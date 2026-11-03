/* MiniMARS: a small in-browser MIPS assembler and runtime for the study portal.
   Branches and jumps take effect immediately. There is no delay slot.
   Memory is little-endian, matching MARS. Arithmetic wraps; it does not trap. */
(function (root) {
  'use strict';

  var TEXT_BASE = 0x00400000;
  var DATA_BASE = 0x10010000;
  var STACK_POINTER = 0x7fffeffc;
  var STEP_LIMIT = 10000;

  var REG_DISPLAY = [
    'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
    't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
    's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
    't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'
  ];

  var REG_INDEX = {};
  REG_DISPLAY.forEach(function (name, i) { REG_INDEX[name] = i; });
  REG_INDEX.s8 = 30;

  var SAMPLE = [
    '# Counted loop: print 1 2 3 4 5',
    '.data',
    'space: .asciiz " "',
    '',
    '.text',
    '    li   $t0, 1        # counter',
    '    li   $t1, 5        # last number to print',
    'loop:',
    '    move $a0, $t0',
    '    li   $v0, 1',
    '    syscall            # print integer',
    '    la   $a0, space',
    '    li   $v0, 4',
    '    syscall            # print a space',
    '    beq  $t0, $t1, done',
    '    addi $t0, $t0, 1',
    '    j    loop',
    'done:',
    '    li   $v0, 10',
    '    syscall            # exit'
  ].join('\n');

  function AssembleError(line, message) {
    this.name = 'AssembleError';
    this.line = line;
    this.message = line ? ('Line ' + line + ': ' + message) : message;
  }
  AssembleError.prototype = Object.create(Error.prototype);

  function hex8(n) {
    return '0x' + (n >>> 0).toString(16).padStart(8, '0');
  }

  function regToken(n) {
    return '$' + REG_DISPLAY[n];
  }

  function parseIntToken(tok) {
    var sign = 1;
    var s = tok;
    if (s[0] === '+') s = s.slice(1);
    else if (s[0] === '-') { sign = -1; s = s.slice(1); }
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(s)) return null;
    var v = /^0x/i.test(s) ? parseInt(s.slice(2), 16) : parseInt(s, 10);
    if (!Number.isSafeInteger(v)) return null;
    return sign * v;
  }

  function isIntToken(tok) {
    return parseIntToken(tok) !== null;
  }

  function isLabelToken(tok) {
    return /^[A-Za-z_][\w]*$/.test(tok);
  }

  function toUint32(n, line, what) {
    if (!Number.isSafeInteger(n) || n < -0x80000000 || n > 0xffffffff) {
      throw new AssembleError(line, what + ' does not fit in 32 bits');
    }
    return n >>> 0;
  }

  function signed16(n, line) {
    if (!Number.isSafeInteger(n) || n < -32768 || n > 32767) {
      throw new AssembleError(line, 'immediate ' + n + ' does not fit in 16 bits');
    }
    return n;
  }

  function low16(n, line) {
    if (!Number.isSafeInteger(n) || n < -32768 || n > 65535) {
      throw new AssembleError(line, 'immediate ' + n + ' does not fit in 16 bits');
    }
    return n & 0xffff;
  }

  function stripComment(line) {
    var inStr = false;
    var esc = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '#') return line.slice(0, i);
    }
    return line;
  }

  function splitArgs(s) {
    var out = [];
    var cur = '';
    var inStr = false;
    var esc = false;
    var depth = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inStr) {
        cur += c;
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; cur += c; continue; }
      if (c === '(') { depth++; cur += c; continue; }
      if (c === ')') { depth--; cur += c; continue; }
      if (c === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function parseReg(tok, line) {
    if (!tok || tok[0] !== '$') {
      throw new AssembleError(line, 'expected a register such as $t0, found "' + (tok || '') + '"');
    }
    var name = tok.slice(1);
    if (/^\d+$/.test(name)) {
      var n = Number(name);
      if (n > 31) throw new AssembleError(line, 'register ' + tok + ' is out of range');
      return n;
    }
    var idx = REG_INDEX[name.toLowerCase()];
    if (idx === undefined) throw new AssembleError(line, 'unknown register ' + tok);
    return idx;
  }

  function parseString(tok, line) {
    if (tok.length < 2 || tok[0] !== '"' || tok[tok.length - 1] !== '"') {
      throw new AssembleError(line, 'expected a "string"');
    }
    var body = tok.slice(1, -1);
    var out = '';
    for (var i = 0; i < body.length; i++) {
      if (body[i] !== '\\') { out += body[i]; continue; }
      var n = body[++i];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === '0') out += '\0';
      else if (n === '\\' || n === '"') out += n;
      else throw new AssembleError(line, 'unknown string escape \\' + (n || ''));
    }
    for (var k = 0; k < out.length; k++) {
      if (out.charCodeAt(k) > 255) {
        throw new AssembleError(line, '.asciiz only stores byte characters');
      }
    }
    return out;
  }

  function parseMem(tok, line) {
    var m = /^(.*)\(\s*(\$[A-Za-z0-9]+)\s*\)$/.exec(tok);
    if (!m) throw new AssembleError(line, 'expected offset($register), found "' + tok + '"');
    var offText = m[1].trim();
    var off = offText === '' ? 0 : parseIntToken(offText);
    if (off === null) throw new AssembleError(line, 'bad memory offset "' + offText + '"');
    return { imm: signed16(off, line), rs: parseReg(m[2], line) };
  }

  function need(args, n, line, op) {
    if (args.length !== n) {
      throw new AssembleError(line, op + ' expects ' + n + ' operand' + (n === 1 ? '' : 's'));
    }
  }

  function expand(op, args, line, origin) {
    var list = [];
    function push(fields) {
      fields.op = fields.op || op;
      fields.line = line;
      fields.origin = origin;
      list.push(fields);
    }
    if (op === 'syscall') {
      need(args, 0, line, op);
      push({});
      return list;
    }
    if (op === 'nop') {
      need(args, 0, line, op);
      push({});
      return list;
    }
    if (op === 'j' || op === 'jal') {
      need(args, 1, line, op);
      if (!isLabelToken(args[0])) throw new AssembleError(line, op + ' expects a label');
      push({ label: args[0] });
      return list;
    }
    if (op === 'jr') {
      need(args, 1, line, op);
      push({ rs: parseReg(args[0], line) });
      return list;
    }
    if (op === 'lui') {
      need(args, 2, line, op);
      var luiImm = parseIntToken(args[1]);
      if (luiImm === null) throw new AssembleError(line, 'lui expects a number');
      push({ rt: parseReg(args[0], line), imm: low16(luiImm, line) });
      return list;
    }
    if (op === 'lw' || op === 'sw') {
      need(args, 2, line, op);
      var mem = parseMem(args[1], line);
      push({ rt: parseReg(args[0], line), rs: mem.rs, imm: mem.imm });
      return list;
    }
    if (op === 'beq' || op === 'bne') {
      need(args, 3, line, op);
      if (!isLabelToken(args[2])) throw new AssembleError(line, op + ' expects a label');
      push({ rs: parseReg(args[0], line), rt: parseReg(args[1], line), label: args[2] });
      return list;
    }
    if (op === 'add' || op === 'sub' || op === 'and' || op === 'or' || op === 'slt') {
      need(args, 3, line, op);
      push({ rd: parseReg(args[0], line), rs: parseReg(args[1], line), rt: parseReg(args[2], line) });
      return list;
    }
    if (op === 'addi' || op === 'slti') {
      need(args, 3, line, op);
      var immS = parseIntToken(args[2]);
      if (immS === null) throw new AssembleError(line, op + ' expects a number');
      push({ rt: parseReg(args[0], line), rs: parseReg(args[1], line), imm: signed16(immS, line) });
      return list;
    }
    if (op === 'andi' || op === 'ori') {
      need(args, 3, line, op);
      var immU = parseIntToken(args[2]);
      if (immU === null) throw new AssembleError(line, op + ' expects a number');
      push({ rt: parseReg(args[0], line), rs: parseReg(args[1], line), imm: low16(immU, line) });
      return list;
    }
    if (op === 'subi') {
      need(args, 3, line, op);
      var subImm = parseIntToken(args[2]);
      if (subImm === null) throw new AssembleError(line, 'subi expects a number');
      if (subImm === -32768) throw new AssembleError(line, 'subi immediate does not fit in 16 bits');
      push({ op: 'addi', rt: parseReg(args[0], line), rs: parseReg(args[1], line), imm: signed16(-subImm, line) });
      return list;
    }
    if (op === 'move') {
      need(args, 2, line, op);
      push({ op: 'add', rd: parseReg(args[0], line), rs: parseReg(args[1], line), rt: 0 });
      return list;
    }
    if (op === 'li') {
      need(args, 2, line, op);
      if (!isIntToken(args[1])) {
        throw new AssembleError(line, 'li expects a number; use la for a label');
      }
      var value = toUint32(parseIntToken(args[1]), line, 'li immediate');
      var dest = parseReg(args[0], line);
      var signed = value | 0;
      // addi sign-extends a 16-bit immediate, so it only matches that bit pattern.
      if (signed >= -32768 && signed <= 32767 && (signed >>> 0) === value) {
        push({ op: 'addi', rt: dest, rs: 0, imm: signed });
      } else {
        push({ op: 'lui', rt: dest, imm: (value >>> 16) & 0xffff });
        push({ op: 'ori', rt: dest, rs: dest, imm: value & 0xffff });
      }
      return list;
    }
    if (op === 'la') {
      need(args, 2, line, op);
      if (!isLabelToken(args[1])) throw new AssembleError(line, 'la expects a label');
      var rd = parseReg(args[0], line);
      push({ op: 'lui', rt: rd, label: args[1], part: 'upper' });
      push({ op: 'ori', rt: rd, rs: rd, label: args[1], part: 'lower' });
      return list;
    }
    throw new AssembleError(line, 'unknown instruction "' + op + '"');
  }

  function formatInsn(insn) {
    var r = regToken;
    switch (insn.op) {
      case 'add':
      case 'sub':
      case 'and':
      case 'or':
      case 'slt':
        return insn.op + ' ' + r(insn.rd) + ', ' + r(insn.rs) + ', ' + r(insn.rt);
      case 'addi':
      case 'slti':
        return insn.op + ' ' + r(insn.rt) + ', ' + r(insn.rs) + ', ' + insn.imm;
      case 'andi':
      case 'ori':
        return insn.op + ' ' + r(insn.rt) + ', ' + r(insn.rs) + ', ' + (insn.imm & 0xffff);
      case 'lui':
        return 'lui ' + r(insn.rt) + ', 0x' + (insn.imm & 0xffff).toString(16);
      case 'lw':
        return 'lw ' + r(insn.rt) + ', ' + insn.imm + '(' + r(insn.rs) + ')';
      case 'sw':
        return 'sw ' + r(insn.rt) + ', ' + insn.imm + '(' + r(insn.rs) + ')';
      case 'beq':
      case 'bne':
        return insn.op + ' ' + r(insn.rs) + ', ' + r(insn.rt) + ', ' + insn.label;
      case 'j':
      case 'jal':
        return insn.op + ' ' + insn.label;
      case 'jr':
        return 'jr ' + r(insn.rs);
      case 'syscall':
        return 'syscall';
      case 'nop':
        return 'nop';
      default:
        return insn.op;
    }
  }

  function writeBytes(bytes, addr, value) {
    var v = value >>> 0;
    bytes.set(addr, v & 0xff);
    bytes.set(addr + 1, (v >>> 8) & 0xff);
    bytes.set(addr + 2, (v >>> 16) & 0xff);
    bytes.set(addr + 3, (v >>> 24) & 0xff);
  }

  function assemble(source) {
    var text = String(source).replace(/^\uFEFF/, '');
    var lines = text.split(/\r?\n/);
    var labels = new Map();
    var pending = [];
    var section = 'text';
    var textAddr = TEXT_BASE;
    var dataAddr = DATA_BASE;
    var instructions = [];
    var dataItems = [];

    function define(name, addr, line) {
      if (labels.has(name)) {
        throw new AssembleError(line, 'label "' + name + '" is already defined');
      }
      labels.set(name, addr >>> 0);
    }

    function takeLabels(addr, line) {
      pending.forEach(function (name) { define(name, addr, line); });
      pending = [];
    }

    function setSectionAddress(addr, line) {
      if (!Number.isSafeInteger(addr) || addr < 0 || addr > 0xffffffff) {
        throw new AssembleError(line, 'section address is out of range');
      }
      if (section === 'text') {
        if (addr & 3) throw new AssembleError(line, '.text address is not word-aligned');
        textAddr = addr >>> 0;
      } else {
        dataAddr = addr >>> 0;
      }
    }

    lines.forEach(function (raw, index) {
      var lineNo = index + 1;
      var code = stripComment(raw).trim();
      if (!code) return;
      var label = null;
      var rest = code;
      var labelled = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(code);
      if (labelled) {
        label = labelled[1];
        rest = labelled[2].trim();
      }
      if (label) pending.push(label);
      if (!rest) return;

      if (rest[0] === '.') {
        var dir = /^\.([A-Za-z]+)\b\s*([\s\S]*)$/.exec(rest);
        if (!dir) throw new AssembleError(lineNo, 'bad directive');
        var name = dir[1].toLowerCase();
        var arg = dir[2].trim();
        if (name === 'text' || name === 'data') {
          section = name;
          if (arg) {
            var sec = parseIntToken(arg.split(/\s+/)[0]);
            if (sec === null) throw new AssembleError(lineNo, 'bad section address');
            setSectionAddress(sec, lineNo);
          }
          return;
        }
        if (name === 'globl' || name === 'global') return;
        if (name === 'word') {
          if (section !== 'data') throw new AssembleError(lineNo, '.word belongs in .data');
          dataAddr = (dataAddr + 3) & ~3;
          takeLabels(dataAddr, lineNo);
          var words = splitArgs(arg);
          if (!words.length) throw new AssembleError(lineNo, '.word needs a value');
          words.forEach(function (part) {
            var spec;
            if (isIntToken(part)) spec = { type: 'imm', value: toUint32(parseIntToken(part), lineNo, '.word value') };
            else if (isLabelToken(part)) spec = { type: 'label', name: part };
            else throw new AssembleError(lineNo, 'bad .word value "' + part + '"');
            dataItems.push({ addr: dataAddr, spec: spec, line: lineNo, size: 4 });
            dataAddr += 4;
          });
          return;
        }
        if (name === 'asciiz') {
          if (section !== 'data') throw new AssembleError(lineNo, '.asciiz belongs in .data');
          takeLabels(dataAddr, lineNo);
          var strings = splitArgs(arg);
          if (!strings.length) throw new AssembleError(lineNo, '.asciiz needs a string');
          strings.forEach(function (part) {
            var s = parseString(part, lineNo);
            for (var i = 0; i < s.length; i++) {
              dataItems.push({ addr: dataAddr, spec: { type: 'byte', value: s.charCodeAt(i) }, line: lineNo, size: 1 });
              dataAddr += 1;
            }
            dataItems.push({ addr: dataAddr, spec: { type: 'byte', value: 0 }, line: lineNo, size: 1 });
            dataAddr += 1;
          });
          return;
        }
        throw new AssembleError(lineNo, 'unknown directive ".' + name + '"');
      }

      if (section !== 'text') {
        throw new AssembleError(lineNo, 'instruction in .data; put .text before the code');
      }
      if (textAddr & 3) throw new AssembleError(lineNo, '.text address is not word-aligned');
      var opMatch = /^([A-Za-z]+)\b\s*([\s\S]*)$/.exec(rest);
      if (!opMatch) throw new AssembleError(lineNo, 'expected an instruction');
      var op = opMatch[1].toLowerCase();
      var args = opMatch[2].trim() ? splitArgs(opMatch[2].trim()) : [];
      var expanded = expand(op, args, lineNo, rest);
      takeLabels(textAddr, lineNo);
      expanded.forEach(function (insn) {
        insn.addr = textAddr;
        instructions.push(insn);
        textAddr = (textAddr + 4) >>> 0;
      });
    });

    if (pending.length) {
      var at = section === 'text' ? textAddr : dataAddr;
      pending.forEach(function (name) { define(name, at, null); });
      pending = [];
    }
    if (!instructions.length) {
      throw new AssembleError(null, 'No instructions. Add some code, usually under .text.');
    }

    instructions.forEach(function (insn) {
      if (insn.label && (insn.op === 'beq' || insn.op === 'bne' || insn.op === 'j' || insn.op === 'jal')) {
        if (!labels.has(insn.label)) throw new AssembleError(insn.line, 'unknown label "' + insn.label + '"');
        insn.target = labels.get(insn.label) >>> 0;
      }
      if (insn.part) {
        if (!labels.has(insn.label)) throw new AssembleError(insn.line, 'unknown label "' + insn.label + '"');
        var addr = labels.get(insn.label) >>> 0;
        insn.imm = insn.part === 'upper' ? (addr >>> 16) & 0xffff : addr & 0xffff;
      }
      insn.asm = formatInsn(insn);
    });

    var bytes = new Map();
    dataItems.forEach(function (item) {
      var value;
      if (item.spec.type === 'byte') value = item.spec.value;
      else if (item.spec.type === 'imm') value = item.spec.value;
      else {
        if (!labels.has(item.spec.name)) {
          throw new AssembleError(item.line, 'unknown label "' + item.spec.name + '"');
        }
        value = labels.get(item.spec.name) >>> 0;
      }
      if (item.size === 1) bytes.set(item.addr, value & 0xff);
      else writeBytes(bytes, item.addr, value);
    });

    var byAddr = new Map();
    instructions.forEach(function (insn) {
      if (byAddr.has(insn.addr)) {
        throw new AssembleError(insn.line, 'two instructions at ' + hex8(insn.addr));
      }
      byAddr.set(insn.addr, insn);
    });

    var labelAt = new Map();
    labels.forEach(function (addr, name) {
      if (!labelAt.has(addr)) labelAt.set(addr, []);
      labelAt.get(addr).push(name);
    });

    return {
      instructions: instructions,
      byAddr: byAddr,
      labels: labels,
      labelAt: labelAt,
      bytes: bytes,
      start: instructions[0].addr,
      textBase: TEXT_BASE,
      dataBase: DATA_BASE
    };
  }

  function readWordAt(mem, addr) {
    addr >>>= 0;
    if (addr & 3) {
      var err = new Error('unaligned word address ' + hex8(addr));
      throw err;
    }
    var v = 0;
    for (var i = 0; i < 4; i++) v |= (mem.get(addr + i) || 0) << (8 * i);
    return v >>> 0;
  }

  function readStringAt(mem, addr) {
    addr >>>= 0;
    var s = '';
    for (var i = 0; i < 4096; i++) {
      var b = mem.get((addr + i) >>> 0) || 0;
      if (b === 0) return s;
      s += String.fromCharCode(b);
    }
    throw new Error('string at ' + hex8(addr) + ' is not terminated within 4096 bytes');
  }

  function boot(program, hooks) {
    hooks = hooks || {};
    var regs = new Uint32Array(32);
    regs[29] = STACK_POINTER;
    return {
      program: program,
      mem: new Map(program.bytes),
      regs: regs,
      pc: program.start >>> 0,
      halted: false,
      waiting: false,
      error: null,
      output: '',
      steps: 0,
      written: null,
      touched: new Set(),
      readInput: hooks.readInput || function () { return null; }
    };
  }

  function readReg(machine, id) {
    var n = typeof id === 'number' ? id : REG_INDEX[String(id).replace(/^\$/, '').toLowerCase()];
    return machine.regs[n] >>> 0;
  }

  function readRegSigned(machine, id) {
    return readReg(machine, id) | 0;
  }

  function writeReg(machine, rd, value) {
    if (rd === 0) return;
    machine.regs[rd] = value >>> 0;
  }

  function writeWord(machine, addr, value) {
    addr >>>= 0;
    if (addr & 3) throw new Error('unaligned word address ' + hex8(addr));
    var v = value >>> 0;
    for (var i = 0; i < 4; i++) machine.mem.set(addr + i, (v >>> (8 * i)) & 0xff);
    machine.written = addr;
    machine.touched.add(addr);
  }

  function fellOff(machine) {
    var last = machine.program.instructions[machine.program.instructions.length - 1];
    if (machine.pc === ((last.addr + 4) >>> 0)) {
      return 'Execution fell off the end of the program. Use syscall 10 to exit.';
    }
    return 'PC ' + hex8(machine.pc) + ' is not an instruction.';
  }

  function doSyscall(machine, next) {
    var code = readRegSigned(machine, 2);
    if (code === 1) {
      machine.output += String(readRegSigned(machine, 4));
      machine.pc = next;
      return;
    }
    if (code === 4) {
      machine.output += readStringAt(machine.mem, readReg(machine, 4));
      machine.pc = next;
      return;
    }
    if (code === 5) {
      var value = machine.readInput();
      if (value === null || value === undefined) {
        machine.waiting = true;
        return;
      }
      if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0xffffffff) {
        throw new Error('read integer is out of range');
      }
      writeReg(machine, 2, value);
      machine.pc = next;
      return;
    }
    if (code === 10) {
      machine.halted = true;
      machine.pc = next;
      return;
    }
    throw new Error('unsupported syscall ' + code);
  }

  function execute(machine, insn) {
    var next = (machine.pc + 4) >>> 0;
    var rs;
    var rt;
    var addr;
    switch (insn.op) {
      case 'nop':
        machine.pc = next;
        break;
      case 'add':
        writeReg(machine, insn.rd, (readReg(machine, insn.rs) + readReg(machine, insn.rt)) >>> 0);
        machine.pc = next;
        break;
      case 'sub':
        writeReg(machine, insn.rd, (readReg(machine, insn.rs) - readReg(machine, insn.rt)) >>> 0);
        machine.pc = next;
        break;
      case 'and':
        writeReg(machine, insn.rd, readReg(machine, insn.rs) & readReg(machine, insn.rt));
        machine.pc = next;
        break;
      case 'or':
        writeReg(machine, insn.rd, readReg(machine, insn.rs) | readReg(machine, insn.rt));
        machine.pc = next;
        break;
      case 'slt':
        writeReg(machine, insn.rd, (readRegSigned(machine, insn.rs) < readRegSigned(machine, insn.rt)) ? 1 : 0);
        machine.pc = next;
        break;
      case 'addi':
        writeReg(machine, insn.rt, (readReg(machine, insn.rs) + insn.imm) >>> 0);
        machine.pc = next;
        break;
      case 'slti':
        writeReg(machine, insn.rt, (readRegSigned(machine, insn.rs) < insn.imm) ? 1 : 0);
        machine.pc = next;
        break;
      case 'andi':
        writeReg(machine, insn.rt, readReg(machine, insn.rs) & (insn.imm & 0xffff));
        machine.pc = next;
        break;
      case 'ori':
        writeReg(machine, insn.rt, readReg(machine, insn.rs) | (insn.imm & 0xffff));
        machine.pc = next;
        break;
      case 'lui':
        writeReg(machine, insn.rt, (insn.imm & 0xffff) << 16);
        machine.pc = next;
        break;
      case 'lw':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeReg(machine, insn.rt, readWordAt(machine.mem, addr));
        machine.pc = next;
        break;
      case 'sw':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeWord(machine, addr, readReg(machine, insn.rt));
        machine.pc = next;
        break;
      case 'beq':
        rs = readReg(machine, insn.rs);
        rt = readReg(machine, insn.rt);
        machine.pc = rs === rt ? insn.target : next;
        break;
      case 'bne':
        rs = readReg(machine, insn.rs);
        rt = readReg(machine, insn.rt);
        machine.pc = rs !== rt ? insn.target : next;
        break;
      case 'j':
        machine.pc = insn.target;
        break;
      case 'jal':
        writeReg(machine, 31, next);
        machine.pc = insn.target;
        break;
      case 'jr':
        addr = readReg(machine, insn.rs);
        if (addr & 3) throw new Error('unaligned jump target ' + hex8(addr));
        machine.pc = addr;
        break;
      case 'syscall':
        doSyscall(machine, next);
        break;
      default:
        throw new Error('unknown instruction "' + insn.op + '"');
    }
  }

  function step(machine) {
    if (machine.halted || machine.error || machine.waiting) return machine;
    machine.written = null;
    var insn = machine.program.byAddr.get(machine.pc >>> 0);
    if (!insn) {
      machine.error = fellOff(machine);
      return machine;
    }
    try {
      execute(machine, insn);
    } catch (err) {
      machine.error = 'Line ' + insn.line + ': ' + err.message;
      return machine;
    }
    if (!machine.waiting) machine.steps += 1;
    return machine;
  }

  function run(programOrSource, opts) {
    opts = opts || {};
    var program = typeof programOrSource === 'string' ? assemble(programOrSource) : programOrSource;
    var inputs = (opts.inputs || []).slice();
    var machine = boot(program, {
      readInput: function () { return inputs.length ? inputs.shift() : null; }
    });
    var limit = opts.limit == null ? STEP_LIMIT : opts.limit;
    var n = 0;
    while (!machine.halted && !machine.error && !machine.waiting && n < limit) {
      step(machine);
      n += 1;
    }
    if (!machine.halted && !machine.error && !machine.waiting && n >= limit) {
      machine.error = 'Stopped after ' + limit + ' steps. The program may be in an infinite loop.';
    }
    return machine;
  }

  function peekWord(machine, addr) {
    return readWordAt(machine.mem, addr);
  }

  var api = {
    SAMPLE: SAMPLE,
    STEP_LIMIT: STEP_LIMIT,
    TEXT_BASE: TEXT_BASE,
    DATA_BASE: DATA_BASE,
    STACK_POINTER: STACK_POINTER,
    REG_DISPLAY: REG_DISPLAY,
    assemble: assemble,
    boot: boot,
    step: step,
    run: run,
    readReg: readReg,
    readRegSigned: readRegSigned,
    peekWord: peekWord,
    hex8: hex8
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniMars = api;

  if (typeof document === 'undefined' || !document.getElementById) return;

  function init() {
    var editor = document.getElementById('mm-editor');
    if (!editor) return;
    var message = document.getElementById('mm-message');
    var pcEl = document.getElementById('mm-pc');
    var nextEl = document.getElementById('mm-next');
    var regsEl = document.getElementById('mm-regs');
    var textEl = document.getElementById('mm-text');
    var memEl = document.getElementById('mm-mem');
    var consoleEl = document.getElementById('mm-console');
    var input = document.getElementById('mm-input');
    var program = null;
    var machine = null;
    var assembledSource = null;
    var shownRegs = null;

    editor.value = SAMPLE;

    function show(kind, text) {
      message.hidden = !text;
      message.className = 'mm-message' + (kind ? ' ' + kind : '');
      message.textContent = text || '';
    }

    function parseInputToken(raw) {
      var m = /^\s*([+-]?(?:0x[0-9a-f]+|\d+))/i.exec(raw);
      if (!m) return null;
      return { text: m[1], value: parseIntToken(m[1]), length: m[0].length };
    }

    function takeInput() {
      var found = parseInputToken(input.value);
      if (!found) return null;
      input.value = input.value.slice(found.length);
      if (found.value === null || found.value < -0x80000000 || found.value > 0xffffffff) {
        throw new Error('integer does not fit in 32 bits');
      }
      return found.value;
    }

    function hasToken() {
      return !!parseInputToken(input.value);
    }

    function freshMachine() {
      machine = boot(program, { readInput: takeInput });
      shownRegs = new Uint32Array(machine.regs);
    }

    function assembleFromEditor(force) {
      var src = editor.value;
      if (!force && machine && src === assembledSource && !machine.error) return true;
      if (!force && src === assembledSource && program && machine && machine.error) return false;
      try {
        program = assemble(src);
        assembledSource = src;
        freshMachine();
        return true;
      } catch (err) {
        program = null;
        machine = null;
        assembledSource = src;
        shownRegs = null;
        show('error', err.message);
        render();
        return false;
      }
    }

    function wordAddresses() {
      if (!machine) return [];
      var data = new Set();
      var extra = new Set();
      machine.program.bytes.forEach(function (_b, addr) { data.add(addr & ~3); });
      machine.touched.forEach(function (addr) {
        var word = addr & ~3;
        if (!data.has(word)) extra.add(word);
      });
      var list = Array.from(data).sort(function (a, b) { return a - b; }).slice(0, 48);
      Array.from(extra).sort(function (a, b) { return a - b; }).slice(0, 16).forEach(function (addr) {
        list.push(addr);
      });
      return list;
    }

    function labelsFor(addr) {
      var names = [];
      if (!program) return '';
      program.labelAt.forEach(function (list, at) {
        if ((at & ~3) === addr) names = names.concat(list);
      });
      return names.join(', ');
    }

    function render() {
      if (!machine) {
        pcEl.textContent = '—';
        nextEl.textContent = '';
        regsEl.innerHTML = '';
        textEl.innerHTML = '';
        memEl.innerHTML = '';
        consoleEl.textContent = '';
        consoleEl.dataset.empty = 'true';
        return;
      }
      var insn = program.byAddr.get(machine.pc >>> 0);
      pcEl.textContent = hex8(machine.pc);
      if (machine.halted) nextEl.textContent = 'Halted';
      else if (insn) nextEl.textContent = 'Next · line ' + insn.line + ' · ' + insn.asm;
      else nextEl.textContent = '';

      var html = '';
      for (var row = 0; row < 16; row++) {
        html += '<tr>';
        [row, row + 16].forEach(function (i) {
          var changed = shownRegs && shownRegs[i] !== machine.regs[i];
          html += '<td class="' + (changed ? 'changed' : '') + '">$' + REG_DISPLAY[i] + '</td>';
          html += '<td class="' + (changed ? 'changed' : '') + '">' + hex8(machine.regs[i]) + '</td>';
          html += '<td class="' + (changed ? 'changed' : '') + '">' + (machine.regs[i] | 0) + '</td>';
        });
        html += '</tr>';
      }
      regsEl.innerHTML = html;

      var textHtml = '';
      program.instructions.forEach(function (item) {
        var current = item.addr === (machine.pc >>> 0) && !machine.halted;
        var origin = item.origin !== item.asm ? '<span class="mm-origin">' + escapeHtml(item.origin) + '</span>' : '';
        textHtml += '<tr' + (current ? ' class="current"' : '') + ' data-addr="' + item.addr + '">';
        textHtml += '<td>' + hex8(item.addr) + '</td><td>' + escapeHtml(item.asm) + origin + '</td></tr>';
      });
      textEl.innerHTML = textHtml;
      var currentRow = textEl.querySelector('.current');
      if (currentRow) revealRow(currentRow, document.getElementById('mm-text-scroll'));

      var memHtml = '';
      var addrs = wordAddresses();
      if (!addrs.length) {
        memHtml = '<tr><td class="mm-empty" colspan="4">No data yet. .word, .asciiz and sw show up here.</td></tr>';
      } else {
        addrs.forEach(function (addr) {
          var word = 0;
          var known = false;
          for (var b = 0; b < 4; b++) {
            if (machine.mem.has(addr + b)) {
              known = true;
              word |= machine.mem.get(addr + b) << (8 * b);
            }
          }
          var mark = machine.written === addr ? ' class="changed"' : '';
          var ascii = '';
          for (var c = 0; c < 4; c++) {
            var byte = machine.mem.has(addr + c) ? machine.mem.get(addr + c) : null;
            ascii += byte == null ? '·' : (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '·');
          }
          memHtml += '<tr' + mark + '><td>' + hex8(addr) + '</td><td>' + escapeHtml(labelsFor(addr)) + '</td><td>' +
            (known ? hex8(word >>> 0) : '—') + '</td><td>' + escapeHtml(ascii) + '</td></tr>';
        });
      }
      memEl.innerHTML = memHtml;

      consoleEl.textContent = machine.output;
      consoleEl.dataset.empty = machine.output ? 'false' : 'true';
      shownRegs = new Uint32Array(machine.regs);
    }

    function finishStatus() {
      if (!machine) return;
      if (machine.error) show('error', machine.error);
      else if (machine.waiting) show('wait', 'Syscall 5 needs an integer. Type it in Console input, then press Enter.');
      else if (machine.halted) show('ok', 'Program exited.');
      else show('', '');
    }

    function onAssemble() {
      if (!assembleFromEditor(true)) return;
      show('ok', 'Assembled ' + program.instructions.length + ' instructions. PC starts at ' + hex8(program.start) + '.');
      render();
    }

    function guardStopped() {
      if (machine.halted) {
        show('ok', 'Program has exited. Press Reset to run it again.');
        return true;
      }
      if (machine.error) {
        show('error', machine.error);
        return true;
      }
      return false;
    }

    function onStep() {
      if (!assembleFromEditor(false)) return;
      if (guardStopped()) { render(); return; }
      if (machine.waiting && hasToken()) machine.waiting = false;
      step(machine);
      finishStatus();
      render();
    }

    function onRun() {
      if (!assembleFromEditor(false)) return;
      if (guardStopped()) { render(); return; }
      if (machine.waiting && hasToken()) machine.waiting = false;
      var n = 0;
      while (n < STEP_LIMIT && !machine.halted && !machine.error && !machine.waiting) {
        step(machine);
        n += 1;
      }
      if (!machine.halted && !machine.error && !machine.waiting && n >= STEP_LIMIT) {
        machine.error = 'Stopped after ' + STEP_LIMIT + ' steps. The program may be in an infinite loop.';
      }
      finishStatus();
      render();
    }

    function onEnter() {
      if (machine && machine.waiting) onStep();
    }

    document.getElementById('mm-assemble').addEventListener('click', onAssemble);
    document.getElementById('mm-run').addEventListener('click', onRun);
    document.getElementById('mm-step').addEventListener('click', onStep);
    document.getElementById('mm-reset').addEventListener('click', onAssemble);
    document.getElementById('mm-sample').addEventListener('click', function () {
      editor.value = SAMPLE;
      onAssemble();
    });
    document.getElementById('mm-enter').addEventListener('click', onEnter);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        onEnter();
      }
    });
    editor.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onRun();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        var start = editor.selectionStart;
        var end = editor.selectionEnd;
        editor.value = editor.value.slice(0, start) + '\t' + editor.value.slice(end);
        editor.selectionStart = editor.selectionEnd = start + 1;
      }
    });

    onAssemble();
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function revealRow(row, scroller) {
    if (!row || !scroller) return;
    var top = row.offsetTop;
    var bottom = top + row.offsetHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);

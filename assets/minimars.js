/* MiniMARS: a small in-browser MIPS assembler and runtime for the study portal.
   Branches and jumps take effect immediately. There is no delay slot.
   Memory is little-endian, matching MARS. Arithmetic wraps; it does not trap.
   HI and LO hold multiply and divide results. $f0–$f31 hold IEEE floating point. */
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

  function floatToBits(n) {
    var buf = new ArrayBuffer(4);
    var view = new DataView(buf);
    view.setFloat32(0, n, true);
    return view.getUint32(0, true);
  }

  function bitsToFloat(bits) {
    var buf = new ArrayBuffer(4);
    var view = new DataView(buf);
    view.setUint32(0, bits >>> 0, true);
    return view.getFloat32(0, true);
  }

  function doubleParts(n) {
    var buf = new ArrayBuffer(8);
    var view = new DataView(buf);
    view.setFloat64(0, n, true);
    return { lo: view.getUint32(0, true), hi: view.getUint32(4, true) };
  }

  function formatReal(n) {
    if (Number.isNaN(n)) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    if (Object.is(n, -0)) return '-0.0';
    var text = String(n);
    if (!/[.eE]/.test(text)) text += '.0';
    return text;
  }

  function product64(a, b, unsigned) {
    var p = unsigned ? (BigInt(a >>> 0) * BigInt(b >>> 0)) : (BigInt(a | 0) * BigInt(b | 0));
    return {
      lo: Number(p & 0xffffffffn) >>> 0,
      hi: Number((p >> 32n) & 0xffffffffn) >>> 0
    };
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
    var quote = '';
    var esc = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (quote) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
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
        throw new AssembleError(line, 'a string only stores byte characters');
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

  function parseFReg(tok, line) {
    var m = /^\$f(\d+)$/i.exec(tok || '');
    if (!m) {
      throw new AssembleError(line, 'expected a floating-point register such as $f0, found "' + (tok || '') + '"');
    }
    var n = Number(m[1]);
    if (n > 31) throw new AssembleError(line, 'register ' + tok + ' is out of range');
    return n;
  }

  function shamtOf(tok, line) {
    var n = parseIntToken(tok);
    if (n === null || n < 0 || n > 31) throw new AssembleError(line, 'shift amount must be 0..31');
    return n;
  }

  function requireLabel(tok, line, op) {
    if (!isLabelToken(tok)) throw new AssembleError(line, op + ' expects a label');
    return tok;
  }

  function parseRealToken(tok) {
    if (!/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(tok)) return null;
    var n = Number(tok);
    return Number.isFinite(n) ? n : null;
  }

  function parseByteValue(part, line) {
    if (isIntToken(part)) {
      var n = parseIntToken(part);
      if (n < -128 || n > 255) throw new AssembleError(line, '.byte value ' + n + ' does not fit in 8 bits');
      return n & 0xff;
    }
    if (part.length >= 2 && part[0] === "'" && part[part.length - 1] === "'") {
      var body = part.slice(1, -1);
      var ch = null;
      if (body.length === 1) ch = body;
      else if (body.length === 2 && body[0] === '\\') {
        if (body[1] === 'n') ch = '\n';
        else if (body[1] === 't') ch = '\t';
        else if (body[1] === 'r') ch = '\r';
        else if (body[1] === '0') ch = '\0';
        else if (body[1] === '\\' || body[1] === "'") ch = body[1];
        else throw new AssembleError(line, 'unknown character escape \\' + body[1]);
      }
      if (ch == null || ch.charCodeAt(0) > 255) throw new AssembleError(line, 'bad character ' + part);
      return ch.charCodeAt(0);
    }
    if (part.length >= 2 && part[0] === '"') {
      var s = parseString(part, line);
      if (s.length !== 1) throw new AssembleError(line, '.byte string must be one character');
      return s.charCodeAt(0);
    }
    throw new AssembleError(line, 'bad .byte value "' + part + '"');
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
    if (op === 'lb' || op === 'lbu' || op === 'lh' || op === 'lhu' || op === 'lw' || op === 'sb' || op === 'sh' || op === 'sw') {
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
    if (op === 'bltz' || op === 'bgez' || op === 'bgtz' || op === 'blez') {
      need(args, 2, line, op);
      push({ rs: parseReg(args[0], line), label: requireLabel(args[1], line, op) });
      return list;
    }
    if (op === 'beqz' || op === 'bnez') {
      need(args, 2, line, op);
      push({ op: op === 'beqz' ? 'beq' : 'bne', rs: parseReg(args[0], line), rt: 0, label: requireLabel(args[1], line, op) });
      return list;
    }
    if (op === 'blt' || op === 'bgt' || op === 'ble' || op === 'bge' || op === 'bltu' || op === 'bgtu' || op === 'bleu' || op === 'bgeu') {
      need(args, 3, line, op);
      var brs = parseReg(args[0], line);
      var brt = parseReg(args[1], line);
      var blab = requireLabel(args[2], line, op);
      var unsigned = op === 'bltu' || op === 'bgtu' || op === 'bleu' || op === 'bgeu';
      var swap = op === 'bgt' || op === 'ble' || op === 'bgtu' || op === 'bleu';
      var onEqual = op === 'bge' || op === 'ble' || op === 'bgeu' || op === 'bleu';
      push({ op: unsigned ? 'sltu' : 'slt', rd: 1, rs: swap ? brt : brs, rt: swap ? brs : brt });
      push({ op: onEqual ? 'beq' : 'bne', rs: 1, rt: 0, label: blab });
      return list;
    }
    if (op === 'add' || op === 'addu' || op === 'sub' || op === 'subu' || op === 'and' || op === 'or' || op === 'xor' || op === 'nor' || op === 'slt' || op === 'sltu' || op === 'mul') {
      need(args, 3, line, op);
      push({ rd: parseReg(args[0], line), rs: parseReg(args[1], line), rt: parseReg(args[2], line) });
      return list;
    }
    if (op === 'addi' || op === 'addiu' || op === 'slti' || op === 'sltiu') {
      need(args, 3, line, op);
      var immS = parseIntToken(args[2]);
      if (immS === null) throw new AssembleError(line, op + ' expects a number');
      push({ rt: parseReg(args[0], line), rs: parseReg(args[1], line), imm: signed16(immS, line) });
      return list;
    }
    if (op === 'andi' || op === 'ori' || op === 'xori') {
      need(args, 3, line, op);
      var immU = parseIntToken(args[2]);
      if (immU === null) throw new AssembleError(line, op + ' expects a number');
      push({ rt: parseReg(args[0], line), rs: parseReg(args[1], line), imm: low16(immU, line) });
      return list;
    }
    if (op === 'sll' || op === 'srl' || op === 'sra') {
      need(args, 3, line, op);
      push({ rd: parseReg(args[0], line), rt: parseReg(args[1], line), shamt: shamtOf(args[2], line) });
      return list;
    }
    if (op === 'sllv' || op === 'srlv' || op === 'srav') {
      need(args, 3, line, op);
      push({ rd: parseReg(args[0], line), rt: parseReg(args[1], line), rs: parseReg(args[2], line) });
      return list;
    }
    if (op === 'mult' || op === 'multu') {
      need(args, 2, line, op);
      push({ rs: parseReg(args[0], line), rt: parseReg(args[1], line) });
      return list;
    }
    if (op === 'div' || op === 'divu') {
      if (args.length === 2) {
        push({ rs: parseReg(args[0], line), rt: parseReg(args[1], line) });
        return list;
      }
      if (args.length === 3) {
        push({ rd: parseReg(args[0], line), rs: parseReg(args[1], line), rt: parseReg(args[2], line) });
        return list;
      }
      throw new AssembleError(line, op + ' expects 2 or 3 operands');
    }
    if (op === 'mfhi' || op === 'mflo') {
      need(args, 1, line, op);
      push({ rd: parseReg(args[0], line) });
      return list;
    }
    if (op === 'mthi' || op === 'mtlo') {
      need(args, 1, line, op);
      push({ rs: parseReg(args[0], line) });
      return list;
    }
    if (op === 'not') {
      need(args, 2, line, op);
      push({ op: 'nor', rd: parseReg(args[0], line), rs: parseReg(args[1], line), rt: 0 });
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
    if (op === 'lwc1' || op === 'swc1' || op === 'ldc1' || op === 'sdc1') {
      need(args, 2, line, op);
      var fmem = parseMem(args[1], line);
      push({ ft: parseFReg(args[0], line), rs: fmem.rs, imm: fmem.imm });
      return list;
    }
    if (op === 'add.s' || op === 'sub.s' || op === 'mul.s' || op === 'div.s' || op === 'add.d' || op === 'sub.d' || op === 'mul.d' || op === 'div.d') {
      need(args, 3, line, op);
      push({ fd: parseFReg(args[0], line), fs: parseFReg(args[1], line), ft: parseFReg(args[2], line) });
      return list;
    }
    if (op === 'mov.s' || op === 'mov.d' || op === 'neg.s' || op === 'neg.d' || op === 'abs.s' || op === 'abs.d' || op === 'cvt.s.w' || op === 'cvt.w.s' || op === 'cvt.d.w' || op === 'cvt.w.d' || op === 'cvt.d.s' || op === 'cvt.s.d') {
      need(args, 2, line, op);
      push({ fd: parseFReg(args[0], line), fs: parseFReg(args[1], line) });
      return list;
    }
    if (op === 'c.eq.s' || op === 'c.lt.s' || op === 'c.le.s' || op === 'c.eq.d' || op === 'c.lt.d' || op === 'c.le.d') {
      need(args, 2, line, op);
      push({ fs: parseFReg(args[0], line), ft: parseFReg(args[1], line) });
      return list;
    }
    if (op === 'bc1t' || op === 'bc1f') {
      need(args, 1, line, op);
      push({ label: requireLabel(args[0], line, op) });
      return list;
    }
    if (op === 'mtc1') {
      need(args, 2, line, op);
      push({ rs: parseReg(args[0], line), ft: parseFReg(args[1], line) });
      return list;
    }
    if (op === 'mfc1') {
      need(args, 2, line, op);
      push({ rt: parseReg(args[0], line), fs: parseFReg(args[1], line) });
      return list;
    }
    throw new AssembleError(line, 'unknown instruction "' + op + '"');
  }

  function ftok(n) {
    return '$f' + n;
  }

  function formatInsn(insn) {
    var r = regToken;
    switch (insn.op) {
      case 'add':
      case 'addu':
      case 'sub':
      case 'subu':
      case 'and':
      case 'or':
      case 'xor':
      case 'nor':
      case 'slt':
      case 'sltu':
      case 'mul':
        return insn.op + ' ' + r(insn.rd) + ', ' + r(insn.rs) + ', ' + r(insn.rt);
      case 'addi':
      case 'addiu':
      case 'slti':
      case 'sltiu':
        return insn.op + ' ' + r(insn.rt) + ', ' + r(insn.rs) + ', ' + insn.imm;
      case 'andi':
      case 'ori':
      case 'xori':
        return insn.op + ' ' + r(insn.rt) + ', ' + r(insn.rs) + ', ' + (insn.imm & 0xffff);
      case 'sll':
      case 'srl':
      case 'sra':
        return insn.op + ' ' + r(insn.rd) + ', ' + r(insn.rt) + ', ' + insn.shamt;
      case 'sllv':
      case 'srlv':
      case 'srav':
        return insn.op + ' ' + r(insn.rd) + ', ' + r(insn.rt) + ', ' + r(insn.rs);
      case 'mult':
      case 'multu':
        return insn.op + ' ' + r(insn.rs) + ', ' + r(insn.rt);
      case 'div':
      case 'divu':
        return insn.rd != null
          ? insn.op + ' ' + r(insn.rd) + ', ' + r(insn.rs) + ', ' + r(insn.rt)
          : insn.op + ' ' + r(insn.rs) + ', ' + r(insn.rt);
      case 'mfhi':
      case 'mflo':
        return insn.op + ' ' + r(insn.rd);
      case 'mthi':
      case 'mtlo':
        return insn.op + ' ' + r(insn.rs);
      case 'lui':
        return 'lui ' + r(insn.rt) + ', 0x' + (insn.imm & 0xffff).toString(16);
      case 'lb':
      case 'lbu':
      case 'lh':
      case 'lhu':
      case 'lw':
      case 'sb':
      case 'sh':
      case 'sw':
        return insn.op + ' ' + r(insn.rt) + ', ' + insn.imm + '(' + r(insn.rs) + ')';
      case 'lwc1':
      case 'swc1':
      case 'ldc1':
      case 'sdc1':
        return insn.op + ' ' + ftok(insn.ft) + ', ' + insn.imm + '(' + r(insn.rs) + ')';
      case 'add.s':
      case 'sub.s':
      case 'mul.s':
      case 'div.s':
      case 'add.d':
      case 'sub.d':
      case 'mul.d':
      case 'div.d':
        return insn.op + ' ' + ftok(insn.fd) + ', ' + ftok(insn.fs) + ', ' + ftok(insn.ft);
      case 'mov.s':
      case 'mov.d':
      case 'neg.s':
      case 'neg.d':
      case 'abs.s':
      case 'abs.d':
      case 'cvt.s.w':
      case 'cvt.w.s':
      case 'cvt.d.w':
      case 'cvt.w.d':
      case 'cvt.d.s':
      case 'cvt.s.d':
        return insn.op + ' ' + ftok(insn.fd) + ', ' + ftok(insn.fs);
      case 'c.eq.s':
      case 'c.lt.s':
      case 'c.le.s':
      case 'c.eq.d':
      case 'c.lt.d':
      case 'c.le.d':
        return insn.op + ' ' + ftok(insn.fs) + ', ' + ftok(insn.ft);
      case 'mtc1':
        return 'mtc1 ' + r(insn.rs) + ', ' + ftok(insn.ft);
      case 'mfc1':
        return 'mfc1 ' + r(insn.rt) + ', ' + ftok(insn.fs);
      case 'bc1t':
      case 'bc1f':
        return insn.op + ' ' + insn.label;
      case 'beq':
      case 'bne':
        return insn.op + ' ' + r(insn.rs) + ', ' + r(insn.rt) + ', ' + insn.label;
      case 'bltz':
      case 'bgez':
      case 'bgtz':
      case 'blez':
        return insn.op + ' ' + r(insn.rs) + ', ' + insn.label;
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
        if (name === 'asciiz' || name === 'ascii') {
          if (section !== 'data') throw new AssembleError(lineNo, '.' + name + ' belongs in .data');
          takeLabels(dataAddr, lineNo);
          var strings = splitArgs(arg);
          if (!strings.length) throw new AssembleError(lineNo, '.' + name + ' needs a string');
          strings.forEach(function (part) {
            var s = parseString(part, lineNo);
            for (var i = 0; i < s.length; i++) {
              dataItems.push({ addr: dataAddr, spec: { type: 'byte', value: s.charCodeAt(i) }, line: lineNo, size: 1 });
              dataAddr += 1;
            }
            if (name === 'asciiz') {
              dataItems.push({ addr: dataAddr, spec: { type: 'byte', value: 0 }, line: lineNo, size: 1 });
              dataAddr += 1;
            }
          });
          return;
        }
        if (name === 'byte' || name === 'half' || name === 'float' || name === 'double') {
          if (section !== 'data') throw new AssembleError(lineNo, '.' + name + ' belongs in .data');
          var boundary = name === 'double' ? 8 : (name === 'byte' ? 1 : (name === 'half' ? 2 : 4));
          var aligned = (dataAddr + boundary - 1) & ~(boundary - 1);
          if (aligned < dataAddr) throw new AssembleError(lineNo, 'data ran past the end of memory');
          dataAddr = aligned >>> 0;
          takeLabels(dataAddr, lineNo);
          var pieces = splitArgs(arg);
          if (!pieces.length) throw new AssembleError(lineNo, '.' + name + ' needs a value');
          pieces.forEach(function (part) {
            if (name === 'byte') {
              dataItems.push({ addr: dataAddr, spec: { type: 'byte', value: parseByteValue(part, lineNo) }, line: lineNo, size: 1 });
              dataAddr += 1;
            } else if (name === 'half') {
              if (!isIntToken(part)) throw new AssembleError(lineNo, 'bad .half value "' + part + '"');
              var half = parseIntToken(part);
              if (half < -32768 || half > 65535) throw new AssembleError(lineNo, '.half value ' + half + ' does not fit in 16 bits');
              dataItems.push({ addr: dataAddr, spec: { type: 'imm', value: half & 0xffff }, line: lineNo, size: 2 });
              dataAddr += 2;
            } else if (name === 'float') {
              var flt = parseRealToken(part);
              if (flt === null) throw new AssembleError(lineNo, 'bad .float value "' + part + '"');
              dataItems.push({ addr: dataAddr, spec: { type: 'float', value: flt }, line: lineNo, size: 4 });
              dataAddr += 4;
            } else {
              var dbl = parseRealToken(part);
              if (dbl === null) throw new AssembleError(lineNo, 'bad .double value "' + part + '"');
              dataItems.push({ addr: dataAddr, spec: { type: 'double', value: dbl }, line: lineNo, size: 8 });
              dataAddr += 8;
            }
          });
          return;
        }
        if (name === 'space') {
          if (section !== 'data') throw new AssembleError(lineNo, '.space belongs in .data');
          takeLabels(dataAddr, lineNo);
          var spaceArgs = arg.split(/\s+/).filter(Boolean);
          var count = spaceArgs.length === 1 ? parseIntToken(spaceArgs[0]) : null;
          if (count === null || count < 0 || count > 1048576) throw new AssembleError(lineNo, '.space size is out of range');
          for (var si = 0; si < count; si++) {
            dataItems.push({ addr: dataAddr, spec: { type: 'byte', value: 0 }, line: lineNo, size: 1 });
            dataAddr += 1;
          }
          return;
        }
        if (name === 'align') {
          if (section !== 'data') throw new AssembleError(lineNo, '.align belongs in .data');
          var alignArgs = arg.split(/\s+/).filter(Boolean);
          var power = alignArgs.length === 1 ? parseIntToken(alignArgs[0]) : null;
          if (power === null || power < 0 || power > 16) throw new AssembleError(lineNo, '.align power must be 0..16');
          var span = 1 << power;
          var nextAddr = (dataAddr + span - 1) & ~(span - 1);
          if (nextAddr < dataAddr) throw new AssembleError(lineNo, '.align ran past the end of memory');
          dataAddr = nextAddr >>> 0;
          takeLabels(dataAddr, lineNo);
          return;
        }
        throw new AssembleError(lineNo, 'unknown directive ".' + name + '"');
      }

      if (section !== 'text') {
        throw new AssembleError(lineNo, 'instruction in .data; put .text before the code');
      }
      if (textAddr & 3) throw new AssembleError(lineNo, '.text address is not word-aligned');
      var opMatch = /^([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*)\s*([\s\S]*)$/.exec(rest);
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
      if (insn.label && !insn.part) {
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
      if (item.spec.type === 'float') {
        writeBytes(bytes, item.addr, floatToBits(item.spec.value));
        return;
      }
      if (item.spec.type === 'double') {
        var parts = doubleParts(item.spec.value);
        writeBytes(bytes, item.addr, parts.lo);
        writeBytes(bytes, item.addr + 4, parts.hi);
        return;
      }
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
      else if (item.size === 2) {
        bytes.set(item.addr, value & 0xff);
        bytes.set(item.addr + 1, (value >>> 8) & 0xff);
      } else writeBytes(bytes, item.addr, value);
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

    var heap = (dataAddr + 3) & ~3;
    if (heap < dataAddr) heap = dataAddr;

    return {
      instructions: instructions,
      byAddr: byAddr,
      labels: labels,
      labelAt: labelAt,
      bytes: bytes,
      start: instructions[0].addr,
      heap: heap >>> 0,
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
      readInput: hooks.readInput || function () { return null; },
      hi: 0,
      lo: 0,
      fregs: new Uint32Array(32),
      fcc: 0,
      heap: (program.heap == null ? DATA_BASE : program.heap) >>> 0,
      files: new Map(),
      fds: new Map(),
      nextFd: 3,
      waitFor: null,
      exitCode: null
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

  function readByte(mem, addr) {
    return mem.get(addr >>> 0) || 0;
  }

  function readHalf(mem, addr) {
    addr >>>= 0;
    if (addr & 1) throw new Error('unaligned halfword address ' + hex8(addr));
    return (mem.get(addr) || 0) | ((mem.get((addr + 1) >>> 0) || 0) << 8);
  }

  function writeByte(machine, addr, value) {
    machine.mem.set(addr >>> 0, value & 0xff);
    machine.written = addr & ~3;
    machine.touched.add(machine.written);
  }

  function writeHalf(machine, addr, value) {
    addr >>>= 0;
    if (addr & 1) throw new Error('unaligned halfword address ' + hex8(addr));
    var v = value & 0xffff;
    machine.mem.set(addr, v & 0xff);
    machine.mem.set(addr + 1, (v >>> 8) & 0xff);
    machine.written = addr & ~3;
    machine.touched.add(machine.written);
    var nextWord = (addr + 1) & ~3;
    if (nextWord !== machine.written) machine.touched.add(nextWord);
  }

  function evenPair(n) {
    if (n & 1) throw new Error('double register $f' + n + ' must be even');
  }

  function readDouble(machine, n) {
    evenPair(n);
    var buf = new ArrayBuffer(8);
    var view = new DataView(buf);
    view.setUint32(0, machine.fregs[n] >>> 0, true);
    view.setUint32(4, machine.fregs[n + 1] >>> 0, true);
    return view.getFloat64(0, true);
  }

  function writeDouble(machine, n, value) {
    evenPair(n);
    var parts = doubleParts(value);
    machine.fregs[n] = parts.lo;
    machine.fregs[n + 1] = parts.hi;
  }

  function copyDouble(machine, fd, fs) {
    evenPair(fd);
    evenPair(fs);
    machine.fregs[fd] = machine.fregs[fs];
    machine.fregs[fd + 1] = machine.fregs[fs + 1];
  }

  function absOrNegDouble(machine, fd, fs, negate) {
    evenPair(fd);
    evenPair(fs);
    machine.fregs[fd] = machine.fregs[fs];
    var hi = machine.fregs[fs + 1] >>> 0;
    machine.fregs[fd + 1] = negate ? ((hi ^ 0x80000000) >>> 0) : (hi & 0x7fffffff);
  }

  function fpOp(op, a, b) {
    var kind = op.split('.')[0];
    if (kind === 'add') return a + b;
    if (kind === 'sub') return a - b;
    if (kind === 'mul') return a * b;
    return a / b;
  }

  function fpCmp(op, a, b) {
    var rel = op.split('.')[1];
    if (rel === 'eq') return a === b;
    if (rel === 'lt') return a < b;
    return a <= b;
  }

  function floatToInt(n) {
    if (!Number.isFinite(n) || n < -2147483648 || n >= 2147483648) {
      throw new Error('float does not fit in a word');
    }
    return Math.trunc(n) >>> 0;
  }

  function divide(machine, rs, rt, unsigned) {
    var a = unsigned ? (readReg(machine, rs) >>> 0) : readRegSigned(machine, rs);
    var b = unsigned ? (readReg(machine, rt) >>> 0) : readRegSigned(machine, rt);
    if (b === 0) throw new Error('division by zero');
    var q;
    var rem;
    if (!unsigned && a === -2147483648 && b === -1) {
      q = -2147483648;
      rem = 0;
    } else if (unsigned) {
      q = Math.floor(a / b);
      rem = a % b;
    } else {
      q = Math.trunc(a / b);
      rem = a - q * b;
    }
    machine.lo = q >>> 0;
    machine.hi = rem >>> 0;
  }

  function asInt(value) {
    if (typeof value === 'string') {
      var parsed = parseIntToken(value.trim());
      if (parsed === null) throw new Error('read integer is out of range');
      value = parsed;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value) || value < -0x80000000 || value > 0xffffffff) {
      throw new Error('read integer is out of range');
    }
    return value;
  }

  function asReal(value) {
    if (typeof value === 'string') value = Number(value.trim());
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('read float is not a number');
    return value;
  }

  function asChar(value) {
    if (typeof value === 'string') {
      if (!value.length) throw new Error('read character is empty');
      value = value.charCodeAt(0);
    }
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('read character is out of range');
    return value;
  }

  function writeInputString(machine, addr, text, maxlen) {
    if (!Number.isSafeInteger(maxlen) || maxlen < 1) throw new Error('read string length must be at least 1');
    var cut = text.indexOf('\n');
    var s = cut >= 0 ? text.slice(0, cut + 1) : text + '\n';
    var n = Math.min(s.length, maxlen - 1);
    for (var i = 0; i < n; i++) {
      var ch = s.charCodeAt(i);
      if (ch > 255) throw new Error('read string has a character outside a byte');
      machine.mem.set((addr + i) >>> 0, ch);
      machine.touched.add((addr + i) & ~3);
    }
    machine.mem.set((addr + n) >>> 0, 0);
    machine.touched.add((addr + n) & ~3);
    machine.written = addr & ~3;
  }

  function openFile(machine, name, flags) {
    var file = machine.files.get(name);
    var write = false;
    var pos = 0;
    if (flags === 0) {
      if (!file) return -1;
    } else if (flags === 1) {
      write = true;
      file = [];
      machine.files.set(name, file);
    } else if (flags === 9) {
      write = true;
      if (!file) {
        file = [];
        machine.files.set(name, file);
      }
      pos = file.length;
    } else {
      throw new Error('file flag must be 0 (read), 1 (write) or 9 (append)');
    }
    var fd = machine.nextFd++;
    machine.fds.set(fd, { data: file, pos: pos, write: write });
    return fd;
  }

  function transferFile(machine, writing) {
    var fd = readRegSigned(machine, 4);
    var buf = readReg(machine, 5);
    var len = readRegSigned(machine, 6);
    if (!Number.isSafeInteger(len) || len < 0) throw new Error('file length is negative');
    if (len > 1048576) throw new Error('file length is too large');
    var slot = machine.fds.get(fd);
    if (!slot) return -1;
    if (writing && !slot.write) return -1;
    var n = 0;
    if (writing) {
      while (n < len) {
        var b = machine.mem.get((buf + n) >>> 0) || 0;
        if (slot.pos === slot.data.length) slot.data.push(b & 0xff);
        else slot.data[slot.pos] = b & 0xff;
        slot.pos += 1;
        n += 1;
      }
      return n;
    }
    while (n < len && slot.pos < slot.data.length) {
      machine.mem.set((buf + n) >>> 0, slot.data[slot.pos] & 0xff);
      machine.touched.add((buf + n) & ~3);
      slot.pos += 1;
      n += 1;
    }
    if (n) machine.written = buf & ~3;
    return n;
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

    function finish() {
      machine.waitFor = null;
      machine.pc = next;
    }

    function pull(kind) {
      machine.waitFor = kind;
      var value = machine.readInput();
      if (value === null || value === undefined) {
        machine.waiting = true;
        return undefined;
      }
      machine.waiting = false;
      machine.waitFor = null;
      return value;
    }

    if (code === 1) {
      machine.output += String(readRegSigned(machine, 4));
      finish();
      return;
    }
    if (code === 2) {
      machine.output += formatReal(bitsToFloat(machine.fregs[12]));
      finish();
      return;
    }
    if (code === 3) {
      machine.output += formatReal(readDouble(machine, 12));
      finish();
      return;
    }
    if (code === 4) {
      machine.output += readStringAt(machine.mem, readReg(machine, 4));
      finish();
      return;
    }
    if (code === 5) {
      var integer = pull('int');
      if (integer === undefined) return;
      writeReg(machine, 2, asInt(integer));
      finish();
      return;
    }
    if (code === 6) {
      var flt = pull('float');
      if (flt === undefined) return;
      machine.fregs[0] = floatToBits(asReal(flt));
      finish();
      return;
    }
    if (code === 7) {
      var dbl = pull('double');
      if (dbl === undefined) return;
      writeDouble(machine, 0, asReal(dbl));
      finish();
      return;
    }
    if (code === 8) {
      var line = pull('string');
      if (line === undefined) return;
      writeInputString(machine, readReg(machine, 4), String(line), readRegSigned(machine, 5));
      finish();
      return;
    }
    if (code === 9) {
      var size = readRegSigned(machine, 4);
      if (size < 0) throw new Error('sbrk size is negative');
      var bytes = (size + 3) & ~3;
      var old = machine.heap >>> 0;
      var grown = old + bytes;
      if (grown > 0x7fffeffc) throw new Error('sbrk ran out of memory');
      machine.heap = grown >>> 0;
      writeReg(machine, 2, old);
      finish();
      return;
    }
    if (code === 10) {
      machine.halted = true;
      finish();
      return;
    }
    if (code === 11) {
      machine.output += String.fromCharCode(readReg(machine, 4) & 0xff);
      finish();
      return;
    }
    if (code === 12) {
      var ch = pull('char');
      if (ch === undefined) return;
      writeReg(machine, 2, asChar(ch));
      finish();
      return;
    }
    if (code === 13) {
      writeReg(machine, 2, openFile(machine, readStringAt(machine.mem, readReg(machine, 4)), readRegSigned(machine, 5)));
      finish();
      return;
    }
    if (code === 14) {
      writeReg(machine, 2, transferFile(machine, false));
      finish();
      return;
    }
    if (code === 15) {
      writeReg(machine, 2, transferFile(machine, true));
      finish();
      return;
    }
    if (code === 16) {
      var fd = readRegSigned(machine, 4);
      if (!machine.fds.has(fd)) writeReg(machine, 2, -1);
      else {
        machine.fds.delete(fd);
        writeReg(machine, 2, 0);
      }
      finish();
      return;
    }
    if (code === 17) {
      machine.exitCode = readRegSigned(machine, 4);
      machine.halted = true;
      finish();
      return;
    }
    throw new Error('unsupported syscall ' + code);
  }

  function execute(machine, insn) {
    var next = (machine.pc + 4) >>> 0;
    var rs;
    var rt;
    var addr;
    var prod;
    switch (insn.op) {
      case 'nop':
        machine.pc = next;
        break;
      case 'add':
      case 'addu':
        writeReg(machine, insn.rd, (readReg(machine, insn.rs) + readReg(machine, insn.rt)) >>> 0);
        machine.pc = next;
        break;
      case 'sub':
      case 'subu':
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
      case 'xor':
        writeReg(machine, insn.rd, readReg(machine, insn.rs) ^ readReg(machine, insn.rt));
        machine.pc = next;
        break;
      case 'nor':
        writeReg(machine, insn.rd, ~(readReg(machine, insn.rs) | readReg(machine, insn.rt)));
        machine.pc = next;
        break;
      case 'slt':
        writeReg(machine, insn.rd, (readRegSigned(machine, insn.rs) < readRegSigned(machine, insn.rt)) ? 1 : 0);
        machine.pc = next;
        break;
      case 'sltu':
        writeReg(machine, insn.rd, (readReg(machine, insn.rs) < readReg(machine, insn.rt)) ? 1 : 0);
        machine.pc = next;
        break;
      case 'addi':
      case 'addiu':
        writeReg(machine, insn.rt, (readReg(machine, insn.rs) + insn.imm) >>> 0);
        machine.pc = next;
        break;
      case 'slti':
        writeReg(machine, insn.rt, (readRegSigned(machine, insn.rs) < insn.imm) ? 1 : 0);
        machine.pc = next;
        break;
      case 'sltiu':
        writeReg(machine, insn.rt, (readReg(machine, insn.rs) < (insn.imm >>> 0)) ? 1 : 0);
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
      case 'xori':
        writeReg(machine, insn.rt, readReg(machine, insn.rs) ^ (insn.imm & 0xffff));
        machine.pc = next;
        break;
      case 'lui':
        writeReg(machine, insn.rt, (insn.imm & 0xffff) << 16);
        machine.pc = next;
        break;
      case 'sll':
        writeReg(machine, insn.rd, readReg(machine, insn.rt) << insn.shamt);
        machine.pc = next;
        break;
      case 'srl':
        writeReg(machine, insn.rd, readReg(machine, insn.rt) >>> insn.shamt);
        machine.pc = next;
        break;
      case 'sra':
        writeReg(machine, insn.rd, readRegSigned(machine, insn.rt) >> insn.shamt);
        machine.pc = next;
        break;
      case 'sllv':
        writeReg(machine, insn.rd, readReg(machine, insn.rt) << (readReg(machine, insn.rs) & 31));
        machine.pc = next;
        break;
      case 'srlv':
        writeReg(machine, insn.rd, readReg(machine, insn.rt) >>> (readReg(machine, insn.rs) & 31));
        machine.pc = next;
        break;
      case 'srav':
        writeReg(machine, insn.rd, readRegSigned(machine, insn.rt) >> (readReg(machine, insn.rs) & 31));
        machine.pc = next;
        break;
      case 'mul':
        prod = product64(readReg(machine, insn.rs), readReg(machine, insn.rt), false);
        writeReg(machine, insn.rd, prod.lo);
        machine.pc = next;
        break;
      case 'mult':
      case 'multu':
        prod = product64(readReg(machine, insn.rs), readReg(machine, insn.rt), insn.op === 'multu');
        machine.lo = prod.lo;
        machine.hi = prod.hi;
        machine.pc = next;
        break;
      case 'div':
      case 'divu':
        divide(machine, insn.rs, insn.rt, insn.op === 'divu');
        if (insn.rd != null) writeReg(machine, insn.rd, machine.lo);
        machine.pc = next;
        break;
      case 'mfhi':
        writeReg(machine, insn.rd, machine.hi);
        machine.pc = next;
        break;
      case 'mflo':
        writeReg(machine, insn.rd, machine.lo);
        machine.pc = next;
        break;
      case 'mthi':
        machine.hi = readReg(machine, insn.rs);
        machine.pc = next;
        break;
      case 'mtlo':
        machine.lo = readReg(machine, insn.rs);
        machine.pc = next;
        break;
      case 'lb':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeReg(machine, insn.rt, (readByte(machine.mem, addr) << 24) >> 24);
        machine.pc = next;
        break;
      case 'lbu':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeReg(machine, insn.rt, readByte(machine.mem, addr));
        machine.pc = next;
        break;
      case 'lh':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeReg(machine, insn.rt, (readHalf(machine.mem, addr) << 16) >> 16);
        machine.pc = next;
        break;
      case 'lhu':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeReg(machine, insn.rt, readHalf(machine.mem, addr));
        machine.pc = next;
        break;
      case 'lw':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeReg(machine, insn.rt, readWordAt(machine.mem, addr));
        machine.pc = next;
        break;
      case 'sb':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeByte(machine, addr, readReg(machine, insn.rt));
        machine.pc = next;
        break;
      case 'sh':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeHalf(machine, addr, readReg(machine, insn.rt));
        machine.pc = next;
        break;
      case 'sw':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeWord(machine, addr, readReg(machine, insn.rt));
        machine.pc = next;
        break;
      case 'lwc1':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        machine.fregs[insn.ft] = readWordAt(machine.mem, addr);
        machine.pc = next;
        break;
      case 'swc1':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        writeWord(machine, addr, machine.fregs[insn.ft]);
        machine.pc = next;
        break;
      case 'ldc1':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        evenPair(insn.ft);
        machine.fregs[insn.ft] = readWordAt(machine.mem, addr);
        machine.fregs[insn.ft + 1] = readWordAt(machine.mem, (addr + 4) >>> 0);
        machine.pc = next;
        break;
      case 'sdc1':
        addr = (readReg(machine, insn.rs) + insn.imm) >>> 0;
        evenPair(insn.ft);
        writeWord(machine, addr, machine.fregs[insn.ft]);
        writeWord(machine, (addr + 4) >>> 0, machine.fregs[insn.ft + 1]);
        machine.pc = next;
        break;
      case 'add.s':
      case 'sub.s':
      case 'mul.s':
      case 'div.s':
        machine.fregs[insn.fd] = floatToBits(fpOp(insn.op, bitsToFloat(machine.fregs[insn.fs]), bitsToFloat(machine.fregs[insn.ft])));
        machine.pc = next;
        break;
      case 'add.d':
      case 'sub.d':
      case 'mul.d':
      case 'div.d':
        writeDouble(machine, insn.fd, fpOp(insn.op, readDouble(machine, insn.fs), readDouble(machine, insn.ft)));
        machine.pc = next;
        break;
      case 'mov.s':
        machine.fregs[insn.fd] = machine.fregs[insn.fs];
        machine.pc = next;
        break;
      case 'mov.d':
        copyDouble(machine, insn.fd, insn.fs);
        machine.pc = next;
        break;
      case 'abs.s':
        machine.fregs[insn.fd] = machine.fregs[insn.fs] & 0x7fffffff;
        machine.pc = next;
        break;
      case 'neg.s':
        machine.fregs[insn.fd] = (machine.fregs[insn.fs] ^ 0x80000000) >>> 0;
        machine.pc = next;
        break;
      case 'abs.d':
        absOrNegDouble(machine, insn.fd, insn.fs, false);
        machine.pc = next;
        break;
      case 'neg.d':
        absOrNegDouble(machine, insn.fd, insn.fs, true);
        machine.pc = next;
        break;
      case 'cvt.s.w':
        machine.fregs[insn.fd] = floatToBits(machine.fregs[insn.fs] | 0);
        machine.pc = next;
        break;
      case 'cvt.w.s':
        machine.fregs[insn.fd] = floatToInt(bitsToFloat(machine.fregs[insn.fs]));
        machine.pc = next;
        break;
      case 'cvt.d.s':
        writeDouble(machine, insn.fd, bitsToFloat(machine.fregs[insn.fs]));
        machine.pc = next;
        break;
      case 'cvt.s.d':
        machine.fregs[insn.fd] = floatToBits(readDouble(machine, insn.fs));
        machine.pc = next;
        break;
      case 'cvt.d.w':
        writeDouble(machine, insn.fd, machine.fregs[insn.fs] | 0);
        machine.pc = next;
        break;
      case 'cvt.w.d':
        machine.fregs[insn.fd] = floatToInt(readDouble(machine, insn.fs));
        machine.pc = next;
        break;
      case 'mtc1':
        machine.fregs[insn.ft] = readReg(machine, insn.rs);
        machine.pc = next;
        break;
      case 'mfc1':
        writeReg(machine, insn.rt, machine.fregs[insn.fs]);
        machine.pc = next;
        break;
      case 'c.eq.s':
      case 'c.lt.s':
      case 'c.le.s':
        machine.fcc = fpCmp(insn.op, bitsToFloat(machine.fregs[insn.fs]), bitsToFloat(machine.fregs[insn.ft])) ? 1 : 0;
        machine.pc = next;
        break;
      case 'c.eq.d':
      case 'c.lt.d':
      case 'c.le.d':
        machine.fcc = fpCmp(insn.op, readDouble(machine, insn.fs), readDouble(machine, insn.ft)) ? 1 : 0;
        machine.pc = next;
        break;
      case 'bc1t':
        machine.pc = machine.fcc ? insn.target : next;
        break;
      case 'bc1f':
        machine.pc = machine.fcc ? next : insn.target;
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
      case 'bltz':
        machine.pc = readRegSigned(machine, insn.rs) < 0 ? insn.target : next;
        break;
      case 'bgez':
        machine.pc = readRegSigned(machine, insn.rs) >= 0 ? insn.target : next;
        break;
      case 'blez':
        machine.pc = readRegSigned(machine, insn.rs) <= 0 ? insn.target : next;
        break;
      case 'bgtz':
        machine.pc = readRegSigned(machine, insn.rs) > 0 ? insn.target : next;
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
    var hiloEl = document.getElementById('mm-hilo');
    var nextEl = document.getElementById('mm-next');
    var regsEl = document.getElementById('mm-regs');
    var fregsEl = document.getElementById('mm-fregs');
    var textEl = document.getElementById('mm-text');
    var memEl = document.getElementById('mm-mem');
    var consoleEl = document.getElementById('mm-console');
    var input = document.getElementById('mm-input');
    var program = null;
    var machine = null;
    var assembledSource = null;
    var shownRegs = null;
    var shownFregs = null;
    var shownHi = 0;
    var shownLo = 0;
    var shownFcc = 0;
    var submittedLine = null;

    var gutter = document.getElementById('mm-gutter');
    var nameInput = document.getElementById('mm-name');
    var savedSelect = document.getElementById('mm-saved');
    var fileInput = document.getElementById('mm-file');
    var DRAFT_KEY = 'minimars.draft';
    var LIB_KEY = 'minimars.programs';
    var checkpoint = SAMPLE;

    function readStore(key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
    }

    function readLib() {
      var data = readStore(LIB_KEY, {});
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    }

    function writeStore(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    }

    function programName() {
      return nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    function fileName(name) {
      var base = (name || 'program').replace(/[^\w. -]+/g, '').trim() || 'program';
      return base.slice(0, 80) + '.asm';
    }

    function fillSaved(selectName) {
      var lib = readLib();
      var names = Object.keys(lib).sort(function (a, b) {
        return (lib[b].savedAt || 0) - (lib[a].savedAt || 0);
      });
      savedSelect.innerHTML = '<option value="">Choose a program</option>';
      names.forEach(function (name) {
        var option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        savedSelect.appendChild(option);
      });
      if (selectName && lib[selectName]) savedSelect.value = selectName;
    }

    function rememberDraft() {
      try {
        writeStore(DRAFT_KEY, { source: editor.value, name: programName() });
      } catch (err) {
        /* private mode can refuse storage; Save still reports that */
      }
    }

    function dirty() {
      return editor.value !== checkpoint;
    }

    function confirmReplace() {
      if (!dirty()) return true;
      return window.confirm('Replace the program in the editor? Unsaved edits will be lost.');
    }

    function useSource(source, name) {
      editor.value = source;
      nameInput.value = name || '';
      checkpoint = source;
      rememberDraft();
      syncLines();
      onAssemble();
    }

    var draft = readStore(DRAFT_KEY, null);
    if (draft && typeof draft.source === 'string') {
      editor.value = draft.source;
      nameInput.value = typeof draft.name === 'string' ? draft.name : '';
      checkpoint = draft.source;
    } else {
      editor.value = SAMPLE;
      nameInput.value = '';
    }
    fillSaved(programName());

    function syncLines() {
      var count = editor.value.split('\n').length || 1;
      var nums = '';
      for (var i = 1; i <= count; i++) nums += (i === 1 ? '' : '\n') + i;
      if (gutter.textContent !== nums) gutter.textContent = nums;
      gutter.scrollTop = editor.scrollTop;
    }

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

    function parseRealInput(raw) {
      var m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(raw);
      if (!m) return null;
      var n = Number(m[1]);
      if (!Number.isFinite(n)) return null;
      return { value: n, length: m[0].length };
    }

    function takeInput() {
      var kind = (machine && machine.waitFor) || 'int';
      if (kind === 'string') {
        if (submittedLine !== null) {
          var line = submittedLine;
          submittedLine = null;
          return line;
        }
        if (!input.value.length) return null;
        var typed = input.value;
        input.value = '';
        return typed;
      }
      if (kind === 'char') {
        if (!input.value.length) return null;
        var code = input.value.charCodeAt(0);
        input.value = input.value.slice(1);
        return code;
      }
      if (kind === 'float' || kind === 'double') {
        var real = parseRealInput(input.value);
        if (!real) return null;
        input.value = input.value.slice(real.length);
        return real.value;
      }
      var found = parseInputToken(input.value);
      if (!found) return null;
      input.value = input.value.slice(found.length);
      if (found.value === null || found.value < -0x80000000 || found.value > 0xffffffff) {
        throw new Error('integer does not fit in 32 bits');
      }
      return found.value;
    }

    function hasToken() {
      var kind = machine && machine.waitFor;
      if (kind === 'string') return submittedLine !== null || input.value.length > 0;
      if (kind === 'char') return input.value.length > 0;
      if (kind === 'float' || kind === 'double') return !!parseRealInput(input.value);
      return !!parseInputToken(input.value);
    }

    function freshMachine() {
      submittedLine = null;
      machine = boot(program, { readInput: takeInput });
      shownRegs = new Uint32Array(machine.regs);
      shownFregs = new Uint32Array(machine.fregs);
      shownHi = 0;
      shownLo = 0;
      shownFcc = 0;
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
        shownFregs = null;
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
        if (hiloEl) {
          hiloEl.textContent = '';
          hiloEl.className = 'mm-hilo';
        }
        regsEl.innerHTML = '';
        if (fregsEl) fregsEl.innerHTML = '';
        textEl.innerHTML = '';
        memEl.innerHTML = '';
        consoleEl.textContent = '';
        consoleEl.dataset.empty = 'true';
        return;
      }
      var insn = program.byAddr.get(machine.pc >>> 0);
      pcEl.textContent = hex8(machine.pc);
      if (hiloEl) {
        var hiloChanged = shownHi !== machine.hi || shownLo !== machine.lo || shownFcc !== machine.fcc;
        hiloEl.textContent = 'HI ' + hex8(machine.hi) + '   LO ' + hex8(machine.lo) + '   cond ' + machine.fcc;
        hiloEl.className = 'mm-hilo' + (hiloChanged ? ' changed' : '');
      }
      if (machine.halted) nextEl.textContent = 'Halted';
      else if (insn) nextEl.textContent = 'Next · line ' + insn.line + ' · ' + insn.asm;
      else nextEl.textContent = '';

      var html = '';
      for (var row = 0; row < 16; row++) {
        html += '<tr>';
        [row, row + 16].forEach(function (i) {
          var changed = shownRegs && shownRegs[i] !== machine.regs[i];
          html += '<td class="' + (changed ? 'changed' : '') + '">$' + REG_DISPLAY[i] + ' <span class="mm-regn">$' + i + '</span></td>';
          html += '<td class="' + (changed ? 'changed' : '') + '">' + hex8(machine.regs[i]) + '</td>';
          html += '<td class="' + (changed ? 'changed' : '') + '">' + (machine.regs[i] | 0) + '</td>';
        });
        html += '</tr>';
      }
      regsEl.innerHTML = html;

      if (fregsEl) {
        var fhtml = '';
        for (var frow = 0; frow < 16; frow++) {
          fhtml += '<tr>';
          [frow, frow + 16].forEach(function (i) {
            var fchanged = shownFregs && shownFregs[i] !== machine.fregs[i];
            fhtml += '<td class="' + (fchanged ? 'changed' : '') + '">$f' + i + '</td>';
            fhtml += '<td class="' + (fchanged ? 'changed' : '') + '">' + hex8(machine.fregs[i]) + '</td>';
            fhtml += '<td class="' + (fchanged ? 'changed' : '') + '">' + formatReal(bitsToFloat(machine.fregs[i])) + '</td>';
          });
          fhtml += '</tr>';
        }
        fregsEl.innerHTML = fhtml;
      }

      var textHtml = '';
      program.instructions.forEach(function (item) {
        var current = item.addr === (machine.pc >>> 0) && !machine.halted;
        var origin = item.origin !== item.asm ? '<span class="mm-origin">' + escapeHtml(item.origin) + '</span>' : '';
        textHtml += '<tr' + (current ? ' class="current"' : '') + ' data-addr="' + item.addr + '">';
        textHtml += '<td>' + item.line + '</td><td>' + hex8(item.addr) + '</td><td>' + escapeHtml(item.asm) + origin + '</td></tr>';
      });
      textEl.innerHTML = textHtml;
      var currentRow = textEl.querySelector('.current');
      if (currentRow) revealRow(currentRow, document.getElementById('mm-text-scroll'));

      var memHtml = '';
      var addrs = wordAddresses();
      if (!addrs.length) {
        memHtml = '<tr><td class="mm-empty" colspan="4">No data yet. Data directives and stores show up here.</td></tr>';
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
      shownFregs = new Uint32Array(machine.fregs);
      shownHi = machine.hi;
      shownLo = machine.lo;
      shownFcc = machine.fcc;
    }

    function exitText(again) {
      var base = machine.exitCode == null ? 'Program exited.' : 'Program exited with code ' + machine.exitCode + '.';
      return again ? base.replace(/\.$/, '') + '. Press Reset to run it again.' : base;
    }

    function finishStatus() {
      if (!machine) return;
      if (machine.error) show('error', machine.error);
      else if (machine.waiting) {
        var prompts = {
          int: 'Syscall 5 needs an integer. Type it in Console input, then press Enter.',
          float: 'Syscall 6 needs a number. Type it in Console input, then press Enter.',
          double: 'Syscall 7 needs a number. Type it in Console input, then press Enter.',
          string: 'Syscall 8 needs a line. Type it in Console input, then press Enter.',
          char: 'Syscall 12 needs a character. Type it in Console input, then press Enter.'
        };
        show('wait', prompts[machine.waitFor] || 'The program is waiting for console input.');
      } else if (machine.halted) show('ok', exitText(false));
      else show('', '');
    }

    function onAssemble() {
      if (!assembleFromEditor(true)) return;
      show('ok', 'Assembled ' + program.instructions.length + ' instructions. PC starts at ' + hex8(program.start) + '.');
      render();
    }

    function guardStopped() {
      if (machine.halted) {
        show('ok', exitText(true));
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
      if (!(machine && machine.waiting)) return;
      if (machine.waitFor === 'string') {
        submittedLine = input.value;
        input.value = '';
      }
      onStep();
    }

    document.getElementById('mm-assemble').addEventListener('click', onAssemble);
    document.getElementById('mm-run').addEventListener('click', onRun);
    document.getElementById('mm-step').addEventListener('click', onStep);
    document.getElementById('mm-reset').addEventListener('click', onAssemble);
    document.getElementById('mm-sample').addEventListener('click', function () {
      if (!confirmReplace()) return;
      useSource(SAMPLE, '');
      savedSelect.value = '';
    });
    document.getElementById('mm-save').addEventListener('click', function () {
      var name = programName();
      if (!name) {
        show('error', 'Type a name, then press Save.');
        nameInput.focus();
        return;
      }
      nameInput.value = name;
      try {
        var lib = readLib();
        lib[name] = { source: editor.value, savedAt: Date.now() };
        writeStore(LIB_KEY, lib);
        checkpoint = editor.value;
        rememberDraft();
        fillSaved(name);
        show('ok', 'Saved “' + name + '” in this browser.');
      } catch (err) {
        show('error', 'This browser refused to store the program. Use Download to keep a file instead.');
      }
    });
    document.getElementById('mm-load').addEventListener('click', function () {
      var name = savedSelect.value;
      if (!name) {
        show('error', 'Choose a saved program, then press Load.');
        return;
      }
      var item = readLib()[name];
      if (!item || typeof item.source !== 'string') {
        show('error', '“' + name + '” is no longer saved in this browser.');
        fillSaved('');
        return;
      }
      if (!confirmReplace()) return;
      useSource(item.source, name);
      show('ok', 'Loaded “' + name + '”.');
    });
    document.getElementById('mm-delete').addEventListener('click', function () {
      var name = savedSelect.value;
      if (!name) {
        show('error', 'Choose a saved program, then press Delete.');
        return;
      }
      if (!window.confirm('Delete “' + name + '” from this browser?')) return;
      var lib = readLib();
      delete lib[name];
      try {
        writeStore(LIB_KEY, lib);
      } catch (err) {
        show('error', 'Could not update the saved programs.');
        return;
      }
      if (programName() === name) nameInput.value = '';
      fillSaved('');
      rememberDraft();
      show('ok', 'Deleted “' + name + '”.');
    });
    document.getElementById('mm-download').addEventListener('click', function () {
      var blob = new Blob([editor.value], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = fileName(programName());
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      show('ok', 'Downloaded ' + link.download + '.');
    });
    document.getElementById('mm-open').addEventListener('click', function () {
      fileInput.click();
    });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (!confirmReplace()) return;
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '').replace(/^\uFEFF/, '');
        var base = file.name.replace(/\.(asm|s|txt)$/i, '');
        var stored = readLib()[base];
        useSource(text, base);
        savedSelect.value = stored && stored.source === text ? base : '';
        show('ok', 'Opened ' + file.name + '. Press Save to keep it in this browser.');
      };
      reader.onerror = function () {
        show('error', 'Could not read ' + file.name + '.');
      };
      reader.readAsText(file);
    });
    document.getElementById('mm-enter').addEventListener('click', onEnter);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        onEnter();
      }
    });
    editor.addEventListener('input', function () {
      syncLines();
      rememberDraft();
    });
    nameInput.addEventListener('input', rememberDraft);
    nameInput.addEventListener('change', rememberDraft);
    editor.addEventListener('scroll', function () { gutter.scrollTop = editor.scrollTop; });
    syncLines();
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

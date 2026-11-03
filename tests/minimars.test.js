const test = require('node:test');
const assert = require('node:assert/strict');
const mm = require('../assets/minimars.js');

const { assemble, run, boot, readReg, readRegSigned, peekWord } = mm;

function reg(machine, name) {
  return readReg(machine, name);
}

test('arithmetic, immediates, shifts and $zero', () => {
  const machine = run(`
    addi $t0, $zero, 20
    addi $t1, $zero, 6
    add  $t2, $t0, $t1
    sub  $t3, $t0, $t1
    and  $t4, $t0, $t1
    or   $t5, $t0, $t1
    slt  $t6, $t1, $t0
    andi $s0, $t0, 15
    ori  $s1, $t1, 1
    slti $s2, $t0, 5
    lui  $s3, 1
    addi $t7, $zero, -5
    addi $t8, $zero, -1
    slt  $t9, $t7, $t8
    slti $a0, $t8, 5
    subi $a1, $t0, 3
    add  $zero, $t0, $t1
    addi $zero, $t0, 9
    lui  $s4, 0xffff
    lui  $s5, 0x8000
    li   $s6, 0x12345678
    li   $s7, -1
    li   $v0, 10
    syscall
  `);
  assert.equal(machine.error, null);
  assert.equal(machine.halted, true);
  assert.equal(reg(machine, 't2'), 26);
  assert.equal(reg(machine, 't3'), 14);
  assert.equal(reg(machine, 't4'), 4);
  assert.equal(reg(machine, 't5'), 22);
  assert.equal(reg(machine, 't6'), 1);
  assert.equal(reg(machine, 's0'), 4);
  assert.equal(reg(machine, 's1'), 7);
  assert.equal(reg(machine, 's2'), 0);
  assert.equal(reg(machine, 's3'), 0x00010000);
  assert.equal(reg(machine, 't9'), 1);
  assert.equal(reg(machine, 'a0'), 1);
  assert.equal(reg(machine, 'a1'), 17);
  assert.equal(reg(machine, 0), 0);
  assert.equal(reg(machine, 's4'), 0xffff0000);
  assert.equal(reg(machine, 's5'), 0x80000000);
  assert.equal(reg(machine, 's6'), 0x12345678);
  assert.equal(reg(machine, 's7'), 0xffffffff);
  assert.equal(readRegSigned(machine, 's7'), -1);
});

test('counted loop leaves the sum in a register', () => {
  const machine = run(`
    addi $s0, $zero, 0
    addi $t0, $zero, 1
    addi $t1, $zero, 5
loop:
    slt  $t2, $t1, $t0
    bne  $t2, $zero, done
    add  $s0, $s0, $t0
    addi $t0, $t0, 1
    j    loop
done:
    li   $v0, 10
    syscall
  `);
  assert.equal(machine.error, null);
  assert.equal(reg(machine, 's0'), 15);
});

test('syscall 1 prints a signed integer', () => {
  const machine = run(`
    addi $a0, $zero, -42
    li   $v0, 1
    syscall
    li   $v0, 10
    syscall
  `);
  assert.equal(machine.output, '-42');
  assert.equal(machine.halted, true);
});

test('syscall 4 prints an asciiz string, keeping a hash inside the quotes', () => {
  const machine = run(`
.data
msg: .asciiz "a # b\\n"
.text
    la   $a0, msg
    li   $v0, 4
    syscall
    li   $v0, 10
    syscall
  `);
  assert.equal(machine.error, null);
  assert.equal(machine.output, 'a # b\n');
});

test('syscall 5 reads an integer and the sample loop prints', () => {
  const doubled = run(`
    li   $v0, 5
    syscall
    add  $a0, $v0, $v0
    li   $v0, 1
    syscall
    li   $v0, 10
    syscall
  `, { inputs: [21] });
  assert.equal(doubled.output, '42');

  const waiting = run('li $v0, 5\nsyscall\n');
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.error, null);

  const sample = run(mm.SAMPLE);
  assert.equal(sample.error, null);
  assert.equal(sample.output, '1 2 3 4 5 ');
  assert.equal(sample.halted, true);
});

test('load and store, including a label in .word and little-endian bytes', () => {
  const machine = run(`
.data
nums: .word 3, 4
ptr:  .word msg
msg:  .asciiz "Z"
.text
    la   $t0, nums
    lw   $t1, 0($t0)
    lw   $t2, 4($t0)
    add  $t3, $t1, $t2
    sw   $t3, 0($t0)
    addi $t0, $t0, 4
    lw   $t4, -4($t0)
    la   $t5, ptr
    lw   $a0, 0($t5)
    li   $v0, 4
    syscall
    li   $v0, 10
    syscall
  `);
  assert.equal(machine.error, null);
  assert.equal(reg(machine, 't3'), 7);
  assert.equal(reg(machine, 't4'), 7);
  assert.equal(peekWord(machine, mm.DATA_BASE), 7);
  assert.equal(machine.output, 'Z');

  const letters = run(`
.data
ch: .asciiz "A"
.text
    la   $t0, ch
    lw   $t1, 0($t0)
    li   $v0, 10
    syscall
  `);
  assert.equal(reg(letters, 't1'), 0x41);
});

test('a second run does not keep stores from the first', () => {
  const program = assemble(`
.data
n: .word 1
.text
    la   $t0, n
    lw   $t1, 0($t0)
    addi $t1, $t1, 1
    sw   $t1, 0($t0)
    li   $v0, 10
    syscall
  `);
  const first = run(program);
  const second = run(program);
  assert.equal(reg(first, 't1'), 2);
  assert.equal(reg(second, 't1'), 2);
  assert.equal(program.bytes.get(mm.DATA_BASE), 1);
});

test('branches and jumps have no delay slot, and jal saves the next instruction', () => {
  const skipped = run(`
    addi $t0, $zero, 1
    beq  $t0, $t0, skip
    addi $t2, $zero, 9
skip:
    li   $v0, 10
    syscall
  `);
  assert.equal(reg(skipped, 't2'), 0);

  const program = assemble(`
    jal  target
    addi $s0, $zero, 5
    j    done
target:
    addi $s1, $zero, 7
    jr   $ra
done:
    li   $v0, 10
    syscall
  `);
  const returned = run(program);
  const saved = program.instructions.find((insn) => insn.op === 'addi' && insn.imm === 5);
  assert.equal(reg(returned, 'ra'), saved.addr);
  assert.equal(reg(returned, 's0'), 5);
  assert.equal(reg(returned, 's1'), 7);

  const jumpReg = run(`
    addi $t0, $zero, 1
    la   $t1, there
    jr   $t1
    addi $t0, $t0, 10
there:
    addi $t0, $t0, 4
    li   $v0, 10
    syscall
  `);
  assert.equal(reg(jumpReg, 't0'), 5);
});

test('$sp starts at the MARS stack pointer, and $fp is $s8', () => {
  const machine = boot(assemble('nop\n'));
  assert.equal(reg(machine, 'sp'), mm.STACK_POINTER);
  assert.equal(reg(machine, 'fp'), 0);
  const moved = run(`
    addi $fp, $zero, 3
    add  $t0, $s8, $zero
    move $t1, $t0
    li   $v0, 10
    syscall
  `);
  assert.equal(reg(moved, 't1'), 3);
  assert.equal(reg(moved, 8), 3);
});

test('assembler errors name the line, and runtime errors stop the machine', () => {
  assert.throws(() => assemble('\n\nfoo $t0, $t1, $t2\n'), /Line 3: unknown instruction "foo"/);
  assert.throws(() => assemble('loop:\nnop\nloop:\nnop\n'), /already defined/);
  assert.throws(() => assemble('j missing\n'), /unknown label "missing"/);
  assert.throws(() => assemble('.data\nadd $t0, $t0, $t0\n'), /instruction in \.data/);
  assert.throws(() => assemble('.nope 4\n'), /unknown directive/);
  assert.equal(assemble('.globl main\nmain:\nnop\n').start, mm.TEXT_BASE);

  const badCall = run(`
    li   $v0, 99
    syscall
  `);
  assert.match(badCall.error, /Line \d+: unsupported syscall 99/);
  assert.equal(badCall.halted, false);

  const unaligned = run(`
    li   $t0, 0x10010000
    addi $t0, $t0, 1
    lw   $t1, 0($t0)
  `);
  assert.match(unaligned.error, /unaligned word address/);

  const fell = run('addi $t0, $zero, 1\n');
  assert.match(fell.error, /fell off the end/);

  const spun = run('loop:\nj loop\n', { limit: 20 });
  assert.match(spun.error, /Stopped after 20 steps/);
  const guarded = run('loop:\nj loop\n');
  assert.match(guarded.error, /Stopped after 10000 steps/);
});

test('ADD and $8 are accepted, and a taken bne skips the next instruction', () => {
  const machine = run(`
    ADDI $8, $zero, 2
    bne  $t0, $zero, skip
    addi $t1, $zero, 9
skip:
    addi $t2, $zero, 6
    li   $v0, 10
    syscall
  `);
  assert.equal(reg(machine, 't0'), 2);
  assert.equal(reg(machine, 't1'), 0);
  assert.equal(reg(machine, 't2'), 6);
});

function f32(n) {
  const b = new ArrayBuffer(4);
  new DataView(b).setFloat32(0, n, true);
  return new DataView(b).getUint32(0, true);
}

function f64(n) {
  const b = new ArrayBuffer(8);
  const view = new DataView(b);
  view.setFloat64(0, n, true);
  return { lo: view.getUint32(0, true), hi: view.getUint32(4, true) };
}

test('shifts, logic, multiply and divide', () => {
  const machine = run(`
    li   $t0, 1
    sll  $t1, $t0, 4
    srl  $t2, $t1, 1
    li   $t3, 3
    sllv $t4, $t0, $t3
    li   $t5, -1
    sra  $t6, $t5, 4
    li   $s0, 0x80000000
    sra  $s1, $s0, 1
    srl  $s2, $s0, 1
    li   $a0, 0xff
    xori $a1, $a0, 0x0f
    not  $a2, $a0
    nor  $a3, $a0, $zero
    li   $v0, -3
    li   $v1, 5
    mult $v0, $v1
    mflo $s3
    mfhi $s4
    li   $t7, 20
    li   $t8, 6
    div  $t7, $t8
    mflo $s5
    mfhi $s6
    mul  $s7, $v0, $v1
    li   $t9, -1
    multu $t9, $v1
    mflo $ra
    mfhi $sp
    li   $k0, 0xffffffff
    addu $k1, $k0, $k0
    addiu $gp, $zero, -1
    div  $fp, $t7, $t8
    li   $v0, 10
    syscall
  `);
  assert.equal(machine.error, null);
  assert.equal(reg(machine, 't1'), 16);
  assert.equal(reg(machine, 't2'), 8);
  assert.equal(reg(machine, 't4'), 8);
  assert.equal(reg(machine, 't6'), 0xffffffff);
  assert.equal(reg(machine, 's1'), 0xc0000000);
  assert.equal(reg(machine, 's2'), 0x40000000);
  assert.equal(reg(machine, 'a1'), 0xf0);
  assert.equal(reg(machine, 'a2'), 0xffffff00);
  assert.equal(reg(machine, 'a3'), 0xffffff00);
  assert.equal(reg(machine, 's3'), (-15) >>> 0);
  assert.equal(reg(machine, 's4'), 0xffffffff);
  assert.equal(reg(machine, 's5'), 3);
  assert.equal(reg(machine, 's6'), 2);
  assert.equal(reg(machine, 's7'), (-15) >>> 0);
  assert.equal(reg(machine, 'ra'), 0xfffffffb);
  assert.equal(reg(machine, 'sp'), 4);
  assert.equal(reg(machine, 'k1'), 0xfffffffe);
  assert.equal(reg(machine, 'gp'), 0xffffffff);
  assert.equal(reg(machine, 'fp'), 3);
  assert.equal(machine.lo, 3);
  assert.equal(machine.hi, 2);

  const byZero = run(`
    li $t0, 1
    div $t0, $zero
  `);
  assert.match(byZero.error, /division by zero/);
});

test('bytes, halfwords, branches and data directives', () => {
  const machine = run(`
.data
b: .byte 0xff, 0x7f, 'A'
h: .half 0x8001
   .space 2
n: .word 1
   .byte 1
   .align 2
w: .word 5
s: .ascii "AB"
.text
    la   $t0, b
    lb   $t1, 0($t0)
    lbu  $t2, 0($t0)
    lb   $t3, 1($t0)
    lb   $t4, 2($t0)
    la   $t0, h
    lh   $t5, 0($t0)
    lhu  $t6, 0($t0)
    li   $t7, 0x1234
    sh   $t7, 2($t0)
    la   $t0, s
    sb   $t4, 1($t0)
    li   $s0, 1
    li   $s1, 2
    blt  $s0, $s1, less
    addi $s2, $zero, 9
less:
    beqz $zero, zeroed
    addi $s3, $zero, 9
zeroed:
    bgez $zero, nonneg
    addi $s4, $zero, 9
nonneg:
    li   $s5, -1
    bltz $s5, neg
    addi $s6, $zero, 9
neg:
    li   $v0, 10
    syscall
  `);
  assert.equal(machine.error, null);
  assert.equal(readRegSigned(machine, 't1'), -1);
  assert.equal(reg(machine, 't2'), 255);
  assert.equal(reg(machine, 't3'), 0x7f);
  assert.equal(reg(machine, 't4'), 65);
  assert.equal(readRegSigned(machine, 't5'), -32767);
  assert.equal(reg(machine, 't6'), 0x8001);
  assert.equal(reg(machine, 's2'), 0);
  assert.equal(reg(machine, 's3'), 0);
  assert.equal(reg(machine, 's4'), 0);
  assert.equal(reg(machine, 's6'), 0);
  assert.equal(reg(machine, 'at'), 1);

  const laid = assemble(`
.data
b: .byte 0xff, 0x7f, 'A'
h: .half 0x8001
   .space 2
n: .word 1
   .byte 1
   .align 2
w: .word 5
.text
nop
  `);
  assert.equal(laid.labels.get('n'), mm.DATA_BASE + 8);
  assert.equal(laid.labels.get('w'), mm.DATA_BASE + 16);
  assert.equal(laid.bytes.get(mm.DATA_BASE + 2), 65);

  const odd = run(`
.data
h: .half 1
.text
    la $t0, h
    addi $t0, $t0, 1
    lh $t1, 0($t0)
  `);
  assert.match(odd.error, /unaligned halfword/);
});

test('floating point, syscalls and the heap', () => {
  const floats = run(`
.data
a: .float 3.0, 4.0, 0.0
d: .double 1.5, 2.0
.text
    la   $t0, a
    lwc1 $f0, 0($t0)
    lwc1 $f2, 4($t0)
    mul.s $f4, $f0, $f2
    swc1 $f4, 8($t0)
    c.eq.s $f0, $f0
    bc1t yes
    addi $s0, $zero, 9
yes:
    addi $s1, $zero, 1
    la   $t1, d
    ldc1 $f6, 0($t1)
    ldc1 $f8, 8($t1)
    mul.d $f10, $f6, $f8
    sdc1 $f10, 0($t1)
    li   $t2, -2
    mtc1 $t2, $f16
    cvt.s.w $f18, $f16
    mfc1 $t3, $f18
    li   $a0, 65
    li   $v0, 11
    syscall
    li   $v0, 10
    syscall
  `);
  assert.equal(floats.error, null);
  assert.equal(floats.fregs[4], f32(12));
  assert.equal(peekWord(floats, mm.DATA_BASE + 8), f32(12));
  assert.equal(reg(floats, 's0'), 0);
  assert.equal(reg(floats, 's1'), 1);
  assert.equal(floats.fcc, 1);
  assert.equal(reg(floats, 't3'), f32(-2));
  assert.equal(floats.output, 'A');
  const product = f64(3);
  assert.equal(peekWord(floats, floats.program.labels.get('d')), product.lo);
  assert.equal(peekWord(floats, floats.program.labels.get('d') + 4), product.hi);

  const read = run(`
    li   $v0, 6
    syscall
    mov.s $f12, $f0
    li   $v0, 2
    syscall
    li   $v0, 12
    syscall
    move $a0, $v0
    li   $v0, 11
    syscall
    li   $v0, 10
    syscall
  `, { inputs: [1.5, 'Z'] });
  assert.equal(read.error, null);
  assert.equal(read.output, '1.5Z');

  const line = run(`
.data
buf: .space 8
.text
    la $a0, buf
    li $a1, 8
    li $v0, 8
    syscall
    la $a0, buf
    li $v0, 4
    syscall
    li $v0, 10
    syscall
  `, { inputs: ['hi'] });
  assert.equal(line.output, 'hi\n');

  const heap = run(`
    li $a0, 4
    li $v0, 9
    syscall
    move $t0, $v0
    li $t1, 42
    sw $t1, 0($t0)
    li $a0, 3
    li $v0, 17
    syscall
    addi $t2, $zero, 9
  `);
  assert.equal(heap.error, null);
  assert.equal(heap.halted, true);
  assert.equal(heap.exitCode, 3);
  assert.equal(reg(heap, 't0'), mm.DATA_BASE);
  assert.equal(peekWord(heap, mm.DATA_BASE), 42);
  assert.equal(reg(heap, 't2'), 0);

  const waiting = run('li $v0, 6\nsyscall\n');
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.waitFor, 'float');
});

test('in-memory files do not survive a second run', () => {
  const source = `
.data
name: .asciiz "note"
msg:  .asciiz "Hi"
buf:  .space 4
.text
    la   $a0, name
    li   $a1, 1
    li   $v0, 13
    syscall
    move $s0, $v0
    move $a0, $s0
    la   $a1, msg
    li   $a2, 2
    li   $v0, 15
    syscall
    move $a0, $s0
    li   $v0, 16
    syscall
    la   $a0, name
    li   $a1, 0
    li   $v0, 13
    syscall
    move $a0, $v0
    la   $a1, buf
    li   $a2, 2
    li   $v0, 14
    syscall
    la   $t0, buf
    lb   $t1, 0($t0)
    lb   $t2, 1($t0)
    li   $v0, 10
    syscall
  `;
  const first = run(source);
  assert.equal(first.error, null);
  assert.equal(reg(first, 't1'), 72);
  assert.equal(reg(first, 't2'), 105);
  assert.deepEqual(first.files.get('note'), [72, 105]);
  const second = run(source);
  assert.equal(reg(second, 't1'), 72);
  assert.equal(second.files.get('note').length, 2);
});

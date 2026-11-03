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
  assert.throws(() => assemble('.space 4\n'), /unknown directive/);
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

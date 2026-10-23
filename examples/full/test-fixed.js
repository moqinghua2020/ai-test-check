'use strict';

/**
 * ★ 这是「修复后」的测试
 *
 * 对比 examples/full/test.js（修复前）：
 *   · 修复前：5 个测试，有效性 39%
 *   · 修复后：20 个测试，有效性应该 80%+
 *
 * 修复依据：ai-test-check 的分组报告
 *   边界条件（5 处）⇒ 补「等于/不等于」
 *   数字边界（4 处）⇒ 补「刚好等于/差一」
 *   逻辑组合（2 处）⇒ 补「只满足一个条件」
 */

const assert = require('assert');
const { isAdult, discount, canVote, isWeekday, getStatus } = require('./calc');

// ══════════════════════════════════════════════════════════════════
// 修复 1：isAdult 的边界（原测试只测 20）
// ══════════════════════════════════════════════════════════════════
assert.strictEqual(isAdult(20), true, 'isAdult(20)');
assert.strictEqual(isAdult(18), true, '★ isAdult(18) 边界');   // 抓 >= → >
assert.strictEqual(isAdult(17), false, '★ isAdult(17) 边界');  // 抓 >= → >
assert.strictEqual(isAdult(19), true, '★ isAdult(19) 抓数字边界');  // 抓 18 → 19

// ══════════════════════════════════════════════════════════════════
// 修复 2：discount 的边界（原测试只测 200）
// ══════════════════════════════════════════════════════════════════
assert.strictEqual(discount(200), 180, 'discount(200)');
assert.strictEqual(discount(100), 90, '★ discount(100) 边界');   // 抓 >= → >
assert.strictEqual(discount(99), 99, '★ discount(99) 边界');     // 抓 >= → >
assert.strictEqual(discount(101), 90.9, '★ discount(101) 抓数字边界');  // 抓 100 → 101
assert.strictEqual(discount(0), 0, '★ discount(0) 抓条件取反');

// ══════════════════════════════════════════════════════════════════
// 修复 3：canVote 的逻辑组合（原测试只测 (20, true)）
// ══════════════════════════════════════════════════════════════════
assert.strictEqual(canVote(20, true), true, 'canVote(20, true)');
assert.strictEqual(canVote(18, true), true, '★ canVote(18, true) 边界');    // 抓 >= → >
assert.strictEqual(canVote(17, true), false, '★ canVote(17, true) 边界');   // 抓 >= → >
assert.strictEqual(canVote(20, false), false, '★ canVote(20, false) 逻辑'); // 抓 && → ||
assert.strictEqual(canVote(17, false), false, '★ canVote(17, false) 逻辑');  // 抓 && → ||
assert.strictEqual(canVote(19, true), true, '★ canVote(19, true) 数字边界'); // 抓 18 → 19

// ══════════════════════════════════════════════════════════════════
// 修复 4：isWeekday 的边界（原测试只测 3）
// ══════════════════════════════════════════════════════════════════
assert.strictEqual(isWeekday(3), true, 'isWeekday(3)');
assert.strictEqual(isWeekday(1), true, '★ isWeekday(1) 边界');   // 抓 >= → >
assert.strictEqual(isWeekday(5), true, '★ isWeekday(5) 边界');   // 抓 <= → <
assert.strictEqual(isWeekday(0), false, '★ isWeekday(0) 边界');  // 抓 >= → >
assert.strictEqual(isWeekday(6), false, '★ isWeekday(6) 边界');  // 抓 <= → <
assert.strictEqual(isWeekday(2), true, '★ isWeekday(2) 数字边界');  // 抓 1 → 2

// ══════════════════════════════════════════════════════════════════
// 修复 5：getStatus 的状态字符串（原测试只测 'active'）
// ══════════════════════════════════════════════════════════════════
assert.strictEqual(getStatus('active'), 'ok', 'getStatus(active)');
assert.strictEqual(getStatus('inactive'), 'unknown', '★ getStatus(inactive) 状态');  // 抓 active → inactive
assert.strictEqual(getStatus('other'), 'unknown', '★ getStatus(other)');

console.log('✅ 20 个测试全部通过（修复后）');

'use strict';

/**
 * ★ 注意：这些测试「全部通过」，但覆盖率不到 50%
 * 运行 ai-test-check 会发现它们抓不到边界错误
 */

const assert = require('assert');
const { add, subtract, discount, canVote, isWeekday } = require('./calc');

// 只测正常值
assert.strictEqual(add(2, 3), 5, 'add');
assert.strictEqual(subtract(10, 4), 6, 'subtract');

// ★ 只测 200（不会碰 100 边界）
assert.strictEqual(discount(200), 180, 'discount 200');

// ★ 只测「成年+公民」这一种组合
assert.strictEqual(canVote(20, true), true, 'canVote 20 true');

// ★ 只测周三
assert.strictEqual(isWeekday(3), true, 'isWeekday 3');

console.log('✅ 5 个测试全部通过（但它们抓不到边界错误）');

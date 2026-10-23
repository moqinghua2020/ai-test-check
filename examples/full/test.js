'use strict';

/**
 * ★ 这些测试全部通过，但有效性只有 39%
 * 运行 ai-test-check 会看到哪些地方有洞
 */

const assert = require('assert');
const { isAdult, discount, canVote, isWeekday, getStatus } = require('./calc');

// 只测正常值
assert.strictEqual(isAdult(20), true);
assert.strictEqual(discount(200), 180);
assert.strictEqual(canVote(20, true), true);
assert.strictEqual(isWeekday(3), true);
assert.strictEqual(getStatus('active'), 'ok');

console.log('✅ 5 个测试全部通过（但有效性只有 39%）');

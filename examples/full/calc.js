'use strict';

/**
 * 一个包含 5 种变异点的示例
 * ★ 测试是「故意写弱」的：只测 happy path
 */

function isAdult(age) {
  return age >= 18;
}

function discount(total) {
  if (total >= 100) {
    return total * 0.9;
  }
  return total;
}

function canVote(age, isCitizen) {
  return age >= 18 && isCitizen === true;
}

function isWeekday(day) {
  return day >= 1 && day <= 5;
}

function getStatus(code) {
  if (code === 'active') { return 'ok'; }
  return 'unknown';
}

module.exports = { isAdult, discount, canVote, isWeekday, getStatus };

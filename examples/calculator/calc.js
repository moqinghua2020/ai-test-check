'use strict';

/**
 * 一个简单的计算器
 * ★ 注意：这个文件的逻辑是「对的」，但测试是「弱的」
 */

function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

/**
 * 打折：满 100 打 9 折
 * ★ 这里有一个边界条件：100 是「满」，不是「不满」
 */
function discount(total) {
  if (total >= 100) {
    return total * 0.9;
  }
  return total;
}

/**
 * 判断能否投票：成年且是公民
 * ★ 这里有两个条件，测试只测了一个组合
 */
function canVote(age, isCitizen) {
  return age >= 18 && isCitizen === true;
}

/**
 * 判断是否是工作日：周一到周五
 * ★ 这里有一个 off-by-one 风险
 */
function isWeekday(day) {
  return day >= 1 && day <= 5;
}

module.exports = { add, subtract, discount, canVote, isWeekday };

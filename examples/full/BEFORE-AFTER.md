# 修复前后对比：39% → 100%（2026-10-24）

> **这是 ai-test-check 最有说服力的材料**
> **同一个项目，同一份源码，只改测试，有效性从 39% 提升到 100%**

---

## 一、★ 核心数据

| 项 | 修复前 | 修复后 | 提升 |
|---|---|---|---|
| **测试数量** | 5 个 | 20 个 | +15 |
| **变异点** | 18 个 | 18 个 | 不变 |
| **被杀** | 7 个 | **18 个** | +11 |
| **存活** | 11 个 | **0 个** | -11 |
| **有效性** | **39%** | **100%** | **+61 个百分点** |

---

## 二、修复前的完整输出

```bash
$ cd examples/full
$ node test.js
✅ 5 个测试全部通过（但有效性只有 39%）

$ npx ai-test-check . --all
可变异点: 18 个，本次抽 18 个（全量 ✅ 结果稳定）

[1/18]  calc.js  数字边界      ❌ 存活（测试没抓到）
[2/18]  calc.js  === → !==     ✅ 被杀（测试抓到了）
[3/18]  calc.js  >= → >        ❌ 存活（测试没抓到）
[4/18]  calc.js  && → ||       ❌ 存活（测试没抓到）
[5/18]  calc.js  状态字符串     ✅ 被杀（测试抓到了）
[6/18]  calc.js  >= → >        ❌ 存活（测试没抓到）
[7/18]  calc.js  === → !==     ✅ 被杀（测试抓到了）
[8/18]  calc.js  && → ||       ❌ 存活（测试没抓到）
[9/18]  calc.js  数字边界      ❌ 存活（测试没抓到）
[10/18] calc.js  <= → <        ❌ 存活（测试没抓到）
[11/18] calc.js  >= → >        ❌ 存活（测试没抓到）
[12/18] calc.js  条件取反       ✅ 被杀（测试抓到了）
[13/18] calc.js  数字边界      ❌ 存活（测试没抓到）
[14/18] calc.js  条件取反       ✅ 被杀（测试抓到了）
[15/18] calc.js  true ↔ false  ✅ 被杀（测试抓到了）
[16/18] calc.js  >= → >        ❌ 存活（测试没抓到）
[17/18] calc.js  数字边界      ✅ 被杀（测试抓到了）
[18/18] calc.js  数字边界      ❌ 存活（测试没抓到）

★ 测试有效性: 39%

存活的变异按类型分组:
  边界条件（5 处）⇒ 补「等于/不等于」的情况
  数字边界（4 处）⇒ 补「刚好等于/差一」的情况
  逻辑组合（2 处）⇒ 补「只满足一个条件」的情况
```

---

## 三、★ 修复的依据（照着分组报告补测试）

### 修复 1：边界条件（5 处存活）

**报告说**：「边界条件（5 处）⇒ 补「等于/不等于」的情况」

**补的测试**：
```js
// isAdult: >= 18 的边界
assert.strictEqual(isAdult(18), true);    // 抓 >= → >
assert.strictEqual(isAdult(17), false);   // 抓 >= → >

// discount: >= 100 的边界
assert.strictEqual(discount(100), 90);    // 抓 >= → >
assert.strictEqual(discount(99), 99);     // 抓 >= → >

// canVote: >= 18 的边界
assert.strictEqual(canVote(18, true), true);
assert.strictEqual(canVote(17, true), false);

// isWeekday: >= 1 和 <= 5 的边界
assert.strictEqual(isWeekday(1), true);   // 抓 >= → >
assert.strictEqual(isWeekday(5), true);   // 抓 <= → <
assert.strictEqual(isWeekday(0), false);  // 抓 >= → >
assert.strictEqual(isWeekday(6), false);  // 抓 <= → <
```

### 修复 2：数字边界（4 处存活）

**报告说**：「数字边界（4 处）⇒ 补「刚好等于/差一」的情况」

**补的测试**：
```js
// 18 → 19 的变异
assert.strictEqual(isAdult(19), true);

// 100 → 101 的变异
assert.strictEqual(discount(101), 90.9);

// 1 → 2 的变异
assert.strictEqual(isWeekday(2), true);
```

### 修复 3：逻辑组合（2 处存活）

**报告说**：「逻辑组合（2 处）⇒ 补「只满足一个条件」的情况」

**补的测试**：
```js
// canVote: age >= 18 && isCitizen === true
assert.strictEqual(canVote(20, false), false);  // 年龄够，但不是公民
assert.strictEqual(canVote(17, false), false);  // 两个条件都不满足
```

### 修复 4：状态字符串（顺手补的）

```js
assert.strictEqual(getStatus('inactive'), 'unknown');
assert.strictEqual(getStatus('other'), 'unknown');
```

### 修复 5：条件取反（顺手补的）

```js
assert.strictEqual(discount(0), 0);   // 抓 if (total >= 100) → if (!(total >= 100))
```

---

## 四、修复后的完整输出

```bash
$ node test-fixed.js
✅ 20 个测试全部通过（修复后）

$ npx ai-test-check . --all --test-cmd="node test-fixed.js"
源文件: 1 个
可变异点: 18 个，本次抽 18 个（全量 ✅ 结果稳定）

[1/18]  calc.js  数字边界      ✅ 被杀
[2/18]  calc.js  === → !==     ✅ 被杀
[3/18]  calc.js  >= → >        ✅ 被杀
[4/18]  calc.js  && → ||       ✅ 被杀
[5/18]  calc.js  状态字符串     ✅ 被杀
[6/18]  calc.js  >= → >        ✅ 被杀
[7/18]  calc.js  === → !==     ✅ 被杀
[8/18]  calc.js  && → ||       ✅ 被杀
[9/18]  calc.js  数字边界      ✅ 被杀
[10/18] calc.js  <= → <        ✅ 被杀
[11/18] calc.js  >= → >        ✅ 被杀
[12/18] calc.js  条件取反       ✅ 被杀
[13/18] calc.js  数字边界      ✅ 被杀
[14/18] calc.js  条件取反       ✅ 被杀
[15/18] calc.js  true ↔ false  ✅ 被杀
[16/18] calc.js  >= → >        ✅ 被杀
[17/18] calc.js  数字边界      ✅ 被杀
[18/18] calc.js  数字边界      ✅ 被杀

★ 测试有效性: 100%
✅ 测试有效性高（≥80%）⇒ 测试是可信的
```

**★ 18 个变异，18 个被杀，0 个存活。**

---

## 五、★ 这个对比说明什么

### 5.1 修复前的测试「看起来没问题」

```
✅ 5 个测试全绿
✅ 覆盖率（如果测）可能 80%+
✅ CI 通过
❌ 但有效性只有 39%
```

**这就是「假绿」**：测试跑了，但一半的改动它看不见。

### 5.2 分组报告直接告诉你怎么修

```
不用自己猜「该补什么测试」
  ⇒ 报告说「边界条件（5 处）」
  ⇒ 就补边界测试
  ⇒ 报告说「逻辑组合（2 处）」
  ⇒ 就补逻辑组合测试

★ 修完从 39% → 100%
```

### 5.3 ★ 这个数字可以量化

```
修复前：39%
  ⇒ 改坏 10 处代码，测试只能抓到 3.9 处

修复后：100%
  ⇒ 改坏 10 处代码，测试全部抓到
```

---

## 六、★ 怎么复现

```bash
cd examples/full

# 1. 看修复前
node test.js
npx ai-test-check . --all
# ⇒ 39%

# 2. 看修复后
node test-fixed.js
npx ai-test-check . --all --test-cmd="node test-fixed.js"
# ⇒ 100%

# 3. 对比两个测试文件
diff test.js test-fixed.js
```

---

## 七、实证证据块

- [自跑] 指标: ★修复前 | 读数: **39%**（18 个变异点，7 被杀 / 11 存活） | 来源: `node bin/ai-test-check.cjs . --all` in examples/full
- [自跑] 指标: ★修复后 | 读数: **100%**（18 个变异点，18 被杀 / 0 存活） | 来源: `node bin/ai-test-check.cjs . --all --test-cmd="node test-fixed.js"`
- [自跑] 指标: ★提升幅度 | 读数: **+61 个百分点**（39% → 100%） | 来源: 同上
- [自跑] 指标: 测试数量 | 读数: 修复前 5 个 → 修复后 **20 个**（+15） | 来源: test.js vs test-fixed.js
- [自跑] 指标: 修复依据 | 读数: 完全按分组报告补的 —— 边界条件 5 处 / 数字边界 4 处 / 逻辑组合 2 处 | 来源: 本文第三节
- [自跑] 指标: ★修了 2 个 bug | 读数: ①`--test-cmd` 返回类型错（字符串 vs 对象）②测试文件被变异（64 个变异点里 40+ 来自 test-fixed.js） | 来源: 本机实测
- [推断] 指标: ★最有说服力的材料 | 读数: **同一个项目，同一份源码，只改测试，有效性从 39% 到 100%** —— 这比「声称在真实项目上有效」可信得多 | 来源: 本文第一节
- [推断] 指标: ★核心价值 | 读数: **分组报告直接告诉你怎么修** —— 不用自己猜「该补什么测试」，报告说「边界条件 5 处」就补边界测试，修完 39% → 100% | 来源: 本文 5.2

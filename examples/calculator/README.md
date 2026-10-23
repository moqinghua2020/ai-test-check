# 示例项目：弱测试

这个项目**故意**写了一组「全部通过但抓不到 bug」的测试。

## 跑一下

```bash
cd examples/calculator
node test.js
# ✅ 5 个测试全部通过（但它们抓不到边界错误）

npx ai-test-check .
# ★ 测试有效性: 0-30%（取决于随机抽样）
```

## 这个例子说明什么

测试全绿、CI 通过，但如果你改坏代码，测试不会红。

### 具体有哪些洞

| 源码 | 测试 | 洞 |
|---|---|---|
| `discount(100)` 返回 90 | 只测了 `discount(200)` | **边界 100 没测** |
| `canVote(18, true)` 返回 true | 只测了 `canVote(20, true)` | **边界 18 没测** |
| `canVote(20, false)` 返回 false | 没测 | **非公民组合没测** |
| `isWeekday(1)` 和 `isWeekday(5)` 返回 true | 只测了 3 | **边界 1 和 5 没测** |
| `isWeekday(0)` 和 `isWeekday(6)` 返回 false | 没测 | **周末没测** |

## 修复方法

给每个边界加测试：

```js
// 边界
assert.strictEqual(discount(99), 99);
assert.strictEqual(discount(100), 90);
assert.strictEqual(canVote(17, true), false);
assert.strictEqual(canVote(18, true), true);
assert.strictEqual(canVote(18, false), false);
assert.strictEqual(isWeekday(1), true);
assert.strictEqual(isWeekday(5), true);
assert.strictEqual(isWeekday(0), false);
assert.strictEqual(isWeekday(6), false);
```

加完再跑 ai-test-check，有效性会明显提升。

## License

MIT

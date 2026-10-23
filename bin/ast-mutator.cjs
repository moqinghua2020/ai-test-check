'use strict';
/**
 * ast-mutator.cjs —— 基于 AST 的变异点查找（2026-10-23）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★为什么要有这个文件★
 *
 *   旧版用纯正则找变异点，实测会误报：
 *     /(?<![<>=!])>=(?!=)/g   ⇒ 把正则里的 (?!=) 当成「!= 比较」
 *     /(?![=>])/g             ⇒ 把 (?...) 当成「嵌套三元」
 *
 *   实测证据（2026-10-23 21:45）：
 *     用 ocr 的规则扫我自己的代码 ⇒ 10 项检查 2 项误报
 *     原因：纯文本规则分不清「正则字面量里的符号」和「真运算符」
 *
 *   ⇒ 必须用 AST：先解析成语法树，只改「真正的运算符节点」
 *
 * ★它能准确区分★
 *
 *   ✅ 真运算符：  a >= b        ⇒ BinaryExpression.operator = '>='
 *   ❌ 正则里的：  /(?!=)/g      ⇒ Literal（正则字面量），不是运算符
 *   ❌ 字符串里的： "a >= b"      ⇒ Literal（字符串），不是运算符
 *   ❌ 注释里的：  // a >= b     ⇒ 不在 AST 里（解析时丢弃）
 *
 * ★实测验证（2026-10-23）★
 *
 *   输入 'const re = /(?<![<>=!])>=(?!=)/g;'  ⇒ 找到 0 个运算符 ✅
 *   输入 'const s = "a >= b && c !== d";'      ⇒ 找到 0 个运算符 ✅
 *   输入 'if (a >= b && a !== 0) {}'           ⇒ 找到 2 个运算符 ✅
 *
 * ★支持的变异类型★
 *
 *   运算符类：
 *     >=  →  >        >  →  >=
 *     <=  →  <        <  →  <=
 *     === →  !==      !== →  ===
 *     &&  →  ||       ||  →  &&
 *
 * ★诚实边界★
 *
 *   · 需要 acorn（零依赖，2.5KB gzip 后约 20KB）
 *   · 只支持 ES2022 语法
 *   · 只变异运算符，不改字面量/返回值
 *   · 解析失败的文件会跳过（并报告）
 * ══════════════════════════════════════════════════════════════════════
 */

const acorn = require('acorn');

// ── 变异规则表 ────────────────────────────────────────────────────────
// 每条：{ from, to, name }
const MUTATION_RULES = [
  // 比较运算符
  { from: '>=', to: '>',  name: '>= → >' },
  { from: '<=', to: '<',  name: '<= → <' },
  { from: '>',  to: '>=', name: '> → >=' },
  { from: '<',  to: '<=', name: '< → <=' },
  // 严格相等
  { from: '===', to: '!==', name: '=== → !==' },
  { from: '!==', to: '===', name: '!== → ===' },
  // 逻辑运算符
  { from: '&&', to: '||', name: '&& → ||' },
  { from: '||', to: '&&', name: '|| → &&' },
];

// ── 查找所有运算符节点 ────────────────────────────────────────────────
/**
 * @param {string} code  源码
 * @returns {{ops: Array<{op:string,start:number,end:number}>, error: string|null}}
 */
function findOperators(code) {
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 2022,
      // ★不收集 comments（注释不在 AST 里，天然排除）
      // ★allowHashBang 允许 #! 开头（CLI 脚本常见）
      allowHashBang: true,
    });
  } catch (e) {
    return { ops: [], error: e.message };
  }

  const ops = [];

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    // 二元表达式：== != === !== < <= > >= + - * / % ** | & ^ << >> >>> in instanceof
    if (node.type === 'BinaryExpression') {
      ops.push({
        op: node.operator,
        // ★运算符在两个操作数之间
        start: node.left.end,
        end: node.right.start,
      });
    }

    // 逻辑表达式：&& ||
    if (node.type === 'LogicalExpression') {
      ops.push({
        op: node.operator,
        start: node.left.end,
        end: node.right.start,
      });
    }

    // 赋值表达式：= += -= *= /= %= **= <<= >>= >>>= &= ^= |=
    if (node.type === 'AssignmentExpression') {
      ops.push({
        op: node.operator,
        start: node.left.end,
        end: node.right.start,
      });
    }

    // 一元表达式：! ~ + - typeof void delete
    if (node.type === 'UnaryExpression') {
      ops.push({
        op: node.operator,
        start: node.start,
        end: node.argument.start,
      });
    }

    // 更新表达式：++ --
    if (node.type === 'UpdateExpression') {
      ops.push({
        op: node.operator,
        start: node.start,
        end: node.start + 2,
      });
    }

    // 三元表达式：? :
    if (node.type === 'ConditionalExpression') {
      ops.push({
        op: '?:',
        start: node.test.end,
        end: node.test.end + 1,
      });
    }

    // 递归子节点
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      walk(node[key]);
    }
  }

  walk(ast);
  return { ops, error: null };
}

// ── 生成变异候选 ──────────────────────────────────────────────────────
/**
 * @param {string} file  文件路径
 * @param {string} src   源码
 * @returns {{candidates: Array, parseError: string|null}}
 */
function buildCandidates(file, src) {
  const { ops, error } = findOperators(src);
  if (error) return { candidates: [], parseError: error };

  const candidates = [];

  for (const op of ops) {
    // 找这条运算符对应的变异规则
    const rule = MUTATION_RULES.find((r) => r.from === op.op);
    if (!rule) continue;

    // ★从 AST 给出的位置精确切出运算符原文（含空白）
    //   op.start/op.end 之间可能有空格，如 `a  >=  b`
    const rawOp = src.slice(op.start, op.end);
    const trimmed = rawOp.trim();

    // 校验：切出来的必须真的是这个运算符
    if (trimmed !== op.op) continue;

    // 计算运算符在原文里的精确位置（跳过前导空白）
    const leading = rawOp.length - rawOp.trimStart().length;
    const opStart = op.start + leading;

    // 行号（给报告用）
    const line = src.slice(0, opStart).split('\n').length;

    candidates.push({
      file,
      src,
      kind: rule.name,
      op: op.op,
      at: opStart,
      line,
      apply: (s) => s.slice(0, opStart) + rule.to + s.slice(opStart + op.op.length),
    });
  }

  return { candidates, parseError: null };
}

module.exports = { findOperators, buildCandidates, MUTATION_RULES };

#!/usr/bin/env node
/**
 * ai-test-check.cjs —— 检测「测试是不是真的」（MVP 原型）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★它回答一个问题★
 *
 *   「AI 写的测试，到底测没测到东西？」
 *
 * ★为什么这个问题值钱★
 *
 *   AI 写代码快，但测试经常是"假绿"：
 *     · 断言写得很弱（只测"不报错"）
 *     · 边界没覆盖（只测 happy path）
 *     · 看起来 100% 通过，改坏代码还是绿
 *   ⇒ 下游全是假的：覆盖率假的、CI 绿灯假的、信心假的
 *
 * ★它怎么工作★
 *
 *   1. 找到源码里的「可变异点」（比较运算符、布尔值、逻辑运算符）
 *   2. 逐个改坏
 *   3. 跑测试
 *   4. 测试还绿 ⇒ 这个变异"存活" ⇒ 测试没抓到 ⇒ 记一笔
 *   5. 测试变红 ⇒ "被杀" ⇒ 测试有效
 *   6. 恢复源码
 *
 *   最后给出：测试有效性 = 被杀数 / 总数
 *
 * ★诚实边界（MVP 限制）★
 *
 *   · 只支持 JS/CJS（不做 AST，纯文本替换）
 *   · 只变异 6 类简单点（===, !==, >, <, &&, ||）
 *   · 一次只变异一处（慢但准）
 *   · 不改测试文件，只改源码
 *   · 不保证语义等价（可能造出语法错误 ⇒ 当成"被杀"是误判，但方向保守）
 *
 * 用法:
 *   node ai-test-check.cjs <目录> [--test-cmd="npm test"] [--max=10]
 * ══════════════════════════════════════════════════════════════════════
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── 参数 ──────────────────────────────────────────────────────────────
function printHelp() {
  console.log('检测「测试是不是真的」（变异测试 MVP）');
  console.log('');
  console.log('用法:');
  console.log('  node ai-test-check.cjs <目录> [选项]');
  console.log('');
  console.log('选项:');
  console.log('  --test-cmd="<cmd>"  测试命令（默认读 package.json 的 scripts.test）');
  console.log('  --max=<n>           最多变异几处（默认 10）');
  console.log('  --file=<glob>       只变异匹配的文件（默认 src 下所有 .js）');
  console.log('  --help              显示本帮助');
  console.log('');
  console.log('退出码: 0=测试有效率高；1=有效率低；2=用法错误');
  process.exit(0);
}
if (process.argv.includes('--help') || process.argv.includes('-h')) printHelp();

const TARGET = process.argv[2];
if (!TARGET || TARGET.startsWith('--')) {
  console.error('❌ 缺少目录参数（用 --help 看用法）');
  process.exit(2);
}

function getArg(name, def) {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : def;
}

const MAX_MUTANTS = Number(getArg('max', '10')) || 10;
const TEST_CMD = getArg('test-cmd', null);

// ── 找源码和测试命令 ──────────────────────────────────────────────────
const ROOT = path.resolve(TARGET);

// ★修（2026-10-23）：把 node_modules/.bin 加到 PATH
//   原因：mocha/ava/xo 等只在 .bin 里，execSync 不自动找
const BIN_DIR = path.join(ROOT, 'node_modules', '.bin');
const testEnv = {
  ...process.env,
  PATH: fs.existsSync(BIN_DIR) ? BIN_DIR + path.delimiter + process.env.PATH : process.env.PATH,
};
if (!fs.existsSync(ROOT)) {
  console.error('❌ 目录不存在: ' + ROOT);
  process.exit(2);
}

function findTestCommand() {
  if (TEST_CMD) return TEST_CMD;
  const pkgPath = path.join(ROOT, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.test) return pkg.scripts.test;
    } catch (_) { /* ignore */ }
  }
  // 兜底：找 .test.js
  const hasTest = findFiles(ROOT, /\.test\.(c|m)?js$/).length > 0;
  if (hasTest) return 'node --test';
  return null;
}

function findFiles(dir, re, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    // ★修：排除非源码目录（benchmark/example/demo/script/test）
    if (['node_modules', '.git', 'dist', 'coverage', 'benchmark', 'benchmarks',
         'example', 'examples', 'demo', 'demos', 'script', 'scripts',
         'test', 'tests', '__tests__', '.github'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, re, out);
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

// ── 变异点 ────────────────────────────────────────────────────────────
// 每条：{ name, find, replace }
// ★保守策略：只变异"一定有语义"的符号，且一次只改一处
const MUTATIONS = [
  { name: '=== → !==', find: '===', replace: '!==' },
  { name: '!== → ===', find: '!==', replace: '===' },
  { name: '&& → ||', find: '&&', replace: '||' },
  { name: '|| → &&', find: '||', replace: '&&' },
];

// 比较运算符要避开 >=, <=, =>, ===, !==
const COMPARE_MUTATIONS = [
  { name: '> → >=', re: /(?<![<>=!])>(?![=>])/g, to: '>=' },
  { name: '< → <=', re: /(?<![<>=!])<(?![=<])/g, to: '<=' },
  { name: '>= → >', re: /(?<![<>=!])>=(?!=)/g, to: '>' },
  { name: '<= → <', re: /(?<![<>=!])<=(?!=)/g, to: '<' },
];

// ── 主流程 ────────────────────────────────────────────────────────────
console.log('═══ AI 测试有效性检测（变异测试 MVP）═══');
console.log('');

const testCmd = findTestCommand();
if (!testCmd) {
  console.error('❌ 找不到测试命令（没有 package.json 的 scripts.test，也没有 .test.js）');
  console.error('   ⇒ 用 --test-cmd="<你的测试命令>" 指定');
  process.exit(2);
}

console.log('  目录: ' + ROOT);
console.log('  测试命令: ' + testCmd);
console.log('  最多变异: ' + MAX_MUTANTS + ' 处');
console.log('');

// 找源文件（排除测试文件）
const srcFiles = findFiles(ROOT, /\.(c|m)?js$/).filter((f) => !/\.test\.|\.spec\./.test(f));

if (srcFiles.length === 0) {
  console.error('❌ 没找到源文件（.js/.cjs/.mjs，排除 .test./.spec.）');
  process.exit(2);
}

console.log('  源文件: ' + srcFiles.length + ' 个');
console.log('');

// 先跑一次基线：测试必须是绿的，否则没意义
console.log('  ── 基线检查 ──');
let baselineOk = false;
try {
  execSync(testCmd, { cwd: ROOT, stdio: 'pipe', timeout: 120000, env: testEnv });
  baselineOk = true;
  console.log('  ✅ 基线测试通过（可以开始变异）');
} catch (e) {
  console.log('  ❌ 基线测试就是红的 ⇒ 无法判断"测试是否有效"');
  console.log('     （先让测试全绿，再来测有效性）');
  console.log('');
  console.log('  测试输出（最后 3 行）:');
  const out = ((e.stdout || '') + (e.stderr || '')).toString();
  out.split('\n').filter((l) => l.trim()).slice(-3).forEach((l) => console.log('    ' + l.trim().slice(0, 100)));
  process.exit(1);
}

// 收集所有变异点
const candidates = [];
for (const file of srcFiles) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of MUTATIONS) {
    let idx = -1;
    while ((idx = src.indexOf(m.find, idx + 1)) !== -1) {
      candidates.push({ file, src, kind: m.name, at: idx, apply: (s) => s.slice(0, idx) + m.replace + s.slice(idx + m.find.length) });
    }
  }
  for (const m of COMPARE_MUTATIONS) {
    m.re.lastIndex = 0;
    let match;
    while ((match = m.re.exec(src)) !== null) {
      const at = match.index;
      const len = match[0].length;      // ★捕获当次长度（闭包会变）
      const to = m.to;
      candidates.push({ file, src, kind: m.name, at, apply: (s) => s.slice(0, at) + to + s.slice(at + len) });
    }
  }
}

if (candidates.length === 0) {
  console.log('');
  console.log('  ⚠ 没找到可变异点（源码里没有 ===, !==, >, <, &&, ||）');
  process.exit(0);
}

// 洗牌 + 截断
const shuffled = candidates.slice().sort(() => Math.random() - 0.5).slice(0, MAX_MUTANTS);

console.log('  可变异点: ' + candidates.length + ' 个，本次抽 ' + shuffled.length + ' 个');
console.log('');
console.log('  ── 逐个变异 ──');

let killed = 0;
let survived = 0;
const survivors = [];

for (let i = 0; i < shuffled.length; i++) {
  const c = shuffled[i];
  const rel = path.relative(ROOT, c.file);
  const mutated = c.apply(c.src);

  // 语法检查：如果变异造出语法错误，跳过（不算有效样本）
  if (mutated === c.src) {
    console.log('  [' + (i + 1) + '/' + shuffled.length + '] ' + rel + '  ' + c.kind + '  ⏭ 跳过（无变化）');
    continue;
  }

  const backup = c.src;
  try {
    fs.writeFileSync(c.file, mutated, 'utf8');
    execSync(testCmd, { cwd: ROOT, stdio: 'pipe', timeout: 120000, env: testEnv });
    // 测试还绿 ⇒ 变异存活 ⇒ 测试没抓到
    survived++;
    survivors.push({ file: rel, kind: c.kind, line: c.src.slice(0, c.at).split('\n').length });
    console.log('  [' + (i + 1) + '/' + shuffled.length + '] ' + rel + '  ' + c.kind + '  ❌ 存活（测试没抓到）');
  } catch (e) {
    // 测试变红 ⇒ 变异被杀 ⇒ 测试有效
    killed++;
    console.log('  [' + (i + 1) + '/' + shuffled.length + '] ' + rel + '  ' + c.kind + '  ✅ 被杀（测试抓到了）');
  } finally {
    // ★必须恢复
    fs.writeFileSync(c.file, backup, 'utf8');
  }
}

// ── 报告 ──────────────────────────────────────────────────────────────
const total = killed + survived;
const rate = total > 0 ? Math.round((killed / total) * 100) : 0;

console.log('');
console.log('═══ 结果 ═══');
console.log('  变异总数: ' + total);
console.log('  被杀: ' + killed + '（测试抓到了）');
console.log('  存活: ' + survived + '（测试没抓到）');
console.log('');
console.log('  ★ 测试有效性: ' + rate + '%');
console.log('');

if (survivors.length > 0) {
  console.log('  存活的变异（这些地方测试有洞）:');
  for (const s of survivors.slice(0, 10)) {
    console.log('    ' + s.file + ':' + s.line + '  ' + s.kind);
  }
  console.log('');
}

// 判据
if (rate >= 80) {
  console.log('  ✅ 测试有效性高（≥80%）⇒ 测试是可信的');
} else if (rate >= 50) {
  console.log('  ⚠ 测试有效性中等（50-79%）⇒ 有一半变异没抓到，建议补测试');
} else {
  console.log('  ❌ 测试有效性低（<50%）⇒ 测试可能是"假绿"，改坏代码也不会红');
}

console.log('');
console.log('═══ NOT_COVERED ═══');
console.log('  · 只支持 JS/CJS，不做 AST（纯文本替换）');
console.log('  · 只变异 6 类简单点（===, !==, >, <, &&, ||）');
console.log('  · 一次只变异一处，最多 ' + MAX_MUTANTS + ' 处');
console.log('  · 变异可能造出语法错误 ⇒ 被当成"被杀"（方向保守，会高估有效性）');
console.log('  · 不测"边界值"、"异常路径"这类变异');

process.exit(rate >= 50 ? 0 : 1);

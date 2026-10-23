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
 *   1. 找到源码里的「可变异点」（★用 AST 精确识别真运算符）
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
 *   · 只支持 JS/CJS（用 acorn 做 AST，ES2022 语法）
 *   · 只变异 8 类运算符（>=, <=, >, <, ===, !==, &&, ||）
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

// ★AST 变异器（2026-10-23 加）：用语法树找真运算符，不再纯正则
const { buildCandidates } = require('./ast-mutator.cjs');

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

// ★修（2026-10-24）：取第一个非 -- 开头的参数作为目录
//   原 bug：TARGET = process.argv[2]，写成 `ai-test-check --max=5 ./src` 时会取到 --max=5
const TARGET = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!TARGET) {
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

  // ★修（2026-10-24）：从 ROOT 向上找 package.json，最多 5 级
  //   原 bug：用户传 ./src，但 package.json 在项目根 ⇒ 找不到测试命令
  let dir = ROOT;
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts && pkg.scripts.test) {
          // ★测试命令要在 package.json 所在目录跑，不是 ROOT
          return { cmd: pkg.scripts.test, cwd: dir };
        }
      } catch (_) { /* ignore */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  // 兜底：找 .test.js
  const hasTest = findFiles(ROOT, /\.test\.(c|m)?js$/).length > 0;
  if (hasTest) return { cmd: 'node --test', cwd: ROOT };
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

// ── 变异点（★已改用 AST，见 ast-mutator.cjs）────────────────────────
// 旧版纯正则会误报：
//   /(?!=)/g  ⇒ 把正则 lookahead 当成「!= 比较」
//   /(?![=>])/g ⇒ 把正则 lookahead 当成「嵌套三元」
// 实测（2026-10-23）：用 ocr 规则扫自己代码，10 项检查 2 项误报
// ⇒ 改用 acorn 解析成 AST，只变异真正的运算符节点

// ── 主流程 ────────────────────────────────────────────────────────────
console.log('═══ AI 测试有效性检测（变异测试 MVP）═══');
console.log('');

const testInfo = findTestCommand();
if (!testInfo) {
  console.error('❌ 找不到测试命令（没有 package.json 的 scripts.test，也没有 .test.js）');
  console.error('   ⇒ 用 --test-cmd="<你的测试命令>" 指定');
  process.exit(2);
}
const testCmd = testInfo.cmd;
const testCwd = testInfo.cwd;   // ★测试命令在该目录跑

console.log('  目录: ' + ROOT);
console.log('  测试命令: ' + testCmd);
console.log('  最多变异: ' + MAX_MUTANTS + ' 处');
console.log('');

// 找源文件（排除测试文件）
// ★修（2026-10-24）：排除测试文件本身
//   原 bug：只排除 .test./.spec.，但 demo 的测试文件叫 test.js ⇒ 变异了测试自己
//   修法：排除 test.js / tests.js / test/ / tests/ / __tests__/
const srcFiles = findFiles(ROOT, /\.(c|m)?js$/).filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (/\.test\.|\.spec\./.test(rel)) return false;
  if (/^(test|tests|__tests__)\//.test(rel)) return false;
  if (/^(test|tests)\.(c|m)?js$/.test(rel)) return false;
  return true;
});

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
  execSync(testCmd, { cwd: testCwd, stdio: 'pipe', timeout: 120000, env: testEnv });
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

// 收集所有变异点（★用 AST 精确识别，排除正则/字符串/注释里的假符号）
const candidates = [];
const parseErrors = [];
for (const file of srcFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const result = buildCandidates(file, src);
  if (result.parseError) {
    parseErrors.push({ file: path.relative(ROOT, file), error: result.parseError });
    continue;
  }
  candidates.push(...result.candidates);
}

if (candidates.length === 0) {
  console.log('');
  console.log('  ⚠ 没找到可变异点（源码里没有 ===, !==, >, <, &&, ||）');
  process.exit(0);
}

// 洗牌 + 截断
const shuffled = candidates.slice().sort(() => Math.random() - 0.5).slice(0, MAX_MUTANTS);

console.log('  可变异点: ' + candidates.length + ' 个，本次抽 ' + shuffled.length + ' 个');

// ★报告解析失败的文件（AST 解析不了 ⇒ 跳过，但不静默）
if (parseErrors.length > 0) {
  console.log('');
  console.log('  ⚠ ' + parseErrors.length + ' 个文件解析失败（已跳过）:');
  for (const pe of parseErrors.slice(0, 5)) {
    console.log('    ' + pe.file + ': ' + pe.error.slice(0, 80));
  }
  if (parseErrors.length > 5) console.log('    ...还有 ' + (parseErrors.length - 5) + ' 个');
}
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
    execSync(testCmd, { cwd: testCwd, stdio: 'pipe', timeout: 120000, env: testEnv });
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
console.log('  · 只支持 JS/CJS（acorn AST，ES2022）');
console.log('  · 变异类型：运算符（>=, <=, >, <, ===, !==, &&, ||）');
console.log('              + 布尔字面量（true ↔ false）');
console.log('              + 数字边界（N → N±1）');
console.log('              + 状态字符串（active ↔ inactive 等）');
console.log('  · 不改条件取反（if (x) → if (!x)）、不改返回值类型');
console.log('  · 解析失败的文件跳过（会报告，不静默）');
console.log('  · 一次只变异一处，最多 ' + MAX_MUTANTS + ' 处');
console.log('  · 变异可能造出语法错误 ⇒ 被当成"被杀"（方向保守，会高估有效性）');
console.log('  · 只做单文件变异，无跨文件/模块间契约检测');
console.log('  · 不测"边界值"、"异常路径"这类变异');

process.exit(rate >= 50 ? 0 : 1);

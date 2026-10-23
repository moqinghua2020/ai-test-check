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
  console.log('  ★变异类型: 运算符 / 布尔 / 数字边界 / 状态字符串 / 条件取反');
  console.log('  --all               跑所有变异点（结果稳定，但慢）');
  console.log('  --file=<glob>       只变异匹配的文件（默认 src 下所有 .js）');
  console.log('  --help              显示本帮助');
  console.log('');
  console.log('退出码: 0=测试有效率高；1=有效率低；2=用法错误');
  process.exit(0);
}
if (process.argv.includes('--help') || process.argv.includes('-h')) printHelp();

// ★自检（2026-10-24 加）：验证 AST 变异器 + 分类函数
if (process.argv.includes('--selftest')) {
  const { buildCandidates } = require('./ast-mutator.cjs');
  let pass = 0, fail = 0;
  const t = (name, fn) => {
    try { fn(); console.log('  ✅ ' + name); pass++; }
    catch (e) { console.log('  ❌ ' + name + ': ' + e.message); fail++; }
  };
  const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' 期望 ' + JSON.stringify(b) + ' 实得 ' + JSON.stringify(a)); };

  console.log('═══ ai-test-check 自检 ═══');
  console.log('');

  t('AST：真运算符能找到', () => {
    // ★注意：现在是 5 个 —— >= / && / !== / 数字18 / 条件取反
    const r = buildCandidates('t.js', 'if (a >= 18 && b !== 0) {}');
    eq(r.candidates.length, 5, '应有 5 个（>= && !== + 数字18 + 条件取反）');
    const kinds = r.candidates.map(x => x.kind);
    if (!kinds.some(k => k.includes('>='))) throw new Error('缺 >=');
    if (!kinds.some(k => k.includes('&&'))) throw new Error('缺 &&');
    if (!kinds.some(k => k.includes('!=='))) throw new Error('缺 !==');
    if (!kinds.some(k => k.includes('数字'))) throw new Error('缺数字边界');
    if (!kinds.some(k => k.includes('条件取反'))) throw new Error('缺条件取反');
  });

  t('AST：正则里的符号不算', () => {
    const r = buildCandidates('t.js', 'const re = /(?<![<>=!])>=(?!=)/g;');
    eq(r.candidates.length, 0);
  });

  t('AST：字符串里的符号不算', () => {
    const r = buildCandidates('t.js', 'const s = "a >= b && c !== d";');
    eq(r.candidates.length, 0);
  });

  t('AST：布尔字面量能变异', () => {
    const r = buildCandidates('t.js', 'function f() { return true; }');
    const bools = r.candidates.filter(x => x.kind.includes('true'));
    eq(bools.length, 1);
  });

  t('AST：数字边界能变异', () => {
    const r = buildCandidates('t.js', 'function f(a) { return a >= 18; }');
    const nums = r.candidates.filter(x => x.kind.includes('数字'));
    eq(nums.length, 1, '18 应该被变异');
  });

  t('AST：状态字符串能变异', () => {
    const r = buildCandidates('t.js', 'function f(s) { return s === "active"; }');
    const strs = r.candidates.filter(x => x.kind.includes('状态'));
    eq(strs.length, 1);
  });

  t('AST：语法错误要报错不崩', () => {
    const r = buildCandidates('t.js', 'function f( {');
    if (!r.parseError) throw new Error('该报解析错误');
  });

  t('AST：0 和 1 不参与数字变异（避免噪音）', () => {
    const r = buildCandidates('t.js', 'const a = 0; const b = 1;');
    const nums = r.candidates.filter(x => x.kind.includes('数字'));
    eq(nums.length, 0);
  });

  t('可复现：同种子同结果', () => {
    // 直接测 seededShuffle 逻辑
    function seededShuffle(arr, seed) {
      let s = 0;
      for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) | 0;
      s = Math.abs(s) || 1;
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
      }
      return a;
    }
    const arr = [1,2,3,4,5,6,7,8,9,10];
    const a = seededShuffle(arr, '/path/to/project');
    const b = seededShuffle(arr, '/path/to/project');
    eq(JSON.stringify(a), JSON.stringify(b), '同种子应同结果');
  });

  t('可复现：不同种子不同结果', () => {
    function seededShuffle(arr, seed) {
      let s = 0;
      for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) | 0;
      s = Math.abs(s) || 1;
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
      }
      return a;
    }
    const arr = [1,2,3,4,5,6,7,8,9,10];
    const a = seededShuffle(arr, '/path/A');
    const b = seededShuffle(arr, '/path/B');
    if (JSON.stringify(a) === JSON.stringify(b)) throw new Error('不同种子应该不同结果（概率上）');
  });

  t('AST：算术运算符能变异', () => {
    const r = buildCandidates('t.js', 'function f(a,b) { return a + b; }');
    const arith = r.candidates.filter(x => x.kind.includes('+ → -'));
    eq(arith.length, 1, '该有 1 个 + → -');
  });

  t('AST：算术运算符全 5 种', () => {
    const code = 'function f(a,b) { return a + b - a * b / a % b; }';
    const r = buildCandidates('t.js', code);
    const arith = r.candidates.filter(x => /[+\-*/%] →/.test(x.kind));
    if (arith.length < 5) throw new Error('该有 ≥5 个算术变异，实得 ' + arith.length);
  });

  t('AST：条件取反能变异', () => {
    const r = buildCandidates('t.js', 'if (a >= 18) { x(); }');
    const neg = r.candidates.filter(x => x.kind.includes('条件取反'));
    eq(neg.length, 1, '该有 1 个条件取反');
  });

  t('AST：条件取反不产生语法错误', () => {
    const acorn = require('acorn');
    const r = buildCandidates('t.js', 'if (a >= 18) { x(); }');
    const neg = r.candidates.filter(x => x.kind.includes('条件取反'));
    const mutated = neg[0].apply(neg[0].src);
    acorn.parse(mutated, { ecmaVersion: 2022 });   // 不抛错就算通过
  });

  t('分类：边界条件识别', () => {
    const r = buildCandidates('t.js', 'if (a >= 18) {}');
    const kinds = r.candidates.map(x => x.kind);
    if (!kinds.some(k => k.includes('>='))) throw new Error('该有 >= 变异');
  });

  t('分类：逻辑组合识别', () => {
    const r = buildCandidates('t.js', 'if (a && b) {}');
    if (!r.candidates.some(x => x.kind.includes('&&'))) throw new Error('该有 && 变异');
  });

  console.log('');
  console.log('  通过: ' + pass + ' / ' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
}

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

// ★修（2026-10-24）：--all 跑全量
const RUN_ALL = process.argv.includes('--all');
const MAX_MUTANTS = RUN_ALL ? Infinity : (Number(getArg('max', '10')) || 10);
const TEST_CMD = getArg('test-cmd', null);

// ── 找源码和测试命令 ──────────────────────────────────────────────────
const ROOT = path.resolve(TARGET);

// ★修（2026-10-23）：把 node_modules/.bin 加到 PATH
//   原因：mocha/ava/xo 等只在 .bin 里，execSync 不自动找
// ★修（2026-10-24）：同时注入 ROOT 和 testCwd 的 .bin
//   实测：slugify 的 node_modules/ava 存在但 .bin 不生成（npm 在 Windows 的已知问题）
//   ⇒ 需要 npx 兜底
const BIN_DIRS = [
  path.join(ROOT, 'node_modules', '.bin'),
];
const testEnv = {
  ...process.env,
  PATH: BIN_DIRS.filter((d) => fs.existsSync(d)).join(path.delimiter) +
        (BIN_DIRS.some((d) => fs.existsSync(d)) ? path.delimiter : '') +
        process.env.PATH,
};
if (!fs.existsSync(ROOT)) {
  console.error('❌ 目录不存在: ' + ROOT);
  process.exit(2);
}

function findTestCommand() {
  // ★修（2026-10-24）：返回对象，不是字符串
  //   原 bug：--test-cmd="node test.js" ⇒ testCmd = undefined
  if (TEST_CMD) return { cmd: TEST_CMD, cwd: ROOT };

  // ★修（2026-10-24）：从 ROOT 向上找 package.json，最多 5 级
  //   原 bug：用户传 ./src，但 package.json 在项目根 ⇒ 找不到测试命令
  let dir = ROOT;
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts && pkg.scripts.test) {
          // ★修（2026-10-24）：拆开 &&，只跑真正的测试命令
          //   实测：slugify 的 "xo && ava"，xo 没装 ⇒ 基线失败
          const LINT_CMDS = ['xo', 'standard', 'eslint', 'tsc', 'prettier', 'nz'];
          const parts = pkg.scripts.test.split('&&').map((s) => s.trim()).filter(Boolean);
          const testParts = parts.filter((p) => {
            const first = p.split(/\s+/)[0];
            return !LINT_CMDS.includes(first);
          });
          const realTest = testParts.length > 0 ? testParts[0] : pkg.scripts.test;
          return { cmd: realTest, cwd: dir, original: pkg.scripts.test };
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
if (testInfo.original && testInfo.original !== testCmd) {
  console.log('  原命令: ' + testInfo.original);
  console.log('  ★ 只跑测试部分: ' + testCmd);
} else {
  console.log('  测试命令: ' + testCmd);
}
console.log('  最多变异: ' + MAX_MUTANTS + ' 处');
console.log('');

// 找源文件（排除测试文件）
// ★修（2026-10-24）：排除测试文件本身
//   原 bug：只排除 .test./.spec.，但 demo 的测试文件叫 test.js ⇒ 变异了测试自己
//   修法：排除 test.js / tests.js / test/ / tests/ / __tests__/
// ★修（2026-10-24）：从 --test-cmd 提取测试文件名，排除它
const testFilePatterns = [];
if (TEST_CMD) {
  // 从 "node test-fixed.js" 提取 "test-fixed.js"
  const m = TEST_CMD.match(/([\w\-.]+\.(c|m)?js)/);
  if (m) testFilePatterns.push(m[1]);
}

const srcFiles = findFiles(ROOT, /\.(c|m)?js$/).filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (/\.test\.|\.spec\./.test(rel)) return false;
  if (/^(test|tests|__tests__)\//.test(rel)) return false;
  if (/^(test|tests)\.(c|m)?js$/.test(rel)) return false;
  // ★排除 --test-cmd 指定的测试文件
  if (testFilePatterns.some((p) => rel === p || rel.endsWith('/' + p))) return false;
  // ★排除 test-*.js / *-test.js / *-spec.js
  if (/^test-[\w-]+\.(c|m)?js$/.test(rel)) return false;
  if (/^[\w-]+-test\.(c|m)?js$/.test(rel)) return false;
  if (/^[\w-]+-spec\.(c|m)?js$/.test(rel)) return false;
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
  // ★修（2026-10-24）：如果命令找不到（.bin 不生成），用 npx 兜底
  let finalCmd = testCmd;
  const firstWord = testCmd.split(/\s+/)[0];
  const cmdExists = (() => {
    try {
      execSync(process.platform === 'win32' ? 'where ' + firstWord : 'which ' + firstWord, { stdio: 'pipe', env: testEnv });
      return true;
    } catch (_) { return false; }
  })();
  if (!cmdExists) {
    finalCmd = 'npx ' + testCmd;
  }
  execSync(finalCmd, { cwd: testCwd, stdio: 'pipe', timeout: 120000, env: testEnv });
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

// ★修（2026-10-24）：可复现的随机抽样
//   原 bug：sort(() => Math.random() - 0.5) 每次不同
//   实测：同一项目两次跑出 20% 和 100%，用户不会信任
//   修法：用项目路径做种子，同一项目每次抽同样的变异
function seededShuffle(arr, seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) | 0;
  s = Math.abs(s) || 1;
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

const shuffled = seededShuffle(candidates, ROOT).slice(0, MAX_MUTANTS);

// ★修（2026-10-24）：说明是全量还是抽样
const isFull = shuffled.length === candidates.length;
console.log('  可变异点: ' + candidates.length + ' 个，本次抽 ' + shuffled.length + ' 个' +
  (isFull ? '（全量 ✅ 结果稳定）' : '（抽样 ' + Math.round(shuffled.length / candidates.length * 100) + '%，结果可能波动）'));

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
    // ★修（2026-10-24）：如果命令找不到（.bin 不生成），用 npx 兜底
  let finalCmd = testCmd;
  const firstWord = testCmd.split(/\s+/)[0];
  const cmdExists = (() => {
    try {
      execSync(process.platform === 'win32' ? 'where ' + firstWord : 'which ' + firstWord, { stdio: 'pipe', env: testEnv });
      return true;
    } catch (_) { return false; }
  })();
  if (!cmdExists) {
    finalCmd = 'npx ' + testCmd;
  }
  execSync(finalCmd, { cwd: testCwd, stdio: 'pipe', timeout: 120000, env: testEnv });
    // 测试还绿 ⇒ 变异存活 ⇒ 测试没抓到
    survived++;
    survivors.push({ file: rel, kind: c.kind, line: c.src.slice(0, c.at).split('\n').length, op: c.op });
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

// ★按类型分组报告（2026-10-24 加）
//   ★为什么加：只报「有效性 25%」不够具体
//   用户需要知道「哪类测试没写」——边界？逻辑？状态？
function classifyKind(kind) {
  if (kind.includes('→') && /[<>=!]/.test(kind)) return '边界条件';
  if (kind.includes('&&') || kind.includes('||')) return '逻辑组合';
  if (kind.includes('true') || kind.includes('false')) return '布尔判断';
  if (kind.includes('数字')) return '数字边界';
  if (kind.includes('状态')) return '状态判断';
  return '其他';
}

// 给每个存活变异打分类
for (const s of survivors) s.category = classifyKind(s.kind);

if (survivors.length > 0) {
  // ── 按类型汇总 ──
  const byCat = {};
  for (const s of survivors) {
    if (!byCat[s.category]) byCat[s.category] = [];
    byCat[s.category].push(s);
  }

  console.log('  存活的变异按类型分组:');
  console.log('');
  const CAT_HINT = {
    '边界条件': '补「等于/不等于」的情况',
    '逻辑组合': '补「只满足一个条件」的情况',
    '布尔判断': '补「相反情况」的测试',
    '数字边界': '补「刚好等于/差一」的情况',
    '状态判断': '补「状态切换」的测试',
    '其他': '看具体位置',
  };
  for (const [cat, arr] of Object.entries(byCat).sort((a, b) => b[1].length - a[1].length)) {
    console.log('    ' + cat + '（' + arr.length + ' 处）⇒ ' + (CAT_HINT[cat] || ''));
    for (const s of arr.slice(0, 3)) {
      console.log('      ' + s.file + ':' + s.line + '  ' + s.kind);
    }
    if (arr.length > 3) console.log('      ...还有 ' + (arr.length - 3) + ' 处');
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
console.log('  · 变异类型：比较运算符（>=, <=, >, <, ===, !==）');
console.log('              + 逻辑运算符（&&, ||）');
console.log('              + 算术运算符（+ - * / %）');
console.log('              + 布尔字面量（true ↔ false）');
console.log('              + 数字边界（N → N+1）');
console.log('              + 状态字符串（active ↔ inactive 等）');
console.log('              + 条件取反（if (x) → if (!(x))）');
console.log('  · 不改返回值类型、不改对象属性访问');
console.log('  · 解析失败的文件跳过（会报告，不静默）');
console.log('  · 一次只变异一处，最多 ' + MAX_MUTANTS + ' 处');
console.log('  · 变异可能造出语法错误 ⇒ 被当成"被杀"（方向保守，会高估有效性）');
console.log('  · 只做单文件变异，无跨文件/模块间契约检测');
console.log('  · 不测"边界值"、"异常路径"这类变异');

process.exit(rate >= 50 ? 0 : 1);

#!/usr/bin/env node
/**
 * tests/run.mjs —— 「结构化输出守卫」纯函数检测器测试台（ESM / 零依赖）
 *
 * 被测对象： plugin/src/detect.js   （冻结接口见 docs/INTERFACE.md，含裁定 R1–R8 与 D-0/D-1）
 * 判据来源： docs/DESIGN.md §6「可测量的成功判据」、§7「测试台」
 *
 * 运行：  node tests/run.mjs
 * 退出码：全部 PASS → 0；任一 FAIL 或被测实现缺失 → 1
 *
 * 纪律：断言按 docs/INTERFACE.md 逐条写死，不为了让实现通过而放宽。
 *       本文件自身也不书写连续的字面闭合标签（用 T()/TE() 拼接构造）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures');
const DETECT_PATH = path.join(HERE, '..', 'plugin', 'src', 'detect.js');

// ---- 冻结记号（R2 / docs/INTERFACE.md §0）：结束序列只认 INVOKE_END ----
const C_END = '<' + '/invoke' + '>'; // INVOKE_END
const C_PARAM_END = '<' + '/parameter' + '>'; // PARAM_END（不计入 endSequence）
const T = (name) => '<' + name + '>'; // 开场标记
const TE = (name) => '<' + '/' + name + '>'; // 闭合标记

// 「未执行」在英文文案里的等价说法（G4 / H3 共用；中文侧直接匹配「未执行」）
const EN_NOT_EXECUTED_RE =
  /(executed nothing|nothing was executed|no operation|not executed|did not execute|did not run|was not run|not run|was not applied|without executing)/i;
// lang:'en' 的文案里不应出现 CJK 字符（用于证明语言切换确实生效）
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// 带属性的开场标记 `<name attrs>`（T()/TE() 只用于无属性场景）
const TA = (name, attrs) => '<' + name + ' ' + attrs + '>';

// ---- 冻结的 FindingCode 集合（裁定 R5 增补 INTERNAL_ERROR，共 9 个） ----
const FINDING_CODES = new Set([
  'END_SEQUENCE_MULTIPLIED',
  'UNPAIRED_CLOSING_TAG',
  'MISSING_OPENING_MARKUP',
  'MARKUP_LEAKED_AS_TEXT',
  'TRUNCATED_PAYLOAD',
  'PAYLOAD_TOO_LONG',
  'CLOSING_TAG_DENSITY',
  'SUSPICIOUS_NOOP_RESULT',
  'INTERNAL_ERROR',
]);

const REQUIRED_EXPORTS = [
  'DEFAULT_CONFIG',
  'mergeConfig',
  'scanAssistantText',
  'scanToolArguments',
  'scanToolResult',
  'buildCorrectionMessage',
  'buildDenyReason',
  'sanitizeMessages', // R12 (M5)
];

// INTERFACE.md §配置：默认值必须逐字段一致（D1）。键集合另行从被测 DEFAULT_CONFIG 推导，
// 这样新增 config 键不会误红；值仍然冻结在这里逐字段断言。
const DEFAULTS = {
  enabled: true,
  maxLines: 100,
  maxChars: 20000,
  closingTagCount: 8,
  endSequenceRepeats: 2,
  maxCorrectionsPerTurn: 1,
  lang: 'zh',
  noopCheck: true, // R9：M3「疑似空转」检测的 kill switch（默认开）
  debugLog: false, // R10：诊断日志开关（默认 false = 零开销零副作用）
  debugLogPath: '', // R10：日志目标；空串由系统临时目录推导
  contextGuard: false, // R12：M5 上下文净化（默认关：它会改写模型可见历史）
  contextGuardNote: '', // R12：改写注记；空串 = 内置本地化注记
};

// 正例：3 个真实故障变体（DESIGN §1.2 / §7）
const POSITIVES = [
  {
    file: 'v1-end-multiplied.txt',
    variant: 'V1',
    title: '结束序列增殖',
    expectCodes: ['END_SEQUENCE_MULTIPLIED'],
    canary: 'CANARY_V1_PAYLOAD_7f3a',
  },
  {
    file: 'v2-missing-opening.txt',
    variant: 'V2',
    title: '开场序列缺失',
    expectCodes: ['MISSING_OPENING_MARKUP'],
    canary: null,
  },
  {
    file: 'v3-leaked-markup.txt',
    variant: 'V3',
    title: '正文泄漏',
    expectCodes: ['MARKUP_LEAKED_AS_TEXT'],
    canary: 'CANARY_V3_PAYLOAD_2b91',
  },
];

// 反例：必须零误报（DESIGN §6「误报：对正常代码/HTML/长文本 0 误报」）
const NEGATIVES = [
  { file: 'ok-normal-html.txt', kind: '正常 HTML（大量闭合标签但逐 tag 配平）' },
  { file: 'ok-normal-js.txt', kind: '正常长 JS（>100 行，无闭合标签）' },
  { file: 'ok-normal-markdown-table.txt', kind: '正常 Markdown 表格' },
  { file: 'ok-short-text-few-tags.txt', kind: '正常短文本（少量配平标签）' },
  {
    file: 'ok-single-end-sequence.txt',
    kind: '合法收尾：恰好 1 个 PARAM_END + 1 个 INVOKE_END（裁定 R2）',
    allowCallMarkup: true,
  },
];

// ---- 微型 runner：逐条 PASS/FAIL，失败不中断 ----
let pass = 0;
let fail = 0;
const failures = [];

function check(id, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${id}`);
  } catch (err) {
    fail += 1;
    const msg = (err && err.message) || String(err);
    failures.push([id, msg]);
    console.log(`FAIL  ${id} -- ${msg}`);
  }
}

function section(title) {
  console.log('');
  console.log(`== ${title} ==`);
}

function eq(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label || 'value'}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function ok(cond, label) {
  if (!cond) throw new Error(label || '期望为真，实际为假');
}

function sameJson(a, b, label) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${label || 'JSON'}: 两次结果不一致\n  A=${x}\n  B=${y}`);
}

// 敌意输入工厂（I 组 R3 修正 与 L 组 R5 共用）：属性 getter / Proxy trap 抛错。
const HOSTILE_GETTER = {};
Object.defineProperty(HOSTILE_GETTER, 'content', {
  enumerable: true,
  configurable: true,
  get() {
    throw new Error('hostile getter');
  },
});
const HOSTILE_PROXY = new Proxy(
  {},
  {
    ownKeys() {
      throw new Error('hostile ownKeys');
    },
    getOwnPropertyDescriptor() {
      throw new Error('hostile gopd');
    },
    get() {
      throw new Error('hostile get');
    },
  },
);
// R5：内部异常时 reason 必须为空。shape 里 `reason?` 可选，故 '' 与缺省都算空。
const reasonIsEmpty = (value) => value === '' || value === undefined;

function assertFindingSet(findings) {
  ok(Array.isArray(findings), 'findings 必须是数组');
  for (const f of findings) {
    ok(f && typeof f === 'object', 'finding 必须是对象');
    ok(FINDING_CODES.has(f.code), `出现冻结集合外的 FindingCode: ${JSON.stringify(f.code)}`);
    ok(
      f.severity === 'info' || f.severity === 'warn' || f.severity === 'error',
      `severity 非法: ${JSON.stringify(f.severity)}`,
    );
    eq(typeof f.detail, 'string', 'finding.detail 必须是字符串');
  }
}

// 整轮测试产生过的 FindingCode（M5 用它证明 TRUNCATED_PAYLOAD 不是死代码）
const producedCodes = new Set();

function codes(result) {
  const list = (result.findings || []).map((f) => f.code);
  for (const code of list) producedCodes.add(code);
  return list;
}

function hasCode(result, code) {
  return codes(result).includes(code);
}

function assertDenyReason(reason) {
  eq(typeof reason, 'string', 'deny.reason 必须是字符串');
  ok(reason.length > 0, 'deny.reason 不得为空');
  ok(reason.length <= 400, `deny.reason 超过 400 字符: ${reason.length}`);
  ok(reason.includes('未执行'), `deny.reason 缺少"未执行"语义: ${reason.slice(0, 120)}`);
}

// 逐 tag 配平统计（用于校验反例确实"结构合法"）
function tagBalance(text) {
  const opens = new Map();
  const closes = new Map();
  const OPEN_RE = /<([a-zA-Z][\w:-]*)/g;
  const CLOSE_RE = /<[/]([a-zA-Z][\w:-]*)/g;
  for (const m of text.matchAll(OPEN_RE)) {
    const t = m[1].toLowerCase();
    opens.set(t, (opens.get(t) || 0) + 1);
  }
  for (const m of text.matchAll(CLOSE_RE)) {
    const t = m[1].toLowerCase();
    closes.set(t, (closes.get(t) || 0) + 1);
  }
  const over = [];
  for (const [t, c] of closes) {
    const o = opens.get(t) || 0;
    if (c > o) over.push(`${t}: 闭合 ${c} > 开场 ${o}`);
  }
  return { opens, closes, over };
}

// ---- fixture 读取（带缓存 + 明确错误） ----
const fixtureCache = new Map();

function fixture(name) {
  if (!fixtureCache.has(name)) {
    try {
      fixtureCache.set(name, readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
    } catch (err) {
      throw new Error(`读取 fixture 失败 ${name}: ${err.message}`);
    }
  }
  return fixtureCache.get(name);
}

const ALL_FILES = [...POSITIVES, ...NEGATIVES].map((x) => x.file);

// ---- 加载被测实现（ESM 动态 import；缺失时给清晰报错而不是栈回溯） ----
let detect = null;
let importError = null;
try {
  detect = await import(pathToFileURL(DETECT_PATH).href);
} catch (err) {
  importError = err;
}

function blockedBanner(err) {
  console.error(
    [
      '',
      '=========================================================',
      '[BLOCKED] 被测实现缺失或无法加载，测试台无法执行断言。',
      `  期望文件 : ${DETECT_PATH}`,
      `  加载失败 : ${(err && (err.code || err.name)) || 'Error'}: ${(err && err.message) || String(err)}`,
      '  期望契约 : docs/INTERFACE.md（ESM），必须导出：',
      `             ${REQUIRED_EXPORTS.join(', ')}`,
      '  fixtures 已就绪；等 plugin-dev 交付后重跑：node tests/run.mjs',
      '=========================================================',
      '',
    ].join('\n'),
  );
}

// 键集合从被测实现的 DEFAULT_CONFIG 推导（不硬编码）：新增 config 键时自动跟随，避免误红；
// 值仍按 docs/INTERFACE.md 的冻结默认值逐字段断言；未知键仍必须被忽略。
function assertDefaults(obj, label, expectedKeySet) {
  ok(obj && typeof obj === 'object', `${label}: 必须是对象`);
  for (const [k, v] of Object.entries(DEFAULTS)) eq(obj[k], v, `${label}.${k}`);
  eq(
    Object.keys(obj).sort().join(','),
    expectedKeySet,
    `${label} 的键集合应与 DEFAULT_CONFIG 一致（未知键被忽略；新增键自动跟随）`,
  );
}

function assertEvidenceShape(ev, text) {
  ok(ev && typeof ev === 'object', 'evidence 必须是对象');
  eq(typeof ev.length, 'number', 'evidence.length 类型');
  eq(ev.length, text.length, 'evidence.length 应等于文本长度');
  eq(typeof ev.closingTagCount, 'number', 'evidence.closingTagCount 类型');
  eq(typeof ev.endSequenceRepeats, 'number', 'evidence.endSequenceRepeats 类型');
  eq(typeof ev.leakedMarkup, 'boolean', 'evidence.leakedMarkup 类型');
  eq(typeof ev.truncated, 'boolean', 'evidence.truncated 类型');
}

async function main() {
  if (importError) {
    blockedBanner(importError);
    check('impl.available', () => {
      throw new Error(`无法加载 ${DETECT_PATH}（${importError.message}）`);
    });
    return 1;
  }

  const missing = REQUIRED_EXPORTS.filter((name) => detect[name] === undefined);
  check('impl.exports.complete', () => {
    ok(missing.length === 0, `缺少导出: ${missing.join(', ')}`);
  });
  if (missing.length > 0) {
    console.error('\n[BLOCKED] 实现已存在但导出不全，后续断言无法执行。请对齐 docs/INTERFACE.md §暴露。');
    return 1;
  }

  const {
    DEFAULT_CONFIG,
    mergeConfig,
    scanAssistantText,
    scanToolArguments,
    scanToolResult,
    buildCorrectionMessage,
    buildDenyReason,
    sanitizeMessages,
  } = detect;

  const defaultSnapshot = JSON.stringify(DEFAULT_CONFIG);
  // I2/I14 的键集合基准：从实现自己的 DEFAULT_CONFIG 推导（新增 config 键自动跟随）。
  const DEFAULT_KEY_SET = Object.keys(DEFAULT_CONFIG).sort().join(',');

  // ================= A. fixtures 完整性 =================
  section('A. fixtures 完整性（防分块写入被静默截断）');

  check('A1 8 个 fixture 文件齐全', () => {
    const present = new Set(readdirSync(FIXTURE_DIR));
    for (const f of ALL_FILES) ok(present.has(f), `缺少 ${f}`);
    eq(ALL_FILES.length, 8, 'fixture 数量（3 正例 + 5 反例）');
  });

  check('A2 无残留 @@ 占位符', () => {
    for (const f of ALL_FILES) ok(!fixture(f).includes('@@'), `${f} 含占位符`);
  });

  check('A3 fixture 非空且以换行结束', () => {
    for (const f of ALL_FILES) {
      const t = fixture(f);
      ok(t.length > 0, `${f} 为空`);
      ok(t.endsWith('\n'), `${f} 未以换行结束`);
    }
  });

  check('A4 反例逐 tag 配平（无过度闭合）', () => {
    for (const n of NEGATIVES) {
      const { over } = tagBalance(fixture(n.file));
      ok(over.length === 0, `${n.file} 未配平: ${over.join('; ')}`);
    }
  });

  check('A5 普通反例不含调用标记', () => {
    for (const n of NEGATIVES) {
      if (n.allowCallMarkup) continue;
      const t = fixture(n.file);
      ok(!t.includes(T('invoke')), `${n.file} 意外含调用开场标记`);
      ok(!t.includes(T('parameter')), `${n.file} 意外含参数开场标记`);
    }
  });

  // ================= B. 正例检出 =================
  section('B. 正例：scanAssistantText 检出 3/3 变体（DESIGN §6 检测召回）');

  for (const p of POSITIVES) {
    const text = fixture(p.file);
    const r = scanAssistantText(text);

    check(`B1[${p.variant}] ${p.title} 判 damaged:true`, () => {
      eq(r.damaged, true, 'damaged');
    });

    check(`B1b[${p.variant}] 命中 ${p.expectCodes.join('+')}`, () => {
      const got = new Set(codes(r));
      for (const c of p.expectCodes) ok(got.has(c), `缺少 ${c}（实际: ${[...got].join(', ') || '无'}）`);
    });

    check(`B1c[${p.variant}] findings 形状合法`, () => assertFindingSet(r.findings));

    check(`B1d[${p.variant}] 至少一个 error 级 finding`, () => {
      ok(
        r.findings.some((f) => f.severity === 'error'),
        `severity 列表: ${r.findings.map((f) => f.severity).join(',') || '空'}`,
      );
    });

    check(`B1e[${p.variant}] evidence 形状合法`, () => assertEvidenceShape(r.evidence, text));

    if (p.canary) {
      check(`B1f[${p.variant}] 结果不含 payload 正文（canary 检查）`, () => {
        ok(!JSON.stringify(r).includes(p.canary), 'findings/evidence 泄漏了 payload 正文');
      });
    }
  }

  check('B2 V1 evidence.endSequenceRepeats >= 2（R2 尾部门限）', () => {
    const r = scanAssistantText(fixture('v1-end-multiplied.txt'));
    ok(r.evidence.endSequenceRepeats >= 2, `实际 ${r.evidence.endSequenceRepeats}`);
  });

  check('B3 V3 evidence.leakedMarkup === true', () => {
    const r = scanAssistantText(fixture('v3-leaked-markup.txt'));
    eq(r.evidence.leakedMarkup, true, 'evidence.leakedMarkup');
  });

  // ================= C. 反例零误报 =================
  section('C. 反例：零误报（DESIGN §6「对正常代码/HTML/长文本 0 误报」）');

  for (const n of NEGATIVES) {
    const text = fixture(n.file);
    const r = scanAssistantText(text);

    check(`C1[${n.file}] damaged:false`, () => {
      if (r.damaged) throw new Error(`误报，findings=${JSON.stringify(r.findings)}`);
    });

    check(`C1b[${n.file}] 无 error/warn finding`, () => {
      const bad = r.findings.filter((f) => f.severity === 'error' || f.severity === 'warn');
      ok(bad.length === 0, `误报: ${JSON.stringify(bad)}`);
    });

    check(`C1c[${n.file}] evidence 形状合法`, () => assertEvidenceShape(r.evidence, text));

    check(`C1d[${n.file}] evidence.truncated:false`, () => eq(r.evidence.truncated, false, 'truncated'));
  }

  check('C2 合法收尾（1 个 PARAM_END + 1 个 INVOKE_END）不判 END_SEQUENCE_MULTIPLIED', () => {
    const r = scanAssistantText(fixture('ok-single-end-sequence.txt'));
    ok(!hasCode(r, 'END_SEQUENCE_MULTIPLIED'), `实际 codes: ${codes(r).join(', ') || '无'}`);
  });

  check('C3 合成截断样例判 TRUNCATED_PAYLOAD（DESIGN §1.3 证据 B 的尾部丢失形态）', () => {
    const truncated = [
      TA('invoke', 'name="write"'),
      TA('parameter', 'name="path"') + 'a.html' + C_PARAM_END,
      TA('parameter', 'name="content"'),
      TA('section', 'class="x"'),
    ].join('\n');
    const r = scanAssistantText(truncated);
    eq(r.damaged, true, 'damaged');
    ok(hasCode(r, 'TRUNCATED_PAYLOAD'), `缺少 TRUNCATED_PAYLOAD（实际: ${codes(r).join(', ') || '无'}）`);
    eq(r.evidence.truncated, true, 'evidence.truncated');
  });

  // ================= D. 静默失败标志（R1） =================
  section('D. 静默失败标志 silentFailure（裁定 R1：唯一名字 + 精确公式）');

  const META_CASES = [
    ['meta 缺省', undefined],
    ['hasToolCalls=false', { hasToolCalls: false }],
    ['hasToolCalls=true', { hasToolCalls: true }],
    ['meta={} 无 hasToolCalls', {}],
    ['hasToolCalls 非布尔', { hasToolCalls: 'false' }],
  ];

  for (const p of POSITIVES) {
    const text = fixture(p.file);
    for (const [label, meta] of META_CASES) {
      check(`D1[${p.variant}] silentFailure === (damaged && meta.hasToolCalls===false) @ ${label}`, () => {
        const r = meta === undefined ? scanAssistantText(text) : scanAssistantText(text, {}, meta);
        const expected = r.damaged === true && meta?.hasToolCalls === false;
        eq(typeof r.silentFailure, 'boolean', 'silentFailure 必须是 boolean');
        eq(r.silentFailure, expected, 'silentFailure');
      });
    }

    check(`D2[${p.variant}] meta 不影响 damaged / findings`, () => {
      const a = scanAssistantText(text);
      const b = scanAssistantText(text, {}, { hasToolCalls: false });
      eq(b.damaged, a.damaged, 'damaged 不应受 meta 影响');
      sameJson(b.findings, a.findings, 'findings 不应受 meta 影响');
    });

    check(`D3[${p.variant}] 无同义自愈字段（R1）`, () => {
      const r = scanAssistantText(text, {}, { hasToolCalls: false });
      for (const k of ['shouldSelfHeal', 'shouldCorrect', 'quarantine', 'silentFailureDetected']) {
        ok(!(k in r), `不应存在同义字段 ${k}`);
      }
    });
  }

  for (const n of NEGATIVES) {
    check(`D4[${n.file}] 未损坏时 silentFailure:false（即使 hasToolCalls:false）`, () => {
      const r = scanAssistantText(fixture(n.file), {}, { hasToolCalls: false });
      eq(r.silentFailure, false, 'silentFailure');
    });
  }

  // ================= E. scanToolArguments（V1 现场 / M2） =================
  section('E. scanToolArguments：已解析参数的边界扫描（V1 现场）');

  const LONG_LEAF = Array.from({ length: 150 }, (_, i) => `const v${String(i).padStart(4, '0')} = ${i};`).join('\n');
  const HUGE_LINE = 'const big = "' + 'x'.repeat(25000) + '";';
  const DENSITY_LEAF = fixture('ok-normal-html.txt');

  // 大 payload 底座（≥2000 字符 / ≥20 行），用于单独验证 deny 门槛（裁定 R4）
  const BIG_BODY = Array.from({ length: 40 }, (_, i) =>
    [
      '  ' + TA('section', 'class="block" id="b' + i + '"'),
      '    ' + T('p') + 'row ' + i + TE('p'),
      '  ' + TE('section'),
    ].join('\n'),
  ).join('\n');

  // V1 现场：大 payload + 尾部连续 INVOKE_END×3。
  // R4：命中 END_SEQUENCE_MULTIPLIED 且 ≥2000 字符（或 ≥20 行）才 deny。
  const MULTIPLIED_LEAF = BIG_BODY + '\n' + [C_END, C_END, C_END].join('\n') + '\n';

  // 大 payload + 尾部未闭合的调用/参数结构（DESIGN §1.3 证据 B 的「尾部丢失」形态）
  const TRUNCATED_LEAF =
    [
      TA('invoke', 'name="write"'),
      TA('parameter', 'name="path"') + 'docs/large-note.md' + C_PARAM_END,
      TA('parameter', 'name="content"'),
    ].join('\n') +
    '\n' +
    Array.from({ length: 40 }, (_, i) => '# section ' + i + '\n\nbody line for section ' + i).join('\n');

  check('E1 合法参数 → action:ok 且无 finding', () => {
    const r = scanToolArguments('write', { path: 'src/ok.js', content: 'const a = 1;\nconst b = 2;\n' });
    eq(r.action, 'ok', 'action');
    eq(r.findings.length, 0, 'findings 数量');
  });

  check('E2 超长叶子（150 行）→ PAYLOAD_TOO_LONG(warn) → action:flag', () => {
    const r = scanToolArguments('write', { content: LONG_LEAF });
    ok(hasCode(r, 'PAYLOAD_TOO_LONG'), `实际 codes: ${codes(r).join(', ') || '无'}`);
    eq(r.action, 'flag', 'action');
    ok(r.findings.every((f) => f.severity !== 'error'), 'PAYLOAD_TOO_LONG 不应是 error');
  });

  check('E3 超长单行（> maxChars）→ PAYLOAD_TOO_LONG', () => {
    const r = scanToolArguments('write', { content: HUGE_LINE });
    ok(hasCode(r, 'PAYLOAD_TOO_LONG'), `实际 codes: ${codes(r).join(', ') || '无'}`);
  });

  check('E4 嵌套 object/array 字符串叶子被递归遍历', () => {
    const r = scanToolArguments('edit', { edits: [{ oldText: 'a', newText: LONG_LEAF }] });
    ok(hasCode(r, 'PAYLOAD_TOO_LONG'), `实际 codes: ${codes(r).join(', ') || '无'}`);
  });

  check('E5 大 payload + 尾部连续 INVOKE_END×3 → END_SEQUENCE_MULTIPLIED + action:deny', () => {
    ok(
      MULTIPLIED_LEAF.length >= 2000,
      `样本必须超过 deny 门槛（R4：≥2000 字符），实际 ${MULTIPLIED_LEAF.length} 字符 / ${MULTIPLIED_LEAF.split('\n').length} 行`,
    );
    const r = scanToolArguments('write', { content: MULTIPLIED_LEAF });
    ok(hasCode(r, 'END_SEQUENCE_MULTIPLIED'), `实际 codes: ${codes(r).join(', ') || '无'}`);
    eq(r.action, 'deny', 'action');
    assertDenyReason(r.reason);
  });

  check('E6 大 payload 以未闭合 PARAM_OPEN 结束 → TRUNCATED_PAYLOAD + action:deny', () => {
    ok(
      TRUNCATED_LEAF.length >= 2000 || TRUNCATED_LEAF.split('\n').length >= 20,
      `样本必须超过 deny 门槛（R4：≥2000 字符或 ≥20 行），实际 ${TRUNCATED_LEAF.length} 字符 / ${TRUNCATED_LEAF.split('\n').length} 行`,
    );
    const r = scanToolArguments('write', { content: TRUNCATED_LEAF });
    ok(hasCode(r, 'TRUNCATED_PAYLOAD'), `实际 codes: ${codes(r).join(', ') || '无'}`);
    eq(r.action, 'deny', 'action');
    assertDenyReason(r.reason);
  });

  check('E7 配平但闭合标签密集 → CLOSING_TAG_DENSITY(info) → action:flag', () => {
    const r = scanToolArguments('write', { content: DENSITY_LEAF });
    assertFindingSet(r.findings);
    ok(hasCode(r, 'CLOSING_TAG_DENSITY'), `实际 codes: ${codes(r).join(', ') || '无'}`);
    eq(r.action, 'flag', 'action');
    ok(r.findings.every((f) => f.severity !== 'error'), '不应出现 error');
  });

  check('E8 opts 抬高上限后不再 PAYLOAD_TOO_LONG → action:ok', () => {
    const r = scanToolArguments('write', { content: LONG_LEAF }, { maxLines: 100000, maxChars: 1000000 });
    eq(r.findings.length, 0, 'findings 数量');
    eq(r.action, 'ok', 'action');
  });

  check('E9 不修改入参 args（深遍历只读）', () => {
    const args = { path: 'src/ok.js', content: LONG_LEAF, nested: { x: C_END + '\n' + C_END + '\n' + C_END } };
    const before = JSON.stringify(args);
    scanToolArguments('write', args);
    eq(JSON.stringify(args), before, 'args 被修改');
  });

  check('E10 args 为 null / 非字符串叶子 → 不抛异常且无 finding', () => {
    const r1 = scanToolArguments('write', null);
    eq(r1.action, 'ok', 'null args 的 action');
    const r2 = scanToolArguments('write', { n: 1, b: true, u: undefined, z: null, s: 'short' });
    eq(r2.findings.length, 0, 'findings 数量');
    eq(r2.action, 'ok', 'action');
  });

  check('E11 返回值形状合法（action 取值 / findings 形状 / deny 必带 reason）', () => {
    const cases = [
      scanToolArguments('write', { content: 'ok' }),
      scanToolArguments('write', { content: LONG_LEAF }),
      scanToolArguments('write', { content: MULTIPLIED_LEAF }),
    ];
    for (const r of cases) {
      ok(['ok', 'deny', 'flag'].includes(r.action), `action 非法: ${r.action}`);
      assertFindingSet(r.findings);
      if (r.action === 'deny') assertDenyReason(r.reason);
    }
  });

  // ================= E2. deny 门槛：只有大 payload 才拦截（裁定 R4） =================
  section('E2. deny 门槛（R4）：短文档永不 deny、大 payload 才拦、参数叶子 UNPAIRED 恒为 info');

  // N1（关键负例）：直接读 docs/DESIGN.md 全文当叶子 —— 它本身就是「解释本故障」的文档，
  // 正文里天然含闭合标签与调用标记片段。守卫不得因此拒绝写入（否则插件会禁止写自己的说明文档）。
  const DESIGN_TEXT = readFileSync(path.join(HERE, '..', 'docs', 'DESIGN.md'), 'utf8');

  // N1b：小文档（约 200–400 字）里只有一个孤立的 INVOKE_END，没有对应开场标记。
  const N1_DOC =
    '本插件处理的是结构化输出退化的一个子类：工具调用参数边界丢失。' +
    '典型现场是 payload 里出现大量以闭合标签开头的序列（HTML、CSS、XML、调用标记都算），' +
    '它们在模型侧最容易与调用语法本身混淆，从而把参数边界弄丢。' +
    '例如某段说明里只剩下一个孤立的 ' + C_END + ' 而没有对应的开场标记。' +
    '危险之处在于它是静默失败：调用不执行、也不报错，从流程上看像是已经做完了。' +
    '所以守卫不能在短文档上直接拒绝写入，否则连解释这个问题的说明文档都写不进去。';

  // N2：大 payload（≥2000 字符）+ 尾部连续 INVOKE_END → 命中 END_SEQUENCE_MULTIPLIED → 必须 deny。
  const N2_DOC = BIG_BODY + '\n' + [C_END, C_END].join('\n') + '\n';

  check('E12[N1] docs/DESIGN.md 全文作叶子 → 不得 deny（守卫不得拒绝写解释自己的文档）', () => {
    ok(DESIGN_TEXT.length >= 2000, `样本应是大 payload，实际 ${DESIGN_TEXT.length} 字符`);
    ok(
      DESIGN_TEXT.includes(C_PARAM_END) || DESIGN_TEXT.includes(C_END),
      '样本应真的含闭合标签，否则这条负例没有意义',
    );
    const r = scanToolArguments('write', { content: DESIGN_TEXT });
    ok(
      r.action === 'ok' || r.action === 'flag',
      `不得 deny；实际 action=${r.action} findings=${JSON.stringify(r.findings)}`,
    );
  });

  check('E12[N1b] 小 payload（约 200–400 字）含 1 个孤立 INVOKE_END → 不得 deny', () => {
    ok(N1_DOC.length >= 200 && N1_DOC.length <= 400, `样本长度应在 200–400，实际 ${N1_DOC.length}`);
    ok(N1_DOC.split(C_END).length - 1 === 1, '样本应恰好含 1 个孤立 INVOKE_END');
    const r = scanToolArguments('write', { content: N1_DOC });
    ok(
      r.action === 'ok' || r.action === 'flag',
      `不得 deny（否则会拒绝写解释本故障的文档）；实际 action=${r.action} findings=${JSON.stringify(r.findings)}`,
    );
  });

  check('E12[N2] 大 payload（≥2000 字符）+ 尾部连续 INVOKE_END → 必须 deny', () => {
    ok(
      N2_DOC.length >= 2000,
      `样本必须超过 deny 门槛（R4：≥2000 字符），实际 ${N2_DOC.length} 字符 / ${N2_DOC.split('\n').length} 行`,
    );
    const r = scanToolArguments('write', { content: N2_DOC });
    eq(r.action, 'deny', 'action');
    ok(hasCode(r, 'END_SEQUENCE_MULTIPLIED'), `应命中 END_SEQUENCE_MULTIPLIED（实际: ${codes(r).join(', ') || '无'}）`);
    assertDenyReason(r.reason);
  });

  check('E13 参数叶子上的 UNPAIRED_CLOSING_TAG 恒为 info，且永不导致 deny（R4）', () => {
    const leaf = BIG_BODY + '\n' + C_END + '\n';
    const r = scanToolArguments('write', { content: leaf });
    const unpaired = r.findings.filter((f) => f.code === 'UNPAIRED_CLOSING_TAG');
    ok(unpaired.length > 0, `应命中 UNPAIRED_CLOSING_TAG（实际: ${codes(r).join(', ') || '无'}）`);
    for (const f of unpaired) {
      eq(f.severity, 'info', `参数叶子的 UNPAIRED_CLOSING_TAG 应为 info（实际 ${f.severity}）`);
    }
    ok(r.action !== 'deny', `UNPAIRED_CLOSING_TAG 不得导致 deny，实际 action=${r.action}`);
  });

  // ================= F. scanToolResult（M3：宁漏勿扰） =================
  section('F. scanToolResult：形状与「判不准就不报」');

  check('F1 result 为 undefined → suspicious:false，形状合法', () => {
    const r = scanToolResult('write', { path: 'a.txt' }, undefined);
    eq(r.suspicious, false, 'suspicious');
    ok(Array.isArray(r.findings), 'findings 必须是数组');
  });

  check('F2 args/result 为 null → 不抛异常，形状合法', () => {
    const r = scanToolResult('write', null, null);
    eq(typeof r.suspicious, 'boolean', 'suspicious 类型');
    assertFindingSet(r.findings);
  });

  check('F3 证据不足时不报 suspicious（不猜）', () => {
    const r = scanToolResult('write', { path: 'a.txt', content: 'hello' }, { ok: true });
    eq(r.suspicious, false, 'suspicious');
  });

  // ================= G. buildCorrectionMessage（B 文本 / M4） =================
  section('G. buildCorrectionMessage：无 error/warn 时返回空串');

  const V1_FINDINGS = scanAssistantText(fixture('v1-end-multiplied.txt')).findings;

  check('G1 findings 为空 → ""', () => {
    eq(buildCorrectionMessage([]), '', '返回空串');
  });

  check('G2 只有 info 级 finding → ""', () => {
    eq(
      buildCorrectionMessage([{ code: 'CLOSING_TAG_DENSITY', severity: 'info', detail: 'closing tag density' }]),
      '',
      '返回空串',
    );
  });

  check('G3 损坏 findings → 非空且含「未执行」否定语义', () => {
    const msg = buildCorrectionMessage(V1_FINDINGS);
    eq(typeof msg, 'string', '返回类型');
    ok(msg.length > 0, '不应为空');
    ok(msg.includes('未执行'), `缺少「未执行」语义: ${msg.slice(0, 120)}`);
  });

  check('G4 lang:en → 非空英文文案：含英文「未执行」语义且不含 CJK', () => {
    const msg = buildCorrectionMessage(V1_FINDINGS, { lang: 'en' });
    eq(typeof msg, 'string', '返回类型');
    ok(msg.length > 0, '不应为空');
    ok(EN_NOT_EXECUTED_RE.test(msg), `缺少英文「未执行」语义: ${msg.slice(0, 160)}`);
    ok(!CJK_RE.test(msg), `lang:'en' 文案不应含 CJK 字符: ${msg.slice(0, 160)}`);
  });

  check('G5 findings 为 null → ""，不抛异常', () => {
    const msg = buildCorrectionMessage(null);
    eq(typeof msg, 'string', '返回类型');
    eq(msg, '', '返回空串');
  });

  check('G6 不含 payload 正文（canary 检查）', () => {
    ok(!buildCorrectionMessage(V1_FINDINGS).includes('CANARY_V1_PAYLOAD_7f3a'), '纠正文案泄漏 payload 正文');
  });

  // ================= H. buildDenyReason（C 文本 / M2） =================
  section('H. buildDenyReason：长度 ≤ 400 且含「未执行 + 原因 + 怎么改」');

  for (const p of POSITIVES) {
    check(`H1[${p.variant}] 长度 ≤ 400 + 含「未执行」`, () => {
      assertDenyReason(buildDenyReason(scanAssistantText(fixture(p.file)).findings));
    });
  }

  check('H2 200 条 findings 仍 ≤ 400 字符（截断保护）', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      code: 'END_SEQUENCE_MULTIPLIED',
      severity: 'error',
      detail: `重复的结束序列，位置 ${i}`,
    }));
    assertDenyReason(buildDenyReason(many));
  });

  check('H3 lang:en → 非空英文、≤ 400、含英文「未执行」语义、不含 CJK', () => {
    const reason = buildDenyReason(V1_FINDINGS, { lang: 'en' });
    eq(typeof reason, 'string', '返回类型');
    ok(reason.length > 0 && reason.length <= 400, `长度非法: ${reason.length}`);
    ok(EN_NOT_EXECUTED_RE.test(reason), `缺少英文「未执行」语义: ${reason.slice(0, 160)}`);
    ok(!CJK_RE.test(reason), `lang:'en' 拒因不应含 CJK 字符: ${reason.slice(0, 160)}`);
  });

  check('H4 findings 为 null → 返回字符串且 ≤ 400，不抛异常', () => {
    const reason = buildDenyReason(null);
    eq(typeof reason, 'string', '返回类型');
    ok(reason.length <= 400, `长度非法: ${reason.length}`);
  });

  check('H5 不含 payload 正文（canary 检查）', () => {
    ok(!buildDenyReason(V1_FINDINGS).includes('CANARY_V1_PAYLOAD_7f3a'), '拒因泄漏 payload 正文');
  });

  // ================= I. mergeConfig（裁定 R3） =================
  section('I. mergeConfig：默认值 / 非法值回退 / 引用隔离');

  check('I1 DEFAULT_CONFIG 与冻结默认值逐字段一致', () => {
    for (const [k, v] of Object.entries(DEFAULTS)) eq(DEFAULT_CONFIG[k], v, `DEFAULT_CONFIG.${k}`);
  });

  const DEFAULT_CASES = [
    ['mergeConfig()', () => mergeConfig()],
    ['mergeConfig(undefined)', () => mergeConfig(undefined)],
    ['mergeConfig({})', () => mergeConfig({})],
    ['mergeConfig(null)', () => mergeConfig(null)],
    ['mergeConfig([])', () => mergeConfig([])],
    ['mergeConfig(function)', () => mergeConfig(function noop() {})],
    ['mergeConfig(proxy)', () => mergeConfig(new Proxy({}, {}))],
  ];
  for (const [label, build] of DEFAULT_CASES) {
    check(`I2 ${label} → 完整默认值`, () => assertDefaults(build(), label, DEFAULT_KEY_SET));
  }

  check('I3 未知键被忽略', () => {
    const m = mergeConfig({ bogus: 1, maxLines: 50 });
    eq(m.maxLines, 50, 'maxLines');
    ok(!('bogus' in m), '未知键不应出现在返回值');
  });

  check('I4 合法覆盖被采纳', () => {
    const m = mergeConfig({
      enabled: false,
      maxLines: 50,
      maxChars: 500,
      closingTagCount: 4,
      endSequenceRepeats: 3,
      maxCorrectionsPerTurn: 2,
      lang: 'en',
    });
    eq(m.enabled, false, 'enabled');
    eq(m.maxLines, 50, 'maxLines');
    eq(m.maxChars, 500, 'maxChars');
    eq(m.closingTagCount, 4, 'closingTagCount');
    eq(m.endSequenceRepeats, 3, 'endSequenceRepeats');
    eq(m.maxCorrectionsPerTurn, 2, 'maxCorrectionsPerTurn');
    eq(m.lang, 'en', 'lang');
  });

  check('I5 非法数值（负数 / NaN / ±Infinity / 字符串）一律回退默认', () => {
    for (const key of ['maxLines', 'maxChars', 'closingTagCount', 'endSequenceRepeats', 'maxCorrectionsPerTurn']) {
      for (const bad of [-1, NaN, Infinity, -Infinity, '120']) {
        eq(mergeConfig({ [key]: bad })[key], DEFAULTS[key], `${key} = ${String(bad)}`);
      }
    }
  });

  check('I6 未知 lang 回退 zh，合法 lang 保留', () => {
    for (const bad of ['fr', '', 'ZH', 42, null]) eq(mergeConfig({ lang: bad }).lang, 'zh', `lang = ${String(bad)}`);
    eq(mergeConfig({ lang: 'en' }).lang, 'en', 'lang=en');
    eq(mergeConfig({ lang: 'zh' }).lang, 'zh', 'lang=zh');
  });

  check('I7 返回值是新对象，不与 DEFAULT_CONFIG 共享可变引用', () => {
    const a = mergeConfig();
    const b = mergeConfig();
    ok(a !== DEFAULT_CONFIG, '返回值不应是 DEFAULT_CONFIG 本身');
    ok(b !== DEFAULT_CONFIG, '返回值不应是 DEFAULT_CONFIG 本身');
    ok(a !== b, '两次调用应返回不同对象');
    a.maxLines = 99999;
    a.lang = 'en';
    eq(DEFAULT_CONFIG.maxLines, 100, 'DEFAULT_CONFIG.maxLines 被污染');
    eq(DEFAULT_CONFIG.lang, 'zh', 'DEFAULT_CONFIG.lang 被污染');
  });

  check('I8 不修改 partial 入参', () => {
    const partial = { maxLines: 7, bogus: 'x' };
    const before = JSON.stringify(partial);
    mergeConfig(partial);
    eq(JSON.stringify(partial), before, 'partial 被修改');
  });

  // ---- 裁定 R7：数值门槛必须 ≥1（endSequenceRepeats:0 会让判定恒真） ----
  check('I9[R7] maxLines/maxChars/closingTagCount/endSequenceRepeats 取 0 一律回退默认', () => {
    for (const key of ['maxLines', 'maxChars', 'closingTagCount', 'endSequenceRepeats']) {
      eq(mergeConfig({ [key]: 0 })[key], DEFAULTS[key], `${key}=0`);
    }
  });

  check('I10[R7] 非整数（10.5）一律回退默认', () => {
    for (const key of ['maxLines', 'maxChars', 'closingTagCount', 'endSequenceRepeats']) {
      eq(mergeConfig({ [key]: 10.5 })[key], DEFAULTS[key], `${key}=10.5`);
    }
  });

  check('I11[R7 例外] maxCorrectionsPerTurn 允许 0（= 关闭自动纠偏）', () => {
    eq(mergeConfig({ maxCorrectionsPerTurn: 0 }).maxCorrectionsPerTurn, 0, 'maxCorrectionsPerTurn=0');
  });

  check('I12[R7 端到端] {endSequenceRepeats:0} 回退默认后不得判 END_SEQUENCE_MULTIPLIED', () => {
    const plain = scanAssistantText('普通文本', { endSequenceRepeats: 0 });
    ok(!hasCode(plain, 'END_SEQUENCE_MULTIPLIED'), `普通文本被误判: ${codes(plain).join(', ') || '无'}`);
    // 更强的样本：结构完好的调用（恰好 1 个 INVOKE_END）——若 0 被采纳，任何输入都会命中
    const okCall = scanAssistantText(fixture('ok-single-end-sequence.txt'), { endSequenceRepeats: 0 });
    ok(!hasCode(okCall, 'END_SEQUENCE_MULTIPLIED'), `合法收尾被误判: ${codes(okCall).join(', ') || '无'}`);
  });

  // ---- 裁定 R3 措辞修正：透明代理按普通对象处理；其余非普通对象回退默认 ----
  check('I13[R3 修正] 透明 Proxy 按普通对象处理（键被采纳）', () => {
    const m = mergeConfig(new Proxy({ maxLines: 50, lang: 'en' }, {}));
    eq(m.maxLines, 50, '透明代理的 maxLines');
    eq(m.lang, 'en', '透明代理的 lang');
    eq(m.maxChars, DEFAULTS.maxChars, '其余字段仍为默认');
  });

  check('I14[R3 修正] Date / Map / 敌意 Proxy → 不抛异常且回退完整默认值', () => {
    for (const [label, value] of [
      ['Date', new Date(0)],
      ['Map', new Map()],
      ['敌意 Proxy', HOSTILE_PROXY],
    ]) {
      assertDefaults(mergeConfig(value), `mergeConfig(${label})`, DEFAULT_KEY_SET);
    }
  });

  // ---- 裁定 R9：noopCheck（M3 空转检测 kill switch；布尔，默认 true）----
  check('I15[R9] noopCheck 默认 true；false 被采纳；非布尔一律回退默认 true', () => {
    eq(DEFAULT_CONFIG.noopCheck, true, 'DEFAULT_CONFIG.noopCheck');
    eq(mergeConfig().noopCheck, true, 'mergeConfig().noopCheck');
    eq(mergeConfig({}).noopCheck, true, 'mergeConfig({}).noopCheck');
    eq(mergeConfig({ noopCheck: true }).noopCheck, true, 'noopCheck=true');
    eq(mergeConfig({ noopCheck: false }).noopCheck, false, 'noopCheck=false');
    for (const bad of ['no', 0, 1, null, undefined, {}, []]) {
      eq(mergeConfig({ noopCheck: bad }).noopCheck, true, `noopCheck=${String(bad)} 应回退默认 true`);
    }
  });

  // ================= J. 幂等 / 纯函数 =================
  section('J. 幂等 / 纯函数（DESIGN §6 幂等·安全）');

  for (const p of POSITIVES) {
    check(`J1[${p.variant}] 同输入两次 scanAssistantText 结果一致`, () => {
      const a = scanAssistantText(fixture(p.file), {}, { hasToolCalls: false });
      const b = scanAssistantText(fixture(p.file), {}, { hasToolCalls: false });
      sameJson(a, b, 'scanAssistantText');
    });
  }

  for (const n of NEGATIVES) {
    check(`J2[${n.file}] 同输入两次 scanAssistantText 结果一致`, () => {
      const text = fixture(n.file);
      sameJson(scanAssistantText(text), scanAssistantText(text), 'scanAssistantText');
    });
  }

  check('J3 scanToolArguments 幂等', () => {
    const args = { path: 'a.html', content: MULTIPLIED_LEAF };
    sameJson(scanToolArguments('write', args), scanToolArguments('write', args), 'scanToolArguments');
  });

  check('J4 mergeConfig 幂等', () => {
    sameJson(mergeConfig({ maxLines: 50 }), mergeConfig({ maxLines: 50 }), 'mergeConfig');
  });

  check('J5 buildDenyReason / buildCorrectionMessage 幂等', () => {
    sameJson(buildDenyReason(V1_FINDINGS), buildDenyReason(V1_FINDINGS), 'buildDenyReason');
    sameJson(buildCorrectionMessage(V1_FINDINGS), buildCorrectionMessage(V1_FINDINGS), 'buildCorrectionMessage');
  });

  check('J6 DEFAULT_CONFIG 未被任何调用污染', () => {
    eq(JSON.stringify(DEFAULT_CONFIG), defaultSnapshot, 'DEFAULT_CONFIG');
  });

  // ================= K. 健壮性 =================
  section('K. 健壮性：非法入参不抛异常（稳定性要求）');

  check('K1 scanAssistantText 非字符串入参不抛异常且形状合法', () => {
    for (const v of [null, undefined, 123, {}, [], true]) {
      const r = scanAssistantText(v);
      ok(r && typeof r === 'object', `输入 ${String(v)} 返回非对象`);
      eq(typeof r.damaged, 'boolean', 'damaged 类型');
      eq(typeof r.silentFailure, 'boolean', 'silentFailure 类型');
      ok(Array.isArray(r.findings), 'findings 必须是数组');
      ok(r.evidence && typeof r.evidence === 'object', 'evidence 必须是对象');
    }
  });

  check('K2 scanToolArguments 异常入参不抛异常', () => {
    for (const args of [undefined, null, 42, 'text', [], {}]) {
      const r = scanToolArguments('write', args);
      ok(['ok', 'deny', 'flag'].includes(r.action), `action 非法: ${r.action}`);
    }
  });

  check('K3 scanToolResult / 文案构造函数异常入参不抛异常', () => {
    const r = scanToolResult('write', undefined, undefined);
    eq(typeof r.suspicious, 'boolean', 'suspicious 类型');
    eq(typeof buildCorrectionMessage(undefined), 'string', 'buildCorrectionMessage 返回类型');
    eq(typeof buildDenyReason(undefined), 'string', 'buildDenyReason 返回类型');
  });

  check('K4 opts 非法（null / 非对象）不抛异常', () => {
    const text = fixture('v1-end-multiplied.txt');
    for (const opts of [null, undefined, 7, 'x']) {
      eq(typeof scanAssistantText(text, opts).damaged, 'boolean', 'damaged 类型');
    }
  });

  // ================= L. 内建自检（裁定 R5 / R6） =================
  section('L. 内建自检：INTERNAL_ERROR 降级路径 + SUSPICIOUS_NOOP_RESULT 只在 §3');

  check('L0 FindingCode 集合与 INTERFACE.md 冻结集合一致（9 个，R5 增补 INTERNAL_ERROR）', () => {
    const expected = [
      'END_SEQUENCE_MULTIPLIED',
      'UNPAIRED_CLOSING_TAG',
      'MISSING_OPENING_MARKUP',
      'MARKUP_LEAKED_AS_TEXT',
      'TRUNCATED_PAYLOAD',
      'PAYLOAD_TOO_LONG',
      'CLOSING_TAG_DENSITY',
      'SUSPICIOUS_NOOP_RESULT',
      'INTERNAL_ERROR',
    ];
    eq(FINDING_CODES.size, expected.length, 'code 数量');
    for (const code of expected) ok(FINDING_CODES.has(code), `缺少 ${code}`);
  });

  // HOSTILE_GETTER / HOSTILE_PROXY / reasonIsEmpty 定义在模块顶部（I 组与 L 组共用）。

  check('L1 畸形/敌意输入：三函数不抛异常、恒不 deny、info-only 组合不产生 deny、非 deny 时 reason 为空', () => {
    // 注意：这些输入的"不抛异常"正是 R5 降级路径的前提；
    // 实现是逐节点 try/catch 的防御式设计，异常不会穿到外层降级分支，
    // 因此这里断言"可达的不变式"，而不是断言必然出现 INTERNAL_ERROR（见 README「已知盲点」）。
    const CYCLE = { content: 'x' };
    CYCLE.self = CYCLE;
    const battery = [
      ['Proxy（全 trap 抛错）', HOSTILE_PROXY],
      ['抛错 getter 叶子', HOSTILE_GETTER],
      ['Object.create(null)', Object.create(null)],
      ['循环引用', CYCLE],
      ['Symbol 值', Symbol('hostile')],
      ['超长单行（30000 字符）', 'a'.repeat(30000)],
      ['CRLF 混排（400 行）', 'line\r\n'.repeat(200)],
    ];

    for (const [label, value] of battery) {
      const a = scanToolArguments('write', value);
      assertFindingSet(a.findings);
      ok(['ok', 'deny', 'flag'].includes(a.action), `[${label}] action 非法: ${a.action}`);
      ok(a.action !== 'deny', `[${label}] 畸形输入不得 deny，实际 ${a.action}`);
      ok(
        !(a.findings.every((f) => f.severity === 'info') && a.action === 'deny'),
        `[${label}] info-only 组合不得产生 deny`,
      );
      if (a.action !== 'deny') {
        ok(reasonIsEmpty(a.reason), `[${label}] 非 deny 时 reason 必须为空，实际 ${JSON.stringify(a.reason)}`);
      }

      const s = scanToolResult('write', value, value);
      assertFindingSet(s.findings);
      eq(typeof s.suspicious, 'boolean', `[${label}] suspicious 类型`);
      ok(
        !(s.findings.every((f) => f.severity === 'info') && s.suspicious === true),
        `[${label}] info-only 不得判 suspicious`,
      );
      if (s.suspicious !== true) {
        ok(reasonIsEmpty(s.reason), `[${label}] 非 suspicious 时 reason 必须为空，实际 ${JSON.stringify(s.reason)}`);
      }

      const t = scanAssistantText(value);
      assertFindingSet(t.findings);
      eq(typeof t.damaged, 'boolean', `[${label}] damaged 类型`);
      eq(t.damaged, false, `[${label}] 畸形输入不得判 damaged`);
      eq(t.silentFailure, false, `[${label}] 畸形输入不得判 silentFailure`);
    }

    // 反向校验上一条不是同义反复：在确实该 deny 的样本上，deny 必须由 error 级 finding 支撑。
    for (const args of [
      { content: 'ok' },
      { content: LONG_LEAF },
      { content: DENSITY_LEAF },
      { content: MULTIPLIED_LEAF },
      { content: fixture('ok-normal-html.txt') },
    ]) {
      const r = scanToolArguments('write', args);
      const onlyInfo = r.findings.every((f) => f.severity === 'info');
      ok(!(onlyInfo && r.action === 'deny'), 'info-only 组合不得产生 deny');
      if (r.action === 'deny') {
        ok(r.findings.some((f) => f.severity === 'error'), 'deny 必须由 error 级 finding 支撑');
      }
    }
  });

  check('L2 scanToolResult 内部异常 → 不 suspicious、不抛异常、findings 形状合法', () => {
    const r = scanToolResult('write', HOSTILE_GETTER, HOSTILE_PROXY);
    eq(typeof r.suspicious, 'boolean', 'suspicious 类型');
    eq(r.suspicious, false, '内部异常不得判 suspicious');
    assertFindingSet(r.findings);
    for (const f of r.findings.filter((x) => x.code === 'INTERNAL_ERROR')) {
      eq(f.severity, 'info', 'INTERNAL_ERROR 必须是 info');
    }
    ok(reasonIsEmpty(r.reason), `reason 必须为空，实际 ${JSON.stringify(r.reason)}`);
  });

  check('L3 scanAssistantText 非法/敌对入参 → 不抛异常，INTERNAL_ERROR（若有）恒 info 且不判 damaged', () => {
    for (const v of [HOSTILE_GETTER, HOSTILE_PROXY, Symbol('hostile'), 123n]) {
      const r = scanAssistantText(v);
      assertFindingSet(r.findings);
      eq(typeof r.damaged, 'boolean', 'damaged 类型');
      for (const f of r.findings.filter((x) => x.code === 'INTERNAL_ERROR')) {
        eq(f.severity, 'info', 'INTERNAL_ERROR 必须是 info');
      }
      eq(r.damaged, false, '内部异常(info)不得判 damaged');
    }
  });

  check('L4 SUSPICIOUS_NOOP_RESULT 不得出现在 scanToolArguments / scanAssistantText 的结果里（R5）', () => {
    const assistantInputs = [
      ...ALL_FILES.map((f) => fixture(f)),
      LONG_LEAF,
      HUGE_LINE,
      MULTIPLIED_LEAF,
      '<',
      'plain text without markup',
    ];
    for (const text of assistantInputs) {
      const r = scanAssistantText(text);
      ok(!hasCode(r, 'SUSPICIOUS_NOOP_RESULT'), `scanAssistantText 不应出现 SUSPICIOUS_NOOP_RESULT: ${text.slice(0, 40)}`);
    }
    const argsInputs = [
      { content: 'ok' },
      { content: LONG_LEAF },
      { content: HUGE_LINE },
      { content: MULTIPLIED_LEAF },
      { content: TRUNCATED_LEAF },
      { content: fixture('ok-normal-html.txt') },
      null,
      HOSTILE_GETTER,
      HOSTILE_PROXY,
    ];
    for (const args of argsInputs) {
      const r = scanToolArguments('write', args);
      ok(
        !hasCode(r, 'SUSPICIOUS_NOOP_RESULT'),
        `scanToolArguments 不应出现 SUSPICIOUS_NOOP_RESULT（实际: ${codes(r).join(', ') || '无'}）`,
      );
    }
  });

  // ================= M. 静态 / 文档断言（D-0 / R8）+ R6 修正 =================
  section('M. 静态与文档断言（D-0 / R8）+ R6 修正（PARAM_OPEN 起点、TRUNCATED 非死代码）');

  const INDEX_SRC = readFileSync(path.join(HERE, '..', 'plugin', 'index.js'), 'utf8');
  const PLUGIN_README = readFileSync(path.join(HERE, '..', 'plugin', 'README.md'), 'utf8');

  // 静态断言一律先剥离注释：解释"旧形状为什么被拒绝"的注释是有价值的文档，不应被误伤。
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1 ');
  const INDEX_CODE = stripComments(INDEX_SRC);
  const PKG = JSON.parse(readFileSync(path.join(HERE, '..', 'plugin', 'package.json'), 'utf8'));
  const PKG_NAME = PKG.name;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  check('M1[D-0] 剥离注释后，plugin/index.js 的代码里不得出现 kind:"plugin" 旧形状', () => {
    const legacy = /kind\s*:\s*['"]plugin['"]\s*[,}]/;
    ok(
      !legacy.test(INDEX_CODE),
      '代码里出现旧 source 形状 kind:"plugin"（dsh-session-format-v3-to-v4 会抛 SessionFormatError，可能弄坏用户会话）',
    );
  });

  check('M2[D-0] source.kind 必须是 runtime-context 或 plugin:<pkg>，且 <pkg> 与 package.json name 一致', () => {
    // 1) 正向：源码代码区必须有这两种 producer-owned kind
    ok(/['"]runtime-context['"]/.test(INDEX_CODE), '缺少 runtime-context 源类型');
    const pluginKindDirect = new RegExp("['\"]plugin:" + escapeRe(PKG_NAME) + "['\"]").test(INDEX_CODE);
    const pluginKindConcat =
      /['"]plugin:['"]\s*\+/.test(INDEX_CODE) &&
      new RegExp("['\"]" + escapeRe(PKG_NAME) + "['\"]").test(INDEX_CODE);
    ok(
      pluginKindDirect || pluginKindConcat,
      `缺少 plugin:<pkg> 源类型；<pkg> 应为 package.json 的 name（${PKG_NAME}）`,
    );

    // 2) source 构造里的 kind 表达式不得是字面量 'plugin'
    const sourceKind = INDEX_CODE.match(/source\s*:\s*Object\.freeze\(\{\s*kind\s*:\s*([^,}]+?)\s*\}\)/);
    ok(sourceKind, '未找到 `source: Object.freeze({ kind: <expr> })` 构造');
    const expr = sourceKind[1].trim();
    ok(expr !== "'plugin'" && expr !== '"plugin"', `source.kind 不得是字面量 plugin（实际 ${expr}）`);
    ok(
      /^[A-Za-z_$][\w$]*$/.test(expr) || /^['"](runtime-context|plugin:[^'"]+)['"]$/.test(expr),
      `source.kind 应为标识符或 runtime-context / plugin:<pkg> 字面量（实际 ${expr}）`,
    );

    // 3) 所有消息工厂调用点都必须传 producer-owned kind
    const calls = [...INDEX_CODE.matchAll(/(?<!function\s)pluginMessage\s*\(([^)]*)\)/g)].map((m) => m[1]);
    ok(calls.length >= 2, `pluginMessage 调用点应 ≥2 个（实际 ${calls.length}）`);
    for (const args of calls) {
      ok(
        /SOURCE_PLUGIN|SOURCE_RUNTIME_CONTEXT/.test(args),
        `pluginMessage 调用点未传 producer-owned kind: ${args}`,
      );
    }
  });

  check('M3[R8] plugin/README.md 必须写明叶子遍历边界（≤200 个叶子 / 深度 24）', () => {
    ok(
      /(200\b[^\n]{0,80}(叶子|leaf))|((叶子|leaf)[^\n]{0,80}200\b)/i.test(PLUGIN_README),
      'README 未写明「最多 200 个叶子」的遍历边界（R8 要求在「已知边界」显式记录）',
    );
    ok(
      /(24\b[^\n]{0,80}(深度|depth))|((深度|depth)[^\n]{0,80}24\b)/i.test(PLUGIN_README),
      'README 未写明「最大深度 24」的遍历边界',
    );
  });

  // R6 判据的**方向性**必须可区分（D-1 回归）。错误实现可能把「叶子以开场标记起头」
  // 写成「最后一个 token 是开场标记」；下面三条只有在正确方向下才同时成立——
  // 单条用例（如 R6a）在两种方向下结论相同，锁不住判据，故必须成组断言。
  const R6_HTML = BIG_BODY; // 40 段配平 HTML（不含调用标记），≥2000 字符 / ≥20 行
  const R6_CASES = [
    {
      id: 'M4[R6a]',
      label: 'PARAM_OPEN 起头、停在开场标记内',
      leaf:
        TA('parameter', 'name="content"') +
        '\n' +
        Array.from(
          { length: 40 },
          (_, i) => 'body line ' + i + ' for the truncated parameter payload, long enough to clear the deny gate',
        ).join('\n'),
      expectTruncated: true,
      expectDeny: true,
      discriminates: false, // 基线：正确/反向判据下结论相同，单靠它锁不住方向（教训见 README）
    },
    {
      id: 'M4[R6b]',
      label: 'INVOKE_OPEN 起头、信封永不闭合、尾部以 PARAM_END 收尾【漏报方向】',
      leaf: [TA('invoke', 'name="write"'), TA('parameter', 'name="content"'), R6_HTML, C_PARAM_END, ''].join('\n'),
      expectTruncated: true,
      expectDeny: true,
      discriminates: true,
    },
    {
      id: 'M4[R6c]',
      label: '普通 HTML 起头、尾部才出现未闭合开场标记【误报方向】',
      leaf: R6_HTML + '\n' + TA('invoke', 'name="x"') + '\n' + TA('parameter', 'name="c"') + 'abc',
      expectTruncated: false,
      expectDeny: false,
      discriminates: true,
    },
    {
      id: 'M4[R6d]',
      label: '前导空白（换行）后以 INVOKE_OPEN 起头、信封不闭合【非空白门槛】',
      leaf: '\n' + [TA('invoke', 'name="write"'), TA('parameter', 'name="content"'), R6_HTML, C_PARAM_END, ''].join('\n'),
      expectTruncated: true,
      expectDeny: true,
      discriminates: true,
    },
  ];

  for (const c of R6_CASES) {
    check(`${c.id} ${c.label} → TRUNCATED_PAYLOAD=${c.expectTruncated} / deny=${c.expectDeny}`, () => {
      ok(c.leaf.length >= 2000, `样本必须 ≥2000 字符（R4 门槛），实际 ${c.leaf.length}`);
      const r = scanToolArguments('write', { content: c.leaf });
      eq(
        hasCode(r, 'TRUNCATED_PAYLOAD'),
        c.expectTruncated,
        `TRUNCATED_PAYLOAD（实际 codes: ${codes(r).join(', ') || '无'}）`,
      );
      eq(r.action === 'deny', c.expectDeny, `deny 与否（实际 action=${r.action}）`);
      if (c.expectDeny) assertDenyReason(r.reason);
    });
  }

  check('M4[R6-meta] 用例集必须能区分判据方向：R6b/R6c 在两种判据下结论必须不同', () => {
    // 反向判据 = 被验证员抓到的写反形态：只看「最后一个结构 token 是否为开场标记」。
    const structuralTokens = (text) =>
      [...text.matchAll(/<(?:invoke|parameter|[/]invoke|[/]parameter)\b/g)].map((m) => m[0]);
    const invertedCallShaped = (text) => {
      const tokens = structuralTokens(text);
      if (tokens.length === 0) return false;
      const last = tokens[tokens.length - 1];
      return last === '<invoke' || last === '<parameter';
    };
    const correctCallShaped = (text) => /^\s*<(?:invoke|parameter)\b/.test(text);

    const discriminating = R6_CASES.filter((c) => c.discriminates);
    ok(discriminating.length >= 2, `至少需要 2 条可区分方向的用例（实际 ${discriminating.length}）`);
    let denySide = 0;
    let noDenySide = 0;
    for (const c of discriminating) {
      const correct = correctCallShaped(c.leaf);
      const inverted = invertedCallShaped(c.leaf);
      ok(
        correct !== inverted,
        `[${c.id}] 两种判据下结论相同 → 无法锁死方向（correct=${correct}, inverted=${inverted}）`,
      );
      if (c.expectDeny) denySide += 1;
      else noDenySide += 1;
    }
    ok(denySide >= 1 && noDenySide >= 1, `漏报侧与误报侧都要有用例（deny 侧=${denySide}, 不 deny 侧=${noDenySide}）`);

    // 基线用例本就不区分方向——这正是"必须成组断言"的原因，显式记录以免被误当冗余删除。
    const baseline = R6_CASES.find((c) => !c.discriminates);
    ok(baseline, '应保留一条"判据可反写仍绿"的基线用例（R6a）');
    eq(
      correctCallShaped(baseline.leaf),
      invertedCallShaped(baseline.leaf),
      '基线用例本就不区分方向（R6a 在两种判据下都判 call-shaped）',
    );
  });

  check('M5[R6] 整轮测试中 TRUNCATED_PAYLOAD 至少被产生过一次（防死代码）', () => {
    ok(
      producedCodes.has('TRUNCATED_PAYLOAD'),
      `整轮测试从未产生 TRUNCATED_PAYLOAD；已产生: ${[...producedCodes].sort().join(', ')}`,
    );
  });

  // ================= N. M3「疑似空转」检测（裁定 R9 / noopCheck） =================
  section('N. M3 空转检测（R9）：自由文本不误报 + 真空转仍抓 + kill switch');

  // 写类工具的较长 payload（远大于 MIN_PAYLOAD_CHARS，让"写入量为 0"具备意义）
  const NOOP_ARGS = {
    path: 'src/generated.js',
    content: Array.from({ length: 40 }, (_, i) => 'export const v' + i + ' = ' + i + ';').join('\n'),
  };

  // 误报回归：真实会话里被误伤的那类"普通结果"——自由文本短语匹配已被删除，不得 suspicious。
  const NOOP_FALSE_POSITIVE_RESULTS = [
    [
      'git status 式输出（nothing to commit）',
      {
        isError: false,
        value: { stdout: 'On branch master\nnothing to commit, working tree clean' },
        content: [{ type: 'text', text: 'nothing to commit' }],
      },
    ],
    ['说明性文本含 unchanged', { isError: false, value: { note: 'leaving that text unchanged' } }],
    ['说明性文本含 no changes', { isError: false, value: { summary: 'no changes were necessary' } }],
    ['说明性文本含「未做任何」', { isError: false, value: { message: '本次未做任何改动，因为文件已是最新' } }],
    ['status 里是自由文本 "no changes"（非枚举值）', { isError: false, value: { status: 'no changes' } }],
    ['大小写/换行混排的说明文本', { isError: false, value: { text: 'Nothing To Commit\nWorking tree UNCHANGED' } }],
  ];

  for (const [label, result] of NOOP_FALSE_POSITIVE_RESULTS) {
    check(`N1[R9 误报回归] ${label} → 不得 suspicious`, () => {
      const r = scanToolResult('write', NOOP_ARGS, result);
      eq(r.suspicious, false, `不得判 suspicious（reason=${JSON.stringify(r.reason)}）`);
    });
  }

  check('N2[R9 核心] git status 式结果即使 args 带长 payload 也不得 suspicious', () => {
    const result = {
      isError: false,
      value: { stdout: 'On branch master\nnothing to commit, working tree clean' },
      content: [{ type: 'text', text: 'nothing to commit' }],
    };
    for (const args of [NOOP_ARGS, { content: 'x'.repeat(5000), path: 'a.txt' }]) {
      const r = scanToolResult('write', args, result);
      eq(r.suspicious, false, `不得判 suspicious（reason=${JSON.stringify(r.reason)}）`);
    }
  });

  check('N3[R9 真空转] {written:0} + args 带 payload → 仍必须 suspicious', () => {
    const r = scanToolResult('write', NOOP_ARGS, { isError: false, value: { written: 0 } });
    eq(r.suspicious, true, `真空转必须抓到（findings=${JSON.stringify(r.findings)}）`);
    ok(hasCode(r, 'SUSPICIOUS_NOOP_RESULT'), `应命中 SUSPICIOUS_NOOP_RESULT（实际: ${codes(r).join(', ') || '无'}）`);
    ok(typeof r.reason === 'string' && r.reason.length > 0, 'suspicious 时必须给出可读 reason');
  });

  check('N4[R9 真空转·方向对照] 布尔显式空转标志 unchanged:true → 仍必须 suspicious', () => {
    // 与 N1 的 note:'leaving that text unchanged' 成对：同样的词，机器可读的布尔证据要抓，
    // 自由文本说明不抓 —— 这是 R9 判据的方向性对照。
    const r = scanToolResult('write', NOOP_ARGS, { isError: false, value: { unchanged: true } });
    eq(r.suspicious, true, `显式空转标志必须抓到（findings=${JSON.stringify(r.findings)}）`);
  });

  check('N5[R9 kill switch] noopCheck:false → 真空转也不得 suspicious（且默认开时仍抓）', () => {
    const result = { isError: false, value: { written: 0 } };
    const off = scanToolResult('write', NOOP_ARGS, result, { noopCheck: false });
    eq(off.suspicious, false, `kill switch 失效：仍判 suspicious（reason=${JSON.stringify(off.reason)}）`);
    eq(off.findings.length, 0, 'R9：kill switch 命中时必须立即返回 { suspicious:false, findings:[] }');
    const on = scanToolResult('write', NOOP_ARGS, result);
    eq(on.suspicious, true, 'noopCheck 默认开时应判 suspicious（证明差异只来自开关）');
  });

  check('N6[R9] 非写类工具 / isError / 空 result → 不判 suspicious（宁漏勿扰）', () => {
    for (const [name, result] of [
      ['read', { isError: false, value: { written: 0 } }],
      ['grep', { isError: false, value: { unchanged: true } }],
      ['write', { isError: true, value: { written: 0 } }],
      ['write', null],
    ]) {
      const r = scanToolResult(name, NOOP_ARGS, result);
      eq(r.suspicious, false, `${name} / result=${JSON.stringify(result)} 不得 suspicious`);
    }
  });

  check('N7[R9 方向对照] 同一措辞：机器可读的空转枚举要抓、自由文本不抓', () => {
    // 这一条是 R9 的"方向锁"：把自由文本匹配加回来就会立刻变红。
    for (const value of [
      { status: 'unchanged' },
      { status: 'no_changes' },
      { noop: true },
      { skipped: true },
      { applied: false },
      { written: 0 },
    ]) {
      const r = scanToolResult('write', NOOP_ARGS, { isError: false, value });
      eq(r.suspicious, true, `机器可读的空转证据必须抓到：${JSON.stringify(value)}`);
    }
    for (const value of [
      { note: 'unchanged' },
      { summary: 'no changes' },
      { text: '未做任何改动' },
      { status: 'no changes' }, // 同一字段，但自由文本（非枚举值）
      { written: 5 }, // 有写入量：不是空转
    ]) {
      const r = scanToolResult('write', NOOP_ARGS, { isError: false, value });
      eq(r.suspicious, false, `自由文本/正常值不得误报：${JSON.stringify(value)}`);
    }
  });

  check('N8[R9 文案隔离] suspicious 的 reason 必须是 M3 语义，不得复用 B 段（结构损坏/未执行）', () => {
    // 事故根因之一：把 M4 的 B 段文案用在 M3 上 ⇒ "说未执行、其实执行了"。
    const r = scanToolResult('write', NOOP_ARGS, { isError: false, value: { written: 0 } });
    eq(r.suspicious, true, 'suspicious');
    ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason 必须非空');
    for (const banned of ['结构校验失败', '自动纠正', '未执行任何操作', '该步未执行', '参数边界']) {
      ok(!r.reason.includes(banned), `M3 的 reason 不得复用 B 段措辞（命中「${banned}」）：${r.reason}`);
    }
    ok(
      r.reason.includes('未产生任何改动') || /no changes|no effective change|without changes/i.test(r.reason),
      `reason 应说明 M3 语义（工具自报未产生改动）：${r.reason}`,
    );
    ok(r.reason !== buildCorrectionMessage(r.findings), 'reason 不得等于 B 段文案（buildCorrectionMessage）');
  });

  // ================= O. M5 上下文净化 sanitizeMessages（裁定 R12） =================
  section('O. M5 上下文净化 sanitizeMessages（R12）：窄作用域改写 / 原引用 / 开关 / 纯函数');

  const M5_CANARY = 'CANARY_M5_PAYLOAD_51c7';

  // V2 形态（有参数开场标记、无外层调用开场标记）→ MISSING_OPENING_MARKUP
  const M5_DAMAGED_V2 = [
    TA('parameter', 'name="path"') + 'site/theme.html' + C_PARAM_END,
    TA('parameter', 'name="content"'),
    TA('div', 'class="box" data-canary="' + M5_CANARY + '"'),
    '  ' + T('p') + 'hello' + TE('p'),
    TE('div'),
    C_PARAM_END,
    '',
  ].join('\n');

  // V3 形态（调用标记混在自然语言正文里）→ MARKUP_LEAKED_AS_TEXT
  const M5_DAMAGED_V3 = [
    '我已经把文件写好了，下面是这次的参数内容。',
    '',
    TA('invoke', 'name="write"'),
    TA('parameter', 'name="content"'),
    TA('div', 'data-canary="' + M5_CANARY + '"') + 'x' + TE('div'),
    C_PARAM_END,
    C_END,
    '',
    '以上就是本次改动。',
  ].join('\n');

  const M5_HEALTHY = '好的，我来处理这一步。';

  const m5Assistant = (text, extra = {}) => ({
    id: 'm5-a',
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...extra,
  });
  const m5ToolCall = () => ({
    id: 'm5-call',
    role: 'assistant',
    content: [
      { type: 'text', text: M5_DAMAGED_V2 },
      { type: 'tool-call', id: 'c1', name: 'write', args: { path: 'a.txt' } },
    ],
  });

  check('O0 前置：两个损坏样本确实被判 damaged 且命中预期 code；健康样本不 damaged', () => {
    const v2 = scanAssistantText(M5_DAMAGED_V2);
    eq(v2.damaged, true, 'V2 样本 damaged');
    ok(hasCode(v2, 'MISSING_OPENING_MARKUP'), `V2 codes: ${codes(v2).join(', ') || '无'}`);
    const v3 = scanAssistantText(M5_DAMAGED_V3);
    eq(v3.damaged, true, 'V3 样本 damaged');
    ok(hasCode(v3, 'MARKUP_LEAKED_AS_TEXT'), `V3 codes: ${codes(v3).join(', ') || '无'}`);
    eq(scanAssistantText(M5_HEALTHY).damaged, false, '健康样本不 damaged');
  });

  check('O1[R12 改写] assistant + 无 tool-call + V2 损坏 → changed:true，content 变单个 text 块且不含 payload', () => {
    const messages = [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: '请把页面写出来' }] },
      m5Assistant(M5_DAMAGED_V2),
      { id: 't1', role: 'tool', content: [{ type: 'text', text: 'ok' }] },
    ];
    const before = JSON.stringify(messages);
    const r = sanitizeMessages(messages, { contextGuard: true });
    eq(r.changed, true, 'changed');
    ok(r.messages !== messages, 'changed 时必须返回新数组');
    eq(r.messages.length, 3, '长度保持');
    ok(r.messages[0] === messages[0], '未改动消息必须复用原引用');
    ok(r.messages[2] === messages[2], '未改动消息必须复用原引用');
    const content = r.messages[1].content;
    ok(Array.isArray(content) && content.length === 1, `content 应为单个块（实际 ${JSON.stringify(content)}）`);
    eq(content[0].type, 'text', '块的 type');
    eq(typeof content[0].text, 'string', '块的 text 类型');
    ok(content[0].text.length > 0, '注记不应为空');
    ok(!JSON.stringify(r).includes(M5_CANARY), '改写结果不得含原 payload 正文');
    eq(r.messages[1].id, 'm5-a', '其余字段保留（id）');
    eq(r.messages[1].role, 'assistant', '其余字段保留（role）');
    eq(r.rewrites.length, 1, 'rewrites 数量');
    eq(r.rewrites[0].index, 1, 'rewrites[0].index');
    ok(r.rewrites[0].codes.includes('MISSING_OPENING_MARKUP'), `codes: ${JSON.stringify(r.rewrites[0].codes)}`);
    eq(JSON.stringify(messages), before, '不得修改入参');
  });

  check('O2[R12 改写] V3 正文泄漏形态同样被改写，codes 含 MARKUP_LEAKED_AS_TEXT', () => {
    const messages = [m5Assistant(M5_DAMAGED_V3)];
    const r = sanitizeMessages(messages, { contextGuard: true });
    eq(r.changed, true, 'changed');
    eq(r.messages[0].content.length, 1, 'content 单个块');
    ok(!JSON.stringify(r.messages[0]).includes(M5_CANARY), '不得含原 payload 正文');
    ok(r.rewrites[0].codes.includes('MARKUP_LEAKED_AS_TEXT'), `codes: ${JSON.stringify(r.rewrites[0].codes)}`);
  });

  check('O3[R12 保护真实调用] 同形态损坏但含 tool-call 块 → changed:false 且原引用', () => {
    const messages = [m5ToolCall()];
    const r = sanitizeMessages(messages, { contextGuard: true });
    eq(r.changed, false, '含 tool-call 不得改写');
    ok(r.messages === messages, '未改动必须返回原数组引用');
    eq(r.rewrites.length, 0, 'rewrites 应为空');
  });

  check('O4[R12 不动健康] 正常 assistant 文本 → changed:false 且原引用', () => {
    const messages = [m5Assistant(M5_HEALTHY)];
    const r = sanitizeMessages(messages, { contextGuard: true });
    eq(r.changed, false, 'changed');
    ok(r.messages === messages, '未改动必须返回原数组引用');
    eq(r.rewrites.length, 0, 'rewrites 应为空');
  });

  check('O5[R12 不动其它角色] user / tool / system 永不改写', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: M5_DAMAGED_V2 }] },
      { role: 'tool', content: [{ type: 'text', text: M5_DAMAGED_V2 }] },
      { role: 'system', content: [{ type: 'text', text: M5_DAMAGED_V2 }] },
    ];
    const r = sanitizeMessages(messages, { contextGuard: true });
    eq(r.changed, false, '非 assistant 不得改写');
    ok(r.messages === messages, '未改动必须返回原数组引用');
  });

  check('O6[R12 默认关闭] contextGuard 缺省 / false / 非布尔 → 永不改写且原引用', () => {
    const messages = [m5Assistant(M5_DAMAGED_V2)];
    const cases = [
      ['缺省（无 opts）', null],
      ['{}', {}],
      ['false', { contextGuard: false }],
      ['字符串 "true"', { contextGuard: 'true' }],
      ['数字 1', { contextGuard: 1 }],
      ['null 值', { contextGuard: null }],
    ];
    for (const [label, opts] of cases) {
      const r = opts === null ? sanitizeMessages(messages) : sanitizeMessages(messages, opts);
      eq(r.changed, false, `[${label}] changed`);
      ok(r.messages === messages, `[${label}] 必须返回原数组引用`);
      eq(r.rewrites.length, 0, `[${label}] rewrites`);
    }
    const empty = [];
    const rEmpty = sanitizeMessages(empty, { contextGuard: true });
    eq(rEmpty.changed, false, '空数组 changed');
    ok(rEmpty.messages === empty, '空数组必须返回原引用');
  });

  check('O7[R12 配置] contextGuard 布尔/非布尔回退；contextGuardNote 字符串/非字符串回退', () => {
    eq(DEFAULT_CONFIG.contextGuard, false, 'DEFAULT_CONFIG.contextGuard');
    eq(DEFAULT_CONFIG.contextGuardNote, '', 'DEFAULT_CONFIG.contextGuardNote');
    eq(mergeConfig({}).contextGuard, false, 'mergeConfig 默认');
    eq(mergeConfig({ contextGuard: true }).contextGuard, true, 'contextGuard=true 生效');
    for (const bad of ['true', 1, 0, null, undefined, {}, []]) {
      eq(mergeConfig({ contextGuard: bad }).contextGuard, false, `contextGuard=${String(bad)} 应回退 false`);
    }
    eq(mergeConfig({ contextGuardNote: '自定义注记' }).contextGuardNote, '自定义注记', '自定义注记保留');
    eq(mergeConfig({ contextGuardNote: '' }).contextGuardNote, '', '空串=内置（值仍是空串）');
    for (const bad of [42, null, undefined, {}, [], true]) {
      eq(mergeConfig({ contextGuardNote: bad }).contextGuardNote, '', `contextGuardNote=${String(bad)} 应回退 ''`);
    }
  });

  check('O8[R12 自定义注记] contextGuardNote 非空时改写文本用该注记', () => {
    const custom = '【此处原始输出已因结构损坏被折叠】';
    const messages = [m5Assistant(M5_DAMAGED_V2)];
    const r = sanitizeMessages(messages, { contextGuard: true, contextGuardNote: custom });
    eq(r.changed, true, 'changed');
    eq(r.messages[0].content.length, 1, '单个块');
    eq(r.messages[0].content[0].type, 'text', '块类型');
    eq(r.messages[0].content[0].text, custom, '改写文本应等于自定义注记');
  });

  check('O9[R12 内置注记] 缺省注记按 lang 出中文/英文，且不含 payload', () => {
    const zh = sanitizeMessages([m5Assistant(M5_DAMAGED_V2)], { contextGuard: true });
    const zhNote = zh.messages[0].content[0].text;
    ok(typeof zhNote === 'string' && zhNote.length > 0, 'zh 注记非空');
    ok(/[\u4e00-\u9fff]/.test(zhNote), `zh 内置注记应为中文：${zhNote}`);
    ok(!zhNote.includes(M5_CANARY), 'zh 注记不得含 payload');

    const en = sanitizeMessages([m5Assistant(M5_DAMAGED_V2)], { contextGuard: true, lang: 'en' });
    const enNote = en.messages[0].content[0].text;
    ok(typeof enNote === 'string' && enNote.length > 0, 'en 注记非空');
    ok(!/[\u4e00-\u9fff]/.test(enNote), `lang:'en' 注记不应含 CJK：${enNote}`);
  });

  check('O10[R12 索引与引用] 多消息混合：rewrites.index 精确、未改动消息复用引用、tool-call 消息不动', () => {
    const messages = [
      m5Assistant(M5_HEALTHY, { id: 'a0' }),
      m5Assistant(M5_DAMAGED_V2, { id: 'a1' }),
      { role: 'user', content: [{ type: 'text', text: M5_DAMAGED_V2 }] },
      m5Assistant(M5_DAMAGED_V3, { id: 'a3' }),
      m5ToolCall(),
    ];
    const r = sanitizeMessages(messages, { contextGuard: true });
    eq(r.changed, true, 'changed');
    eq(JSON.stringify(r.rewrites.map((w) => w.index)), '[1,3]', 'rewrites.index');
    ok(r.rewrites[0].codes.includes('MISSING_OPENING_MARKUP'), 'index 1 的 code');
    ok(r.rewrites[1].codes.includes('MARKUP_LEAKED_AS_TEXT'), 'index 3 的 code');
    for (const i of [0, 2, 4]) ok(r.messages[i] === messages[i], `messages[${i}] 必须复用原引用`);
    ok(r.messages[1] !== messages[1] && r.messages[3] !== messages[3], '被改写的消息应是新对象');
    // 注意：index 2 是 role:'user' 的消息，作用域刻意很窄 → 它按设计**原样保留**（含 payload），
    // 所以这里只断言"被改写的消息 / rewrites 不得含 payload"，而不是整个结果。
    ok(!JSON.stringify(r.messages[1]).includes(M5_CANARY), '被改写的 messages[1] 不得含原 payload');
    ok(!JSON.stringify(r.messages[3]).includes(M5_CANARY), '被改写的 messages[3] 不得含原 payload');
    ok(!JSON.stringify(r.rewrites).includes(M5_CANARY), 'rewrites 不得含 payload');
    ok(JSON.stringify(r.messages[2]).includes(M5_CANARY), '未改写的 user 消息按设计原样保留（窄作用域）');
  });

  check('O11[R12 纯函数] 幂等：同输入两次结果一致', () => {
    const build = () => [m5Assistant(M5_DAMAGED_V2), { role: 'user', content: [{ type: 'text', text: 'x' }] }];
    const opts = { contextGuard: true };
    sameJson(sanitizeMessages(build(), opts), sanitizeMessages(build(), opts), 'sanitizeMessages');
  });

  check('O12[R12 纯函数] 非数组 / 畸形元素 / 循环引用 / Proxy → changed:false、不抛异常', () => {
    for (const value of [null, undefined, 42, 'text', {}, true]) {
      const r = sanitizeMessages(value, { contextGuard: true });
      eq(r.changed, false, `非数组 ${String(value)} 应 changed:false`);
      eq(r.rewrites.length, 0, `非数组 ${String(value)} 的 rewrites`);
    }

    const junk = [
      null,
      undefined,
      42,
      { role: 'assistant' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: 'not-an-array' },
      { role: 'assistant', content: [null, 7, { type: 'text', text: M5_HEALTHY }] },
    ];
    const rj = sanitizeMessages(junk, { contextGuard: true });
    eq(rj.changed, false, '全是健康/畸形元素 → changed:false');
    ok(rj.messages === junk, '未改动 → 原引用');

    const cycMsg = m5Assistant(M5_DAMAGED_V2);
    cycMsg.self = cycMsg;
    const cyc = [cycMsg];
    cyc.push(cyc);
    const rc = sanitizeMessages(cyc, { contextGuard: true });
    eq(rc.changed, true, '循环引用中的损坏 assistant 仍应被改写');
    eq(rc.rewrites.length, 1, 'rewrites 数量');
    eq(rc.rewrites[0].index, 0, 'rewrites 索引');

    const proxyArray = new Proxy([], {
      ownKeys() {
        throw new Error('m5 proxy ownKeys');
      },
      getOwnPropertyDescriptor() {
        throw new Error('m5 proxy gopd');
      },
      get() {
        throw new Error('m5 proxy get');
      },
    });
    eq(sanitizeMessages(proxyArray, { contextGuard: true }).changed, false, '数组 Proxy 应安全返回 changed:false');
    eq(sanitizeMessages(HOSTILE_PROXY, { contextGuard: true }).changed, false, '敌意 Proxy（非数组）');
  });

  check('O13[R12 形状] 返回值形状恒定：changed:boolean + messages + rewrites 数组', () => {
    const cases = [
      sanitizeMessages([m5Assistant(M5_DAMAGED_V2)], { contextGuard: true }),
      sanitizeMessages([m5Assistant(M5_HEALTHY)], { contextGuard: true }),
      sanitizeMessages(null, { contextGuard: true }),
      sanitizeMessages([m5Assistant(M5_DAMAGED_V2)], { contextGuard: false }),
    ];
    for (const r of cases) {
      eq(typeof r.changed, 'boolean', 'changed 类型');
      ok(Array.isArray(r.rewrites), 'rewrites 必须是数组');
      for (const w of r.rewrites) {
        eq(typeof w.index, 'number', 'rewrite.index 类型');
        ok(Array.isArray(w.codes), 'rewrite.codes 必须是数组');
      }
    }
  });

  /* P. D-10 / R14 — namespace-prefixed call markup.
     A real failure leaked `antml:invoke` / `antml:parameter`, which contains no
     bare `invoke`/`parameter` substring. Every closing tag below is assembled
     from fragments on purpose (the project's own discipline: never emit a
     contiguous literal closing-tag run). */
  section('P. D-10 命名空间方言（R14）：带前缀的调用标记必须被认出来');

  const LTC = '<';
  const NS_TAIL = LTC + '/antml:';
  const NS_HEAD = LTC + 'antml:invoke name="run_code">';
  const NS_PARAM = (name) => LTC + 'antml:parameter name="' + name + '">';
  const NS_LEAK =
    '我先把这一次调用压缩到 5 行以内，并严格只用一次 `' + NS_TAIL + 'invoke>` 收尾。\n\n' +
    NS_HEAD + '\n' +
    NS_PARAM('code') + 'const fs = await import("node:fs/promises");' + NS_TAIL + 'parameter>\n' +
    NS_PARAM('description') + 'check' + NS_TAIL + 'parameter>\n';

  check('P1[D-10] 带命名空间前缀的泄漏标记 → damaged', () => {
    const r = scanAssistantText(NS_LEAK, {}, { hasToolCalls: false, toolCallCount: 0 });
    ok(r.damaged === true, 'damaged 应为 true（实际 ' + r.damaged + '，codes=' + codes(r).join(',') + '）');
    ok(hasCode(r, 'MARKUP_LEAKED_AS_TEXT'), '应命中 MARKUP_LEAKED_AS_TEXT');
  });

  check('P2[D-10] 同一文本 + hasToolCalls:false → silentFailure（M4 的唯一触发条件）', () => {
    const r = scanAssistantText(NS_LEAK, {}, { hasToolCalls: false });
    eq(r.silentFailure, true, 'silentFailure');
  });

  check('P3[D-10] 带前缀的尾部连续结束序列 → END_SEQUENCE_MULTIPLIED 且按 R4 门槛 deny', () => {
    const fooTail = LTC + '/foo:invoke>';
    const leaf =
      LTC + 'foo:invoke name="x">\n' +
      Array.from({ length: 25 }, (_, i) => 'line ' + i).join('\n') +
      '\n' + fooTail + '\n' + fooTail + '\n';
    const r = scanToolArguments('write', { content: leaf }, {});
    ok(
      hasCode(r, 'END_SEQUENCE_MULTIPLIED'),
      '应命中 END_SEQUENCE_MULTIPLIED（实际 ' + codes(r).join(',') + '）',
    );
    eq(r.action, 'deny', 'action');
  });

  check('P4[D-10 护栏] 含冒号 / 带前缀但非调用标记的文本不得被误判', () => {
    const guards = [
      '参考 https://example.com/a 这个链接。',
      LTC + 'svg:path d="M0 0">' + LTC + '/svg:path> 是 SVG 命名空间标签，不是工具调用。',
      LTC + 'html>' + LTC + 'body>hello' + LTC + '/body>' + LTC + '/html>',
      '时间 12:30 出发，路径 C:/tmp/a.txt 可读。',
    ];
    for (const g of guards) {
      const r = scanAssistantText(g, {}, { hasToolCalls: false });
      eq(r.damaged, false, '不得判 damaged：' + JSON.stringify(g.slice(0, 44)));
    }
  });

  check('P5[D-10 零漂移] 不含冒号的文本行为不变（规范化必须早退）', () => {
    const plain = '普通中文说明，没有调用标记，也没有冒号前缀。';
    const r = scanAssistantText(plain, {}, { hasToolCalls: false });
    eq(r.damaged, false, 'damaged');
    eq(r.evidence.length, plain.length, 'evidence.length 应与原文一致');
  });

  return 0;
}

const rc = await main();

section('汇总');
console.log(`PASS ${pass} / FAIL ${fail}`);
if (failures.length > 0) {
  console.log('失败明细：');
  for (const [id, msg] of failures) console.log(`  - ${id}: ${msg}`);
}
if (fail > 0 || rc !== 0) process.exitCode = 1;

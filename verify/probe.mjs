#!/usr/bin/env node
/**
 * verify/probe.mjs — INDEPENDENT adversarial verifier for plugin/src/detect.js
 *
 * Written by teammate `verifier`. This file does NOT import or reuse any
 * assertion logic from tests/ (per task-4). It imports only the module under
 * test and reads the fixtures as raw bytes.
 *
 * Contract under test: docs/INTERFACE.md (incl. rulings R1/R2/R3) + DESIGN §6.
 * This file never writes a contiguous literal closing tag: every tag token is
 * assembled from fragments, so the probe itself cannot become a payload.
 *
 * Exit code: 0 = all hard checks pass, 1 = at least one hard check failed.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DETECT_PATH = path.join(ROOT, 'plugin', 'src', 'detect.js');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

/* ---------------- tag tokens, always assembled from fragments ------------- */
const LT = '<';
const GT = '>';
const SL = '/';
const CLOSE_PREFIX = LT + SL;                       // the "</" prefix
const OPEN_INVOKE = LT + 'invoke';
const OPEN_PARAM = LT + 'parameter';
const END_INVOKE = LT + SL + 'invoke' + GT;
const END_PARAM = LT + SL + 'parameter' + GT;

const FROZEN_CODES = new Set([
  'END_SEQUENCE_MULTIPLIED',
  'UNPAIRED_CLOSING_TAG',
  'MISSING_OPENING_MARKUP',
  'MARKUP_LEAKED_AS_TEXT',
  'TRUNCATED_PAYLOAD',
  'PAYLOAD_TOO_LONG',
  'CLOSING_TAG_DENSITY',
  'SUSPICIOUS_NOOP_RESULT',
  'INTERNAL_ERROR', // added by ruling R5
]);

/* ---------------- result accounting --------------------------------------- */
let PASS = 0;
let FAIL = 0;
const FAILURES = [];
const NOTES = [];
const DEFECTS = [];
const CODES_SEEN = new Set();

function section(title) {
  console.log('\n== ' + title + ' ==');
}
function check(name, cond, extra = '') {
  if (cond) {
    PASS += 1;
    console.log('PASS  ' + name);
  } else {
    FAIL += 1;
    FAILURES.push({ name, extra });
    console.log('FAIL  ' + name + (extra ? '  :: ' + extra : ''));
  }
}
function note(name, text) {
  NOTES.push({ name, text });
  console.log('NOTE  ' + name + ' :: ' + text);
}
function defect(id, severity, title) {
  DEFECTS.push({ id, severity, title });
}

/* ---------------- helpers ------------------------------------------------- */
function snap(value, seen) {
  seen = seen || new WeakMap();
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'undefined') return '<undefined>';
  if (t === 'symbol') return '<symbol:' + String(value.description) + '>';
  if (t === 'bigint') return '<bigint:' + value.toString() + '>';
  if (t === 'function') return '<function>';
  if (seen.has(value)) return '<cycle>';
  seen.set(value, true);
  try {
    if (Array.isArray(value)) return value.map((x) => snap(x, seen));
  } catch {
    return '<unreadable>';
  }
  const out = {};
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    return '<unreadable>';
  }
  for (const k of keys) {
    let v;
    try {
      v = value[k];
    } catch {
      v = '<getter-threw>';
    }
    out[k] = snap(v, seen);
  }
  return out;
}
const snapStr = (v) => JSON.stringify(snap(v)) || '';
/** Canonical JSON with sorted keys, so object key order never matters. */
function canon(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}
function deepFreeze(v, seen) {
  seen = seen || new WeakSet();
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return v;
  seen.add(v);
  Object.freeze(v);
  for (const k of Object.keys(v)) {
    let c;
    try {
      c = v[k];
    } catch {
      continue;
    }
    deepFreeze(c, seen);
  }
  return v;
}
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}
function readFixture(name) {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}
function readMaybe(...parts) {
  try {
    return readFileSync(path.join(ROOT, ...parts), 'utf8');
  } catch {
    return null;
  }
}
function ms(fn) {
  const t0 = process.hrtime.bigint();
  const v = fn();
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  return { value: v, ms: dt };
}
const hasBlockingCodes = (findings, codes) =>
  Array.isArray(findings) && findings.some((f) => f && codes.includes(f.code));
const hasError = (findings) =>
  Array.isArray(findings) && findings.some((f) => f && f.severity === 'error');

/* collect every FindingCode seen in one return value, bucketed by entry point */
const CODES_BY_FN = { assistant: new Set(), args: new Set(), result: new Set(), other: new Set() };
let HB = 'other';
function harvest(res) {
  if (!res || typeof res !== 'object') return;
  const push = (f) => {
    if (f && typeof f.code === 'string') {
      CODES_SEEN.add(f.code);
      (CODES_BY_FN[HB] || CODES_BY_FN.other).add(f.code);
    }
  };
  if (Array.isArray(res.findings)) res.findings.forEach(push);
}
/* wrap a call: any throw is a hard failure */
function callNoThrow(label, fn) {
  let r;
  try {
    r = fn();
  } catch (e) {
    check(label + ' does not throw', false, 'THREW: ' + ((e && e.message) || String(e)));
    return undefined;
  }
  check(label + ' does not throw', true);
  return r;
}

/* ======================================================================== */
/* load module                                                              */
/* ======================================================================== */
const detect = await import(pathToFileURL(DETECT_PATH).href);
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

/* Pre-D-10 detector (extracted from git as verify/_pre-d10-detect.mjs) — used to
 * measure the D-10/R14 delta directly: only the namespace-dialect class may
 * change behaviour; every pre-existing input must be bit-identical. */
let preD10 = null;
try {
  preD10 = await import(pathToFileURL(path.join(HERE, '_pre-d10-detect.mjs')).href);
} catch { /* optional: corpus/delta checks are skipped when unavailable */ }

section('0. provenance');
const detectSrc = readFileSync(DETECT_PATH, 'utf8');
console.log('detect.js   sha256[0:16]=' + sha256(detectSrc) + '  bytes=' + Buffer.byteLength(detectSrc));
console.log('node        ' + process.version);
for (const f of ['v1-end-multiplied.txt', 'v2-missing-opening.txt', 'v3-leaked-markup.txt',
  'ok-normal-html.txt', 'ok-normal-js.txt', 'ok-normal-markdown-table.txt',
  'ok-short-text-few-tags.txt', 'ok-single-end-sequence.txt']) {
  const s = readFixture(f);
  console.log('fixture     ' + f.padEnd(32) + ' bytes=' + String(Buffer.byteLength(s)).padStart(6) + ' lines=' + (s.split('\n').length) + ' sha16=' + sha256(s));
}

/* ======================================================================== */
section('1. exports + DEFAULT_CONFIG (INTERFACE §暴露/§配置)');
/* ======================================================================== */
for (const [name, val] of Object.entries({
  DEFAULT_CONFIG, mergeConfig, scanAssistantText, scanToolArguments,
  scanToolResult, buildCorrectionMessage, buildDenyReason, sanitizeMessages,
})) {
  check('export ' + name + (name === 'DEFAULT_CONFIG' ? ' is object' : ' is function'),
    name === 'DEFAULT_CONFIG' ? typeof val === 'object' && val !== null : typeof val === 'function',
    'got ' + typeof val);
}
/*
 * Config key set: derived from the module (never a hardcoded key list), with the
 * documented VALUES frozen. R9 added `noopCheck`; R10 added `debugLog` /
 * `debugLogPath` (empty string => system temp dir); R12 added `contextGuard` /
 * `contextGuardNote` (M5). A separate check requires every runtime key to be
 * named in docs/INTERFACE.md, so contract drift surfaces instead of silently
 * breaking this probe.
 */
const EXPECTED_VALUES = {
  enabled: true, maxLines: 100, maxChars: 20000, closingTagCount: 8,
  endSequenceRepeats: 2, maxCorrectionsPerTurn: 1, lang: 'zh', noopCheck: true,
  debugLog: false,
  /* R10: empty => derived from the system temp directory; never a hardcoded path. */
  debugLogPath: '',
  /* R12: M5 context guard is OFF by default (it rewrites model-visible history). */
  contextGuard: false,
  contextGuardNote: '',
};
const KNOWN_KEYS = new Set([...Object.keys(EXPECTED_VALUES)]);
const derivedKeys = Object.keys(DEFAULT_CONFIG).sort();
const declaredKeys = Object.keys(EXPECTED_VALUES).sort();
check('DEFAULT_CONFIG contains every declared config key',
  declaredKeys.every((k) => derivedKeys.includes(k)),
  'missing=' + JSON.stringify(declaredKeys.filter((k) => !derivedKeys.includes(k))));
check('DEFAULT_CONFIG has no undocumented/unknown config key',
  derivedKeys.every((k) => KNOWN_KEYS.has(k)),
  'unknown=' + JSON.stringify(derivedKeys.filter((k) => !KNOWN_KEYS.has(k))));
for (const key of declaredKeys) {
  check('DEFAULT_CONFIG.' + key + ' == ' + JSON.stringify(EXPECTED_VALUES[key]),
    DEFAULT_CONFIG[key] === EXPECTED_VALUES[key],
    'actual=' + JSON.stringify(DEFAULT_CONFIG[key]));
}
check('R9: DEFAULT_CONFIG.noopCheck defaults to true (M3 kill switch on)',
  DEFAULT_CONFIG.noopCheck === true, 'noopCheck=' + JSON.stringify(DEFAULT_CONFIG.noopCheck));
check('R10: default debugLogPath hardcodes no absolute machine path',
  !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(DEFAULT_CONFIG.debugLogPath)),
  'actual=' + JSON.stringify(DEFAULT_CONFIG.debugLogPath));
{
  const iface = readMaybe('docs', 'INTERFACE.md') || '';
  for (const key of derivedKeys) {
    check('INTERFACE §配置 documents config key "' + key + '"', iface.includes(key),
      'not found in docs/INTERFACE.md');
  }
  const undocumented = derivedKeys.filter((k) => !iface.includes(k));
  if (undocumented.length > 0) {
    defect('D-5', 'low',
      'Contract drift: DEFAULT_CONFIG has key(s) ' + JSON.stringify(undocumented) +
      ' that docs/INTERFACE.md never documents.');
  } else {
    note('R10 documented', 'docs/INTERFACE.md documents all ' + derivedKeys.length +
      ' config keys (D-5 resolved by the 2026-10-29 R10 ruling)');
  }
  if (DEFAULT_CONFIG.debugLogPath !== '') {
    defect('D-6', 'low',
      'R10 implementation diverges from the published contract: INTERFACE §配置 pins the debugLogPath ' +
      'default to "" (empty => derived from the system temp dir) and forbids hardcoding any machine ' +
      'absolute path, but DEFAULT_CONFIG hardcodes ' + JSON.stringify(DEFAULT_CONFIG.debugLogPath) +
      ' and detect.js contains no temp-dir derivation (grep tmpdir|os.|temp -> none). Listed by lead as to-fix.');
  }
}
const expectedConfig = EXPECTED_VALUES;

/* ======================================================================== */
section('2. mergeConfig / ruling R3');
/* ======================================================================== */
/* R3 invariant: a non-plain `partial` yields a full copy of the MODULE's defaults. */
const defJson = canon(DEFAULT_CONFIG);
for (const [label, input] of [
  ['no args', undefined],
  ['null', null],
  ['array', [1, 2]],
  ['function', function () {}],
  ['string', 'nope'],
  ['number', 42],
  ['Date', new Date(0)],
  ['Map', new Map()],
]) {
  const r = callNoThrow('mergeConfig(' + label + ')', () => mergeConfig(input));
  if (r !== undefined) {
    check('mergeConfig(' + label + ') returns full defaults',
      canon(r) === defJson, 'actual=' + JSON.stringify(r));
  }
}
{
  const trap = new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } });
  const r = callNoThrow('mergeConfig(hostile proxy)', () => mergeConfig(trap));
  if (r !== undefined) check('mergeConfig(hostile proxy) returns full defaults', canon(r) === defJson, 'actual=' + JSON.stringify(r));
}
{
  const benign = new Proxy({ maxLines: 5 }, {});
  const r = mergeConfig(benign);
  check('R3 (2026-10-28 wording fix): a transparent proxy is read as a plain object',
    r.maxLines === 5, 'maxLines=' + r.maxLines);
}
{
  const partial = { maxLines: 5, unknownKey: 1 };
  const before = snapStr(partial);
  const r = mergeConfig(partial);
  check('mergeConfig does not mutate its input', snapStr(partial) === before);
  check('mergeConfig applies valid numeric override', r.maxLines === 5, 'maxLines=' + r.maxLines);
  check('mergeConfig ignores unknown keys', !('unknownKey' in r));
}
{
  const r1 = mergeConfig();
  r1.maxLines = 1;
  r1.enabled = false;
  r1.noopCheck = false;
  check('mergeConfig result does not share mutable ref with DEFAULT_CONFIG',
    DEFAULT_CONFIG.maxLines === 100 && DEFAULT_CONFIG.enabled === true &&
    DEFAULT_CONFIG.noopCheck === true && mergeConfig().maxLines === 100 &&
    mergeConfig().noopCheck === true, 'DEFAULT_CONFIG mutated?');
}
/* ---- R9: noopCheck semantics in mergeConfig (boolean, default true) ---- */
{
  check('R9: mergeConfig({noopCheck:false}) -> false',
    mergeConfig({ noopCheck: false }).noopCheck === false);
  check('R9: mergeConfig({noopCheck:true}) -> true',
    mergeConfig({ noopCheck: true }).noopCheck === true);
  for (const bad of ['no', 0, 1, null, undefined, {}, []]) {
    check('R9: non-boolean noopCheck ' + JSON.stringify(bad) + ' falls back to true',
      mergeConfig({ noopCheck: bad }).noopCheck === true,
      'got ' + JSON.stringify(mergeConfig({ noopCheck: bad }).noopCheck));
  }
  check('R9: noopCheck does not leak into other defaults',
    canon(mergeConfig({ noopCheck: false })) === canon({ ...DEFAULT_CONFIG, noopCheck: false }));
  /* R10 diagnostics plumbing (not yet documented in INTERFACE — see defect D-5). */
  check('R10: mergeConfig({debugLog:true}) -> true', mergeConfig({ debugLog: true }).debugLog === true);
  check('R10: non-boolean debugLog falls back to false',
    mergeConfig({ debugLog: 'yes' }).debugLog === false && mergeConfig({ debugLog: 1 }).debugLog === false);
  check('R10: mergeConfig({debugLogPath:"/tmp/x.log"}) -> that path',
    mergeConfig({ debugLogPath: '/tmp/x.log' }).debugLogPath === '/tmp/x.log');
  check('R10: empty/non-string debugLogPath resolves to the DOCUMENTED default "" (temp dir)',
    mergeConfig({ debugLogPath: '' }).debugLogPath === '' &&
    mergeConfig({ debugLogPath: 42 }).debugLogPath === '',
    JSON.stringify({ empty: mergeConfig({ debugLogPath: '' }).debugLogPath, num: mergeConfig({ debugLogPath: 42 }).debugLogPath }));
  /* R12 (M5 context guard + independent switch). */
  check('R12: mergeConfig({contextGuard:true}) -> true',
    mergeConfig({ contextGuard: true }).contextGuard === true);
  check('R12: non-boolean contextGuard falls back to false',
    ['yes', 1, 0, null, undefined, {}].every((v) => mergeConfig({ contextGuard: v }).contextGuard === false),
    JSON.stringify(['yes', 1, 0, null, undefined, {}].map((v) => mergeConfig({ contextGuard: v }).contextGuard)));
  check('R12: non-empty contextGuardNote is honored',
    mergeConfig({ contextGuardNote: 'NOTICE' }).contextGuardNote === 'NOTICE');
  check('R12: empty/non-string contextGuardNote falls back to ""',
    mergeConfig({ contextGuardNote: '' }).contextGuardNote === '' &&
    mergeConfig({ contextGuardNote: 42 }).contextGuardNote === '' &&
    mergeConfig({ contextGuardNote: null }).contextGuardNote === '');
  check('R12: contextGuard settings do not leak into other defaults',
    canon(mergeConfig({ contextGuard: true, contextGuardNote: 'X' })) ===
    canon({ ...DEFAULT_CONFIG, contextGuard: true, contextGuardNote: 'X' }));
}
for (const [label, partial, key, want] of [
  ['NaN', { maxLines: NaN }, 'maxLines', 100],
  ['Infinity', { maxLines: Infinity }, 'maxLines', 100],
  ['-1', { maxLines: -1 }, 'maxLines', 100],
  ['string number', { maxLines: '50' }, 'maxLines', 100],
  ['unknown lang', { lang: 'fr' }, 'lang', 'zh'],
  ['en lang', { lang: 'en' }, 'lang', 'en'],
  ['non-bool enabled', { enabled: 'no' }, 'enabled', true],
]) {
  const r = mergeConfig(partial);
  check('mergeConfig fallback: ' + label, r[key] === want, key + '=' + JSON.stringify(r[key]));
}
{
  const z = mergeConfig({ endSequenceRepeats: 0, closingTagCount: 0, maxLines: 0, maxChars: 0, maxCorrectionsPerTurn: 0 });
  check('R7: 0 on the four detection thresholds falls back to defaults',
    z.endSequenceRepeats === 2 && z.closingTagCount === 8 && z.maxLines === 100 && z.maxChars === 20000,
    JSON.stringify(z));
  check('R7: maxCorrectionsPerTurn:0 is allowed (disables self-heal)',
    z.maxCorrectionsPerTurn === 0, 'value=' + z.maxCorrectionsPerTurn);
  const frac = mergeConfig({ maxLines: 1.5, maxChars: 12345.6 });
  check('R7: non-integer numerics fall back to defaults',
    frac.maxLines === 100 && frac.maxChars === 20000,
    JSON.stringify({ maxLines: frac.maxLines, maxChars: frac.maxChars }));
}

/* ======================================================================== */
section('3. non-string / hostile inputs to scanAssistantText (must not throw)');
HB = 'assistant';
/* ======================================================================== */
const hostileTextInputs = [
  ['undefined', undefined], ['null', null], ['number', 42], ['true', true],
  ['array', [1, 'a']], ['plain obj', { a: 1 }], ['Symbol', Symbol('s')],
  ['BigInt', 10n], ['function', function () {}], ['Object.create(null)', Object.create(null)],
  ['throwing toString', { toString() { throw new Error('boom'); } }],
  ['throwing toPrimitive', { [Symbol.toPrimitive]() { throw new Error('boom'); } }],
  ['Date', new Date(0)],
];
for (const [label, input] of hostileTextInputs) {
  const r = callNoThrow('scanAssistantText(' + label + ')', () => scanAssistantText(input));
  if (r) {
    check('scanAssistantText(' + label + ') shape', typeof r.damaged === 'boolean' && typeof r.silentFailure === 'boolean' && Array.isArray(r.findings) && r.evidence && typeof r.evidence === 'object');
    harvest(r);
  }
}
{
  const proxy = new Proxy({}, { get() { throw new Error('trap'); }, has() { throw new Error('trap'); } });
  const r = callNoThrow('scanAssistantText(hostile proxy)', () => scanAssistantText(proxy));
  if (r) { check('scanAssistantText(hostile proxy) shape', typeof r.damaged === 'boolean'); harvest(r); }
}

/* ======================================================================== */
section('4. scanAssistantText return shape + ruling R1 (silentFailure)');
/* ======================================================================== */
const v1Text = readFixture('v1-end-multiplied.txt');
const v2Text = readFixture('v2-missing-opening.txt');
const v3Text = readFixture('v3-leaked-markup.txt');
const okHtml = readFixture('ok-normal-html.txt');
const okJs = readFixture('ok-normal-js.txt');
const okMd = readFixture('ok-normal-markdown-table.txt');
const okShort = readFixture('ok-short-text-few-tags.txt');
const okOneEnd = readFixture('ok-single-end-sequence.txt');

{
  const r = scanAssistantText(v1Text);
  check('scanAssistantText return keys == {damaged,silentFailure,findings,evidence}',
    JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['damaged', 'evidence', 'findings', 'silentFailure']),
    'keys=' + JSON.stringify(Object.keys(r)));
  check('evidence keys == {length,closingTagCount,endSequenceRepeats,leakedMarkup,truncated}',
    JSON.stringify(Object.keys(r.evidence).sort()) === JSON.stringify(['length', 'closingTagCount', 'endSequenceRepeats', 'leakedMarkup', 'truncated'].sort()),
    'keys=' + JSON.stringify(Object.keys(r.evidence)));
}
{
  const r = scanAssistantText(v1Text);
  check('R1: damaged===true for V1', r.damaged === true);
  const table = [
    ['meta omitted', undefined, false],
    ['meta null', null, false],
    ['meta {}', {}, false],
    ['meta {hasToolCalls:true}', { hasToolCalls: true }, false],
    ['meta {hasToolCalls:false}', { hasToolCalls: false }, true],
    ['meta {hasToolCalls:"no"}', { hasToolCalls: 'no' }, false],
    ['meta {hasToolCalls:undefined}', { hasToolCalls: undefined }, false],
  ];
  for (const [label, meta, want] of table) {
    const rr = meta === undefined ? r : scanAssistantText(v1Text, undefined, meta);
    check('R1 ' + label + ' -> silentFailure=' + want, rr.silentFailure === want,
      'got ' + rr.silentFailure);
  }
  const a = scanAssistantText(v1Text, undefined, { hasToolCalls: false });
  const b = scanAssistantText(v1Text, undefined, { hasToolCalls: true });
  check('R1: meta does not change damaged', a.damaged === b.damaged);
  check('R1: meta does not change findings',
    JSON.stringify(a.findings) === JSON.stringify(b.findings));
}
{
  const meta = {};
  Object.defineProperty(meta, 'hasToolCalls', { get() { throw new Error('trap'); } });
  const r = callNoThrow('scanAssistantText with throwing meta getter', () => scanAssistantText(v1Text, undefined, meta));
  if (r) check('throwing meta getter -> silentFailure false', r.silentFailure === false);
}
{
  const r = scanAssistantText(okHtml, undefined, { hasToolCalls: false });
  check('R1: undamaged input never sets silentFailure', r.damaged === false && r.silentFailure === false);
}

/* ======================================================================== */
section('5. fixture replay: positives must hit, negatives must not');
HB = 'assistant';
/* ======================================================================== */
const positives = [
  ['v1-end-multiplied', v1Text, 'END_SEQUENCE_MULTIPLIED'],
  ['v2-missing-opening', v2Text, 'MISSING_OPENING_MARKUP'],
  ['v3-leaked-markup', v3Text, 'MARKUP_LEAKED_AS_TEXT'],
];
for (const [label, text, code] of positives) {
  const r = scanAssistantText(text, undefined, { hasToolCalls: false });
  harvest(r);
  check('positive ' + label + ': damaged===true', r.damaged === true, 'findings=' + JSON.stringify(r.findings.map((f) => f.code)));
  check('positive ' + label + ': contains ' + code, hasBlockingCodes(r.findings, [code]),
    'codes=' + JSON.stringify(r.findings.map((f) => f.code)));
  check('positive ' + label + ': silentFailure===true (no tool calls)', r.silentFailure === true);
  check('positive ' + label + ': >=1 error finding', hasError(r.findings));
}
const negatives = [
  ['ok-normal-html', okHtml], ['ok-normal-js', okJs],
  ['ok-normal-markdown-table', okMd], ['ok-short-text-few-tags', okShort],
  ['ok-single-end-sequence', okOneEnd],
];
for (const [label, text] of negatives) {
  const r = scanAssistantText(text, undefined, { hasToolCalls: false });
  harvest(r);
  check('negative ' + label + ': damaged===false', r.damaged === false,
    'findings=' + JSON.stringify(r.findings));
  check('negative ' + label + ': silentFailure===false', r.silentFailure === false);
}

/* ======================================================================== */
section('5b. D-10/R14: namespace tolerance — zero drift + dialect recall');
{
  const countClose = (s) => s.split(CLOSE_PREFIX).length - 1;
  const NS_OPEN = LT + 'antml:invoke';
  const NS_PARAM = LT + 'antml:parameter';
  const NS_END_INVOKE = LT + SL + 'antml:invoke' + GT;
  const NS_END_PARAM = LT + SL + 'antml:parameter' + GT;

  /* (a) ZERO DRIFT: colon-bearing inputs that are NOT namespace call tags must
   * keep the undamaged verdict they had before D-10. */
  const driftCases = [
    ['url only', 'https://example.com/a'],
    ['url in attribute', LT + 'a href="https://example.com/a">x' + LT + SL + 'a' + GT],
    ['svg qualified tag', LT + 'svg:path d="M0 0"/>' + '\n' + LT + SL + 'svg:path' + GT],
    ['http pseudo-tag (URL guard)', LT + 'http://x/>'],
    ['plain html', LT + '!DOCTYPE html>' + '\n' + LT + 'html lang="en">' + LT + 'body>' + LT + 'p>hello' + LT + SL + 'p>' + LT + SL + 'body>' + LT + SL + 'html>'],
    ['xml namespace decl', LT + 'root xmlns:x="urn:x">' + LT + 'x:child>v' + LT + SL + 'x:child>' + LT + SL + 'root>'],
  ];
  for (const [label, text] of driftCases) {
    const r = callNoThrow('scanAssistantText(zero-drift: ' + label + ')', () => scanAssistantText(text));
    if (!r) continue;
    check('D-10 zero-drift: ' + label + ' is NOT damaged', r.damaged === false,
      'findings=' + JSON.stringify(r.findings.map((f) => f.code)));
    if (preD10) {
      const p = preD10.scanAssistantText(text);
      check('D-10 zero-drift: ' + label + ' verdict identical to pre-D-10',
        p.damaged === r.damaged && canon(p.findings) === canon(r.findings),
        'pre=' + JSON.stringify(p.findings.map((f) => f.code)));
    }
  }
  note('URL guard observability',
    'the (?!\\/) URL guard in NAMESPACE_PREFIX_RE is defence-in-depth: rewriting `<http://x/>` ' +
    'could only ever produce `<//x/>`, which is not a call marker, so it is not behaviourally ' +
    'observable through scanAssistantText; the case above only proves no verdict drift.');

  /* (b) DIALECT RECALL: prefixed call envelopes must be caught now, and were
   * invisible before D-10. */
  const recallCases = [
    ['prefixed V2 (parameter open, no invoke open, prose)',
      NS_PARAM + ' name="path">a.txt' + NS_END_PARAM + '\n这是一段说明文字，参数缺少开场标记。\n',
      ['MISSING_OPENING_MARKUP']],
    ['prefixed trailing end-sequence run',
      NS_OPEN + ' name="w">\n' + NS_PARAM + ' name="c">x' + NS_END_PARAM + '\n' + NS_END_INVOKE + '\n' + NS_END_INVOKE + '\n',
      ['END_SEQUENCE_MULTIPLIED']],
    ['prefixed truncated structure',
      NS_OPEN + ' name="w">\n' + NS_PARAM + ' name="c">abc',
      ['TRUNCATED_PAYLOAD']],
    ['prefixed leaked markup in prose',
      '样式已经写好了。\n' + NS_OPEN + ' name="w">\n' + NS_PARAM + ' name="c">' + LT + 'div>x' + LT + SL + 'div' + GT + '\n' + NS_END_PARAM + '\n' + NS_END_INVOKE + '\n以上。\n',
      ['MARKUP_LEAKED_AS_TEXT']],
  ];
  for (const [label, text, wantCodes] of recallCases) {
    const r = callNoThrow('scanAssistantText(' + label + ')', () => scanAssistantText(text));
    if (!r) continue;
    harvest(r);
    check('D-10 recall: ' + label + ' => damaged', r.damaged === true,
      'codes=' + JSON.stringify(r.findings.map((f) => f.code)));
    check('D-10 recall: ' + label + ' hits ' + wantCodes.join('+'),
      wantCodes.every((c) => hasBlockingCodes(r.findings, [c])),
      'codes=' + JSON.stringify(r.findings.map((f) => f.code)));
    if (preD10) {
      const p = preD10.scanAssistantText(text);
      check('D-10 recall: ' + label + ' was INVISIBLE pre-D-10 (damaged=false)',
        p.damaged === false, 'pre codes=' + JSON.stringify(p.findings.map((f) => f.code)));
    }
  }

  /* (c) ZERO DRIFT on every existing fixture: identical findings AND evidence. */
  if (preD10) {
    for (const f of ['v1-end-multiplied.txt', 'v2-missing-opening.txt', 'v3-leaked-markup.txt',
      'ok-normal-html.txt', 'ok-normal-js.txt', 'ok-normal-markdown-table.txt',
      'ok-short-text-few-tags.txt', 'ok-single-end-sequence.txt']) {
      const text = readFixture(f);
      const a = scanAssistantText(text);
      const b = preD10.scanAssistantText(text);
      check('D-10 zero-drift on fixture: ' + f,
        a.damaged === b.damaged && canon(a.findings) === canon(b.findings) && canon(a.evidence) === canon(b.evidence),
        'now=' + JSON.stringify(a.findings.map((x) => x.code)) +
        ' pre=' + JSON.stringify(b.findings.map((x) => x.code)));
    }
  } else {
    note('pre-D-10 module missing', 'D-10 delta checks skipped (verify/_pre-d10-detect.mjs not found)');
  }

  /* (d) Numeric evidence comes from the ORIGINAL text, not the shadow copy. */
  {
    const text = NS_OPEN + ' name="w">\n' + NS_PARAM + ' name="c">x' + NS_END_PARAM + '\n' + NS_END_INVOKE + '\n';
    const r = scanAssistantText(text);
    check('R14: evidence.length / closingTagCount are measured on the original text',
      r.evidence.length === text.length && r.evidence.closingTagCount === countClose(text),
      JSON.stringify({ len: r.evidence.length, wantLen: text.length, close: r.evidence.closingTagCount, wantClose: countClose(text) }));
  }

  /* (e) sanitizeMessages inherits the namespace tolerance. The sample must be
   * genuinely damaged: this one is the prefixed V2 analogue (parameter opening
   * with no invoke opening + prose), which probe (b) already proved damaged. */
  {
    const prefixedV2 = NS_PARAM + ' name="path">a.txt' + NS_END_PARAM +
      '\n这是一段说明文字，参数缺少开场标记。\n';
    const msg = { id: 'ns1', role: 'assistant', content: [{ type: 'text', text: prefixedV2 }] };
    const r = sanitizeMessages([msg], { contextGuard: true });
    check('R14: sanitizeMessages inherits namespace tolerance (prefixed damage is rewritten)',
      r.changed === true && r.messages[0].content.length === 1,
      JSON.stringify(r).slice(0, 160));
  }
}

section('6. scanToolArguments: shape, deny gate (lead-reported false positive)');
HB = 'args';
/* ======================================================================== */
function bigHtml(n, tag) {
  let s = '';
  for (let i = 0; i < n; i += 1) s += LT + (tag || 'div') + ' class="x">item-' + i + LT + SL + (tag || 'div') + GT + '\n';
  return s;
}
const damagedBig = bigHtml(40) + END_INVOKE + '\n' + END_INVOKE + '\n'; // >=30 lines, trailing run 2
const okBigHtml = bigHtml(200);                                          // legal HTML, 200 lines
const shortQuotingProtocol = 'const m = text.match("' + END_INVOKE + '");'; // <=400 chars, one isolated closer

console.log('  sizes: damagedBig=' + damagedBig.length + 'ch, okBigHtml=' + okBigHtml.length + 'ch, shortQuotingProtocol=' + shortQuotingProtocol.length + 'ch');
console.log('  CONTROL scanToolArguments(before section 6) = ' +
  JSON.stringify(scanToolArguments('write', { content: 'hello world' })));
console.log('  CONTROL big(40)+EI..EI = ' + JSON.stringify(scanToolArguments('write', { content: damagedBig })));

const argCases = [
  ['ok-normal-html as one leaf', okHtml],
  ['ok-normal-js as one leaf', okJs],
  ['ok-normal-markdown-table', okMd],
  ['ok-short-text-few-tags', okShort],
  ['ok-single-end-sequence', okOneEnd],
  ['V1 fixture as one leaf', v1Text],
  ['legal big HTML (200 lines)', okBigHtml],
  ['short doc quoting protocol once (<=400ch)', shortQuotingProtocol],
  ['damagedBig (>=30 lines + trailing run 2)', damagedBig],
];
for (const [label, leaf] of argCases) {
  const r = callNoThrow('scanToolArguments(' + label + ')', () => scanToolArguments('write', { content: leaf }));
  if (!r) continue;
  harvest(r);
  check('scanToolArguments(' + label + ') action in {ok,flag,deny}',
    ['ok', 'flag', 'deny'].includes(r.action), 'action=' + r.action);
  check('scanToolArguments(' + label + ') findings is array', Array.isArray(r.findings));
  if (r.action === 'deny') {
    check('scanToolArguments(' + label + ') deny has non-empty reason', typeof r.reason === 'string' && r.reason.length > 0);
    check('scanToolArguments(' + label + ') deny reason <= 400 chars', typeof r.reason === 'string' && r.reason.length <= 400, 'len=' + (r.reason || '').length);
    check('scanToolArguments(' + label + ') deny implies an error finding', hasError(r.findings));
  } else {
    check('scanToolArguments(' + label + ') non-deny reason is empty',
      r.reason === undefined || (typeof r.reason === 'string' && r.reason.length === 0),
      'reason=' + JSON.stringify(r.reason));
  }
  console.log('  -> ' + label.padEnd(46) + ' action=' + r.action.padEnd(5) + ' codes=' + JSON.stringify(r.findings.map((f) => f.code)));
  if (r.findings.some((f) => /internal-error/.test(String(f.detail)))) {
    console.log('     INTERNAL: ' + JSON.stringify(r.findings.map((f) => String(f.detail).slice(0, 300))));
  }
}
/* the two acceptance statements from the lead */
{
  const r = scanToolArguments('write', { content: shortQuotingProtocol });
  check('ACCEPTANCE: short (<=400ch) legal doc w/ isolated closer => NOT deny',
    r.action !== 'deny', 'action=' + r.action);
}
{
  const r = scanToolArguments('write', { content: damagedBig });
  check('ACCEPTANCE: big damaged payload => deny', r.action === 'deny', 'action=' + r.action);
}
/* residual dense-tail probe: 8 short lines of isolated parameter closers (<400 chars) */
{
  const denseShort = Array.from({ length: 8 }, () => END_PARAM).join('\n');
  const r = scanToolArguments('write', { content: denseShort });
  const denied = r.action === 'deny';
  check('ACCEPTANCE: 8-line short doc (<=400ch) of isolated closers => NOT deny',
    !denied, 'chars=' + denseShort.length + ' lines=9 action=' + r.action +
    ' findings=' + JSON.stringify(r.findings.map((f) => f.code + ':' + f.severity)));
  if (denied) {
    defect('D-1', 'moderate',
      'scanToolArguments still denies a SHORT document: 8 newline-separated isolated parameter closers (' +
      denseShort.length + ' chars) hits the dense gate (>=8 lines AND >=8 "' + CLOSE_PREFIX +
      '") and yields action=deny. Violates the stated acceptance "short (<400 char) documents must not deny".');
  }
}
/* dense gate boundary sweep to characterise it */
{
  const rows = [];
  for (const n of [1, 2, 4, 6, 7, 8, 9, 12]) {
    const leaf = Array.from({ length: n }, () => END_PARAM).join('\n');
    const r = scanToolArguments('write', { content: leaf });
    rows.push(n + 'lines/' + leaf.length + 'ch->' + r.action);
  }
  note('dense gate sweep (isolated parameter closers, 1 per line)', rows.join('  '));
}
/* non-string args must not throw */
for (const [label, args] of [
  ['undefined', undefined], ['null', null], ['number', 7], ['Symbol', Symbol('s')],
  ['string leaf at root', damagedBig], ['array', [damagedBig]], ['empty obj', {}],
  ['Object.create(null)', Object.create(null)],
  ['symbol value', { a: Symbol('s') }], ['bigint value', { a: 10n }],
  ['function value', { a: function () {} }],
]) {
  const r = callNoThrow('scanToolArguments(args=' + label + ')', () => scanToolArguments('write', args));
  if (r) { harvest(r); check('scanToolArguments(args=' + label + ') action valid', ['ok', 'flag', 'deny'].includes(r.action), 'action=' + r.action); }
}
{
  const throwing = new Proxy({}, { ownKeys() { throw new Error('trap'); } });
  const r = callNoThrow('scanToolArguments(hostile proxy args)', () => scanToolArguments('write', throwing));
  if (r) check('hostile proxy args -> valid action', ['ok', 'flag', 'deny'].includes(r.action));
}
{
  const g = {};
  Object.defineProperty(g, 'content', { get() { throw new Error('trap'); }, enumerable: true });
  const r = callNoThrow('scanToolArguments(throwing getter leaf)', () => scanToolArguments('write', g));
  if (r) check('throwing getter leaf -> valid action', ['ok', 'flag', 'deny'].includes(r.action));
}
/* cyclic */
{
  const cyc = { content: damagedBig };
  cyc.self = cyc;
  const t = ms(() => scanToolArguments('write', cyc));
  check('cyclic args handled in <2000ms', t.ms < 2000, 'ms=' + t.ms.toFixed(1));
  check('cyclic args -> deny (payload still reachable)', t.value.action === 'deny', 'action=' + t.value.action);
}
/* depth + leaf-count recall bounds (INTERFACE §2 says *all* string leaves) */
{
  let deepOk = { leaf: damagedBig };
  for (let i = 0; i < 5; i += 1) deepOk = { n: deepOk };
  const rOk = scanToolArguments('write', deepOk);
  check('damaged leaf at depth ~6 is detected (deny)', rOk.action === 'deny', 'action=' + rOk.action);

  // R8 (2026-10-28): traversal is intentionally bounded (200 leaves / depth 24)
  // and must be documented, not silent. A miss beyond the bound is by design.
  let deepMiss = { leaf: damagedBig };
  for (let i = 0; i < 30; i += 1) deepMiss = { n: deepMiss };
  const rMiss = scanToolArguments('write', deepMiss);
  check('R8: damaged leaf at depth ~31 is NOT scanned (bound = depth 24)',
    rMiss.action === 'ok', 'action=' + rMiss.action);

  const many = { first: damagedBig };
  for (let i = 0; i < 220; i += 1) many['k' + i] = 'small ' + i;
  const rMany = scanToolArguments('write', many);
  check('R8: damaged leaf beyond 200 leaves is NOT scanned (bound = 200)',
    rMany.action === 'ok', 'action=' + rMany.action);

  const iface = readMaybe('docs', 'INTERFACE.md') || '';
  const pReadme = readMaybe('plugin', 'README.md') || '';
  check('R8 is recorded in docs/INTERFACE.md',
    /R8/.test(iface) && /200/.test(iface) && /24/.test(iface) && /(有界|不被扫描|not scanned)/.test(iface));
  check('R8 boundary is recorded in plugin/README.md',
    /200/.test(pReadme) && /24/.test(pReadme) && /(叶子|leaves)/.test(pReadme));
}

/* ======================================================================== */
section('7. scanToolArguments: unit rules (PAYLOAD_TOO_LONG / DENSITY / R2 / truncation)');
/* ======================================================================== */
{
  const longSingle = 'a'.repeat(30000);
  const r = scanToolArguments('write', { content: longSingle });
  harvest(r);
  check('PAYLOAD_TOO_LONG on >maxChars single line => flag (warn only)',
    r.action === 'flag' && hasBlockingCodes(r.findings, ['PAYLOAD_TOO_LONG']),
    'action=' + r.action + ' codes=' + JSON.stringify(r.findings.map((f) => f.code)));
}
{
  const manyLines = Array.from({ length: 101 }, (_, i) => 'line ' + i).join('\n');
  const r = scanToolArguments('write', { content: manyLines });
  harvest(r);
  check('lines > maxLines (101) => PAYLOAD_TOO_LONG warn',
    hasBlockingCodes(r.findings, ['PAYLOAD_TOO_LONG']), 'codes=' + JSON.stringify(r.findings.map((f) => f.code)));
}
{
  const dense = bigHtml(10); // 10 closing prefixes, small doc
  const r = scanToolArguments('write', { content: dense });
  harvest(r);
  check('CLOSING_TAG_DENSITY is info, legal HTML must not deny',
    r.action !== 'deny' && hasBlockingCodes(r.findings, ['CLOSING_TAG_DENSITY']),
    'action=' + r.action + ' codes=' + JSON.stringify(r.findings.map((f) => f.code)));
}
{
  const legalTail = bigHtml(40) + END_PARAM + '\n' + END_INVOKE + '\n'; // ONE invoke end
  const r = scanToolArguments('write', { content: legalTail });
  harvest(r);
  check('R2: one PARAM end + one INVOKE end at tail => no END_SEQUENCE_MULTIPLIED',
    !hasBlockingCodes(r.findings, ['END_SEQUENCE_MULTIPLIED']),
    'codes=' + JSON.stringify(r.findings.map((f) => f.code)));
}
/* R6: only call-shaped leaves get the pairing walk. */
{
  const callShaped = OPEN_INVOKE + ' name="write">\n' + OPEN_PARAM + ' name="content">\n' +
    bigHtml(40) + END_PARAM + '\n';
  const r = scanToolArguments('write', { content: callShaped });
  harvest(r);
  check('R6: call-shaped unclosed structure => TRUNCATED_PAYLOAD',
    hasBlockingCodes(r.findings, ['TRUNCATED_PAYLOAD']),
    'codes=' + JSON.stringify(r.findings.map((f) => f.code)));
  check('R6: call-shaped truncated + >=20 lines => deny', r.action === 'deny', 'action=' + r.action);
}
{
  const proseQuotingMarkup = bigHtml(40) + OPEN_INVOKE + ' name="x">\n' + OPEN_PARAM + ' name="c">abc';
  const r = scanToolArguments('write', { content: proseQuotingMarkup });
  harvest(r);
  check('R6: non-call-shaped doc quoting markup => NO TRUNCATED_PAYLOAD',
    !hasBlockingCodes(r.findings, ['TRUNCATED_PAYLOAD']),
    'codes=' + JSON.stringify(r.findings.map((f) => f.code)));
  check('R6: non-call-shaped doc => no error finding / not deny',
    !hasError(r.findings) && r.action !== 'deny', 'action=' + r.action);
}
{
  const unpaired = bigHtml(40) + END_INVOKE + END_INVOKE;
  const r = scanToolArguments('write', { content: unpaired });
  harvest(r);
  check('UNPAIRED_CLOSING_TAG detected', hasBlockingCodes(r.findings, ['UNPAIRED_CLOSING_TAG']));
}
/* CRLF handling */
{
  const crlf = bigHtml(40) + END_INVOKE + '\r\n' + END_INVOKE + '\r\n';
  const r = scanToolArguments('write', { content: crlf });
  harvest(r);
  check('CRLF: trailing run 2 still detected', hasBlockingCodes(r.findings, ['END_SEQUENCE_MULTIPLIED']),
    'codes=' + JSON.stringify(r.findings.map((f) => f.code)));
  check('CRLF: big damaged payload => deny', r.action === 'deny', 'action=' + r.action);
}

/* ======================================================================== */
section('7b. R4 deny gate + the two named false positives (whole docs)');
{
  // UNPAIRED only (now info) on a big leaf must never deny.
  const bigUnpaired = bigHtml(40) + END_PARAM + '\n';
  const r = scanToolArguments('write', { content: bigUnpaired });
  harvest(r);
  check('R4: big leaf with only UNPAIRED (info) => not deny',
    r.action !== 'deny' && !hasError(r.findings),
    'action=' + r.action + ' codes=' + JSON.stringify(r.findings.map((f) => f.code + ':' + f.severity)));
}
{
  // volume gate: chars >= 2000 (default ceil(20000/10)); lines < 20.
  const head = OPEN_INVOKE + ' name="x">' + OPEN_PARAM + ' name="c">';
  const mk = (total) => head + 'a'.repeat(total - head.length);
  const below = scanToolArguments('write', { content: mk(1999) });
  const at = scanToolArguments('write', { content: mk(2000) });
  harvest(below); harvest(at);
  check('R4: call-shaped truncated 1999 chars/1 line => NOT deny',
    below.action !== 'deny', 'action=' + below.action);
  check('R4: call-shaped truncated 2000 chars/1 line => deny',
    at.action === 'deny', 'action=' + at.action);
  check('R4: below-gate error finding is retained but downgraded to flag',
    hasBlockingCodes(below.findings, ['TRUNCATED_PAYLOAD']) && below.action === 'flag',
    'action=' + below.action + ' codes=' + JSON.stringify(below.findings.map((f) => f.code)));
}
{
  // volume gate: lines >= 20 (default ceil(100/5)); chars < 2000.
  const head = OPEN_INVOKE + ' name="x">\n' + OPEN_PARAM + ' name="c">\n'; // 2 newlines
  const linesOf = (s) => s.split('\n').length;
  const below = scanToolArguments('write', { content: head + '\n'.repeat(16) }); // 19 lines
  const at = scanToolArguments('write', { content: head + '\n'.repeat(17) });    // 20 lines
  harvest(below); harvest(at);
  check('R4: 19-line call-shaped truncated => NOT deny', below.action !== 'deny',
    'action=' + below.action + ' lines=' + linesOf(head + '\n'.repeat(16)));
  check('R4: 20-line call-shaped truncated => deny', at.action === 'deny',
    'action=' + at.action + ' lines=' + linesOf(head + '\n'.repeat(17)));
}
{
  const named = [
    ['docs/DESIGN.md', 'docs', 'DESIGN.md'],
    ['docs/CONTRACTS.md', 'docs', 'CONTRACTS.md'],
    ['plugin/README.md', 'plugin', 'README.md'],
    ['tests/README.md', 'tests', 'README.md'],
    ['docs/INTERFACE.md', 'docs', 'INTERFACE.md'],
    ['docs/PROMPTS.md', 'docs', 'PROMPTS.md'],
  ];
  for (const [label, ...p] of named) {
    const text = readMaybe(...p);
    if (text === null) {
      note('missing doc', label + ' not found; skipping');
      continue;
    }
    const lines = 1 + text.split('\n').length;
    const r = scanToolArguments('write', { content: text });
    harvest(r);
    const aboveGate = text.length >= 2000 || lines >= 20;
    check('FALSE-POSITIVE GUARD: ' + label + ' (not denied)',
      r.action !== 'deny',
      'action=' + r.action + ' chars=' + text.length + ' lines=' + lines +
      ' codes=' + JSON.stringify(r.findings.map((f) => f.code + ':' + f.severity)));
    check('FALSE-POSITIVE GUARD: ' + label + ' has no error finding',
      !hasError(r.findings),
      'codes=' + JSON.stringify(r.findings.map((f) => f.code + ':' + f.severity)));
    if (aboveGate && !hasError(r.findings)) {
      check('FALSE-POSITIVE GUARD: ' + label + ' is above the volume gate (test is meaningful)',
        true);
    } else if (!aboveGate) {
      note('doc below gate', label + ': ' + text.length + ' chars / ' + lines + ' lines');
    }
    console.log('  -> ' + label.padEnd(22) + ' action=' + r.action.padEnd(5) +
      ' aboveGate=' + aboveGate + ' codes=' + JSON.stringify(r.findings.map((f) => f.code)));
  }
}

section('7c. R5 internal-error honesty (code + severity + reason)');
{
  const r = scanAssistantText({ toString() { throw new Error('boom-sentinel'); } });
  harvest(r);
  check('R5: forced internal error reports INTERNAL_ERROR',
    hasBlockingCodes(r.findings, ['INTERNAL_ERROR']),
    'codes=' + JSON.stringify(r.findings.map((f) => f.code)));
  check('R5: internal error is NOT reported as SUSPICIOUS_NOOP_RESULT',
    !hasBlockingCodes(r.findings, ['SUSPICIOUS_NOOP_RESULT']),
    'codes=' + JSON.stringify(r.findings.map((f) => f.code)));
  check('R5: internal error severity is info (never damaged)',
    r.findings.every((f) => f.severity === 'info') && r.damaged === false && r.silentFailure === false,
    JSON.stringify(r.findings));
  check('R5: internal error detail starts with "internal-error: "',
    r.findings.every((f) => String(f.detail).startsWith('internal-error: ')),
    JSON.stringify(r.findings.map((f) => f.detail)));
}
check('R5 (static): INTERNAL_ERROR_CODE is INTERNAL_ERROR, not SUSPICIOUS_NOOP_RESULT',
  /const\s+INTERNAL_ERROR_CODE\s*=\s*'INTERNAL_ERROR'/.test(detectSrc));
check('R5: buildDenyReason on an info-only INTERNAL_ERROR returns ""',
  buildDenyReason([{ code: 'INTERNAL_ERROR', severity: 'info', detail: 'internal-error: x: y' }]) === '');

section('8. scanToolArguments: no payload text in reason/evidence; no mutation');
/* ======================================================================== */
const CANARY = 'CANARY_PAYLOAD_9f3c7a';
{
  const leaf = bigHtml(40) + ' ' + CANARY + '\n' + END_INVOKE + '\n' + END_INVOKE;
  const r = scanToolArguments('write', { content: leaf });
  harvest(r);
  check('canary case denies', r.action === 'deny', 'action=' + r.action);
  check('deny.reason contains NO payload text', !String(r.reason).includes(CANARY));
  check('every finding.detail contains NO payload text',
    r.findings.every((f) => !String(f.detail).includes(CANARY)));
  const ev = scanAssistantText(leaf, undefined, { hasToolCalls: false });
  harvest(ev);
  check('assistant evidence contains NO payload text',
    !JSON.stringify(ev.evidence).includes(CANARY));
  check('assistant findings contain NO payload text',
    ev.findings.every((f) => !String(f.detail).includes(CANARY)));
  check('evidence values are only number/boolean',
    Object.values(ev.evidence).every((v) => typeof v === 'number' || typeof v === 'boolean'),
    JSON.stringify(ev.evidence));
}
{
  const args = { content: damagedBig, nested: { deep: damagedBig }, list: [damagedBig] };
  const before = snapStr(args);
  const r = scanToolArguments('write', args);
  check('scanToolArguments does not mutate its args', snapStr(args) === before);
  const frozen = deepFreeze(JSON.parse(snapStr(args)));
  const rFrozen = scanToolArguments('write', frozen);
  check('result identical on deep-frozen vs live input (no hidden mutation)',
    JSON.stringify(r.findings) === JSON.stringify(rFrozen.findings) && r.action === rFrozen.action,
    'live=' + r.action + ' frozen=' + rFrozen.action);
  const beforeT = snapStr(v1Text);
  scanAssistantText(v1Text, { maxLines: 5 }, { hasToolCalls: false });
  check('scanAssistantText does not mutate its text arg', snapStr(v1Text) === beforeT);
}

/* ======================================================================== */
section('9. scanToolResult: shape, no-op detection, hostile inputs');
HB = 'result';
/* ======================================================================== */
for (const [label, args, result] of [
  ['null result', { content: 'hello' }, null],
  ['string result', { content: 'hello' }, 'str'],
  ['number result', { content: 'hello' }, 42],
  ['isError result', { content: 'hello' }, { isError: true, value: { status: 'noop' } }],
  ['empty result, empty args', {}, {}],
  ['explicit noop status', { content: 'x'.repeat(60) }, { value: { status: 'noop' } }],
  ['bytesWritten 0 w/ payload', { content: 'x'.repeat(60) }, { value: { bytesWritten: 0 } }],
  ['applied=false w/ payload', { content: 'x'.repeat(60) }, { value: { applied: false } }],
  ['nothing-to-do phrase', { content: 'x'.repeat(300) }, { content: [{ type: 'text', text: 'nothing to do; unchanged' }] }],
]) {
  const r = callNoThrow('scanToolResult(' + label + ')', () => scanToolResult('write', args, result));
  if (r) {
    harvest(r);
    check('scanToolResult(' + label + ') shape',
      typeof r.suspicious === 'boolean' && Array.isArray(r.findings),
      JSON.stringify(r).slice(0, 120));
  }
}
{
  const r = scanToolResult('write', { content: 'x'.repeat(60) }, { value: { status: 'noop' } });
  check('explicit no-op status => suspicious:true + SUSPICIOUS_NOOP_RESULT',
    r.suspicious === true && hasBlockingCodes(r.findings, ['SUSPICIOUS_NOOP_RESULT']),
    JSON.stringify(r));
  check('suspect result carries reason', typeof r.reason === 'string' && r.reason.length > 0);
}
{
  const cyc = { value: {} };
  cyc.value.self = cyc;
  const t = ms(() => scanToolResult('write', { content: 'x' }, cyc));
  check('cyclic result handled in <2000ms, no throw', t.value && typeof t.value.suspicious === 'boolean' && t.ms < 2000, 'ms=' + t.ms.toFixed(1));
}
{
  const bad = new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
  const r = callNoThrow('scanToolResult(hostile proxy)', () => scanToolResult('write', { content: 'x' }, bad));
  if (r) check('hostile proxy result -> {suspicious:false}', r.suspicious === false);
}

/* ======================================================================== */
section('9b. R9: noopCheck kill switch, write-tool gate, structured-vs-free-text');
HB = 'result';
{
  const W = (name, args, result, opts) => scanToolResult(name, args, result, opts);
  const payloadArgs = { content: 'x'.repeat(60) };
  const on = W('write', payloadArgs, { value: { status: 'noop' } });
  const off = W('write', payloadArgs, { value: { status: 'noop' } }, { noopCheck: false });
  harvest(on); harvest(off);
  check('R9: default (noopCheck:true) still detects', on.suspicious === true);
  check('R9: noopCheck:false disables M3 entirely',
    off.suspicious === false && Array.isArray(off.findings) && off.findings.length === 0,
    JSON.stringify(off));
  check('R9: noopCheck:false returns exactly {suspicious,findings}',
    canon(Object.keys(off).sort()) === canon(['findings', 'suspicious']),
    JSON.stringify(Object.keys(off)));
  check('R9: noopCheck:false does not change scanAssistantText',
    canon(scanAssistantText(v1Text, { noopCheck: false }, { hasToolCalls: false })) ===
    canon(scanAssistantText(v1Text, undefined, { hasToolCalls: false })));
  check('R9: noopCheck:false does not change scanToolArguments',
    canon(scanToolArguments('write', { content: damagedBig }, { noopCheck: false })) ===
    canon(scanToolArguments('write', { content: damagedBig })));
}
{
  const W = (name) => scanToolResult(name, { content: 'x'.repeat(60) }, { value: { status: 'noop' } });
  for (const n of ['write', 'edit', 'apply_patch', 'append', 'create_file', 'save', 'delete', 'move', 'copy', 'truncate', 'rename']) {
    harvest(W(n));
    check('R9: write-like tool "' + n + '" is judged', W(n).suspicious === true);
  }
  for (const n of ['read', 'grep', 'glob', 'bash', 'run_code', 'web_search', 'list_files', 'terminal', 'ops_bash', 'session_search', 'rg', 'cat']) {
    const r = W(n);
    harvest(r);
    check('R9: non-write tool "' + n + '" is never judged', r.suspicious === false, 'name=' + n);
  }
  check('R9: non-string tool name is never judged',
    scanToolResult(undefined, { content: 'x'.repeat(60) }, { value: { status: 'noop' } }).suspicious === false);
  check('R9: write gate applies even when noopCheck is on (read tool + explicit enum)',
    scanToolResult('grep', { content: 'x'.repeat(60) }, { value: { status: 'noop' } }).findings.length === 0);
}
{
  // Deliberate boundary: structured exact enum values ARE explicit evidence.
  const payloadArgs = { content: 'x'.repeat(60) };
  for (const [label, result] of [
    ['status:"unchanged"', { value: { status: 'unchanged' } }],
    ['status:"noop"', { value: { status: 'noop' } }],
    ['status:"no-op"', { value: { status: 'no-op' } }],
    ['status:"skipped"', { value: { status: 'skipped' } }],
    ['status:"nothing"', { value: { status: 'nothing' } }],
    ['noop:true', { value: { noop: true } }],
    ['skipped:true', { value: { skipped: true } }],
    ['unchanged:true', { value: { unchanged: true } }],
    ['no_change:true', { value: { no_change: true } }],
    ['applied:false', { value: { applied: false } }],
    ['changed:false', { value: { changed: false } }],
    ['written:0 (with payload)', { value: { written: 0 } }],
    ['bytesWritten:0 (with payload)', { value: { bytesWritten: 0 } }],
    ['meta.status:"noop"', { meta: { status: 'noop' } }],
  ]) {
    const r = scanToolResult('write', payloadArgs, result);
    harvest(r);
    check('R9 STRUCTURED evidence fires: ' + label,
      r.suspicious === true && hasBlockingCodes(r.findings, ['SUSPICIOUS_NOOP_RESULT']),
      JSON.stringify(r).slice(0, 170));
  }
  const noPayload = scanToolResult('write', { path: 'a.txt' }, { value: { written: 0 } });
  harvest(noPayload);
  check('R9: written:0 WITHOUT carried payload => not suspicious (path-only call)',
    noPayload.suspicious === false, JSON.stringify(noPayload));
}
{
  // Deliberate boundary: free text (phrases / prose / wrong keys / string leaf) is NOT evidence.
  for (const [label, result] of [
    ['content text "unchanged"', { content: [{ type: 'text', text: 'unchanged' }] }],
    ['content text "no changes"', { content: [{ type: 'text', text: 'no changes' }] }],
    ['content text "nothing to do"', { content: [{ type: 'text', text: 'nothing to do' }] }],
    ['content text "no-op"', { content: [{ type: 'text', text: 'no-op' }] }],
    ['content text "did not write"', { content: [{ type: 'text', text: 'did not write anything' }] }],
    ['content text zh 未做任何改动', { content: [{ type: 'text', text: '未做任何改动' }] }],
    ['content text zh 没有任何变更', { content: [{ type: 'text', text: '没有任何变更' }] }],
    ['git-status prose', { content: [{ type: 'text', text: 'Your branch is up to date. nothing to commit, working tree clean' }] }],
    ['status:"no changes" (spaced, not enum)', { value: { status: 'no changes' } }],
    ['status:"NO CHANGES" (case+space)', { value: { status: 'NO CHANGES' } }],
    ['note:"unchanged" (wrong key)', { value: { note: 'unchanged' } }],
    ['message:"no changes" (wrong key)', { value: { message: 'no changes' } }],
    ['bare string value "unchanged"', { value: 'unchanged' }],
  ]) {
    const r = scanToolResult('write', { content: 'x'.repeat(300) }, result);
    harvest(r);
    check('R9 FREE TEXT must NOT fire: ' + label,
      r.suspicious === false && r.findings.length === 0,
      JSON.stringify(r).slice(0, 170));
  }
}
{
  const r = scanToolResult('write', { content: 'x'.repeat(60) }, { value: { status: 'noop' } });
  check('R9: M3 reason is its own no-op text, never the B "structure damaged" block',
    typeof r.reason === 'string' && r.reason.includes('未产生任何改动') &&
    !r.reason.includes('结构校验失败') && !r.reason.includes('自动纠正'),
    JSON.stringify(r.reason));
  const en = scanToolResult('write', { content: 'x'.repeat(60) }, { value: { status: 'noop' } }, { lang: 'en' });
  check('R9: M3 reason respects lang=en', typeof en.reason === 'string' && /no changes/i.test(en.reason),
    JSON.stringify(en.reason));
  check('R9: M3 suspicious finding is SUSPICIOUS_NOOP_RESULT/severity warn only',
    r.findings.length === 1 && r.findings[0].code === 'SUSPICIOUS_NOOP_RESULT' && r.findings[0].severity === 'warn',
    JSON.stringify(r.findings));
}
{
  // An unreadable result must stay silent (never a false "no-op" verdict).
  const g = {};
  Object.defineProperty(g, 'value', { get() { throw new Error('trap'); }, enumerable: true });
  const r = callNoThrow('scanToolResult(throwing value getter)', () =>
    scanToolResult('write', { content: 'x'.repeat(60) }, g));
  if (r) {
    harvest(r);
    check('R9: unreadable result => suspicious:false, reason empty',
      r.suspicious === false && (r.reason === undefined || r.reason === ''),
      JSON.stringify(r).slice(0, 170));
  }
}

section('9c. R12/M5: sanitizeMessages purity + behavior');
HB = 'assistant';
{
  const healthy = { role: 'assistant', content: [{ type: 'text', text: 'a healthy plain answer' }] };
  const damaged = { role: 'assistant', content: [{ type: 'text', text: v1Text }] };
  const withCall = { role: 'assistant', content: [{ type: 'text', text: v1Text }, { type: 'tool-call', id: 't', name: 'write', arguments: '{}' }] };
  const userDamaged = { role: 'user', content: [{ type: 'text', text: v1Text }] };

  /* OFF by default: no scan at all. */
  const arrOff = [healthy, damaged];
  const beforeOff = snapStr(arrOff);
  const rOff = callNoThrow('sanitizeMessages(default/off)', () => sanitizeMessages(arrOff));
  if (rOff) {
    check('R12-off: changed === false', rOff.changed === false, JSON.stringify(rOff).slice(0, 120));
    check('R12-off: returns the ORIGINAL array reference', rOff.messages === arrOff);
    check('R12-off: rewrites === []', Array.isArray(rOff.rewrites) && rOff.rewrites.length === 0);
  }
  check('R12-off: input not mutated', snapStr(arrOff) === beforeOff);

  /* ON: the damaged assistant message is replaced by a single neutral text block. */
  const arrOn = [userDamaged, healthy, damaged, withCall];
  const beforeOn = snapStr(arrOn);
  const rOn = callNoThrow('sanitizeMessages(contextGuard:true)', () => sanitizeMessages(arrOn, { contextGuard: true }));
  if (rOn) {
    check('R12-on: changed === true', rOn.changed === true);
    check('R12-on: returns a NEW array (not the input reference)', rOn.messages !== arrOn);
    check('R12-on: exactly one rewrite, at the damaged assistant index 2',
      Array.isArray(rOn.rewrites) && rOn.rewrites.length === 1 && rOn.rewrites[0].index === 2,
      JSON.stringify(rOn.rewrites));
    check('R12-on: rewritten content is exactly one text block',
      Array.isArray(rOn.messages[2].content) && rOn.messages[2].content.length === 1 &&
      rOn.messages[2].content[0].type === 'text' && typeof rOn.messages[2].content[0].text === 'string');
    check('R12-on: rewritten message is a NEW object; untouched messages are reused by reference',
      rOn.messages[2] !== arrOn[2] && rOn.messages[0] === arrOn[0] &&
      rOn.messages[1] === arrOn[1] && rOn.messages[3] === arrOn[3]);
    check('R12-on: rewritten message keeps role=assistant', rOn.messages[2].role === 'assistant');
    check('R12-on: rewrites contain no payload text',
      !JSON.stringify(rOn.rewrites).includes('CANARY') &&
      !JSON.stringify(rOn.rewrites).includes('data-canary'));
    check('R12-on: rewrites carry FindingCodes',
      Array.isArray(rOn.rewrites[0].codes) && rOn.rewrites[0].codes.length > 0,
      JSON.stringify(rOn.rewrites[0].codes));
    check('R12-on: a tool-call message is never touched', rOn.messages[3] === arrOn[3]);
    check('R12-on: a non-assistant message is never touched', rOn.messages[0] === arrOn[0]);
  }
  check('R12-on: input not mutated (original damaged message intact)', snapStr(arrOn) === beforeOn);

  const arrHealthy = [healthy, userDamaged];
  const rHealthy = callNoThrow('sanitizeMessages(healthy, on)', () => sanitizeMessages(arrHealthy, { contextGuard: true }));
  if (rHealthy) {
    check('R12: nothing damaged -> changed:false + ORIGINAL array reference',
      rHealthy.changed === false && rHealthy.messages === arrHealthy);
  }

  {
    const identified = {
      id: 'MSG-ID-1', role: 'assistant', source: { kind: 'model' },
      content: [{ type: 'text', text: v1Text }],
    };
    const r = callNoThrow('sanitizeMessages(identified message)', () => sanitizeMessages([identified], { contextGuard: true }));
    if (r) {
      check('R12: id and source are preserved on the rewritten message',
        r.changed === true && r.messages[0].id === 'MSG-ID-1' &&
        JSON.stringify(r.messages[0].source) === JSON.stringify({ kind: 'model' }),
        JSON.stringify({ id: r.messages[0].id, source: r.messages[0].source }));
    }
  }

  const rNote = sanitizeMessages([damaged], { contextGuard: true, contextGuardNote: 'REDACTED-NOTE' });
  check('R12: contextGuardNote overrides the built-in note verbatim',
    rNote.changed === true && rNote.messages[0].content[0].text === 'REDACTED-NOTE',
    JSON.stringify(rNote.messages[0].content[0].text));
  const rZh = sanitizeMessages([damaged], { contextGuard: true, lang: 'zh' });
  const rEn = sanitizeMessages([damaged], { contextGuard: true, lang: 'en' });
  check('R12: lang switches the built-in note',
    rZh.messages[0].content[0].text !== rEn.messages[0].content[0].text,
    JSON.stringify([rZh.messages[0].content[0].text, rEn.messages[0].content[0].text]));
  check('R12: the neutral note contains no payload text',
    !rZh.messages[0].content[0].text.includes('CANARY_V1_PAYLOAD') &&
    !rZh.messages[0].content[0].text.includes('data-canary'));

  /* Hostile inputs must never throw and must degrade to changed:false. */
  for (const [label, input] of [
    ['undefined', undefined], ['null', null], ['string', 'nope'], ['number', 7],
    ['plain object', {}], ['function', function () {}], ['empty array', []],
    ['array of junk', [null, 42, 'x', {}, []]],
  ]) {
    const r = callNoThrow('sanitizeMessages(' + label + ', on)', () => sanitizeMessages(input, { contextGuard: true }));
    if (r) {
      check('R12 hostile(' + label + '): shape {changed,messages,rewrites}',
        typeof r.changed === 'boolean' && Array.isArray(r.rewrites) && 'messages' in r);
    }
  }
  {
    const cyc = [damaged];
    cyc.push(cyc);
    const r = callNoThrow('sanitizeMessages(cyclic array)', () => sanitizeMessages(cyc, { contextGuard: true }));
    if (r) {
      check('R12 cyclic array: no throw, damaged still rewritten at index 0',
        r.changed === true && r.rewrites[0].index === 0, JSON.stringify(r.rewrites));
    }
  }
  {
    const throwing = new Proxy([], { get() { throw new Error('trap'); } });
    const r = callNoThrow('sanitizeMessages(hostile proxy)', () => sanitizeMessages(throwing, { contextGuard: true }));
    if (r) {
      check('R12 hostile proxy: no throw, changed:false, original reference returned',
        r.changed === false && r.messages === throwing);
    }
  }
  {
    const throwingMsg = { role: 'assistant', get content() { throw new Error('trap'); } };
    const r = callNoThrow('sanitizeMessages(throwing content getter)',
      () => sanitizeMessages([throwingMsg], { contextGuard: true }));
    if (r) check('R12 throwing content getter: no throw', typeof r.changed === 'boolean');
  }
  {
    const frozen = deepFreeze([{ role: 'assistant', content: [{ type: 'text', text: v1Text }] }]);
    const r = callNoThrow('sanitizeMessages(deep-frozen input, on)', () => sanitizeMessages(frozen, { contextGuard: true }));
    if (r) check('R12 deep-frozen input: no throw and still rewrites',
      r.changed === true && r.messages !== frozen);
  }
}

section('10. buildCorrectionMessage / buildDenyReason');
/* ======================================================================== */
{
  const r = buildCorrectionMessage([{ code: 'PAYLOAD_TOO_LONG', severity: 'warn' }]);
  check('buildCorrectionMessage non-empty for warn', typeof r === 'string' && r.length > 0);
  check('buildCorrectionMessage default lang zh', r.includes('自动纠正'));
  const en = buildCorrectionMessage([{ code: 'END_SEQUENCE_MULTIPLIED', severity: 'error' }], { lang: 'en', maxLines: 7 });
  check('buildCorrectionMessage respects lang + {MAX}', en.includes('automatic correction') && en.includes('<= 7'));
  check('buildCorrectionMessage empty when only info',
    buildCorrectionMessage([{ code: 'CLOSING_TAG_DENSITY', severity: 'info' }]) === '');
  check('buildCorrectionMessage empty for [] / null',
    buildCorrectionMessage([]) === '' && buildCorrectionMessage(null) === '' && buildCorrectionMessage(undefined) === '');
  check('buildCorrectionMessage never throws on garbage',
    typeof buildCorrectionMessage('x') === 'string');
}
{
  const r = buildDenyReason([{ code: 'END_SEQUENCE_MULTIPLIED', severity: 'error' }]);
  check('buildDenyReason non-empty, states NOT executed, <=400',
    r.length > 0 && r.length <= 400 && (r.includes('未执行') || r.includes('NOT executed')), 'len=' + r.length);
  check('buildDenyReason empty for no blocking findings',
    buildDenyReason([{ code: 'CLOSING_TAG_DENSITY', severity: 'info' }]) === '' &&
    buildDenyReason([]) === '' && buildDenyReason(null) === '');
  const big = [];
  for (let i = 0; i < 120; i += 1) big.push({ code: 'END_SEQUENCE_MULTIPLIED', severity: 'error', detail: 'x'.repeat(500) });
  const rb = buildDenyReason(big);
  check('buildDenyReason truncates to <=400 for huge findings', rb.length <= 400, 'len=' + rb.length);
  const ren = buildDenyReason([{ code: 'MISSING_OPENING_MARKUP', severity: 'error' }], { lang: 'en' });
  check('buildDenyReason respects lang', ren.includes('NOT executed'));
}

/* ======================================================================== */
section('11. idempotence, purity (no console), unknown FindingCode guard');
/* ======================================================================== */
{
  const pairs = [
    [() => scanAssistantText(v1Text, undefined, { hasToolCalls: false })],
    [() => scanAssistantText(okHtml)],
    [() => scanToolArguments('write', { content: damagedBig })],
    [() => scanToolArguments('write', { content: okBigHtml })],
    [() => scanToolResult('write', { content: 'x'.repeat(60) }, { value: { status: 'noop' } })],
  ];
  let same = true;
  for (const [fn] of pairs) {
    const a = JSON.stringify(fn());
    const b = JSON.stringify(fn());
    if (a !== b) same = false;
  }
  check('idempotent: same input -> identical output (5 cases)', same);
}
{
  const realLog = console.log, realErr = console.error, realWarn = console.warn;
  let calls = 0;
  console.log = () => { calls += 1; };
  console.error = () => { calls += 1; };
  console.warn = () => { calls += 1; };
  try {
    scanAssistantText(v1Text, undefined, { hasToolCalls: false });
    scanAssistantText(v3Text);
    scanToolArguments('write', { content: damagedBig });
    scanToolResult('write', { content: 'x'.repeat(60) }, { value: { status: 'noop' } });
    buildDenyReason([{ code: 'END_SEQUENCE_MULTIPLIED', severity: 'error' }]);
  } finally {
    console.log = realLog; console.error = realErr; console.warn = realWarn;
  }
  check('detect functions write nothing to console (no logging)', calls === 0, 'console calls=' + calls);
}
{
  check('R5: SUSPICIOUS_NOOP_RESULT never leaks into scanAssistantText',
    !CODES_BY_FN.assistant.has('SUSPICIOUS_NOOP_RESULT'),
    JSON.stringify([...CODES_BY_FN.assistant]));
  check('R5: SUSPICIOUS_NOOP_RESULT never leaks into scanToolArguments',
    !CODES_BY_FN.args.has('SUSPICIOUS_NOOP_RESULT'),
    JSON.stringify([...CODES_BY_FN.args]));
  // R5 only forbids SUSPICIOUS_NOOP_RESULT outside scanToolResult; INTERNAL_ERROR
  // is the honest degradation code and MAY appear in any of the three functions.
  check('R5: scanToolResult is the only producer of SUSPICIOUS_NOOP_RESULT',
    CODES_BY_FN.result.has('SUSPICIOUS_NOOP_RESULT') &&
    !CODES_BY_FN.assistant.has('SUSPICIOUS_NOOP_RESULT') &&
    !CODES_BY_FN.args.has('SUSPICIOUS_NOOP_RESULT'),
    'result=' + JSON.stringify([...CODES_BY_FN.result]));
  check('R5: INTERNAL_ERROR is allowed to degrade inside scanToolResult',
    CODES_BY_FN.result.has('INTERNAL_ERROR'),
    'result=' + JSON.stringify([...CODES_BY_FN.result]));
  const unknown = [...CODES_SEEN].filter((c) => !FROZEN_CODES.has(c));
  check('no FindingCode outside the frozen set was ever produced', unknown.length === 0, JSON.stringify(unknown));
  const missing = [...FROZEN_CODES].filter((c) => !CODES_SEEN.has(c));
  note('FindingCode coverage', 'produced=' + [...CODES_SEEN].sort().join(',') + '  not-produced=' + (missing.join(',') || '(none)'));
  if (missing.length) {
    defect('D-4', 'info', 'frozen FindingCodes not exercised by this probe: ' + missing.join(', '));
  }
}

/* ======================================================================== */
section('12. large-input performance (adversarial)');
HB = 'assistant';
/* ======================================================================== */
{
  const fiveMbAscii = 'x'.repeat(5 * 1024 * 1024);
  const t1 = ms(() => scanAssistantText(fiveMbAscii, undefined, { hasToolCalls: false }));
  check('5MB plain text: no throw, <5000ms', t1.ms < 5000, 'ms=' + t1.ms.toFixed(1));
  harvest(t1.value);
  check('5MB plain text: length reported', t1.value.evidence.length === fiveMbAscii.length);

  const fiveMbTags = (LT + SL + 'div' + GT + '\n').repeat(500000);
  const t2 = ms(() => scanAssistantText(fiveMbTags, undefined, { hasToolCalls: false }));
  check('5MB of closing tags: no throw, <5000ms', t2.ms < 5000, 'ms=' + t2.ms.toFixed(1) + ' len=' + fiveMbTags.length);
  harvest(t2.value);
  console.log('  5MB closing-tag scan: closingTagCount=' + t2.value.evidence.closingTagCount + ' damaged=' + t2.value.damaged + ' ms=' + t2.ms.toFixed(1));

  HB = 'args';
  const threeMb = (LT + 'invoke name="x">\n' + LT + 'parameter name="c">y\n' + LT + SL + 'parameter' + GT + '\n').repeat(30000);
  const t3 = ms(() => scanToolArguments('write', { content: threeMb }));
  check('~2.6MB call markup via args: no throw, <5000ms', t3.ms < 5000, 'ms=' + t3.ms.toFixed(1) + ' len=' + threeMb.length);
  harvest(t3.value);
  console.log('  call-markup args: action=' + t3.value.action + ' ms=' + t3.ms.toFixed(1) + ' codes=' + JSON.stringify(t3.value.findings.map((f) => f.code)));

  const adversarial = (LT.repeat(100000) + GT.repeat(100000));
  const t4 = ms(() => scanAssistantText(adversarial, undefined, { hasToolCalls: false }));
  check('pathological < / > flood: no throw, <5000ms', t4.ms < 5000, 'ms=' + t4.ms.toFixed(1));
  const t5 = ms(() => scanToolArguments('write', { content: adversarial }));
  check('pathological flood via args: no throw, <5000ms', t5.ms < 5000, 'ms=' + t5.ms.toFixed(1));
}

/* ======================================================================== */
section('SUMMARY');
/* ======================================================================== */
console.log('PASS=' + PASS + '  FAIL=' + FAIL + '  NOTES=' + NOTES.length + '  DEFECTS=' + DEFECTS.length);
if (FAILURES.length) {
  console.log('\n--- failed checks ---');
  for (const f of FAILURES) console.log('  * ' + f.name + (f.extra ? '  :: ' + f.extra : ''));
}
if (DEFECTS.length) {
  console.log('\n--- defect list ---');
  for (const d of DEFECTS) console.log('  [' + d.severity + '] ' + d.id + ' ' + d.title);
}
console.log('\n--- raw snapshot ---');
console.log('frozenCodesProduced=' + JSON.stringify([...CODES_SEEN].sort()));
process.exitCode = FAIL > 0 ? 1 : 0;

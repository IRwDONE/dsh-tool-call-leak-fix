#!/usr/bin/env node
/**
 * verify/probe-index.mjs — INDEPENDENT wiring probe for plugin/index.js.
 *
 * Drives the plugin's real listeners through a mock Cordis context and asserts
 * the task-4 checklist: try/catch degradation, next() when not taking over,
 * effect-based registration, Config actually read, no hardcoded payload, M4 seam
 * (session/event -> agent/turn-stopping -> agent.inject), and M2's V4 guard
 * being limited to tools that declare non-empty required parameters.
 *
 * M1 (system-prompt prevention block) was removed by user decision: the plugin
 * is code-layer only. This probe therefore asserts its ABSENCE (no
 * systemPrompt.section registration, inject === ['tools'], and apply() survives
 * a profile whose systemPrompt service is a throwing getter).
 *
 * It needs no DSH runtime and installs nothing. Tag tokens are assembled from
 * fragments so this source cannot itself become a payload.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INDEX_PATH = path.join(ROOT, 'plugin', 'index.js');
const DETECT_PATH = path.join(ROOT, 'plugin', 'src', 'detect.js');

const LT = '<', GT = '>', SL = '/';
const OPEN_INVOKE = LT + 'invoke';
const OPEN_PARAM = LT + 'parameter';
const END_INVOKE = LT + SL + 'invoke' + GT;
const END_PARAM = LT + SL + 'parameter' + GT;

let PASS = 0, FAIL = 0;
const FAILURES = [], NOTES = [], DEFECTS = [];
const check = (name, cond, extra = '') => {
  if (cond) { PASS += 1; console.log('PASS  ' + name); }
  else { FAIL += 1; FAILURES.push({ name, extra }); console.log('FAIL  ' + name + (extra ? '  :: ' + extra : '')); }
};
const note = (n, t) => { NOTES.push({ n, t }); console.log('NOTE  ' + n + ' :: ' + t); };
const defect = (id, sev, title) => DEFECTS.push({ id, sev, title });
const section = (t) => console.log('\n== ' + t + ' ==');
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const canon = (v) => JSON.stringify(v);
/* Every assertion below guards its own dereferences, so one bad assumption can
 * never abort the probe before SUMMARY. */
const bigHtml = (n) => {
  let s = '';
  for (let i = 0; i < n; i += 1) s += LT + 'div class="x">item-' + i + LT + SL + 'div' + GT + '\n';
  return s;
};
const readFixture = (f) => readFileSync(path.join(ROOT, 'tests', 'fixtures', f), 'utf8');

/* MessageSourceMap kinds admitted by the current v4 session format (see
 * dsh-session-format-v3-to-v4/lib/index.js source(): kind "plugin" is rejected). */
const ADMITTED_KINDS = new Set(['user', 'model', 'tool', 'system-prompt', 'model-selection', 'runtime-context',
  'working-directory', 'user-approval', 'ptc-mode', 'tool-registry', 'agent-message', 'subagent-settled',
  'skill-invocation', 'compact-checkpoint', 'cordis-host-runner', 'team-message', 'user-question-reply',
  'goal', 'plan-mode', 'schedule', 'session-reference', 'webhook']);
const isAdmittedKind = (kind) => ADMITTED_KINDS.has(kind) || (typeof kind === 'string' && kind.startsWith('plugin:'));

/* Cordis seams. Counts are always DERIVED from the registered handler set —
 * never hardcoded (that is the "frozen 7 keys" mistake in another guise).
 *  - CORE_EVENTS: must be registered for the shipped mechanisms M2/M3/M4.
 *  - OPTIONAL_EVENTS: seams that MAY be registered (M5's `llm/stream` is
 *    currently WITHDRAWN by user decision, see D-8); if one is present, its
 *    behaviour is checked rather than assumed. */
const CORE_EVENTS = [
  'tools/pre-execute',
  'tools/post-execute',
  'session/event',
  'agent/turn-stopping',
];
const OPTIONAL_EVENTS = ['llm/stream'];
const ALLOWED_EVENTS = [...CORE_EVENTS, ...OPTIONAL_EVENTS];

section('0. provenance');
const idxSrc = readFileSync(INDEX_PATH, 'utf8');
const detSrc = readFileSync(DETECT_PATH, 'utf8');
console.log('index.js  sha256=' + sha(idxSrc) + ' bytes=' + idxSrc.length);
console.log('detect.js sha256=' + sha(detSrc) + ' bytes=' + detSrc.length);

const mod = await import(pathToFileURL(INDEX_PATH).href);
section('1. module shape (apply / inject)');
check('index.js default-loads and exports apply()', typeof mod.apply === 'function');
check('index.js exports inject as an array of service names',
  Array.isArray(mod.inject) && mod.inject.every((s) => typeof s === 'string'),
  JSON.stringify(mod.inject));
check('M1-removed: inject === ["tools"] (never systemPrompt)',
  canon(mod.inject) === canon(['tools']), JSON.stringify(mod.inject));

/* -------- mock Cordis ctx: records effects and handlers -------- */
function mockCtx() {
  const handlers = new Map();
  const effects = [];
  const sections = [];
  const ctx = {
    systemPrompt: { section(opts) { sections.push(opts); return () => {}; } },
    tools: {},
    on(name, listener) { handlers.set(name, listener); return () => {}; },
    effect(fn) { effects.push(fn()); },
  };
  return { ctx, handlers, effects, sections };
}

section('1b. Config export: hand-written Standard Schema v1 (R9)');
{
  check('index.js exports Config', typeof mod.Config === 'function');
  if (typeof mod.Config === 'function') {
    const called = mod.Config({ maxLines: 7 });
    check('Config is callable schemastery-style: Config(raw) -> merged config',
      called && called.maxLines === 7 && called.noopCheck === true, JSON.stringify(called));
    const std = mod.Config['~standard'];
    check('Config["~standard"] exists with version 1 + validate()',
      !!std && std.version === 1 && typeof std.validate === 'function',
      JSON.stringify(std && { version: std.version, vendor: std.vendor }));
    if (std && typeof std.validate === 'function') {
      const v = std.validate({ maxLines: 7, maxChars: 0, lang: 'fr', noopCheck: false, junk: 1 });
      check('Config.validate returns {value} and never {issues} (cannot deactivate the plugin)',
        v && v.value && !v.issues, JSON.stringify(v && Object.keys(v)));
      check('Config.validate clamps exactly like mergeConfig (R7)',
        v && v.value.maxLines === 7 && v.value.maxChars === 20000 && v.value.lang === 'zh' &&
        v.value.noopCheck === false, JSON.stringify(v && v.value));
      check('Config.validate drops unknown keys', v && v.value && !('junk' in v.value));
      const d = std.validate(null);
      check('Config.validate(null) -> full defaults (incl. noopCheck:true)',
        d && d.value && d.value.maxLines === 100 && d.value.noopCheck === true, JSON.stringify(d && d.value));
      check('Config.validate is idempotent on its own output',
        v && JSON.stringify(std.validate(v.value).value) === JSON.stringify(v.value));
      /* R10 diagnostics plumbing. */
      check('Config.validate({debugLog:true}) -> true', std.validate({ debugLog: true }).value.debugLog === true);
      check('Config.validate defaults debugLog to false', std.validate({}).value.debugLog === false);
      check('Config.validate keeps a supplied debugLogPath',
        std.validate({ debugLogPath: '/tmp/y.log' }).value.debugLogPath === '/tmp/y.log');
      const allKeys = Object.keys(std.validate({}).value).sort();
      check('Config.validate covers all 12 documented config keys',
        ['enabled', 'maxLines', 'maxChars', 'closingTagCount', 'endSequenceRepeats',
          'maxCorrectionsPerTurn', 'lang', 'noopCheck', 'debugLog', 'debugLogPath',
          'contextGuard', 'contextGuardNote']
          .every((k) => allKeys.includes(k)), JSON.stringify(allKeys));
      check('R10: Config.validate defaults debugLogPath to "" (matches the contract)',
        std.validate({}).value.debugLogPath === '', JSON.stringify(std.validate({}).value.debugLogPath));
      check('R12: Config.validate defaults contextGuard to false',
        std.validate({}).value.contextGuard === false);
      check('R12: Config.validate keeps contextGuardNote',
        std.validate({ contextGuardNote: 'N' }).value.contextGuardNote === 'N');
    }
  }
}

section('2. apply(): Config read + effect-based registration (M1 removed)');
{
  const { ctx, handlers, effects, sections } = mockCtx();
  mod.apply(ctx, { enabled: false });
  check('enabled:false registers nothing', effects.length === 0 && handlers.size === 0 && sections.length === 0);
}
{
  const { ctx, handlers, effects, sections } = mockCtx();
  mod.apply(ctx, { maxLines: 7, lang: 'en' });
  check('one listener per ctx.effect registration (count derived, never hardcoded)',
    effects.length === handlers.size && effects.length > 0,
    'effects=' + effects.length + ' handlers=' + handlers.size);
  check('every effect returned a disposer function', effects.every((d) => typeof d === 'function'),
    'types=' + effects.map((d) => typeof d).join(','));
  /* M1 was removed by user decision (code layer only). These are regression guards. */
  check('M1-removed: apply() never registers a systemPrompt.section',
    Array.isArray(sections) && sections.length === 0, 'sections=' + JSON.stringify(sections));
  for (const name of CORE_EVENTS) {
    check('core listener registered: ' + name, handlers.has(name));
  }
  check('no listener outside the allowed event set',
    [...handlers.keys()].every((n) => ALLOWED_EVENTS.includes(n)),
    JSON.stringify([...handlers.keys()]));
  check('registered set == CORE + whichever OPTIONAL seams are wired',
    handlers.size >= CORE_EVENTS.length &&
    CORE_EVENTS.every((n) => handlers.has(n)) &&
    [...handlers.keys()].every((n) => ALLOWED_EVENTS.includes(n)),
    JSON.stringify([...handlers.keys()]));
  note('registered seams', JSON.stringify([...handlers.keys()].sort()) +
    ' (OPTIONAL ' + JSON.stringify(OPTIONAL_EVENTS) + ' wired=' +
    OPTIONAL_EVENTS.filter((n) => handlers.has(n)).length + ')');
  check('unload: invoking every disposer does not throw',
    (() => { try { effects.forEach((d) => d()); return true; } catch (e) { return false; } })());
  // missing-service degradation
  let threw = false;
  try { mod.apply({}, {}); mod.apply({ on() { throw new Error('x'); } }, {}); } catch { threw = true; }
  check('apply() degrades on a ctx without tools / with a throwing on()', !threw);
}
{
  /* Regression guard for the M1 removal: a profile whose `systemPrompt` service
   * is a throwing getter must not break apply() at all (nothing may touch it). */
  const handlers = new Map();
  const effects = [];
  const ctx = {
    get systemPrompt() { throw new Error('systemPrompt must not be touched'); },
    tools: {},
    on(name, listener) { handlers.set(name, listener); return () => {}; },
    effect(fn) { effects.push(fn()); },
  };
  let err = '';
  try { mod.apply(ctx, {}); } catch (e) { err = (e && e.message) || String(e); }
  check('M1-removed: apply() completes when systemPrompt is a throwing getter',
    err === '' && effects.length === handlers.size && handlers.has('tools/pre-execute'),
    'err=' + JSON.stringify(err) + ' effects=' + effects.length);
}
{
  /* Static guards: no prompt-layer code may remain in index.js. */
  const code = idxSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1 ');
  check('M1-removed (static): no systemPrompt reference in index.js code',
    !/systemPrompt/.test(code));
  check('M1-removed (static): no PREVENTION_TEXT / preventionText left',
    !/PREVENTION_TEXT|preventionText/.test(code));
  check('M1-removed (static): the A-block prompt text is not hardcoded in index.js',
    !/工具调用结构纪律/.test(idxSrc));
}

{
  /* R10 diagnostics: turning on debugLog must not break registration or throw. */
  const { ctx, handlers, effects } = mockCtx();
  const scratchLog = path.join(os.tmpdir(), 'guard-probe-debug.log'); // never litter verify/
  let err = '';
  try { mod.apply(ctx, { debugLog: true, debugLogPath: scratchLog }); }
  catch (e) { err = (e && e.message) || String(e); }
  check('R10: apply() with debugLog:true completes and still registers the full event set',
    err === '' && effects.length === handlers.size && handlers.has('tools/post-execute'),
    'err=' + JSON.stringify(err) + ' effects=' + effects.length);
}

section('3. M2 tools/pre-execute: deny damaged, next() otherwise');
{
  const { ctx, handlers } = mockCtx();
  mod.apply(ctx, {});
  const pre = handlers.get('tools/pre-execute');
  const damaged = bigHtml(40) + END_INVOKE + '\n' + END_INVOKE + '\n';

  let nextCalls = 0;
  const next = () => { nextCalls += 1; return { kind: 'accept' }; };
  const deny = await pre.call(undefined, { name: 'write', arguments: { content: damaged } }, next);
  check('M2: damaged args => {kind:"deny"} with a reason',
    deny && deny.kind === 'deny' && typeof deny.reason === 'string' && deny.reason.length > 0,
    JSON.stringify(deny));
  check('M2: takeover path does NOT call next()', nextCalls === 0, 'nextCalls=' + nextCalls);

  nextCalls = 0;
  const ok = await pre.call(undefined, { name: 'write', arguments: { content: 'short healthy text' } }, next);
  check('M2: healthy args => calls next() and returns its value',
    nextCalls === 1 && ok && ok.kind === 'accept', 'nextCalls=' + nextCalls + ' ret=' + JSON.stringify(ok));

  nextCalls = 0;
  const passthru = await pre.call(undefined, undefined, next);
  check('M2: malformed exec => still calls next()', nextCalls === 1 && passthru && passthru.kind === 'accept');
}

section('4. M2 V4 guard: only for tools declaring non-empty required params');
{
  const { ctx, handlers } = mockCtx();
  mod.apply(ctx, {});
  const pre = handlers.get('tools/pre-execute');
  let nextCalls = 0;
  const next = () => { nextCalls += 1; return { kind: 'accept' }; };

  const withRequired = { get: () => ({ parameters: { type: 'object', required: ['content', 'path'] } }) };
  nextCalls = 0;
  const d1 = await pre.call(withRequired, { name: 'write', arguments: {} }, next);
  check('V4: empty args + declared required => deny', d1 && d1.kind === 'deny', JSON.stringify(d1));
  check('V4: denial names the missing required keys',
    d1 && typeof d1.reason === 'string' && d1.reason.includes('content') && d1.reason.includes('path'),
    d1 && d1.reason);

  const noRequired = { get: () => ({ parameters: { type: 'object' } }) };
  nextCalls = 0;
  const d2 = await pre.call(noRequired, { name: 'list_stuff', arguments: {} }, next);
  check('V4: genuine no-argument tool (no required) => NOT denied',
    nextCalls === 1 && (!d2 || d2.kind !== 'deny'), 'nextCalls=' + nextCalls + ' ret=' + JSON.stringify(d2));

  const emptyRequired = { get: () => ({ parameters: { type: 'object', required: [] } }) };
  nextCalls = 0;
  await pre.call(emptyRequired, { name: 'noop_tool', arguments: {} }, next);
  check('V4: required:[] => NOT denied (next called)', nextCalls === 1, 'nextCalls=' + nextCalls);

  const unknownSchema = { get: () => undefined };
  nextCalls = 0;
  await pre.call(unknownSchema, { name: 'unknown', arguments: {} }, next);
  check('V4: unknown tool schema => NOT denied (conservative)', nextCalls === 1, 'nextCalls=' + nextCalls);

  nextCalls = 0;
  const d3 = await pre.call(withRequired, { name: 'write', arguments: { content: 'x' } }, next);
  check('V4: non-empty args => NOT denied', nextCalls === 1 && (!d3 || d3.kind !== 'deny'), 'nextCalls=' + nextCalls);

  nextCalls = 0;
  const throwing = { get() { throw new Error('boom'); } };
  const d4 = await pre.call(throwing, { name: 'write', arguments: {} }, next);
  check('V4: throwing registry => listener does not throw, calls next()',
    nextCalls === 1 && (!d4 || d4.kind !== 'deny'), 'nextCalls=' + nextCalls);
}

section('5. M3 tools/post-execute: always next(), enrich on suspicion');
{
  const { ctx, handlers } = mockCtx();
  mod.apply(ctx, {});
  const post = handlers.get('tools/post-execute');
  let nextCalls = 0;
  const next = async () => { nextCalls += 1; return { kind: 'accept' }; };

  const exec = { name: 'write', arguments: { content: 'x'.repeat(60) } };
  const res = await post.call(undefined, exec, { value: { status: 'noop' } }, next);
  check('M3: calls next() exactly once', nextCalls === 1, 'nextCalls=' + nextCalls);
  check('M3: suspicious no-op => decision gains additionalContexts',
    res && Array.isArray(res.additionalContexts) && res.additionalContexts.length >= 1,
    JSON.stringify(res && res.kind));
  if (res && Array.isArray(res.additionalContexts) && res.additionalContexts.length >= 1) {
    const msg = res.additionalContexts[0];
    check('M3: additionalContexts entry is a user message with the correction text',
      msg && msg.role === 'user' && Array.isArray(msg.content) && msg.content[0] && msg.content[0].type === 'text');
    const kind = msg && msg.source && msg.source.kind;
    check('M3: additionalContexts source.kind is an admitted v4 producer kind',
      isAdmittedKind(kind), 'kind=' + JSON.stringify(kind));
    if (!isAdmittedKind(kind)) {
      defect('D-0b', 'high',
        'M3 additionalContexts message uses source.kind=' + JSON.stringify(kind) +
        ' which the v4 admission validator rejects (kind "plugin" is the retired V3 wrapper).');
    }
  }

  nextCalls = 0;
  const res2 = await post.call(undefined, exec, { value: { status: 'applied' } }, next);
  check('M3: clean result => decision unchanged (still next()ed once)',
    nextCalls === 1 && res2 && res2.additionalContexts === undefined, JSON.stringify(res2));

  nextCalls = 0;
  const res3 = await post.call(undefined, exec, { value: { status: 'noop' } }, async () => { nextCalls += 1; return { kind: 'reject' }; });
  check('M3: unknown downstream decision kind => left untouched',
    nextCalls === 1 && res3 && res3.kind === 'reject' && res3.additionalContexts === undefined,
    JSON.stringify(res3));
}

section('5b. R9: M3 kill switch, write-tool gate, own reason text');
{
  const runM3 = async (cfg, exec, result) => {
    const { ctx, handlers } = mockCtx();
    mod.apply(ctx, cfg);
    return handlers.get('tools/post-execute').call(undefined, exec, result, async () => ({ kind: 'accept' }));
  };
  const writeExec = (name) => ({ name: name || 'write', arguments: { content: 'x'.repeat(60) } });

  const on = await runM3({}, writeExec(), { value: { status: 'noop' } });
  check('R9/M3: default config => M3 still enriches',
    Array.isArray(on.additionalContexts) && on.additionalContexts.length === 1, JSON.stringify(on));
  const off = await runM3({ noopCheck: false }, writeExec(), { value: { status: 'noop' } });
  check('R9/M3: noopCheck:false => M3 never enriches', !off.additionalContexts, JSON.stringify(off));
  const readTool = await runM3({}, writeExec('grep'), { value: { status: 'noop' } });
  check('R9/M3: non-write tool => M3 never enriches', !readTool.additionalContexts, JSON.stringify(readTool));
  const freeText = await runM3({}, writeExec(), { content: [{ type: 'text', text: 'nothing to do; unchanged' }] });
  check('R9/M3: free-text result => M3 never enriches', !freeText.additionalContexts, JSON.stringify(freeText));

  const text = on.additionalContexts && on.additionalContexts[0] && on.additionalContexts[0].content[0].text;
  check('R9/M3: injected text is the no-op reason, NOT the B "structure damaged" block',
    typeof text === 'string' && text.includes('未产生任何改动') && !text.includes('结构校验失败') &&
    !text.includes('自动纠正'), JSON.stringify(text));
  check('R9/M3: injected text carries no payload', typeof text === 'string' && !text.includes('CANARY'));
  const en = await runM3({ lang: 'en' }, writeExec(), { value: { status: 'noop' } });
  const enText = en.additionalContexts && en.additionalContexts[0].content[0].text;
  check('R9/M3: text respects lang=en', typeof enText === 'string' && /no changes/i.test(enText), JSON.stringify(enText));
}

section('6. M4 seam: session/event -> agent/turn-stopping -> agent.inject');
const v1Text = readFixture('v1-end-multiplied.txt');
function m4Ctx(config) {
  const { ctx, handlers } = mockCtx();
  mod.apply(ctx, config || {});
  return {
    onAssistant(sessionId, turn, message) {
      handlers.get('session/event')({ id: sessionId }, { type: 'assistant/message', data: { turn, step: 1, message } });
    },
    stop(sessionId, turn) {
      const injected = [];
      handlers.get('agent/turn-stopping')({
        agent: { id: sessionId, inject: (msg) => injected.push(msg) },
        turn,
      });
      return injected;
    },
  };
}
{
  const m = m4Ctx({ maxCorrectionsPerTurn: 1 });
  m.onAssistant('s1', 1, { role: 'assistant', content: [{ type: 'text', text: v1Text }] });
  const inj = m.stop('s1', 1);
  check('M4: damaged assistant text (no tool-call) => one inject()', inj.length === 1, 'n=' + inj.length);
  if (inj.length === 1) {
    const msg = inj[0];
    console.log('  injected message = ' + JSON.stringify(msg));
    check('M4: injected message is a user message with a text block',
      msg && msg.role === 'user' && Array.isArray(msg.content) && msg.content[0] && msg.content[0].type === 'text');
    check('M4: injected text is the correction prompt, not the payload',
      typeof msg.content[0].text === 'string' && !msg.content[0].text.includes('CANARY_V1_PAYLOAD'));
    const kind = msg.source && msg.source.kind;
    const valid = isAdmittedKind(kind);
    check('M4: injected message source.kind is an admitted v4 producer kind', valid,
      'kind=' + JSON.stringify(kind) + ' source=' + JSON.stringify(msg.source));
    if (!valid) {
      defect('D-0', 'high',
        'index.js pluginMessage() tags messages source.kind="plugin" — the retired V3 wrapper. ' +
        'The live v4 admission validator rejects it: assertReleasedV4Relationships -> source() throws ' +
        '"format v4 message requires a producer-owned source kind" when kind==="plugin" ' +
        '(dsh-session-format-v3-to-v4/lib/index.js:124-127, called at :1032). Affects M4 agent.inject and M3 additionalContexts.');
    }
    check('M4: injected message carries a string id', typeof msg.id === 'string' && msg.id.length > 0);
  }
  check('M4: per-turn cap honored (2nd stop injects nothing)', m.stop('s1', 1).length === 0);
}
{
  const m = m4Ctx({ maxCorrectionsPerTurn: 1 });
  m.onAssistant('s2', 1, { role: 'assistant', content: [{ type: 'text', text: 'healthy plain answer' }] });
  check('M4: healthy assistant text => no inject', m.stop('s2', 1).length === 0);
}
{
  const m = m4Ctx({ maxCorrectionsPerTurn: 1 });
  m.onAssistant('s3', 1, {
    role: 'assistant',
    content: [{ type: 'text', text: v1Text }, { type: 'tool-call', id: 't1', name: 'write', arguments: '{}' }],
  });
  check('M4: damaged text WITH tool calls => no inject (R1 hasToolCalls)', m.stop('s3', 1).length === 0);
}
{
  const m = m4Ctx({ maxCorrectionsPerTurn: 1 });
  m.onAssistant('s4', 1, { role: 'assistant', content: [{ type: 'text', text: v1Text }] });
  check('M4: first stop injects', m.stop('s4', 1).length === 1);
  m.onAssistant('s4', 2, { role: 'assistant', content: [{ type: 'text', text: v1Text }] });
  check('M4: cap resets for a new turn', m.stop('s4', 2).length === 1);
}
{
  const m = m4Ctx({ maxCorrectionsPerTurn: 0 });
  m.onAssistant('s5', 1, { role: 'assistant', content: [{ type: 'text', text: v1Text }] });
  check('M4: maxCorrectionsPerTurn:0 disables self-heal', m.stop('s5', 1).length === 0);
}
{
  const m = m4Ctx({});
  m.onAssistant('s6', 1, { role: 'assistant', content: [{ type: 'text', text: v1Text }] });
  let threw = false;
  try { m.stop('s6', 1); } catch { threw = true; }
  check('M4: turn-stopping listener never throws', !threw);
  // listener robustness on malformed payloads
  const { ctx, handlers } = mockCtx();
  mod.apply(ctx, {});
  let bad = 0;
  for (const p of [undefined, null, {}, { agent: null }, { agent: {} }, { agent: { inject: null }, turn: 1 }]) {
    try { handlers.get('agent/turn-stopping')(p); } catch { bad += 1; }
  }
  check('M4: malformed turn-stopping payloads never throw', bad === 0, 'throws=' + bad);
  for (const ev of [undefined, null, {}, { type: 'x' }, { type: 'assistant/message' }, { type: 'assistant/message', data: {} }]) {
    try { handlers.get('session/event')({ id: 'x' }, ev); } catch { bad += 1; }
  }
  check('M4: malformed session events never throw', bad === 0, 'throws=' + bad);
}

section('6b. M5/R12 wiring status + (if wired) llm/stream behaviour');
{
  const statusCtx = mockCtx();
  mod.apply(statusCtx.ctx, { contextGuard: true });
  const wired = statusCtx.handlers.has('llm/stream');
  note('M5 wiring status', wired
    ? 'llm/stream IS registered'
    : 'llm/stream is NOT registered (M5 withdrawn by user decision; D-8 capability gap, implementation kept in src/detect.js)');
  if (wired) {
  const damagedText = readFixture('v1-end-multiplied.txt');
  const mkMessages = () => ([
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: damagedText }] },
  ]);
  const runStream = (cfg, options) => {
    const { ctx, handlers } = mockCtx();
    mod.apply(ctx, cfg);
    const fn = handlers.get('llm/stream');
    let nextCalls = 0;
    const ret = fn(options, () => { nextCalls += 1; return { kind: 'stream' }; });
    return { registered: typeof fn === 'function', nextCalls, ret };
  };

  {
    const options = { messages: mkMessages() };
    const originalRef = options.messages;
    const { registered, nextCalls } = runStream({}, options);
    check('M5: llm/stream listener is registered', registered);
    check('M5-off: exactly one next() call', nextCalls === 1, 'nextCalls=' + nextCalls);
    check('M5-off: options.messages untouched (same reference, damaged text intact)',
      options.messages === originalRef && options.messages[1].content[0].text === damagedText);
  }
  {
    const options = { messages: mkMessages() };
    const originalRef = options.messages;
    const originalMsgRef = options.messages[1];
    const { nextCalls } = runStream({ contextGuard: true }, options);
    check('M5-on: exactly one next() call', nextCalls === 1, 'nextCalls=' + nextCalls);
    check('M5-on: options.messages is REPLACED IN PLACE (new array instance)',
      options.messages !== originalRef);
    check('M5-on: the damaged assistant message became one neutral text block',
      options.messages[1] !== originalMsgRef &&
      Array.isArray(options.messages[1].content) && options.messages[1].content.length === 1 &&
      options.messages[1].content[0].type === 'text' &&
      options.messages[1].content[0].text !== damagedText);
    check('M5-on: the user message is reused by reference', options.messages[0] === originalRef[0]);
    check('M5-on: rewritten message keeps id/role',
      options.messages[1].id === 'a1' && options.messages[1].role === 'assistant');
  }
  {
    const options = { messages: [{ id: 'a', role: 'assistant', content: [{ type: 'text', text: 'all good' }] }] };
    const ref = options.messages;
    const { nextCalls } = runStream({ contextGuard: true }, options);
    check('M5-on/healthy: next() once, messages untouched',
      nextCalls === 1 && options.messages === ref, 'nextCalls=' + nextCalls);
  }
  for (const [label, opts] of [['undefined', undefined], ['null', null], ['string', 'x'], ['number', 7]]) {
    const { nextCalls } = runStream({ contextGuard: true }, opts);
    check('M5 malformed options(' + label + '): next() once, no throw',
      nextCalls === 1, 'nextCalls=' + nextCalls);
  }
  {
    const options = {};
    Object.defineProperty(options, 'messages', { get() { throw new Error('trap'); }, enumerable: true });
    const { nextCalls } = runStream({ contextGuard: true }, options);
    check('M5 throwing messages getter: next() once, no throw', nextCalls === 1, 'nextCalls=' + nextCalls);
  }
  {
    /* The listener must never throw even if a downstream next() does: check that
       it still calls next exactly once when the rewrite path throws internally. */
    const options = { messages: [{ role: 'assistant', get content() { throw new Error('trap'); } }] };
    const { nextCalls } = runStream({ contextGuard: true }, options);
    check('M5 throwing content getter: next() once, no throw', nextCalls === 1, 'nextCalls=' + nextCalls);
  }
  {
    /* HARNESS REALITY (verified in the unpacked tree):
     *  - dsh-agent-loop/lib/index.js:1214 buildRequest() returns
     *    markAgentLoopRequest(Object.freeze({... messages ...})) at :1281;
     *  - that exact object is dispatched at :1084 -> llm.stream(request);
     *  - dsh-llm/lib/index.js:2397 passes it to the llm/stream waterfall.
     * So `options` is FROZEN. An in-place `options.messages = ...` throws a
     * TypeError in ESM strict mode, which the listener swallows -> silent no-op. */
    const frozenMessages = Object.freeze(mkMessages());
    const options = Object.freeze({ messages: frozenMessages });
    const { nextCalls } = runStream({ contextGuard: true }, options);
    check('M5 harness-realism: rewrite still lands when options is frozen like agent-loop builds it',
      options.messages !== frozenMessages,
      'options.messages is the ORIGINAL frozen array (rewrite blocked)');
    check('M5 harness-realism: next() still called exactly once on frozen options (fails safe)',
      nextCalls === 1, 'nextCalls=' + nextCalls);
    if (options.messages === frozenMessages) {
      defect('D-8', 'high',
        'M5/R12 cannot work at the llm/stream seam as implemented: agent-loop dispatches a FROZEN ' +
        'request object (buildRequest Object.freeze at agent-loop:1281, dispatched at :1084), so ' +
        '`options.messages = result.messages` throws in strict mode, is swallowed by the listener, and ' +
        'the rewrite never lands (silent no-op). Fails safe, but the advertised contextGuard feature is inert.');
    }
  }
  } else {
    /* WITHDRAWN (user decision, 2026-10-29): the wiring is gone, the pure
     * implementation stays. Assert the closure state, the kept rationale, and
     * that no artifact still advertises a working feature. */
    check('M5-withdrawn: apply() registers no llm/stream listener', !wired);
    const code = idxSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1 ');
    check('M5-withdrawn: index.js code has no sanitizeMessages call site (no dead path)',
      !/sanitizeMessages/.test(code));
    check('M5-withdrawn: the D-8 rationale + re-wiring guidance are kept in a comment',
      /D-8/.test(idxSrc) && /buildRequest/.test(idxSrc) && /Object\.isFrozen/.test(idxSrc) &&
      /2397/.test(idxSrc) && /exactly once/.test(idxSrc));
    const detMod = await import(pathToFileURL(DETECT_PATH).href);
    check('M5-withdrawn: sanitizeMessages is still exported and callable (code kept)',
      typeof detMod.sanitizeMessages === 'function');
    if (typeof detMod.sanitizeMessages === 'function') {
      const one = [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: readFixture('v1-end-multiplied.txt') }] }];
      const r = detMod.sanitizeMessages(one, { contextGuard: true });
      check('M5-withdrawn: the kept function still rewrites a damaged assistant message',
        r.changed === true && r.messages !== one);
    }
    let patch = '';
    try { patch = readFileSync(path.join(ROOT, 'plugin', 'cordis.patch.yml'), 'utf8'); } catch { /* optional */ }
    check('M5-withdrawn: the public patch does not expose contextGuard',
      !/contextGuard/.test(patch), JSON.stringify((patch.match(/contextGuard[^\n]*/g) || [])));
    let iface = '';
    try { iface = readFileSync(path.join(ROOT, 'docs', 'INTERFACE.md'), 'utf8'); } catch { /* optional */ }
    /* The doc may (and should) keep describing the future re-wiring rules,
     * including the frozen-guard log call — but it must not claim the listener
     * is currently implemented, and it must mark the seam as not wired. */
    const claimsImplemented = /现行行为（已按此实现）/.test(iface);
    const marksUnwired = /当前并未接线|未接线|已停用|不会生效/.test(iface);
    check('M5-withdrawn: INTERFACE does not claim an implemented llm/stream listener',
      !claimsImplemented && marksUnwired,
      'claimsImplemented=' + claimsImplemented + ' marksUnwired=' + marksUnwired);
    if (claimsImplemented || !marksUnwired) {
      defect('D-9', 'low',
        'Contract drift after the M5 withdrawal: docs/INTERFACE.md §R12 must not state a CURRENT ' +
        'implementation ("现行行为（已按此实现）") and must mark the seam as not wired / disabled; ' +
        'plugin/index.js registers no llm/stream listener (wiring removed by user decision).');
    }
  }
}

section('7. no payload text hardcoded / leaked into messages');
{
  const canary = 'CANARY_PAYLOAD_9f3c7a';
  const { ctx, sections } = mockCtx();
  mod.apply(ctx, {});
  // M1 is gone, so no prompt section may exist at all (guarded: no deref crash).
  check('M1-removed: no prompt section is registered, so no prompt text can leak',
    Array.isArray(sections) && sections.length === 0, 'sections=' + JSON.stringify(sections));
  check('M1-removed: no registered prompt text contains the canary',
    Array.isArray(sections) && sections.every((s) => !s || typeof s.text !== 'string' || !s.text.includes(canary)));
  const m = m4Ctx({});
  m.onAssistant('s7', 1, {
    role: 'assistant',
    content: [{ type: 'text', text: canary + '\n' + bigHtml(40) + END_INVOKE + '\n' + END_INVOKE }],
  });
  const inj = m.stop('s7', 1);
  check('M4 injected correction contains no payload canary',
    inj.length === 1 && !JSON.stringify(inj[0]).includes(canary));
  check('index.js source does not hardcode any fixture canary',
    !idxSrc.includes('CANARY_'));
}

section('8. index.js module hygiene');
{
  let ok = true;
  try { new Function(idxSrc); } catch { ok = false; } // not meaningful for ESM, kept as a sanity no-op guard
  check('index.js source is non-empty and exports apply', idxSrc.length > 500 && /export\s+function\s+apply/.test(idxSrc));
  check('index.js has no top-level await import side effects (loads cleanly)', typeof mod.apply === 'function');
}

section('SUMMARY');
console.log('PASS=' + PASS + '  FAIL=' + FAIL + '  NOTES=' + NOTES.length + '  DEFECTS=' + DEFECTS.length);
if (FAILURES.length) { console.log('\n--- failed checks ---'); for (const f of FAILURES) console.log('  * ' + f.name + (f.extra ? '  :: ' + f.extra : '')); }
if (DEFECTS.length) { console.log('\n--- defect list ---'); for (const d of DEFECTS) console.log('  [' + d.sev + '] ' + d.id + ' ' + d.title); }
process.exitCode = FAIL > 0 ? 1 : 0;

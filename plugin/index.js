/**
 * Host half of the `structured-output-guard` bundle.
 *
 * Mechanisms (see docs/DESIGN.md §5):
 *   M2  tools/pre-execute  waterfall       deny a damaged / emptied call (C)
 *   M3  tools/post-execute waterfall       add a no-op correction (own text)
 *   M4  session/event + agent/turn-stopping  silent no-op self-heal (B)
 *
 * M1 (a system-prompt prevention block) is deliberately ABSENT: prompt-level
 * rules are not enforceable and dilute attention, so this plugin solves at the
 * code layer only — detect and self-heal, never instruct. Users who still want
 * the A text can copy it from docs/PROMPTS.md into their AGENTS.md themselves.
 *
 * Hard rule: this plugin must never break the host. Every listener is wrapped in
 * try/catch and every registration goes through Cordis effect semantics, so an
 * unload removes everything. When a seam does not exist, or a value is not
 * certain, the plugin does nothing instead of guessing.
 *
 * M5 (context isolation) is intentionally NOT implemented: `LlmCallConfig` does
 * not carry messages, so `agent/request` cannot rewrite history. See README.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildCorrectionMessage,
  buildDenyReason,
  mergeConfig,
  scanAssistantText,
  scanToolArguments,
  scanToolResult,
} from './src/detect.js';

/**
 * Services this plugin binds to; the plugin stays inactive without them.
 * `systemPrompt` is deliberately NOT required any more: M1 was removed, so a
 * profile without that service must not mark this plugin unavailable.
 */
export const inject = ['tools'];

/* ------------------------------------------------------------------ */
/* Config schema                                                       */
/* ------------------------------------------------------------------ */

/**
 * Standard Schema v1 (standard-schema.org), implemented by hand.
 *
 * Cordis resolves a row's `config` through exactly one member; `resolveConfig`
 * in @deepseek-ai/cordis reads `runtime.Config['~standard'].validate(config)`
 * and throws a ValidationError when the result carries `issues`. Schemastery and
 * zod both satisfy that interface, but neither can be imported here: this bundle
 * is a `link:`ed workspace directory, so a bare `@deepseek-ai/schemastery`
 * import fails with ERR_MODULE_NOT_FOUND and would keep the whole plugin from
 * activating. Hand-writing the interface keeps the bundle zero-dependency.
 *
 * The schema normalizes and clamps exactly like `mergeConfig` (ruling R7):
 * thresholds are integers >= 1, `maxCorrectionsPerTurn` >= 0, `lang` is zh|en,
 * unknown keys are dropped, and anything invalid falls back to the default.
 * It never reports `issues`, so a malformed `config` can never deactivate the
 * plugin — the host keeps its guard, and the value is always usable.
 *
 * It is a callable so that both conventions in the wild work:
 * `Config(raw)` (schemastery-style call) and `Config['~standard'].validate(raw)`.
 */
function configSchema(raw) {
  return mergeConfig(raw);
}

configSchema['~standard'] = {
  version: 1,
  vendor: 'structured-output-guard',
  validate(value) {
    return { value: mergeConfig(value) };
  },
};

export const Config = configSchema;

/** Must stay identical to `name` in plugin/package.json (used for source kinds). */
const PACKAGE_NAME = '@local/structured-output-guard';
/* ------------------------------------------------------------------ */
/* message construction                                                */
/* ------------------------------------------------------------------ */

function newMessageId() {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* fall through to the manual generator */
  }
  let out = '';
  for (let i = 0; i < 32; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return (
    out.slice(0, 8) + '-' + out.slice(8, 12) + '-4' + out.slice(13, 16) + '-a' + out.slice(17, 20) + '-' + out.slice(20)
  );
}

/**
 * Source kinds accepted by the harness' v4 session format.
 *
 * `dsh-session-format-v3-to-v4/lib/index.js:126` refuses any message whose
 * `source.kind === 'plugin'` ("format v4 message requires a producer-owned
 * source kind"), and `assertV4MessageSources` checks every durable message slot
 * including `user/message` and `agent/inbox/spliced`. The retired
 * `{kind:'plugin', plugin:...}` shape would therefore make the session
 * unreadable once an injected message reaches the log.
 *
 * A producer-owned kind is any non-empty string except `plugin`; per
 * `producerKind()` (same file, lines 87-92) a third-party plugin uses
 * `plugin:<package name>`, while framework runtime context uses the literal
 * `runtime-context`. M4's correction is an injected runtime context; M3's is
 * attributed to this plugin.
 */
const SOURCE_RUNTIME_CONTEXT = 'runtime-context';
const SOURCE_PLUGIN = 'plugin:' + PACKAGE_NAME;
/** Assembled rather than written literally: never emit a contiguous closing tag. */
const LT_TEXT = '<';

/**
 * Build a plugin-authored user message.
 *
 * Never attributed to the human user: the caller must pass a producer-owned
 * source kind. `id` is a fresh UUID, equivalent to the harness'
 * `createUserMessage()` (`dsh-llm/lib/index.js:59`), which brands
 * `randomUUID()`; this plugin cannot import that package, so it brands by hand.
 */
function pluginMessage(text, sourceKind) {
  // content blocks carry no field beyond type/text; freezing keeps the
  // structure immutable like the harness' own createUserMessage().
  const block = Object.freeze({ type: 'text', text: String(text) });
  return Object.freeze({
    id: newMessageId(),
    role: 'user',
    content: Object.freeze([block]),
    source: Object.freeze({ kind: sourceKind }),
  });
}

/* ------------------------------------------------------------------ */
/* diagnostics (R10)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Safe shape description for the diagnostic log: types and key names only,
 * never payload text (a damaged payload must not be copied anywhere).
 */
function describe(value) {
  const out = { type: value === null ? 'null' : typeof value };
  try {
    if (value !== null && typeof value === 'object') out.keys = Object.keys(value).slice(0, 24);
  } catch {
    out.keys = '<unreadable>';
  }
  return out;
}

function describeError(error) {
  try {
    if (error instanceof Error) return { name: error.name, message: String(error.message) };
    return { message: String(error) };
  } catch {
    return { message: '<unprintable>' };
  }
}

/**
 * R10 logger. With `debugLog: false` (the default) this returns a no-op closure
 * and opens no file, so the normal path has zero overhead and zero side effects.
 * Every write is wrapped: a failed diagnostic must never change behaviour.
 */
function makeLogger(config) {
  if (config.debugLog !== true) return () => {};
  // R10 / D-6: an empty or non-string target is derived from the system temp
  // directory, so no machine-specific path is ever baked into the package.
  const configured = typeof config.debugLogPath === 'string' ? config.debugLogPath.trim() : '';
  const target = configured || join(tmpdir(), 'structured-output-guard-debug.log');
  let ready = false;
  return (line) => {
    try {
      if (!ready) {
        mkdirSync(dirname(target), { recursive: true });
        ready = true;
      }
      appendFileSync(target, JSON.stringify({ t: Date.now(), ...line }) + '\n');
    } catch {
      /* a failed diagnostic must not change behaviour */
    }
  };
}

/* ------------------------------------------------------------------ */
/* Cordis effect helper                                                */
/* ------------------------------------------------------------------ */

/**
 * Register one resource with Cordis effect semantics.
 * Returns the disposer so unload can clear the registration completely.
 */
function install(ctx, register) {
  try {
    const factory = () => {
      const dispose = register();
      return typeof dispose === 'function' ? dispose : () => {};
    };
    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(factory);
    } else {
      factory();
    }
  } catch {
    /* a single failed registration must not stop the other mechanisms */
  }
}

/* ------------------------------------------------------------------ */
/* M2 helper: arguments silently emptied by a lenient JSON repair      */
/* ------------------------------------------------------------------ */

function requiredParameters(exec, runtime) {
  try {
    const parameters = exec && exec.schema && exec.schema.parameters;
    if (parameters && typeof parameters === 'object') return parameters;
  } catch {
    /* fall through to the registry */
  }
  try {
    if (runtime && typeof runtime.get === 'function') {
      const definition = runtime.get(exec.name);
      const parameters = definition && definition.parameters;
      if (parameters && typeof parameters === 'object') return parameters;
    }
  } catch {
    /* registry lookup is best-effort */
  }
  return null;
}

/**
 * V4: a lenient streaming-JSON repair can turn invalid arguments into `{}`
 * without raising, and the call then runs with empty arguments. Deny only when
 * the tool actually declares required parameters, so genuine no-argument tools
 * are never touched.
 */
function emptyArgumentsDenial(exec, runtime, config) {
  const args = exec ? exec.arguments : undefined;
  if (args !== null && args !== undefined && (typeof args !== 'object' || Array.isArray(args))) return '';

  let keys;
  try {
    keys = args === null || args === undefined ? [] : Object.keys(args);
  } catch {
    return '';
  }
  if (keys.length > 0) return '';

  const parameters = requiredParameters(exec, runtime);
  const required = parameters && Array.isArray(parameters.required) ? parameters.required : null;
  if (!required || required.length === 0) return '';

  const missing = required.filter((key) => typeof key === 'string' && !(args && key in args));
  if (missing.length === 0) return '';

  const finding = {
    code: 'TRUNCATED_PAYLOAD',
    severity: 'error',
    detail: 'arguments arrived as an empty object although the tool declares required parameters',
  };
  const base = buildDenyReason([finding], config);
  const extra =
    config.lang === 'en'
      ? ' Arguments arrived as an empty object although this tool requires: ' +
        missing.join(', ') +
        '; a lenient JSON repair most likely emptied them.'
      : ' 参数疑似被容错解析器清空为 {}（本工具必填：' +
        missing.join(', ') +
        '）。';
  return (base || '') + extra;
}

/* ------------------------------------------------------------------ */
/* apply                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const config = mergeConfig(rawConfig);
  const log = makeLogger(config);
  log({
    where: 'apply',
    inject: inject.slice(),
    config: {
      enabled: config.enabled,
      noopCheck: config.noopCheck,
      debugLog: config.debugLog,
      lang: config.lang,
      maxLines: config.maxLines,
      maxCorrectionsPerTurn: config.maxCorrectionsPerTurn,
    },
  });
  if (config.enabled !== true) return;

  // M1 (system-prompt prevention block) was removed by user decision:
  // prompt-level rules are not enforceable and cost attention. The plugin now
  // only detects and self-heals in code. The A text remains available to users
  // in docs/PROMPTS.md for manual use.

  /* M2 — scan parsed arguments before dispatch. */
  install(ctx, () =>
    ctx.on('tools/pre-execute', function preExecute(exec, next) {
      try {
        const runtime = this && typeof this.get === 'function' ? this : ctx.tools || undefined;

        const scanned = scanToolArguments(exec && exec.name, exec && exec.arguments, config);
        if (scanned && scanned.action === 'deny' && typeof scanned.reason === 'string' && scanned.reason) {
          return { kind: 'deny', reason: scanned.reason };
        }

        const emptied = emptyArgumentsDenial(exec, runtime, config);
        if (emptied) return { kind: 'deny', reason: emptied };
      } catch {
        /* degrade: fall through and let the call proceed */
      }
      // Never take over another listener's decision.
      return next();
    }),
  );

  /* M3 — enrich the normalized result of a suspected no-op write. */
  install(ctx, () =>
    ctx.on('tools/post-execute', async function postExecute(exec, result, next) {
      const decision = await next();
      try {
        const scanned = scanToolResult(exec && exec.name, exec && exec.arguments, result, config);
        if (!scanned || scanned.suspicious !== true) return decision;
        if (!decision || (decision.kind !== 'accept' && decision.kind !== 'block')) return decision;
        // M3 uses its own reason text: the B correction block describes
        // structural damage/argument boundaries (M4's finding), while M3 says
        // "the tool did no work". Mixing them misleads the model.
        const text = typeof scanned.reason === 'string' ? scanned.reason : '';
        if (!text) return decision;
        const existing = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : [];
        return {
          ...decision,
          additionalContexts: [...existing, pluginMessage(text, SOURCE_PLUGIN)],
        };
      } catch {
        return decision;
      }
    }),
  );

  /* M4 — observe committed assistant messages, then self-heal at turn close. */
  const pending = new Map();
  const corrections = new Map();

  install(ctx, () =>
    ctx.on('session/event', (...args) => {
      const session = args[0];
      const event = args[1];
      try {
        // R10 diagnostic: record the real dispatch signature so a silent
        // observer can be told apart from a wrong shape.
        log({
          where: 'session/event',
          argc: args.length,
          argTypes: args.map((value) => (value === null ? 'null' : typeof value)),
          eventType: event && typeof event === 'object' ? event.type : null,
          eventKeys: event && typeof event === 'object' ? Object.keys(event) : null,
          dataKeys: event && event.data && typeof event.data === 'object' ? Object.keys(event.data) : null,
        });
        if (!event || event.type !== 'assistant/message') return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        const message = data.message;
        if (!message || message.role !== 'assistant') return;

        const blocks = Array.isArray(message.content) ? message.content : [];
        let text = '';
        let toolCallCount = 0;
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') text += block.text;
          else if (block.type === 'tool-call') toolCallCount += 1;
        }

        const sessionId = session && typeof session.id === 'string' ? session.id : '';
        if (!sessionId) return;
        const turn = typeof data.turn === 'number' ? data.turn : -1;

        const scan = scanAssistantText(text, config, {
          hasToolCalls: toolCallCount > 0,
          toolCallCount,
        });

        log({
          where: 'session/event.scan',
          sessionId,
          turn,
          step: typeof data.step === 'number' ? data.step : null,
          blockTypes: blocks.map((block) => (block && block.type) || null),
          textLength: text.length,
          toolCallCount,
          damaged: scan.damaged,
          silentFailure: scan.silentFailure,
          codes: scan.findings.map((finding) => finding && finding.code),
        });

        // R1: silentFailure is the only self-heal trigger.
        if (scan.silentFailure === true) {
          pending.set(sessionId, {
            turn,
            step: typeof data.step === 'number' ? data.step : -1,
            findings: scan.findings,
            codes: scan.findings.map((finding) => finding && finding.code).filter(Boolean),
          });
        } else {
          const previous = pending.get(sessionId);
          if (previous && previous.turn === turn) pending.delete(sessionId);
        }
      } catch {
        /* observer only: a committed append must never be disturbed */
      }
    }),
  );

  install(ctx, () =>
    ctx.on('agent/turn-stopping', async function turnStopping(payload) {
      try {
        if (!payload || !payload.agent) {
          log({ where: 'turn-stopping', reason: 'no-agent', hasPayload: Boolean(payload) });
          return;
        }
        const agent = payload.agent;
        const sessionId = typeof agent.id === 'string' ? agent.id : '';
        const record = sessionId ? pending.get(sessionId) : null;
        const used = sessionId ? corrections.get(sessionId) : null;
        const count = used && used.turn === payload.turn ? used.count : 0;

        // R10 diagnostic: distinguishes "listener never ran" from "ran but had
        // no pending record" from "errored while injecting".
        log({
          where: 'turn-stopping',
          sessionId,
          turn: payload.turn,
          payloadKeys: Object.keys(payload),
          agentKeys: Object.keys(agent),
          hasRecord: Boolean(record),
          pendingSessions: pending.size,
          recordTurn: record ? record.turn : null,
          correctionsUsed: count,
          maxCorrectionsPerTurn: config.maxCorrectionsPerTurn,
          injectType: typeof agent.inject,
        });

        if (!sessionId) return;
        if (!record || record.turn !== payload.turn) return;
        if (count >= config.maxCorrectionsPerTurn) return;

        if (typeof agent.inject !== 'function') return;

        // R11 / R13 — two bounded tiers, both kept here so the frozen B builder
        // in detect.js stays untouched:
        //   tier 1: state the failure, ask for a smaller retry (B block + order);
        //   tier 2: the escalation for "the retry was damaged *again*" — drop the
        //           long explanation, demand ONE call with a tighter chunk cap.
        const tier = count + 1;
        const correction = buildCorrectionMessage(record.findings, config);
        let body = '';
        if (count === 0) {
          // Tier 1 keeps the previous semantics exactly: no correction text
          // means nothing to say, so nothing is injected.
          body = correction
            ? '【立即执行】上一步想做的工具调用没有被执行。不要解释、不要复述上一段内容，' +
              '直接用更小的分块重新发起那个调用。\n\n' + correction
            : '';
        } else {
          body =
            '【第二次尝试仍失败】你上一步依然没有产生任何工具调用，而是又把内容写成了正文。' +
            '换做法：**这一步只发一个调用**，单个参数**不超过 40 行**；' +
            '不要输出任何解释，也不要把要写的内容直接打在正文里。' +
            (Array.isArray(record.codes) && record.codes.length > 0
              ? '（判定：' + record.codes.join('、') + '）'
              : '');
        }
        if (!body) return;

        // inject() queues into `next-step` without waking the driver, which is
        // exactly what keeps the closing turn open for one more step.
        const injected = pluginMessage(body, SOURCE_RUNTIME_CONTEXT);
        agent.inject(injected);
        log({
          where: 'turn-stopping.injected',
          sessionId,
          turn: payload.turn,
          tier,
          textLength: body.length,
          injected,
        });

        corrections.set(sessionId, { turn: payload.turn, count: tier });
        pending.delete(sessionId);
      } catch {
        /* serial dispatch propagates listener errors into the turn: swallow. */
      }
    }),
  );

  /* M7 — R16 fork brief (2026-10-31).
     A forked session inherits the parent's history in its request, and that
     history may contain leaked call markup. We cannot rewrite it (D-8: the
     llm/stream request is frozen), but `agent/pre-step` IS writable and runs
     *before* the step is sent — so the first step of a fork gets one short,
     code-generated briefing that marks the inherited artifacts as invalid
     instead of letting the model imitate them. Bounded to once per session;
     never rejects a step; never takes over another listener's decision. */
  const briefed = new Set();

  /**
   * The session header of a seeded/forked session, or null.
   *
   * D-12 (2026-10-31): the fork marker lives on `session.header` (a
   * `SessionHeader`), **not** in an event stream. `Session` exposes no `events`
   * property at all, and there is no bare `'session'` event — so an earlier
   * version of this function read `session.events`, always found nothing, and
   * made the whole mechanism a silent no-op (the same failure class as D-8/M5).
   */
  function forkHeadline(agent) {
    try {
      const header = agent && agent.session && agent.session.header;
      if (!header || typeof header !== 'object') return null;
      const parent = typeof header.parentSession === 'string' ? header.parentSession : '';
      if (!parent && header.isSeeded !== true) return null;
      return { parent, seeded: header.isSeeded === true };
    } catch {
      return null;
    }
  }

  function forkBriefText(config) {
    if (typeof config.forkBriefNote === 'string' && config.forkBriefNote.length > 0) {
      return config.forkBriefNote;
    }
    if (config.lang === 'en') {
      return (
        '[Session brief] This session continues from a previous one. If the history ' +
        'contains stray call markup — a `' + LT_TEXT + '/` closing prefix, or a parameter ' +
        'opening marker — with no matching tool card, those outputs were DAMAGED and ' +
        'never executed. Ignore them, do not imitate them, and when you need to make a ' +
        'call again, do it in small chunks (<= 100 lines, ideally <= 40).'
      );
    }
    return (
      '【会话简报】本会话继承自上一个会话。若历史里出现**孤立的调用标记**' +
      '（以 `' + LT_TEXT + '/` 开头的闭合标记、或参数开场标记）却**没有对应的工具调用卡**，' +
      '那些都是**损坏输出、未执行** —— 请忽略它们、不要模仿，' +
      '需要时用**小块**（≤100 行，必要时 ≤40 行）重新发起调用。'
    );
  }

  install(ctx, () =>
    ctx.on('agent/pre-step', async function preStep(payload, next) {
      const decision = await next();
      try {
        if (config.forkBrief !== true) return decision;
        if (!decision || decision.kind !== 'enter') return decision;
        const agent = payload && payload.agent;
        const sessionId = agent && typeof agent.id === 'string' ? agent.id : '';
        if (!sessionId || briefed.has(sessionId)) return decision;
        const head = forkHeadline(agent);
        if (!head) return decision;
        briefed.add(sessionId);
        const noteText = forkBriefText(config);
        const note = pluginMessage(noteText, SOURCE_RUNTIME_CONTEXT);
        // D-12 confirmation recipe: with debugLog on, this line appears in a real
        // fork's first step. If it never appears, the header read is wrong again.
        log({
          where: 'pre-step.forkBrief',
          sessionId,
          turn: payload.turn,
          step: payload.step,
          parent: head.parent,
          seeded: head.seeded,
          textLength: noteText.length,
        });
        // Spread so fields such as `startsRequestSeries` survive (practices.md).
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        return { ...decision, messages: [note, ...messages] };
      } catch {
        return decision;
      }
    }),
  );

  /* M5 — R12 context sanitisation: WIRING REMOVED (2026-10-29), per user decision.

     Why it cannot work here (defect D-8, evidence in verify/REPORT.md): agent-loop
     composes the request and then **freezes** it — `dsh-agent-loop/lib/index.js:1214`
     buildRequest → `:1281 Object.freeze({ ...messages })`, with `:1280` freezing the
     messages array and `:1277` deep-freezing every message — and `:1084` hands that
     same object to `llm.stream` → `dsh-llm/lib/index.js:2397`'s `llm/stream`
     waterfall. ESM is strict, so `options.messages = …` throws TypeError. The seam
     is **read-only**, so no listener here can ever rewrite history.

     The implementation is deliberately KEPT for a future writable seam:
     `sanitizeMessages()` in `src/detect.js` (pure, independently verified) finds
     damaged assistant messages that carry no `tool-call` block and returns a
     rewritten list. To re-wire it, add an `llm/stream` waterfall listener that
     (1) checks `Object.isFrozen(options) || Object.isFrozen(options.messages)` and
     bails out explicitly when frozen — never silently, (2) otherwise assigns
     `options.messages = sanitizeMessages(options.messages, config).messages`, and
     (3) calls `next()` exactly once on every path. The switch was removed from the
     public config on purpose, so re-wiring must also reintroduce a gate. */
}

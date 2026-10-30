/**
 * Structured-output guard — pure detection core.
 *
 * Frozen contract: docs/INTERFACE.md (incl. rulings R1/R2/R3).
 * Properties required by that contract:
 *   - ESM, zero dependencies, no DSH imports, runnable under plain node.
 *   - pure: same input -> same output; reads no globals; logs nothing.
 *   - never throws: any internal failure degrades to an `info` finding and a
 *     non-intercepting result.
 *   - never mutates its inputs (read-only deep traversal).
 *   - `reason` / `evidence` never contain payload text.
 *
 * Self-discipline note: this file never writes a contiguous literal closing tag.
 * Every token is assembled from fragments (LT + SLASH + 'invoke' + GT) so that
 * this source is not itself a payload full of closing tags.
 */

const LT = '<';
const GT = '>';
const SLASH = '/';

/** The two-character closing-tag prefix, i.e. LT followed by SLASH. */
const CLOSE_PREFIX = LT + SLASH;
/** Opening marker for a tool call. */
const OPEN_INVOKE = LT + 'invoke';
/** Opening marker for one call parameter. */
const OPEN_PARAM = LT + 'parameter';
/** The single legal call end sequence (see §0 R2). */
const END_INVOKE = LT + SLASH + 'invoke' + GT;
/** A parameter end sequence; explicitly NOT an end sequence for R2. */
const END_PARAM = LT + SLASH + 'parameter' + GT;

const OPEN_INVOKE_RE = new RegExp(LT + 'invoke(?![A-Za-z0-9:_-])', 'g');
const OPEN_PARAM_RE = new RegExp(LT + 'parameter(?![A-Za-z0-9:_-])', 'g');
const END_INVOKE_RE = new RegExp(LT + SLASH + 'invoke[ \\t\\r\\n]*' + GT, 'g');
const END_PARAM_RE = new RegExp(LT + SLASH + 'parameter[ \\t\\r\\n]*' + GT, 'g');
/** Anchored opening markers: the truncation rule's "starts with" gate (R6). */
const HEAD_INVOKE_RE = new RegExp('^' + LT + 'invoke(?![A-Za-z0-9:_-])');
const HEAD_PARAM_RE = new RegExp('^' + LT + 'parameter(?![A-Za-z0-9:_-])');

/**
 * D-10 (2026-10-30): the leaked envelope is not always written with bare tag
 * names. A real failure used the Anthropic-style namespace — `LT` + `antml:invoke`,
 * `LT` + `SLASH` + `antml:parameter`, ... — and none of those contain a bare
 * `LT` + `invoke` / `LT` + `parameter` substring. Every structural rule therefore
 * missed it silently and M4 never fired.
 *
 * Instead of teaching each rule about prefixes (and risking the pairing/offset
 * logic that took several defects to get right), strip an optional namespace
 * prefix in a *shadow copy* used only for structural analysis. Text without a
 * colon is returned as the identical string, so existing behaviour cannot drift.
 * The trailing `(?!SLASH)` keeps URLs such as `LT` + `http://...` out of it.
 */
const NAMESPACE_PREFIX_RE = /<(\/?)([A-Za-z_][A-Za-z0-9_.-]*):(?!\/)/g;

/**
 * D-11 (2026-10-30): a tool-result-shaped block in the assistant's *text*.
 * Observed in a real session: that step made **no** tool call, yet the message
 * read as a `tool_result` block wrapping `v24.12.0 dirs ok` — the model reported
 * a result it never obtained. That is worse than a silent no-op: it asserts a
 * fabricated fact. `[-_]?` allows `tool_result` / `tool-result` / `toolresult`;
 * namespace prefixes are already stripped by `normalizeNamespaces`.
 */
const RESULT_OPEN_RE = new RegExp(LT + 'tool[-_]?result(?![A-Za-z0-9:_-])');

function normalizeNamespaces(text) {
  if (typeof text !== 'string' || text.indexOf(':') === -1) return text;
  try {
    return text.replace(NAMESPACE_PREFIX_RE, '<$1');
  } catch {
    return text;
  }
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_PUNCT_RE = /[\u3000-\u303f\uff01-\uff5e]/;

/**
 * R5: internal failures of this module report themselves honestly instead of
 * borrowing a business code. Always `severity: 'info'` (never damaged, never
 * denied) and always accompanied by an empty `reason`.
 */
const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';

/** @type {{enabled: boolean, maxLines: number, maxChars: number, closingTagCount: number, endSequenceRepeats: number, maxCorrectionsPerTurn: number, lang: 'zh'|'en', noopCheck: boolean, debugLog: boolean, debugLogPath: string, contextGuard: boolean, contextGuardNote: string, forkBrief: boolean, forkBriefNote: string}} */
export const DEFAULT_CONFIG = {
  enabled: true,
  maxLines: 100,
  maxChars: 20000,
  closingTagCount: 8,
  endSequenceRepeats: 2,
  maxCorrectionsPerTurn: 1,
  lang: 'zh',
  /** R9: `false` disables the M3 no-op result check entirely. */
  noopCheck: true,
  /**
   * R10: append one JSON diagnostic line per observed seam call. Off by default,
   * and when off the plugin opens no file at all (zero overhead, no side effect).
   */
  debugLog: false,
  /**
   * R10: diagnostic target; only touched while `debugLog` is true. An empty
   * string means "derive from the system temp directory": a default must never
   * hardcode a path from one machine (INTERFACE R10 / defect D-6).
   */
  debugLogPath: '',
  /**
   * R12: M5 context guard. OFF by default: it rewrites the model-visible
   * history, so the user turns it on deliberately after noticing that a
   * conversation has been poisoned by damaged output.
   */
  contextGuard: false,
  /** R12: replacement note; an empty string uses the built-in localized note. */
  contextGuardNote: '',
  /**
   * R16 (M7): brief a *forked* session before its first model step. A fork
   * inherits a history we cannot rewrite (D-8), but we can mark its damaged
   * artifacts as invalid up front instead of letting the model imitate them.
   */
  forkBrief: true,
  /** R16: briefing text; an empty string uses the built-in localized text. */
  forkBriefNote: '',
};

/** Non-empty string fields; anything else falls back to the default. */
const STRING_KEYS = ['debugLogPath', 'contextGuardNote', 'forkBriefNote'];

/**
 * R7: every numeric field must be an integer >= its minimum, otherwise it falls
 * back to the default. Thresholds need >= 1 (`0` would make `>= threshold` always
 * true, so `endSequenceRepeats: 0` would flag every input); only the anti-loop
 * counter may be 0, which means "never correct automatically".
 */
const NUMERIC_KEYS = [
  { key: 'maxLines', min: 1 },
  { key: 'maxChars', min: 1 },
  { key: 'closingTagCount', min: 1 },
  { key: 'endSequenceRepeats', min: 1 },
  { key: 'maxCorrectionsPerTurn', min: 0 },
];

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function defaultCopy() {
  return {
    enabled: DEFAULT_CONFIG.enabled,
    maxLines: DEFAULT_CONFIG.maxLines,
    maxChars: DEFAULT_CONFIG.maxChars,
    closingTagCount: DEFAULT_CONFIG.closingTagCount,
    endSequenceRepeats: DEFAULT_CONFIG.endSequenceRepeats,
    maxCorrectionsPerTurn: DEFAULT_CONFIG.maxCorrectionsPerTurn,
    lang: DEFAULT_CONFIG.lang,
    noopCheck: DEFAULT_CONFIG.noopCheck,
    debugLog: DEFAULT_CONFIG.debugLog,
    debugLogPath: DEFAULT_CONFIG.debugLogPath,
    contextGuard: DEFAULT_CONFIG.contextGuard,
    contextGuardNote: DEFAULT_CONFIG.contextGuardNote,
    forkBrief: DEFAULT_CONFIG.forkBrief,
    forkBriefNote: DEFAULT_CONFIG.forkBriefNote,
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeMergeConfig(partial) {
  try {
    return mergeConfig(partial);
  } catch {
    return defaultCopy();
  }
}

function errorText(error) {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message;
    return String(error);
  } catch {
    return 'unknown';
  }
}

function internalFinding(where, error) {
  return {
    code: INTERNAL_ERROR_CODE,
    severity: 'info',
    detail: 'internal-error: ' + where + ': ' + errorText(error),
  };
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

function countMatches(text, re) {
  try {
    const re2 = new RegExp(re.source, 'g');
    let count = 0;
    let m;
    while ((m = re2.exec(text)) !== null) {
      count += 1;
      if (m.index === re2.lastIndex) re2.lastIndex += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

function firstIndexOf(text, re) {
  try {
    const re2 = new RegExp(re.source);
    const m = re2.exec(text);
    return m ? m.index : -1;
  } catch {
    return -1;
  }
}

function isSpaceCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
}

function countLines(text) {
  return 1 + countOccurrences(text, '\n');
}

function hasBlocking(findings) {
  if (!Array.isArray(findings)) return false;
  for (const f of findings) {
    if (f && (f.severity === 'error' || f.severity === 'warn')) return true;
  }
  return false;
}

function blockingFindings(findings) {
  if (!Array.isArray(findings)) return [];
  return findings.filter((f) => f && (f.severity === 'error' || f.severity === 'warn'));
}

/**
 * R4 volume gate for `action: 'deny'`: `chars >= ceil(maxChars/10)` **or**
 * `lines >= ceil(maxLines/5)` (defaults: 2000 chars / 20 lines).
 *
 * The real failure (DESIGN §2) needs a long payload; a short document that
 * merely mentions a closing tag is not it, so a structural error found there is
 * reported but never intercepted. Both bounds derive from the configured
 * limits, so a different `maxChars` / `maxLines` scales the gate with it.
 */
function argumentDenyGate(config) {
  return {
    minChars: Math.max(1, Math.ceil(config.maxChars / 10)),
    minLines: Math.max(1, Math.ceil(config.maxLines / 5)),
  };
}

/* ------------------------------------------------------------------ */
/* detection primitives                                                */
/* ------------------------------------------------------------------ */

/**
 * Count the trailing run of contiguous call end sequences.
 * Only the trailing segment counts (see §0 R2): earlier occurrences of the
 * end sequence are ignored, and whitespace inside the run is tolerated.
 * The surrounding whitespace before the run is allowed.
 */
function trailingEndRun(text) {
  let cursor = text.length;
  let count = 0;
  let start = -1;
  for (;;) {
    let probe = cursor;
    while (probe > 0 && isSpaceCode(text.charCodeAt(probe - 1))) probe -= 1;
    const from = probe - END_INVOKE.length;
    if (from >= 0 && text.startsWith(END_INVOKE, from)) {
      count += 1;
      start = from;
      cursor = from;
    } else {
      break;
    }
  }
  return { count, start };
}

function unpairedFindings(text, severity) {
  const out = [];
  const invokeOpen = countMatches(text, OPEN_INVOKE_RE);
  const invokeEnd = countMatches(text, END_INVOKE_RE);
  if (invokeEnd > invokeOpen) {
    out.push({
      code: 'UNPAIRED_CLOSING_TAG',
      severity,
      detail:
        'call end marker count exceeds call opening marker count (' +
        invokeEnd +
        ' end vs ' +
        invokeOpen +
        ' open)',
    });
  }
  const paramOpen = countMatches(text, OPEN_PARAM_RE);
  const paramEnd = countMatches(text, END_PARAM_RE);
  if (paramEnd > paramOpen) {
    out.push({
      code: 'UNPAIRED_CLOSING_TAG',
      severity,
      detail:
        'parameter end marker count exceeds parameter opening marker count (' +
        paramEnd +
        ' end vs ' +
        paramOpen +
        ' open)',
    });
  }
  return out;
}

function hasStructuralMarkup(text) {
  return (
    text.indexOf(OPEN_INVOKE) !== -1 ||
    text.indexOf(OPEN_PARAM) !== -1 ||
    text.indexOf(END_INVOKE) !== -1 ||
    text.indexOf(END_PARAM) !== -1
  );
}

/**
 * True when the text ends in the middle of a call/parameter structure.
 *
 * R6 — the two parts are NOT interchangeable:
 *   - GATE: the text must *start* with a call opening marker (after whitespace),
 *     either `INVOKE_OPEN` or `PARAM_OPEN`. A document that merely *quotes* a
 *     marker deeper in its prose (this repository's own docs do) is not a
 *     truncated call, and a payload that opens with arbitrary content and only
 *     mentions a marker later must not be denied either.
 *   - CONCLUSION: after the pairing walk, an opening marker is still unmatched.
 *
 * Guards, because code and prose must never trip this:
 *   1. the text must contain structural call markup at all (keeps ordinary code
 *      payloads such as `i < n` out of the check);
 *   2. the "starts with" gate above.
 * The cheap "cut off inside a tag" test applies to any text that passed 1 + 2.
 */
function detectTruncatedText(text) {
  if (!hasStructuralMarkup(text)) return false;

  const head = text.trimStart();
  if (!HEAD_INVOKE_RE.test(head) && !HEAD_PARAM_RE.test(head)) return false;

  const lastLt = text.lastIndexOf(LT);
  const lastGt = text.lastIndexOf(GT);
  if (lastLt > lastGt) {
    const fragment = text.slice(lastLt);
    if (/^<[A-Za-z][A-Za-z0-9:_-]*(?=[\s/>]|$)/.test(fragment)) return true;
    if (/^<[A-Za-z][^>]*["'][^"']*$/.test(fragment)) return true;
  }

  const tokens = [];
  const push = (re, kind) => {
    const re2 = new RegExp(re.source, 'g');
    let m;
    while ((m = re2.exec(text)) !== null) {
      tokens.push({ index: m.index, kind });
      if (m.index === re2.lastIndex) re2.lastIndex += 1;
    }
  };
  push(OPEN_INVOKE_RE, 'open-invoke');
  push(OPEN_PARAM_RE, 'open-param');
  push(END_INVOKE_RE, 'end-invoke');
  push(END_PARAM_RE, 'end-param');
  tokens.sort((a, b) => a.index - b.index);

  const stack = [];
  for (const token of tokens) {
    if (token.kind === 'open-invoke') {
      stack.push('invoke');
    } else if (token.kind === 'open-param') {
      stack.push('parameter');
    } else if (token.kind === 'end-param') {
      const at = stack.lastIndexOf('parameter');
      if (at >= 0) stack.length = at;
    } else if (token.kind === 'end-invoke') {
      const at = stack.lastIndexOf('invoke');
      if (at >= 0) stack.length = at;
    }
  }
  return stack.length > 0;
}

/**
 * Conservative natural-language test over text with tags removed.
 *
 * Only two shapes count as a sentence:
 *   - a CJK run of >= 4 chars that carries CJK punctuation (or is >= 12 chars);
 *   - >= 4 latin words, terminated by sentence punctuation, with no code-ish
 *     punctuation anywhere in the segment.
 * Deliberately tight: prose inside a healthy parameter must not be reported.
 */
function hasNaturalLanguageSentence(text) {
  let stripped;
  try {
    stripped = text.replace(/<[^>]*>/g, '\n');
  } catch {
    return false;
  }
  const segments = stripped.split(/[\n\r]+/);
  for (const raw of segments) {
    const segment = raw.trim();
    if (!segment) continue;
    const cjk = countMatches(segment, CJK_RE);
    if (cjk >= 4 && (CJK_PUNCT_RE.test(segment) || cjk >= 12)) return true;
    const words = segment.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    if (
      words.length >= 4 &&
      /[.!?。！？:：]\s*$/.test(segment) &&
      !/[{};=<>[\]()"]/.test(segment)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Record one traversal failure for the R5 internal-error report.
 * Only the key path (never a value) and the error travel with it.
 */
function noteProblem(problems, path, error) {
  if (!Array.isArray(problems) || problems.length >= MAX_INTERNAL_PROBLEMS) return;
  problems.push({ path: path || '', error });
}

const MAX_INTERNAL_PROBLEMS = 4;

/**
 * Collect string leaves of a JSON-ish value, read-only and cycle-safe.
 * Returns `{ path, value }` entries; `path` carries key names only, never values.
 * Hostile getters / proxy traps must not hide themselves, so each failed access
 * is recorded in the optional `problems` array (R5) instead of being swallowed.
 */
function collectStringLeaves(root, limit, problems) {
  const out = [];
  const seen = new Set();
  const stack = [{ value: root, path: '', depth: 0 }];
  while (stack.length > 0 && out.length < limit) {
    const node = stack.pop();
    const value = node.value;
    if (typeof value === 'string') {
      out.push({ path: node.path, value });
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    if (node.depth >= 24) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    let keys;
    try {
      keys = Array.isArray(value)
        ? value.map((_, index) => String(index))
        : Object.keys(value);
    } catch (error) {
      noteProblem(problems, node.path, error);
      continue;
    }
    for (const key of keys) {
      let child;
      try {
        child = value[key];
      } catch (error) {
        noteProblem(problems, node.path ? node.path + '.' + key : key, error);
        continue;
      }
      stack.push({
        value: child,
        path: node.path ? node.path + '.' + key : key,
        depth: node.depth + 1,
      });
    }
  }
  return out;
}

/** Bounded read-only walk over a JSON-ish value; visits key/value pairs. */
function walkValue(root, visit, problems) {
  const seen = new Set();
  const stack = [{ value: root, depth: 0 }];
  let visits = 0;
  while (stack.length > 0 && visits < 400) {
    const node = stack.pop();
    const value = node.value;
    if (value === null || typeof value !== 'object') continue;
    if (node.depth >= 8) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    let keys;
    try {
      keys = Object.keys(value);
    } catch (error) {
      noteProblem(problems, '', error);
      continue;
    }
    for (const key of keys) {
      let child;
      try {
        child = value[key];
      } catch (error) {
        noteProblem(problems, key, error);
        continue;
      }
      visits += 1;
      try {
        visit(key, child, node.depth + 1);
      } catch {
        /* a visitor failure never breaks the walk */
      }
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, depth: node.depth + 1 });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* config                                                             */
/* ------------------------------------------------------------------ */

/**
 * Merge a partial config over DEFAULT_CONFIG.
 * R3: `null` / `undefined` / non-plain-object input returns a full shallow copy
 * of the defaults; unknown keys are ignored; no shared mutable reference.
 */
export function mergeConfig(partial) {
  const out = defaultCopy();
  try {
    if (!isPlainObject(partial)) return out;

    for (const key of ['enabled', 'noopCheck', 'debugLog', 'contextGuard', 'forkBrief']) {
      let value;
      try {
        value = partial[key];
      } catch {
        continue;
      }
      if (typeof value === 'boolean') out[key] = value;
    }

    for (const key of STRING_KEYS) {
      let value;
      try {
        value = partial[key];
      } catch {
        continue;
      }
      if (typeof value === 'string' && value.length > 0) out[key] = value;
    }

    for (const field of NUMERIC_KEYS) {
      let value;
      try {
        value = partial[field.key];
      } catch {
        continue;
      }
      if (Number.isInteger(value) && value >= field.min) {
        out[field.key] = value;
      }
    }

    let lang;
    try {
      lang = partial.lang;
    } catch {
      lang = undefined;
    }
    if (lang === 'zh' || lang === 'en') out.lang = lang;

    return out;
  } catch {
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* 1. assistant text                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {unknown} text raw assistant text
 * @param {unknown} [opts] partial config
 * @param {unknown} [meta] `{ hasToolCalls, toolCallCount, stopReason }`
 */
export function scanAssistantText(text, opts, meta) {
  const config = safeMergeConfig(opts);

  let source;
  try {
    if (typeof text === 'string') source = text;
    else if (text === null || text === undefined) source = '';
    else source = String(text);
  } catch (error) {
    return {
      damaged: false,
      silentFailure: false,
      findings: [internalFinding('scanAssistantText/text', error)],
      evidence: {
        length: 0,
        closingTagCount: 0,
        endSequenceRepeats: 0,
        leakedMarkup: false,
        truncated: false,
      },
    };
  }

  try {
    const findings = [];

    // D-10: structural analysis runs on a namespace-stripped shadow copy. When
    // the text contains no colon this is the identical string, so nothing drifts.
    const structural = normalizeNamespaces(source);
    const closingTagCount = countOccurrences(source, CLOSE_PREFIX);
    const run = trailingEndRun(structural);
    const endSequenceRepeats = run.count;
    const invokeOpenAt = firstIndexOf(structural, OPEN_INVOKE_RE);
    const paramOpenAt = firstIndexOf(structural, OPEN_PARAM_RE);
    const hasInvokeOpen = invokeOpenAt !== -1;
    const hasParamOpen = paramOpenAt !== -1;

    // END_SEQUENCE_MULTIPLIED — §0 R2: trailing contiguous INVOKE_END run only.
    if (endSequenceRepeats >= config.endSequenceRepeats) {
      findings.push({
        code: 'END_SEQUENCE_MULTIPLIED',
        severity: 'error',
        detail:
          'trailing end-sequence run = ' +
          endSequenceRepeats +
          ' (threshold ' +
          config.endSequenceRepeats +
          ')',
        at: run.start >= 0 ? run.start : undefined,
      });
    }

    // MISSING_OPENING_MARKUP — parameter opening without a call opening.
    if (hasParamOpen && !hasInvokeOpen) {
      findings.push({
        code: 'MISSING_OPENING_MARKUP',
        severity: 'error',
        detail: 'parameter opening marker present without any call opening marker',
        at: paramOpenAt,
      });
    }

    // MARKUP_LEAKED_AS_TEXT — call markup sitting inside natural-language prose.
    let leakedMarkup = false;
    if (hasInvokeOpen || hasParamOpen) {
      leakedMarkup = hasNaturalLanguageSentence(source);
      if (leakedMarkup) {
        findings.push({
          code: 'MARKUP_LEAKED_AS_TEXT',
          severity: 'error',
          detail: 'call markup appears inside natural-language prose text',
          at: hasInvokeOpen ? invokeOpenAt : paramOpenAt,
        });
      }
    }

    // D-13 (2026-10-31): call markup that *starts* an assistant text message is a
    // leaked call attempt — prose or not, balanced or not. Observed live: a
    // complete, balanced 325-character envelope with no prose at all passed every
    // other rule (`leakedMarkup: false`, `truncated: false`, no unpaired closers),
    // so M4 never fired and the turn closed silently. A model that merely *quotes*
    // the format starts with prose or a code fence, never with the opening marker.
    const headText = structural.trimStart();
    if (!leakedMarkup && (HEAD_INVOKE_RE.test(headText) || HEAD_PARAM_RE.test(headText))) {
      findings.push({
        code: 'MARKUP_LEAKED_AS_TEXT',
        severity: 'error',
        detail: 'call markup starts an assistant text message (the call was never dispatched)',
        at: structural.length - headText.length,
      });
    }

    // D-11: tool-result-shaped markup in assistant prose. Deliberately NOT gated
    // on `meta.hasToolCalls` (R1: meta only decides `silentFailure`) and
    // deliberately not requiring a natural-language sentence — the observed
    // payload was 43 characters of pure markup plus a fabricated version string.
    // Containment comes from R1: when the step *did* make tool calls,
    // `silentFailure` stays false and M4 never injects.
    const resultMarkupAt = firstIndexOf(structural, RESULT_OPEN_RE);
    if (resultMarkupAt !== -1) {
      findings.push({
        code: 'MARKUP_LEAKED_AS_TEXT',
        severity: 'error',
        detail: 'tool-result-shaped markup in assistant prose (no result was produced here)',
        at: resultMarkupAt,
      });
    }

    // TRUNCATED_PAYLOAD — the call/parameter structure never closed.
    const truncated = detectTruncatedText(structural);
    if (truncated) {
      findings.push({
        code: 'TRUNCATED_PAYLOAD',
        severity: 'error',
        detail: 'call/parameter structure ends before it is closed',
      });
    }

    // UNPAIRED_CLOSING_TAG — more closers than openers for one structural tag.
    findings.push(...unpairedFindings(structural, 'warn'));

    const damaged = hasBlocking(findings);

    // R1: silentFailure === (damaged === true && meta?.hasToolCalls === false)
    let silentFailure = false;
    try {
      silentFailure = damaged === true && meta != null && meta.hasToolCalls === false;
    } catch {
      silentFailure = false;
    }

    return {
      damaged,
      silentFailure,
      findings,
      evidence: {
        length: source.length,
        closingTagCount,
        endSequenceRepeats,
        leakedMarkup,
        truncated,
      },
    };
  } catch (error) {
    return {
      damaged: false,
      silentFailure: false,
      findings: [internalFinding('scanAssistantText', error)],
      evidence: {
        length: typeof source === 'string' ? source.length : 0,
        closingTagCount: 0,
        endSequenceRepeats: 0,
        leakedMarkup: false,
        truncated: false,
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* 2. tool arguments                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {unknown} name tool name (used only as metadata)
 * @param {unknown} args parsed arguments
 * @param {unknown} [opts] partial config
 */
export function scanToolArguments(name, args, opts) {
  const config = safeMergeConfig(opts);

  try {
    const findings = [];
    const gate = argumentDenyGate(config);
    const problems = [];
    const leaves = collectStringLeaves(args, 200, problems);
    let denyEligibleError = false;

    for (const leaf of leaves) {
      const value = leaf.value;
      const where = leaf.path || '<value>';
      const lines = countLines(value);
      const chars = value.length;
      const closing = countOccurrences(value, CLOSE_PREFIX);
      // D-10: structural checks run on a namespace-stripped shadow copy; the
      // line/char counting above intentionally stays on the raw value.
      const structural = normalizeNamespaces(value);

      // R4 volume gate — only a payload of real size may be denied.
      const eligible = chars >= gate.minChars || lines >= gate.minLines;

      const leafFindings = [];

      if (lines > config.maxLines || chars > config.maxChars) {
        leafFindings.push({
          code: 'PAYLOAD_TOO_LONG',
          severity: 'warn',
          detail:
            'string leaf ' +
            where +
            ': ' +
            lines +
            ' lines / ' +
            chars +
            ' chars exceeds ' +
            config.maxLines +
            ' lines / ' +
            config.maxChars +
            ' chars',
        });
      }

      if (closing >= config.closingTagCount) {
        leafFindings.push({
          code: 'CLOSING_TAG_DENSITY',
          severity: 'info',
          detail:
            'string leaf ' +
            where +
            ': ' +
            closing +
            ' closing-prefix occurrences (threshold ' +
            config.closingTagCount +
            ')',
        });
      }

      const run = trailingEndRun(structural);
      const multiplied = run.count >= config.endSequenceRepeats;
      if (multiplied) {
        leafFindings.push({
          code: 'END_SEQUENCE_MULTIPLIED',
          severity: 'error',
          detail:
            'string leaf ' +
            where +
            ': trailing end-sequence run = ' +
            run.count +
            ' (threshold ' +
            config.endSequenceRepeats +
            ')',
        });
      }

      // R4: on an argument leaf this is evidence only — a legitimate document
      // naturally has closing tags whose openers are absent.
      leafFindings.push(...unpairedFindings(structural, 'info'));

      const truncated = detectTruncatedText(structural);
      if (truncated) {
        leafFindings.push({
          code: 'TRUNCATED_PAYLOAD',
          severity: 'error',
          detail: 'string leaf ' + where + ': call/parameter structure ends before it is closed',
        });
      }

      // R4: deny needs a damage signal (multiplied / truncated) AND volume.
      const denySignal = multiplied || truncated;
      if (denySignal && eligible) {
        denyEligibleError = true;
      } else if (denySignal) {
        // Short content stays visible but is never intercepted.
        const note =
          ' [below the deny gate: ' +
          chars +
          ' chars / ' +
          lines +
          ' lines (gate needs >= ' +
          gate.minChars +
          ' chars or >= ' +
          gate.minLines +
          ' lines); downgraded to flag, not denied]';
        for (const finding of leafFindings) {
          if (finding.severity === 'error') finding.detail += note;
        }
      }

      findings.push(...leafFindings);
    }

    // R5: a traversal that could not read everything is reported honestly and
    // never denies, because an incomplete scan cannot support a confident deny.
    const internalFindings = problems.map((problem) =>
      internalFinding(
        'scanToolArguments/' + (problem.path || '<value>'),
        problem.error,
      ),
    );
    const all = internalFindings.concat(findings);

    if (denyEligibleError && internalFindings.length === 0) {
      return {
        action: 'deny',
        findings: all,
        reason: buildDenyReason(all, config),
      };
    }
    if (all.length > 0) return { action: 'flag', findings: all, reason: '' };
    return { action: 'ok', findings: [], reason: '' };
  } catch (error) {
    return { action: 'ok', reason: '', findings: [internalFinding('scanToolArguments', error)] };
  }
}

/* ------------------------------------------------------------------ */
/* 3. tool result                                                     */
/* ------------------------------------------------------------------ */

const WRITTEN_KEY_RE = /written/i;
const NOOP_TRUE_KEY_RE = /^(noop|no_op|nochange|no_change|unchanged|nothing|didnothing|did_nothing|skipped|notmodified|not_modified)$/i;
const NOOP_FALSE_KEY_RE = /^(applied|changed|modified|wrote|writtensomething)$/i;
const NOOP_STATUS_RE = /^(noop|no-op|unchanged|skipped|nothing|no_changes|no-changes)$/i;

/**
 * M3 only judges tools that are recognisably write-like. Anything else (read,
 * search, shell, terminal, web, ...) is left alone: an unrecognised tool means
 * "cannot tell", and here that means "do not report".
 *
 * Free-text phrase matching was removed on purpose. It made ordinary results
 * (git status, grep output, prose such as "leaving that text unchanged") look
 * like silent no-ops, which injected misleading corrections into real sessions.
 * Only explicit machine-readable evidence counts now.
 */
const WRITE_TOOL_RE = /(write|edit|append|patch|apply|replace|insert|update|create|save|mkdir|delete|remove|move|copy|rename|truncate|touch)/i;

/**
 * Minimum total payload before a "wrote 0 bytes" report means anything: an
 * argument list that only carries a path/flag (`{path:'a.txt'}`) did not carry
 * content, so writing nothing is expected rather than suspicious.
 */
const MIN_PAYLOAD_CHARS = 16;

/** True when the call actually carried string payload worth writing. */
function hasPayload(args, problems) {
  let total = 0;
  try {
    for (const leaf of collectStringLeaves(args, 100, problems)) {
      total += leaf.value.length;
      if (total >= MIN_PAYLOAD_CHARS) return true;
    }
  } catch {
    /* best-effort only */
  }
  return false;
}

function noopReason(config) {
  return config.lang === 'en'
    ? 'The tool reported that it produced no changes (possible silent no-op). Re-read the target to verify; if nothing was written, resend in smaller chunks.'
    : '工具自报未产生任何改动（疑似静默空转）。请回读目标确认；若确实未写入，请分块重发。';
}

/**
 * @param {unknown} name tool name (metadata only)
 * @param {unknown} args parsed arguments of the call
 * @param {unknown} result normalized dispatch result
 * @param {unknown} [opts] partial config
 */
export function scanToolResult(name, args, result, opts) {
  const config = safeMergeConfig(opts);

  try {
    // R9 kill switch: `noopCheck: false` disables this mechanism entirely.
    if (config.noopCheck !== true) return { suspicious: false, findings: [] };

    // Only write-like tools are judged. Any other tool means "cannot tell",
    // and "cannot tell" means "do not report".
    if (typeof name !== 'string' || !WRITE_TOOL_RE.test(name)) {
      return { suspicious: false, findings: [] };
    }
    if (result === null || typeof result !== 'object') return { suspicious: false, findings: [] };
    if (result.isError === true) return { suspicious: false, findings: [] };

    const problems = [];
    const carried = hasPayload(args, problems);

    const evidence = [];

    const consider = (key, value) => {
      if (typeof value === 'number') {
        // A write volume of 0 is only meaningful when the call carried payload.
        if (WRITTEN_KEY_RE.test(key) && value === 0 && carried) {
          evidence.push('reported written volume is 0 for a call that carried payload (' + key + ')');
        }
        return;
      }
      if (typeof value === 'boolean') {
        if (value === true && NOOP_TRUE_KEY_RE.test(key)) {
          evidence.push('explicit no-op flag (' + key + ' = true)');
        } else if (value === false && NOOP_FALSE_KEY_RE.test(key)) {
          evidence.push('explicit "nothing applied/changed" flag (' + key + ' = false)');
        }
        return;
      }
      if (
        typeof value === 'string' &&
        /^(status|result|outcome)$/i.test(key) &&
        NOOP_STATUS_RE.test(value.trim())
      ) {
        evidence.push('explicit no-op status value (' + key + ')');
      }
    };

    walkValue(result.value, consider, problems);
    walkValue(result.meta, consider, problems);

    // An incomplete walk cannot support a verdict: report the internal failure
    // and stay silent instead of guessing.
    const internalFindings = problems.map((problem) =>
      internalFinding('scanToolResult/' + (problem.path || '<value>'), problem.error),
    );
    if (internalFindings.length > 0) {
      return { suspicious: false, reason: '', findings: internalFindings };
    }

    if (evidence.length === 0) return { suspicious: false, findings: [] };

    return {
      suspicious: true,
      findings: [
        {
          code: 'SUSPICIOUS_NOOP_RESULT',
          severity: 'warn',
          detail: 'tool reported no effective change: ' + evidence.join('; '),
        },
      ],
      reason: noopReason(config),
    };
  } catch (error) {
    return { suspicious: false, reason: '', findings: [internalFinding('scanToolResult', error)] };
  }
}

/* ------------------------------------------------------------------ */
/* 4/5. messages                                                      */
/* ------------------------------------------------------------------ */

const CODE_LABELS_ZH = {
  END_SEQUENCE_MULTIPLIED: '重复的结束序列',
  UNPAIRED_CLOSING_TAG: '未配对的闭合标记',
  MISSING_OPENING_MARKUP: '缺少开场标记',
  MARKUP_LEAKED_AS_TEXT: '调用标记泄漏为正文',
  TRUNCATED_PAYLOAD: '调用结构中途截断',
  PAYLOAD_TOO_LONG: '载荷过长',
  CLOSING_TAG_DENSITY: '闭合标签密度过高',
  SUSPICIOUS_NOOP_RESULT: '疑似静默空转',
  INTERNAL_ERROR: '守卫内部错误',
};

const CODE_LABELS_EN = {
  END_SEQUENCE_MULTIPLIED: 'repeated end sequence',
  UNPAIRED_CLOSING_TAG: 'unpaired closing marker',
  MISSING_OPENING_MARKUP: 'missing opening markup',
  MARKUP_LEAKED_AS_TEXT: 'call markup leaked as text',
  TRUNCATED_PAYLOAD: 'truncated call structure',
  PAYLOAD_TOO_LONG: 'payload too long',
  CLOSING_TAG_DENSITY: 'high closing-tag density',
  SUSPICIOUS_NOOP_RESULT: 'suspected silent no-op',
  INTERNAL_ERROR: 'guard internal error',
};

function labelList(findings, config) {
  const labels = config.lang === 'en' ? CODE_LABELS_EN : CODE_LABELS_ZH;
  const seen = new Set();
  const out = [];
  for (const finding of findings) {
    const code = finding && finding.code;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(labels[code] || String(code));
  }
  return out.join(config.lang === 'en' ? ', ' : '、');
}

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

const CORRECTION_ZH = [
  '[结构校验失败 · 自动纠正]',
  '',
  '上一步的 assistant 输出被判为工具调用结构损坏（检测到未配对的调用标记、重复的结束序列，',
  '或调用标记泄漏为正文）。该步未执行任何操作——不要假设它已成功，也不要引用它的结果。',
  '',
  '现在请重新执行同一步骤，并遵守：',
  '1. 把 payload 拆到每块 ≤ {MAX} 行：首块用 write，其余用追加。',
  '2. 参数里不要出现完整的字面闭合标签，用拼接构造。',
  '3. 每块落盘后用一次独立的小调用回读校验。',
  '4. 不要复述、不要重新输出上一段损坏内容——直接给出新的、更小的调用。',
].join('\n');

const CORRECTION_EN = [
  '[Structure check failed · automatic correction]',
  '',
  'The previous assistant output was judged to have a damaged tool-call structure (unpaired call',
  'markers, a repeated end sequence, or call markup leaked into prose). That step executed nothing —',
  'do not assume it succeeded and do not reference its result.',
  '',
  'Re-run the same step now, and follow these rules:',
  '1. Split the payload into chunks of <= {MAX} lines: write the first chunk, then append.',
  '2. Do not put complete literal closing tags in a parameter; build them by concatenation.',
  '3. After each chunk lands, verify it with one small independent read-back.',
  '4. Do not restate or re-emit the damaged content — just give the new, smaller calls.',
].join('\n');

/** §4 — correction text injected for M4. Empty when nothing is blocking. */
export function buildCorrectionMessage(findings, opts) {
  const config = safeMergeConfig(opts);
  try {
    const blocking = blockingFindings(findings);
    if (blocking.length === 0) return '';
    const template = config.lang === 'en' ? CORRECTION_EN : CORRECTION_ZH;
    return template.replace('{MAX}', String(config.maxLines));
  } catch {
    return '';
  }
}

/** §5 — deny reason for M2, one sentence: not executed + why + how to fix. */
export function buildDenyReason(findings, opts) {
  const config = safeMergeConfig(opts);
  try {
    const blocking = blockingFindings(findings);
    if (blocking.length === 0) return '';
    const labels = labelList(blocking, config);
    const message =
      config.lang === 'en'
        ? 'Argument structure check failed: the boundary looks lost (' +
          labels +
          '); this call was NOT executed. Split into chunks of <= ' +
          config.maxLines +
          ' lines, write the first chunk then append, and avoid literal closing tags.'
        : '参数结构校验失败：参数疑似边界丢失（' +
          labels +
          '），本次未执行。请拆成 ≤' +
          config.maxLines +
          ' 行的若干块，先写首块再用追加，并避免字面闭合标签。';
    return truncate(message, 400);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 6. M5 — context sanitisation (R12)                                 */
/* ------------------------------------------------------------------ */

/** R12 built-in notes: drop the poisoned sample without losing the fact that
 * the step produced nothing. */
const CONTEXT_NOTE_ZH = '（此段输出因调用标记损坏已被忽略；该步未执行任何操作。）';
const CONTEXT_NOTE_EN =
  '(This output was dropped: its tool-call markup was damaged, so the step executed nothing.)';

/**
 * R12: rewrite damaged assistant messages out of the request's message list.
 *
 * Narrow by design: only `role === 'assistant'`, only messages with NO
 * tool-call block (a real call is never touched), and only when
 * `scanAssistantText` judges the text damaged. Pure: never mutates the input,
 * reuses unaffected messages, and returns the original array reference when
 * nothing changed. Never throws — any failure degrades to `changed: false`.
 *
 * @param {unknown} messages the model-visible message list
 * @param {unknown} [opts] partial config
 */
export function sanitizeMessages(messages, opts) {
  const config = safeMergeConfig(opts);
  const unchanged = () => ({ changed: false, messages, rewrites: [] });

  try {
    if (config.contextGuard !== true) return unchanged();
    if (!Array.isArray(messages)) return unchanged();

    const note =
      typeof config.contextGuardNote === 'string' && config.contextGuardNote.length > 0
        ? config.contextGuardNote
        : config.lang === 'en'
          ? CONTEXT_NOTE_EN
          : CONTEXT_NOTE_ZH;

    let out = null;
    const rewrites = [];

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      if (message.role !== 'assistant') continue;
      const content = Array.isArray(message.content) ? message.content : null;
      if (!content) continue;

      let text = '';
      let toolCallCount = 0;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') text += block.text;
        else if (block.type === 'tool-call') toolCallCount += 1;
      }
      if (toolCallCount > 0 || !text) continue;

      const scan = scanAssistantText(text, config, { hasToolCalls: false, toolCallCount: 0 });
      if (scan.damaged !== true) continue;

      if (out === null) out = messages.slice();
      out[index] = { ...message, content: [{ type: 'text', text: note }] };
      rewrites.push({
        index,
        codes: scan.findings.map((finding) => finding && finding.code).filter(Boolean),
      });
    }

    return out === null ? unchanged() : { changed: true, messages: out, rewrites };
  } catch {
    return unchanged();
  }
}

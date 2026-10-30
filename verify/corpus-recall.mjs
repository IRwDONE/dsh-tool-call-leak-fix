#!/usr/bin/env node
/**
 * verify/corpus-recall.mjs — INDEPENDENT corpus recall for D-10 (R14).
 *
 * Uses the provided multi-frame zstd decoder (`scratch/zstd-frames.mjs`) but
 * computes every metric with its own logic: it runs BOTH the current detector
 * and the pre-D-10 detector (extracted from git into verify/_pre-d10-detect.mjs)
 * over every assistant/message in every real session log, so "only D-10 could
 * have found it" is measured by direct comparison, not by inference.
 *
 * Run: node verify/corpus-recall.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeFrames } from '../scratch/zstd-frames.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions');

const curPath = path.join(ROOT, 'plugin', 'src', 'detect.js');
const prePath = path.join(HERE, '_pre-d10-detect.mjs');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);

console.log('current   detect.js sha16=' + sha(curPath));
console.log('pre-D-10  detect.js sha16=' + sha(prePath));

const cur = await import(pathToFileURL(curPath).href);
const pre = await import(pathToFileURL(prePath).href);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'session.v4.jsonl.zstd') out.push(p);
  }
  return out;
}

const files = walk(SESSIONS).sort();
console.log('session log files = ' + files.length);

let events = 0, withText = 0, textOnly = 0, textPlusCalls = 0;
let damagedNow = 0, silentNow = 0, damagedPre = 0, d10Only = 0;
let damagedNowWithCalls = 0;
let parseErrors = 0, frameErrors = 0;
const d10OnlyHits = [];

for (const file of files) {
  let blob;
  try { blob = decodeFrames(file); } catch { frameErrors += 1; continue; }
  for (const line of blob.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try { ev = JSON.parse(s); } catch { parseErrors += 1; continue; }
    if (!ev || ev.type !== 'assistant/message') continue;
    const msg = ev.data && ev.data.message;
    const blocks = msg && Array.isArray(msg.content) ? msg.content : null;
    if (!blocks) continue;
    events += 1;
    let text = '';
    let toolCalls = 0;
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') text += b.text;
      else if (b.type === 'tool-call') toolCalls += 1;
    }
    if (!text) continue;
    withText += 1;
    if (toolCalls > 0) textPlusCalls += 1; else textOnly += 1;
    const meta = { hasToolCalls: toolCalls > 0, toolCallCount: toolCalls };
    const a = cur.scanAssistantText(text, undefined, meta);
    const b = pre.scanAssistantText(text, undefined, meta);
    if (a.damaged) damagedNow += 1;
    if (a.damaged && toolCalls > 0) damagedNowWithCalls += 1;
    if (a.damaged && toolCalls === 0) silentNow += 1;
    if (b.damaged) damagedPre += 1;
    if (a.damaged && !b.damaged) {
      d10Only += 1;
      d10OnlyHits.push({
        session: path.basename(path.dirname(file)),
        codes: a.findings.map((f) => f.code + ':' + f.severity),
        silentFailure: a.silentFailure,
        textLength: text.length,
        // Raw-dialect evidence: the prefixed form exists, bare markers do not.
        hasNamespacePrefix: /<[A-Za-z_][A-Za-z0-9_.-]*:(?!\/)/.test(text) || /<\/([A-Za-z_][A-Za-z0-9_.-]*):/.test(text),
        hasBareInvoke: text.indexOf('<' + 'invoke') !== -1,
        hasBareParameter: text.indexOf('<' + 'parameter') !== -1,
      });
    }
  }
}
console.log('\n=== independently computed ===');
console.log(JSON.stringify({
  assistantMessageEvents: events,
  assistantMessagesWithText: withText,
  assistantMessagesTextOnlyNoToolCalls: textOnly,
  assistantMessagesWithTextAndToolCalls: textPlusCalls,
  damagedCurrent: damagedNow,
  damagedCurrentWithToolCalls: damagedNowWithCalls,
  damagedCurrentNoToolCalls: silentNow,
  damagedPreD10: damagedPre,
  damagedOnlyViaD10: d10Only,
  parseErrorsSkipped: parseErrors,
  frameErrorsSkipped: frameErrors,
}, null, 2));
console.log('\n=== damaged ONLY via D-10 ===');
for (const h of d10OnlyHits) console.log(JSON.stringify(h));

#!/usr/bin/env node
/**
 * verify/session-trace.mjs — independent reconstruction of a real-session turn.
 *
 * Decodes one append-only session log frame by frame and prints, in order, the
 * durable events of a turn. This lets the verifier check field claims (e.g. the
 * R11 "tier 1 -> the model really re-sent a call" sequence, the tier-2
 * escalation, and the D-11 fabricated tool_result) without trusting a summary.
 *
 * Usage: node verify/session-trace.mjs [sessionIdSubstring] [turn]
 */
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeFrames } from '../scratch/zstd-frames.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const needle = process.argv[2] || '929b19b0';
const wantTurn = Number(process.argv[3] || 25);

const detect = await import(pathToFileURL(path.join(ROOT, 'plugin', 'src', 'detect.js')).href);

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

const file = walk(path.join(os.homedir(), '.dsh', 'sessions'))
  .find((p) => p.includes(needle));
if (!file) { console.log('no session log matching ' + needle); process.exit(1); }
console.log('file = ' + file.replace(os.homedir(), '~'));

const blob = decodeFrames(file);
const events = [];
for (const line of blob.split('\n')) {
  const s = line.trim();
  if (!s) continue;
  try { events.push(JSON.parse(s)); } catch { /* skip */ }
}
const header = events.find((e) => e && e.type === 'session');
if (header) {
  console.log('header: parentSession=' + JSON.stringify(header.parentSession) +
    ' isSeeded=' + header.isSeeded + ' id=' + header.id);
}

console.log('\n=== events @ turn ' + wantTurn + ' ===');
for (const ev of events) {
  const d = ev.data || {};
  if (d.turn !== wantTurn) continue;
  let line = 'step ' + String(d.step).padStart(2) + '  ' + String(ev.type).padEnd(22);
  if (ev.type === 'assistant/message') {
    const blocks = (d.message && Array.isArray(d.message.content)) ? d.message.content : [];
    let text = '';
    let calls = 0;
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.text === 'string') text += b.text;
      else if (b && b.type === 'tool-call') calls += 1;
    }
    const r = detect.scanAssistantText(text, undefined, { hasToolCalls: calls > 0, toolCallCount: calls });
    line += 'blockTypes=' + JSON.stringify(blocks.map((b) => b && b.type)) +
      ' calls=' + calls + ' textLen=' + text.length +
      ' damaged=' + r.damaged + ' silent=' + r.silentFailure +
      ' codes=' + JSON.stringify(r.findings.map((f) => f.code)) +
      ' text=' + JSON.stringify(text.slice(0, 60));
  } else if (ev.type === 'user/message') {
    const src = d.source && d.source.kind;
    const text = d.message ? JSON.stringify((d.message.content || []).map((b) => (b && b.text) || '').join('').slice(0, 50)) : '';
    line += 'source=' + src + ' text=' + text;
  } else if (ev.type === 'tool/call') {
    line += 'name=' + d.name;
  } else if (ev.type === 'step/start' || ev.type === 'step/end') {
    line += '';
  } else {
    line += 'dataKeys=' + Object.keys(d).join(',');
  }
  console.log(line);
}

/* Injected messages are inbox inserts, not turn-tagged events, so show the last
 * few user/message + inbox-splice rows separately. */
console.log('\n=== last injections / inbox activity (any turn) ===');
const tails = events.filter((e) => e && (e.type === 'user/message' || e.type === 'agent/inbox/spliced'));
for (const ev of tails.slice(-8)) {
  const d = ev.data || {};
  if (ev.type === 'user/message') {
    const text = (d.message && Array.isArray(d.message.content))
      ? d.message.content.map((b) => (b && b.text) || '').join('')
      : '';
    console.log('user/message  source=' + (d.source && d.source.kind) +
      ' textLen=' + text.length + ' text=' + JSON.stringify(text.slice(0, 70)));
  } else {
    const inserted = Array.isArray(d.inserted) ? d.inserted : [];
    const first = inserted[0];
    const text = (first && Array.isArray(first.content))
      ? first.content.map((b) => (b && b.text) || '').join('')
      : '';
    console.log('inbox/spliced target=' + JSON.stringify(d.target) +
      ' inserted=' + inserted.length + ' source=' + (first && first.source && first.source.kind) +
      ' text=' + JSON.stringify(text.slice(0, 70)));
  }
}

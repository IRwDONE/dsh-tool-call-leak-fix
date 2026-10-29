import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LT = '<', GT = '>', SL = '/';
const OPEN_INVOKE = LT + 'invoke';
const OPEN_PARAM = LT + 'parameter';
const END_INVOKE = LT + SL + 'invoke' + GT;
const END_PARAM = LT + SL + 'parameter' + GT;
const bigHtml = (n) => { let s = ''; for (let i = 0; i < n; i += 1) s += LT + 'div class="x">item-' + i + LT + SL + 'div' + GT + '\n'; return s; };
const readDoc = (...p) => { try { return readFileSync(path.join(ROOT, ...p), 'utf8'); } catch { return null; } };

const work = await import(pathToFileURL(path.join(ROOT, 'plugin/src/detect.js')).href);
const headPath = path.join(HERE, '_head', 'detect.mjs');
const head = existsSync(headPath) ? await import(pathToFileURL(headPath).href) : null;

const cases = [
  ['docs/plugin-README.md', readDoc('plugin', 'README.md')],
  ['docs/CONTRACTS.md', readDoc('docs', 'CONTRACTS.md')],
  ['docs/INTERFACE.md', readDoc('docs', 'INTERFACE.md')],
  ['docs/DESIGN.md', readDoc('docs', 'DESIGN.md')],
  ['callShaped: invoke+param payload /param NO /invoke (47 lines)', OPEN_INVOKE + ' name="write">\n' + OPEN_PARAM + ' name="content">\n' + bigHtml(40) + END_PARAM + '\n'],
  ['nonCallShaped: html + quoted markup, opener tail', bigHtml(40) + OPEN_INVOKE + ' name="x">\n' + OPEN_PARAM + ' name="c">abc'],
];

function run(m, label, content) {
  const r = m.scanToolArguments('write', { content });
  return { label, action: r.action, codes: r.findings.map((f) => f.code + ':' + f.severity) };
}

for (const [label, content] of cases) {
  if (content === null) { console.log(label.padEnd(50) + ' (missing file)'); continue; }
  const w = run(work, label, content);
  const h = head ? run(head, label, content) : null;
  console.log('\n' + label + '  [' + content.length + ' chars]');
  console.log('  worktree(fe132d8e): action=' + w.action + '  ' + JSON.stringify(w.codes));
  if (h) console.log('  HEAD(fe549ba)    : action=' + h.action + '  ' + JSON.stringify(h.codes));
}

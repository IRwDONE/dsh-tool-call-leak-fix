// verify/repro-d1.mjs — minimal reproductions for D-1 (R6 predicate inverted).
// Run: node verify/repro-d1.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LT = '<', GT = '>', SL = '/';
const OI = LT + 'invoke', OP = LT + 'parameter';
const EI = LT + SL + 'invoke' + GT, EP = LT + SL + 'parameter' + GT;
const html = (n) => { let s = ''; for (let i = 0; i < n; i += 1) s += LT + 'div class="x">item-' + i + LT + SL + 'div' + GT + '\n'; return s; };

const src = readFileSync(path.join(ROOT, 'plugin', 'src', 'detect.js'), 'utf8');
console.log('detect.js sha256=' + createHash('sha256').update(src, 'utf8').digest('hex'));
const { scanToolArguments } = await import(pathToFileURL(path.join(ROOT, 'plugin', 'src', 'detect.js')).href);

const cases = [
  ['D-1a FALSE NEGATIVE: <invoke><parameter>...</parameter> but NO </invoke>',
    OI + ' name="write">\n' + OP + ' name="content">\n' + html(40) + EP + '\n'],
  ['D-1b FALSE POSITIVE: HTML prose quoting markup, opener tail (starts with <div)',
    html(40) + OI + ' name="x">\n' + OP + ' name="c">abc'],
  ['D-1c LIVE: plugin/README.md is denied (guard refuses to write its own README)',
    readFileSync(path.join(ROOT, 'plugin', 'README.md'), 'utf8')],
];

for (const [label, content] of cases) {
  const r = scanToolArguments('write', { content });
  console.log('\n' + label);
  console.log('  chars=' + content.length + ' lines=' + content.split('\n').length);
  console.log('  => action=' + r.action + '  findings=' + JSON.stringify(r.findings.map((f) => f.code + ':' + f.severity)) +
    (r.action === 'deny' ? '\n  => reason=' + JSON.stringify(r.reason) : ''));
}

#!/usr/bin/env node
/**
 * tests/check-fixtures.mjs —— fixtures 完整性诊断（作者工具，不参与验收断言）
 *
 * 目的：长 payload（含大量以「<」「/」开头的闭合标签）写入时可能被**静默截断**，
 *       正是本插件要抓的故障形态。本工具回读每个 fixture，打印 字节数 / 行数 /
 *       闭合标签计数 / 逐 tag 配平，并让"写入截断"无法蒙混过关。
 *
 * 运行： node tests/check-fixtures.mjs
 * 退出码：0 = 无完整性问题；1 = 有空文件 / 残留占位符 / 缺结尾换行 / 读取失败
 *
 * 注意：「over」列对正例是**预期现象**（V1 的 INVOKE_END 过度闭合就是故障形态），
 * 因此它只报告、不计入退出码；反例的配平由 tests/run.mjs 的 A4 断言把关。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'fixtures');

// 记号一律拼接构造，本文件自身不书写连续的字面闭合标签。
const INVOKE = '<' + 'invoke';
const PARAM = '<' + 'parameter';
const INVOKE_END = '<' + '/invoke' + '>';
const PARAM_END = '<' + '/parameter' + '>';
const CLOSE_PREFIX = '<' + '/';

function tagBalance(text) {
  const opens = new Map();
  const closes = new Map();
  for (const m of text.matchAll(/<([a-zA-Z][\w:-]*)/g)) {
    const t = m[1].toLowerCase();
    opens.set(t, (opens.get(t) || 0) + 1);
  }
  for (const m of text.matchAll(/<[/]([a-zA-Z][\w:-]*)/g)) {
    const t = m[1].toLowerCase();
    closes.set(t, (closes.get(t) || 0) + 1);
  }
  const over = [];
  for (const [t, c] of closes) {
    const o = opens.get(t) || 0;
    if (c > o) over.push(`${t}(${c}>${o})`);
  }
  return over;
}

const count = (text, needle) => text.split(needle).length - 1;

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.txt'))
  .sort();

let problems = 0;
const rows = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(path.join(DIR, file), 'utf8');
  } catch (err) {
    problems += 1;
    rows.push({ file, note: `读取失败: ${err.message}` });
    continue;
  }
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const over = tagBalance(text);
  const issues = [];
  if (text.length === 0) issues.push('空文件');
  if (text.includes('@@')) issues.push('残留占位符');
  if (!text.endsWith('\n')) issues.push('缺结尾换行');
  if (issues.length > 0) problems += 1;

  rows.push({
    file,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines,
    density: count(text, CLOSE_PREFIX),
    invokeOpen: count(text, INVOKE),
    invokeEnd: count(text, INVOKE_END),
    paramOpen: count(text, PARAM),
    paramEnd: count(text, PARAM_END),
    over: over.join(' '),
    issues: issues.join(' '),
  });
}

const pad = (v, n) => String(v).padEnd(n);
console.log(
  pad('file', 34) +
    pad('bytes', 7) +
    pad('lines', 7) +
    pad('close', 7) +
    pad('invOpen', 9) +
    pad('invEnd', 8) +
    pad('parOpen', 9) +
    pad('parEnd', 8) +
    'over / issues',
);
console.log('-'.repeat(110));
for (const r of rows) {
  if (r.note) {
    console.log(pad(r.file, 34) + r.note);
    continue;
  }
  console.log(
    pad(r.file, 34) +
      pad(r.bytes, 7) +
      pad(r.lines, 7) +
      pad(r.density, 7) +
      pad(r.invokeOpen, 9) +
      pad(r.invokeEnd, 8) +
      pad(r.paramOpen, 9) +
      pad(r.paramEnd, 8) +
      [r.over, r.issues].filter(Boolean).join(' | '),
  );
}
console.log('');
console.log(`fixtures: ${files.length} 个；完整性问题: ${problems} 个`);
if (problems > 0) process.exitCode = 1;

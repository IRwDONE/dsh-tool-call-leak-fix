'use strict';
/**
 * tests/run.js —— 兼容入口（CommonJS），等价于 `node tests/run.mjs`。
 *
 * 说明：task-3 原始要求交付 `tests/run.js`，但 docs/INTERFACE.md 已把被测模块
 * 从 CommonJS 改为 ESM（裁定见 INTERFACE.md 顶部修订），主运行器因此是
 * `tests/run.mjs`。本文件只做一次动态 import 转发，断言逻辑全部在 run.mjs 里，
 * 避免出现两份会漂移的测试。
 */
import('./run.mjs').catch((err) => {
  console.error('[run.js] 转发 tests/run.mjs 失败：', (err && err.message) || String(err));
  process.exitCode = 1;
});

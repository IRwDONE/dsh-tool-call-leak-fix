# 冻结接口：`plugin/src/detect.js`

> 本文件是**契约**。`plugin-dev` 必须按此实现，`test-harness` 按此写测试。
> 擅自改签名 = 破坏并行工作，需先经 lead 同意并同步更新本文件。
> 该模块是**纯函数、零依赖、ESM**，不 import 任何 DSH 包，可在普通 node 下直接跑。

> **2026-10-28 修订（lead）**：原稿写 CommonJS，但 manifest 规定插件包
> `"type": "module"`（见 skill `cordis-plugin-development` 的 `references/host-plugin.md` 第 7–18 行），
> 包内 `.js` 一律按 ESM 解析 → 统一改为 **ESM**。这是唯一改动，签名与返回形状不变。

## 暴露

```js
export const DEFAULT_CONFIG = { /* 见下 */ };
export function mergeConfig(partial) {}
export function scanAssistantText(text, opts, meta) {}
export function scanToolArguments(name, args, opts) {}
export function scanToolResult(name, args, result, opts) {}
export function buildCorrectionMessage(findings, opts) {}
export function buildDenyReason(findings, opts) {}
export function sanitizeMessages(messages, opts) {}   // R12 (M5) — added 2026-10-29
```

## 配置

`DEFAULT_CONFIG`（全部可被插件 Config 覆盖）：

```js
{
  enabled: true,
  maxLines: 100,                 // 单次调用写入正文的行数硬上限
  maxChars: 20000,               // 单次调用写入正文的字符硬上限
  closingTagCount: 8,            // 正文里 "</" 出现次数的警戒线
  endSequenceRepeats: 2,         // 尾部连续 INVOKE_END 个数达到该值即判损坏（见 §0）
  maxCorrectionsPerTurn: 1,      // 每个 turn 最多自动纠偏次数（防循环）
  lang: 'zh',                    // 'zh' | 'en'，决定提示语语言
  noopCheck: true,               // ★R9：M3「疑似空转」检测的 kill switch
  debugLog: false,               // ★R10：诊断日志开关（默认 false = 零开销零副作用）
  debugLogPath: '',              // ★R10：日志目标；空串时由系统临时目录推导
  contextGuard: false,           // ★R12：M5 上下文净化开关（默认关；本机 harness 上无效，见 D-8）
  contextGuardNote: '',          // ★R12：替换注记；空串=内置中英文注记
}
```

**共 12 个键**（R9 后 8 个，R10 再 +2，R12 再 +2）。`mergeConfig(partial)` → 新对象，缺字段用默认值补齐；非法值回退默认。
测试请**从 `DEFAULT_CONFIG` 推导键集合**，不要硬编码字符串。

**裁定 R10（2026-10-28）—— 诊断日志开关：**

- `debugLog: boolean`（默认 `false`）；`debugLogPath: string`（空串 / 非字符串 → 由**系统临时目录**推导）。
  **不得硬编码任何用户机器上的绝对路径**（发布性要求；此前默认值曾写死本机工作区路径，已列为缺陷 D-5 的一部分）。
- `debugLog !== true` 时 logger **直接返回空函数**：零开销、零副作用。
- 写入失败**绝不得影响主流程**（try/catch 包裹）。
- 用途：把 M4 这种"静默观察者"变成可观测的。本轮 M4 现场诊断即靠它定位。

**M4 现场验收结论修正（2026-10-28，据 `debugLog` 实测）：新结论 = 阳性（plumbing 全通）**

1. `session/event` 的真实派发签名确认为 **`(session, event)`**；`assistant/message` 的 `data` 键为
   `{turn, step, message, usage, stream}`；`agent/turn-stopping` 的 payload 为 `{turn, signal, agent}`，
   且 `agent.inject` 是函数。
2. 全链路实测：`damaged=true, silentFailure=true` → turn-stopping 找到记录 →
   `agent.inject()` 成功 → `agent/inbox/spliced` 落盘 → **同一 turn 内出现 `step/start` 与
   `step N+1`（turn 号未变）**，即 **turn 确实没有关闭**。
3. **未解问题（下一步）**：模型看到注入后**没有真正重做那一步**（下一步只输出了一段短文本）。
   故当前"自愈"只做到"**不静默关闭**"，尚未做到"**真正重做**"。这属 R11 待办。

**裁定 R11（2026-10-28）—— 注入必须"可执行"，不能只是"可读"：**

- M4 注入的消息在 B 段之前**加一行硬指令**（保持在 `index.js` 内，**不改动冻结的
  `buildCorrectionMessage` 构造器**，以免打乱两套测试的既有断言）：
  「【立即执行】上一步想做的工具调用没有被执行。不要解释、不要复述上一段内容，直接用更小的分块重新发起那个调用。」
- 理由：只描述故障（B 段）会让模型倾向于**评论**故障而不是**修**故障；必须显式禁止"解释/复述"并要求
  直接重发调用。M3 也遵守同一原则（它用自己的 `reason`，不复用 B 段）。
- 说明：此改动使"注入文本 ≠ `buildCorrectionMessage()` 的返回值"，两者是**前缀关系**；判定 M4 是否注入时
  不得再用全等比较。
- **诚实标注**：R11 的效果目前只在**人工构造**的样本上观察过，而那一步本来没有真实待办；
  真实故障下的"是否真重做"仍需一次真实发生来验收。

**裁定 R3（2026-10-28）**：`partial` 为 `null` / `undefined` / 非普通对象（含数组、函数、代理）时，
**不抛异常**，返回**完整默认值的浅拷贝**；未知键忽略；返回值不共享 `DEFAULT_CONFIG` 的可变引用。

**裁定 R9（2026-10-28）—— `noopCheck` kill switch，以及 M3 在真实会话中的误报事故：**

- `DEFAULT_CONFIG` 增加 **`noopCheck: boolean`（默认 `true`）**。`false` 时 `scanToolResult` **立即返回
  `{ suspicious: false, findings: [] }`**，M3 整条机制关闭。
- **事故背景（必读）**：M3 原先用**自由文本短语匹配**（`unchanged` / `no changes` / `no-?op` / `未做任何`…）
  判断"工具是否空转"。插件装进真实 profile 后，它在**普通工具结果**（`git status`、`grep` 输出、说明性文本）
  上误报，**向真实会话注入了 4 次**"[结构校验失败 · 自动纠正] …该步未执行任何操作"，
  而那些步骤**明明执行成功**——注入文案与实际语义不符，对用户是误导。
- 因此 M3 规则收紧为：**只认显式结构化证据**（明确的 no-op 布尔/状态字段、`written*` 类计数为 0），
  **禁止自由文本短语匹配**；**只对写入类工具生效**，拿不准就不生效。
- **文案不得复用 B 段**：B 段（`buildCorrectionMessage`）讲的是"结构损坏 / 参数边界丢失"，
  是 M4 的语义；M3 必须用 `scanToolResult` 的 `reason`（"工具自报未产生任何改动…"）。
  两者混用就是这次"说未执行、其实执行了"的根因。

## 0. 记号裁定（R1 / R2，2026-10-28）

为消除"什么是结束序列"的歧义，全文使用拼接记号，且**不书写连续的字面闭合标签**：

| 记号 | 指代 token（拼接描述） | 是否计入 endSequence |
| --- | --- | --- |
| `INVOKE_END` | `<` + `/invoke` + `>` | **是（唯一）** |
| `PARAM_END` | `<` + `/parameter` + `>` | **否** |
| `INVOKE_OPEN` | `<` + `invoke` 开头的开场标记 | — |
| `PARAM_OPEN` | `<` + `parameter` 开头的开场标记 | — |

- **裁定 R2**：**结束序列 = `INVOKE_END`，不含 `PARAM_END`**。
  一个结构完好的调用尾部恰好出现 **1 个** `INVOKE_END`。
- `endSequenceRepeats`（默认 2）= **尾部连续 `INVOKE_END` 的个数**阈值；`≥ 阈值` 即 `END_SEQUENCE_MULTIPLIED`（error）。
- 因此合法收尾（1 个 `PARAM_END` + 1 个 `INVOKE_END`）**不会**误判。
- 判定只看**尾部连续段**（允许其前是空白的连续段），不统计整段的出现总次数。

## 类型

```js
/** @typedef {{code: FindingCode, severity: 'info'|'warn'|'error', detail: string, at?: number}} Finding */

/** @typedef {'END_SEQUENCE_MULTIPLIED'|'UNPAIRED_CLOSING_TAG'|'MISSING_OPENING_MARKUP'
 *  |'MARKUP_LEAKED_AS_TEXT'|'TRUNCATED_PAYLOAD'|'PAYLOAD_TOO_LONG'
 *  |'CLOSING_TAG_DENSITY'|'SUSPICIOUS_NOOP_RESULT'} FindingCode */
```

`FindingCode` 取值集合**冻结**：测试与文案都按这些 code 断言，不新增同义 code。

**裁定 R5（2026-10-28）**：集合**增补一个** code —— `INTERNAL_ERROR`（`severity:'info'`，恒不导致 deny）。
理由：内部异常降级原本复用了 `SUSPICIOUS_NOOP_RESULT`，但该 code 在 §3 表示**真实的空转嫌疑**，
两者语义冲突，会让诊断信息说谎（把"插件自己出错了"报成"工具疑似没干活"）。
`INTERNAL_ERROR` 只在"函数内部异常、已安全降级"时出现，`detail` 形如 `internal-error: <where>: <message>`，
且此时 `reason` 必须为空串。除本次增补外，集合仍然冻结。

**裁定 R6（2026-10-28）**：`TRUNCATED_PAYLOAD` 的"结构未闭合"配对走查**只在本叶子呈调用形状时执行**
（首个非空白结构标记为 `INVOKE_OPEN` 或 `PARAM_OPEN`）。
理由：否则**文档里引用一次参数开场标记**就会被判截断——实测 `docs/DESIGN.md`、`docs/CONTRACTS.md`、
`plugin/README.md` 都曾被误报 `TRUNCATED_PAYLOAD:error`。真实截断只发生在那种形状的输出上。
（V2 那种"缺开场标记"的场景仍由 `MISSING_OPENING_MARKUP` 覆盖，不构成盲点。）

**裁定 R6 修正（2026-10-28，据 verify probe）**：上一条的"调用形状"必须**同时**接受两种起点：
首个非空白结构标记为 `INVOKE_OPEN` **或** `PARAM_OPEN`。
实测：只认 `INVOKE_OPEN` 时，`TRUNCATED_PAYLOAD` 在整轮 probe 里**从未被产生**（`not-produced`），
规则沦为死代码——真实截断同样会发生在以 `PARAM_OPEN` 起头的输出上。

**裁定 R7（2026-10-28）**：数值门槛必须 **≥ 1**。
`maxLines` / `maxChars` / `closingTagCount` / `endSequenceRepeats` 取 `0` 会让判定**恒真**
（如 `endSequenceRepeats:0` ⇒ 任何输入都命中 `END_SEQUENCE_MULTIPLIED`），属危险默认；
`0` / 负数 / 非整数 / 非有限数一律回退默认。**例外**：`maxCorrectionsPerTurn` 允许 `0`（语义 = 关闭自动纠偏）。

**裁定 R8（2026-10-28）**：字符串叶子遍历**有界**，这是有意设计，须显式记录而非静默：
最多 **200** 个叶子、最大**深度 24**；超出部分不扫描，故深/多叶子的损坏**可能漏检**
（真实形态 `write`/`run_code` 只有 2–3 层、1–2 个相关叶子，实务风险可忽略）。
该边界必须写进 `plugin/README.md` 的「已知边界」并在 §2 注明，不得被当作"已覆盖全部叶子"。

**裁定 R3 措辞修正（2026-10-28）**：原文把"代理"一律列为非普通对象。实际**透明代理无法与普通对象区分**，
也不应被拒绝。改为：`partial` 只要**原型链为 `Object.prototype` 或 `null`**（含透明代理）即按普通对象处理；
否则（数组、函数、Date、Map、抛错 getter 的敌意代理等）回退完整默认值。

## 1. `scanAssistantText(text, opts?, meta?)`

扫描一段**原始 assistant 文本**（V2/V3 的现场：调用标记泄漏为正文）。

返回：

```js
{
  damaged: boolean,         // findings 中含 severity==='error' 或 'warn' 即 true
  silentFailure: boolean,   // ★裁定 R1：仅此一个自愈触发标志（顶层字段）
  findings: Finding[],
  evidence: {               // 诊断用，不含 payload 正文（避免二次污染上下文）
    length: number,
    closingTagCount: number,
    endSequenceRepeats: number,
    leakedMarkup: boolean,
    truncated: boolean,
  },
}
```

**裁定 R1（2026-10-28）：静默失败标志的唯一名字是顶层 `silentFailure: boolean`。**
定义（实现与测试都按这一条精确断言）：

```
silentFailure === (damaged === true && meta?.hasToolCalls === false)
```

- `meta` 缺省、`meta.hasToolCalls` 为 `true` 或非布尔 → `silentFailure === false`（**不猜、不自愈**）。
- 这是 M4 自愈的**唯一**触发条件；`hasToolCalls === true` 时只记 finding，不注入纠正。
- 不再另设同义字段（`shouldSelfHeal` / `quarantine` 之类一律**不要**实现）。

判定规则（实现须与此一致）：

- `END_SEQUENCE_MULTIPLIED`：见 §0 R2 —— 尾部连续 `INVOKE_END` 个数 ≥ `endSequenceRepeats` → error。
- `MISSING_OPENING_MARKUP`：出现参数开场标记（`<parameter`）但整段没有调用开场标记（`<invoke`）→ error。
- `MARKUP_LEAKED_AS_TEXT`：`<invoke` / `<parameter` 出现在含自然语言句子的文本里（即被当作正文而非调用）→ error。
- `TRUNCATED_PAYLOAD`：文本在未闭合的调用/参数结构中途结束 → error。
- `UNPAIRED_CLOSING_TAG`：同一 tag 名的闭合标记数 > 开场标记数 → warn。

`meta`（可选）形如 `{ hasToolCalls: boolean, toolCallCount: number, stopReason?: string }`：
它**只**决定裁定 R1 的 `silentFailure` 字段，**不**影响 `damaged` 与 `findings`。

## 2. `scanToolArguments(name, args, opts?)`

扫描**已解析**的调用参数（V1 的现场：结构可解析但带伤）。

- 遍历 `args` 的字符串叶子（递归 object/array）；**有界**：最多 200 个叶子、深度 ≤ 24（见 R8），
  超出部分**不被扫描**（因此不得再声称"遍历全部字符串叶子"）。
- `PAYLOAD_TOO_LONG`：任一叶子行数 > `maxLines` 或字符数 > `maxChars` → warn（建议拆块，不强制拒绝）。
- `CLOSING_TAG_DENSITY`：任一叶子中 `</` 出现次数 ≥ `closingTagCount` → info。
- `END_SEQUENCE_MULTIPLIED` / `TRUNCATED_PAYLOAD`：同 §1 规则，作用在叶子上 → **error**（可导致 deny）。
- `UNPAIRED_CLOSING_TAG`：作用在**参数叶子**上时一律降为 **info**（**永不导致 deny**，只作证据）。

返回：

```js
{ action: 'ok' | 'deny' | 'flag', findings: Finding[], reason?: string }
```

**裁定 R4（2026-10-28）—— deny 的双门槛（防止"守卫拒绝写解释自己的文档"）：**

`action:'deny'` 必须**同时**满足两个条件：

1. **损坏信号**：该叶子命中 error 级结构规则，且仅限 `END_SEQUENCE_MULTIPLIED` 或 `TRUNCATED_PAYLOAD`
   （`UNPAIRED_CLOSING_TAG` 因合法文档天然标签不配对，在本语境已降为 info，**不计入**）。
2. **体量实质**（同一叶子自身）：`chars >= ceil(maxChars/10)` **或** `lines >= ceil(maxLines/5)`
   （默认即 `chars >= 2000` 或 `lines >= 20`）。

不满足条件 2 → **最高只到 `action:'flag'`**，绝不拦截。

- 满足 deny 门槛 → `action:'deny'`，`reason` = `buildDenyReason(findings, opts)`。
- 否则有 warn/info → `action:'flag'`。
- 无 finding → `action:'ok'`。

**理由（必读）**：本仓库的 `docs/DESIGN.md` 就是"描述本故障、内含 1 个孤立 `INVOKE_END`"的文档，
长度 > 10 KB。旧规则会对它 `deny` —— 即**守卫会拒绝写解释自己的文档**，不可接受。
真实故障形态（DESIGN §2）是"长 payload + **尾部连续结束序列** / 结构中途截断"，
与"文档里提到一次闭合标签"可区分，故用上面双门槛区分。

**硬约束**：`action` 绝不为 `deny` 的调用删除/改写参数内容——只拒绝或标记，不改写（避免把损坏写坏成更坏）。

## 3. `scanToolResult(name, args, result, opts?)`

写入类工具的"假成功/空转"检查（M3）。

返回 `{ suspicious: boolean, findings: Finding[], reason?: string }`。
只有出现可判定的空转证据时才给 `suspicious:true`（例如：工具自报写入成功但目标的字节数/行数未变，
或返回值显式表示"未做任何事"）。**判不准就不报**——宁漏勿扰。

## 4. `buildCorrectionMessage(findings, opts?)` → string

生成注入用的纠正文本（对应 `docs/PROMPTS.md` 的 **B**）。按 `opts.lang` 出中文/英文；
无 error/warn 时返回 `''`。

## 5. `buildDenyReason(findings, opts?)` → string

生成 `deny.reason`（对应 **C**）。要求：一句话说清 **未执行 + 原因 + 怎么改**；长度 ≤ 400 字符。

## 稳定性要求

- 纯函数：同输入同输出；不读全局、不打日志、不抛异常（内部异常一律转成
  `{ code:'...', severity:'info', detail:'internal-error: ...' }` 并降级为不拦截）。
- 不修改入参（深遍历只读）。
- `evidence` 与 `reason` **不得包含 payload 正文**（防止损坏内容被复制传播）。

## 6. `sanitizeMessages(messages, opts?)` → `{ changed, messages, rewrites }`

**M5 上下文净化（R12）。** 把**已经损坏的 assistant 文本**从模型可见历史里换掉，
用于"对话已经被带坏"之后的补救。`rewrites` 形如 `[{index, codes}]`。

**裁定 R12（2026-10-29）—— M5 + 独立开关 `contextGuard`：**

- 新增配置 **`contextGuard: boolean`（默认 `false`）**、**`contextGuardNote: string`（默认 `''`，
  空串=内置注记）** → `DEFAULT_CONFIG` 现 **12 键**。
- **默认必须关闭**：它改写**模型可见历史**，属"用户发现对话出问题后主动打开"的手段，不适合常开。
- 作用域**刻意很窄**，只改同时满足三条的消息：
  1. `role === 'assistant'`；
  2. `content` 里**没有 `tool-call` 块**（真实工具调用永不触碰）；
  3. `scanAssistantText(text, config, {hasToolCalls:false}).damaged === true`。
  改写方式：把该消息的 `content` 换成**单个 text 块**（内置中性注记，或 `contextGuardNote`），
  其余字段（`id`/`role`/`source`）保留。
- **纯函数纪律**：不改入参；未改动的消息**复用原引用**；`changed:false` 时返回**原数组引用**；
  内部异常一律降级为 `changed:false`；注记与 `rewrites` **不得含 payload 正文**。
- **挂点与机制依据（已取证）**：`plugin/index.js` 在 **`llm/stream`** waterfall 里工作。
  派发点为 `dsh-llm/lib/index.js:2397` 的
  `ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`：
  下游闭包读**同一个 `options` 引用**，因此必须**原地**赋值 `options.messages = result.messages`
  （把新对象交给 `next(...)` 无效，`next` 无参）。
  安全性依据：同文件 `callConfigEquals`（:367-371）只比较 provider/model/reasoningEffort/
  temperature/maxTokens/stop，**不比较 messages**，故改 messages **不会**触发
  `INVALID_PREPARED_CALL`（见 :2251/:2327）；`prepared` 只含
  `{registration, modelInfo, config, dispatch}`，**不含 messages**。
- **全是 waterfall 纪律**：无论开关开或关、无论是否改写成功，listener **都必须恰好调用一次 `next()`**；
  任何异常都不得让模型调用失败。
- **代价（写进 README）**：改写历史会使**该前缀的 prompt cache 失效**（只影响打开开关之后的首个请求）；
  它不改变工具调用、不改变 system prompt、不新增提示词。

**⚠️ R12 修正（2026-10-29，缺陷 D-8，高危）：上面"原地赋值即可生效"的结论在本机 harness 上不成立。**

独立验证员逐行取证：`agent-loop` 的 `buildRequest()`（`dsh-agent-loop/lib/index.js:1214`）返回的是
**`Object.freeze({ ...header.config, messages: boundaryMessages, ... })`（`:1281`）**，
其中 `:1280` 冻结了 `messages` 数组、`:1277` deepFreeze 了每条消息；`:1084` 把**同一个冻结对象**
交给 `llm.stream` → 经 `dsh-llm/lib/index.js:2397` 的 waterfall。ESM 是严格模式，因此
`options.messages = result.messages` 会抛 `TypeError`。

- **原结论哪里错了**：只验证了"下游闭包读同一引用"（成立）与"`callConfigEquals` 不比 messages"（成立），
  **漏验"该引用只读"**。结果 M5 变成**静默失效**——不报错、不崩、功能为空，正是本项目最该消灭的失败形态。
- **重新接线时必须遵守的规则（⚠️ 当前并未接线 —— 见下方「R12 处置」）**：将来某版本 harness 若给出可写接缝，
  `llm/stream` listener 必须**先做** `Object.isFrozen(options) || Object.isFrozen(options.messages)` 检测；
  命中就**显式记录**（例如 `log({where:'llm/stream', skipped:'frozen-options', rewrites})`）并**照常 `next()`**，
  **绝不允许静默失败**；只有未冻结时才原地赋值；**任何路径都恰好 `next()` 一次**。
- **结论**：`contextGuard` 在**当前 harness 上不会生效**，其接线与公开开关已按下方处置移除；
  文档中一律标注为**已停用 / 内部保留、未接线**，不得当作可用能力。
  要真正生效需要 harness 提供可写接缝（例如允许 listener 返回替换后的请求，或在 envelope 冻结前介入），
  **插件侧无法绕过**。纯函数 `sanitizeMessages` 本身仍达标且被独立验证覆盖。

**R12 处置（2026-10-29，按用户决策「暂时收手，开关可以不保留，代码留着」）：**

- **移除 `llm/stream` 的接线**（留着一个永不生效的监听器只会让每个请求白扫一遍历史），
  并在 `plugin/index.js` 原地留下"为何不能做 + 将来如何重新接线"的注释（含 D-8 行号与三条必须遵守的规则：
  先查 `Object.isFrozen`、失败必须**显式报告**、任何路径**恰好一次** `next()`）。
- **公开开关下架**：`plugin/cordis.patch.yml` 不再暴露 `contextGuard`；
  但 `DEFAULT_CONFIG` **仍保留** `contextGuard` / `contextGuardNote` 两键（供 `sanitizeMessages` 与将来重新接线复用），
  故键数仍为 **12**。二者在文档中一律标注为**内部保留、未接线**。
- **`sanitizeMessages` 保留**在 `src/detect.js` 并仍导出；M5 的状态为**已停用（不注册监听器）**。
  在用的机制回到 **M2 / M3 / M4**。

**裁定 R13（2026-10-30）—— M4 的**有界二次升级**（现场证据驱动）：**

- **触发它的现场证据**：在一个真实用户会话里，M4 **确实工作了**（检测到 `silentFailure` → `turn-stopping`
  注入 → `agent/inbox/spliced` → **同一 turn 内新开一步**），但**没有救回工作**：那一步之后模型
  **又写坏了一次**（而且这次把 **23 KB** 内容当正文吐了出来），随后 `maxCorrectionsPerTurn: 1` 用尽、
  turn 正常关闭。即"自愈"此前只做到"**不静默关闭**"。详见 `verify/REPORT.md` 与 README。
- **实现（只在 `plugin/index.js`，不动冻结的 `detect.js`）**：按 `count` 分两档注入——
  - **tier 1**（`count === 0`）：沿用原语义，B 段 + R11 指令；`buildCorrectionMessage` 返回空串时**不注入**。
  - **tier 2**（`count === 1`）：**丢掉长解释**，换成一句更硬更短的指令——"这一步**只发一个调用**、
    单个参数**不超过 40 行**、不要输出任何解释、不要把内容打在正文里"，并附上判定 code。
- **仍然有界**：注入次数上限就是 `maxCorrectionsPerTurn`；同一 turn 内 tier 2 之后不再注入。
  `DEFAULT_CONFIG.maxCorrectionsPerTurn` **保持 1**（冻结值不动，两套探针不受影响）；
  **本 bundle 的 patch 显式设为 2**，即"装了就带二次升级"。
- **判定纪律**：`count >= maxCorrectionsPerTurn` 时一律不注入；tier 2 只改文案、不放宽任何条件。
- **诚实标注**：tier 2 的**有效性尚未在真实故障中观测到**（它是由上面那次"一次没拦住"的证据所驱动）。

**裁定 R14（2026-10-30）—— 标签方言：容忍可选的命名空间前缀（缺陷 D-10，真实故障驱动）：**

- **现场证据**：在一个真实用户会话（fork 出来的 `session-c8741511`）里，模型把调用信封吐成
  **带命名空间前缀**的形式 —— `<antml:invoke name="…">` / `<antml:parameter name="…">` / `</antml:…>`。
  这些串里**没有**裸 `<invoke` / `<parameter` 子串，所以**每一条结构规则都静默漏过**：
  `damaged = false` → `silentFailure = false` → **M4 一次都没注入** → turn 静默关闭。
  这不是 M4 的机械失效，而是**检测覆盖缺口**。
- **修法（`normalizeNamespaces`）**：结构分析改跑在**去前缀的影子副本**上 ——
  `LT + '(\/?)' + '([A-Za-z_][A-Za-z0-9_.-]*):(?!\/)'` → `LT + '$1'`。
  **不含冒号的文本返回同一字符串**（早退 + 同引用），因此既有行为**无法漂移**。
  数值证据（行数 / 字符数 / `</` 计数）**仍取自原文**；`at` 偏移可能因剥前缀而略有偏移（仅诊断用）。
  作用域：`scanAssistantText` 与 `scanToolArguments` 的结构检查（尾部连续结束序列、配对、截断）；
  `sanitizeMessages` 因为调用 `scanAssistantText` 而**自动继承**。
- **护栏必须保持**：`(?!\/)` 排除 URL（如 `<http://x/>`）；标识符必须以字母/下划线开头；
  R4 的 deny 双门槛、R6 的"起头"门槛（现在也接受带前缀的开场标记）、以及"参数叶子上 `UNPAIRED_CLOSING_TAG`
  一律降为 info"**全部不放宽**。
- **语料级验收（不变量，不是快照）**：把全部真实会话的每条文本**同时**跑修复前 / 修复后的检测器，
  差异**恒为 1 条** —— 正是上面那个 fork 会话（`session-c8741511`）。
  其余 damaged 都发生在插件存在之前（时间线吻合），本次修复精确补上了现实中真正撞到的那一类。
  ⚠️ **绝对总数不能当基线**：会话日志是 append-only，连验证过程本身都会写进去，总数会持续增长。
- **教训（写进 README）**：真实失败至少存在**三种标签方言** —— 裸标签（`<invoke`）、
  带命名空间前缀（`<antml:invoke`）、以及**完全没有信封**的正文泄漏（V3）。检测器现在容忍可选前缀。

**裁定 R15（2026-10-30）—— D-11：伪造的工具结果标记（自称有结果、其实没有调用）**

- **现场证据**：真实会话 `session-929b19b0` 的 turn 25 step 5 —— 该步 `toolCallCount === 0`，
  正文却是"`LT` + `tool_result>` + `v24.12.0 dirs ok` + `LT` + `SLASH` + `tool_result>`"（43 字符）。
  即模型**报告了一个从未获得的工具结果**，还带上了具体版本号 —— 比静默 no-op 更危险：它是**假事实**。
  当时检测器只认 `invoke` / `parameter` 标记，该步判 `damaged=false`，M4 毫无反应
  （且该 turn 的限次当时也已用尽）。
- **规则（新增一个检测面，不新增 code）**：`scanAssistantText` 增加一条 —— 经
  `normalizeNamespaces` 后的文本里出现**结果形状的开场标记**
  （`RESULT_OPEN_RE` = `LT` + `'tool[-_]?result(?![A-Za-z0-9:_-])'`，容忍命名空间前缀与 `-`/`_` 变体）
  → 报 `MARKUP_LEAKED_AS_TEXT`（error），detail 明确写"工具结果形状的标记出现在正文里"。
  **复用既有 code，故 `FindingCode` 集合不变。**
- **不依赖 `meta`**（R1 纪律：meta 只决定 `silentFailure`），**也不要求自然语言句子**
  —— 现场 payload 就是 43 字符的纯标记加一个伪造的版本号。
- **影响面收口**：当该步**确有**工具调用时，`damaged` 仍为 true，但 `silentFailure` 为 false
  → **M4 不会注入**；护栏亦已验证：只提及字段名（不带尖括号标签）不误报。
- **作用域仅限 assistant 文本**：`scanToolArguments` **不**加入该规则 ——
  否则"写一份解释该格式的文档"会被 deny（正是 D-1 那一类误报）。

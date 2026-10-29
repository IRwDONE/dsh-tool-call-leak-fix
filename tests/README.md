# tests/ —— 「结构化输出守卫」纯函数测试台

- 被测对象：`plugin/src/detect.js`（ESM、零依赖、纯函数）
- 冻结契约：[docs/INTERFACE.md](../docs/INTERFACE.md)（含裁定 R1–R12 与 D-0/D-1）
- 判据来源：[docs/DESIGN.md](../docs/DESIGN.md) §6「可测量的成功判据」、§7「测试台」

## 怎么跑

```bash
node tests/run.mjs              # 主运行器（ESM）
node tests/run.js               # 等价入口（CommonJS，仅动态 import run.mjs）
node tests/check-fixtures.mjs   # 回读 fixtures 做完整性/配平诊断（作者工具，不参与验收）
```

- 逐条打印 `PASS <id>` / `FAIL <id> -- <原因>`，末尾打印 `PASS n / FAIL m` 与失败明细。
- **退出码**：全部 PASS → `0`；任一 FAIL、或被测实现缺失/导出不全 → `1`。
- 零依赖：只用 node 内置模块（`node:fs` / `node:path` / `node:url`），**不安装任何东西**。
- 若 `plugin/src/detect.js` 还不存在或导出不全：不会抛栈，而是打印一段 `[BLOCKED]` 报错
  （期望文件绝对路径、期望导出清单、重跑命令），仍以退出码 `1` 收尾。
- 本测试台不依赖 DSH 运行时，也不修改 `plugin/`；只读三个文件：`plugin/src/detect.js`（A–L、N、O 组断言）、`plugin/index.js` 与 `plugin/README.md`（M 组静态 / 文档断言）。

## 目录

| 路径 | 用途 |
| --- | --- |
| `run.mjs` | 主运行器：A–O 组全部断言（唯一权威断言集） |
| `run.js` | 兼容入口：转发到 `run.mjs`，逻辑只此一份，避免两份断言漂移 |
| `check-fixtures.mjs` | 回读每个 fixture，打印 字节数 / 行数 / 闭合标签计数 / 逐 tag 配平，用于抓「长 payload 写入被静默截断」 |
| `fixtures/` | 回放语料：3 个正例 + 5 个反例（纯文本 `.txt`） |

## 断言 ↔ DESIGN §6 判据映射

| DESIGN §6 判据 | 目标 | 本测试台的断言 |
| --- | --- | --- |
| 检测召回 | 3/3 变体被识别 | B 组（`B1`/`B1b`/`B2`/`B3`） |
| 误报 | 正常代码/HTML/长文本 0 误报 | C 组 + fixtures 自检 `A4`/`A5` |
| 静默失败归零 | 损坏时 turn 不静默结束 | D 组（`silentFailure` 精确公式 + meta 不影响 findings） |
| 额外开销 | 每次纠偏 ≤ 1 次请求、有上限 | 属 `plugin/index.js` 的运行时计数，纯函数层测不到；本台覆盖其**触发条件** `silentFailure` |
| 幂等 / 安全 | 不破坏正常调用；deny 必带可操作 reason | E5/E11（deny 必带 reason）、J 组（幂等）、I7/I8（引用隔离与不改入参）、E9 |
| 假成功 / 空转（DESIGN §5 M3） | 真·空转要抓；普通结果不得误判 | N 组（`N1`–`N8`）+ F 组返回形状 |
| 上下文净化（DESIGN §5 M5） | 损坏的 assistant 文本被换掉；真实调用/健康内容/其它角色不动 | O 组（`O0`–`O13`） |

## 裁定 ↔ 断言映射

| 裁定 | 内容 | 断言 |
| --- | --- | --- |
| R1 | 静默失败标志唯一名为顶层 `silentFailure`，公式 `damaged === true && meta.hasToolCalls === false` | `D1`（5 种 meta）/`D2`/`D3`（无同义字段）/`D4` |
| R2 | 结束序列只认 `INVOKE_END`（不是 `PARAM_END`），只看**尾部连续段** | `B1b[V1]`/`B2`/`C2`/`E5` |
| R3 | `mergeConfig(null/undefined/数组/函数/`Date`/`Map`/敌意代理)` → 不抛异常 + 完整默认值浅拷贝 + 未知键忽略 + 不与 `DEFAULT_CONFIG` 共享可变引用；**措辞修正**：原型链为 `Object.prototype` / `null` 即按普通对象处理（**含透明代理**） | `I2`–`I8`/`I13`/`I14` |
| R4 | 参数叶子 `deny` 需同时满足「命中 `END_SEQUENCE_MULTIPLIED` 或 `TRUNCATED_PAYLOAD`」且「叶子 ≥2000 字符或 ≥20 行」；参数叶子 `UNPAIRED_CLOSING_TAG` 恒为 `info` | `E5`/`E6`/`E12[N1]`/`E12[N1b]`/`E12[N2]`/`E13` |
| R5 | `FindingCode` 增补 `INTERNAL_ERROR`（`info`、恒不导致 deny、`detail` 形如 `internal-error: ...`、此时 `reason` 为空串）；`SUSPICIOUS_NOOP_RESULT` 只表示 §3 的真实空转嫌疑 | `L0`（9 个 code 与文档一致）/`L2`（`scanToolResult` 内部异常降级）/`L4`（`SUSPICIOUS_NOOP_RESULT` 不得出现在 args/assistant 结果里） |
| R6 | `TRUNCATED_PAYLOAD` 的配对走查只在本叶子呈**调用形状**时执行；「调用形状」= 叶子**以开场标记起头**（忽略前导空白），**同时接受** `INVOKE_OPEN` 与 `PARAM_OPEN` 两种起点；方向写反（按"最后一个 token"判定）会同时造成漏报与误报，故断言必须成组锁方向 | `E12[N1]`（`docs/DESIGN.md` 全文不得 deny）、`C3`/`E6`、`M4[R6a]`/`M4[R6b]`/`M4[R6c]`/`M4[R6d]`（方向用例）、`M4[R6-meta]`（用例集必须方向可区分）、`M5`（整轮至少产生过一次） |
| R7 | 数值门槛必须 **≥1**：`maxLines` / `maxChars` / `closingTagCount` / `endSequenceRepeats` 取 `0`（以及负数 / 非整数 / 非有限数）一律回退默认；**例外** `maxCorrectionsPerTurn` 允许 `0`（= 关闭自动纠偏） | `I9`/`I10`/`I11`/`I12`（端到端：`{endSequenceRepeats:0}` 不得判 `END_SEQUENCE_MULTIPLIED`） |
| R8 | 字符串叶子遍历有界：最多 **200** 个叶子、最大**深度 24**；该边界必须显式写进 `plugin/README.md` | `M3` |
| D-0 | 注入消息的 `source` 不得用被 v4 会话格式拒绝的 `kind:"plugin"`，必须是 `runtime-context` 或 `plugin:<pkg>`（`<pkg>` = `plugin/package.json` 的 `name`） | `M1`/`M2`（剥离注释后静态读 `plugin/index.js`；含调用点与 `<pkg>` 一致性校验） |
| R9 | 新增布尔配置 `noopCheck`（默认 `true`）= M3「疑似空转」检测的 kill switch；非布尔回退默认；`false` 时 M3 整体关闭。**自由文本短语匹配已删除**：只有机器可读证据（`written:0`、`unchanged:true`、`status:'no_changes'` 等枚举值）才算空转 | `I15`（默认/采纳/非布尔回退）、`N1`/`N2`/`N7`（自由文本不得误报）、`N3`/`N4`/`N7`（真空转仍抓）、`N5`（kill switch）、`N6`（非写类 / isError / 空 result 不报） |
| R10 | 新增 `debugLog: boolean`（默认 `false`）与 `debugLogPath: string`（默认 `''`，空串由系统临时目录推导）：`debugLog !== true` 时 logger 直接返回空函数（零开销、零副作用） | `I1`（默认值）/`I2`（键集合）——**logger 的运行时行为在 `plugin/index.js`，纯函数层不可测**（见「已知边界」） |
| R12 | M5 上下文净化：新增纯函数 `sanitizeMessages(messages, opts)` + `contextGuard: boolean`（默认 `false`）+ `contextGuardNote: string`（默认 `''`，空串=内置本地化注记）→ `DEFAULT_CONFIG` 12 键。只改 `role:'assistant'` **且无 tool-call 块** **且** `scanAssistantText(...).damaged === true` 的消息；改写为单个 text 块（注记），其余字段保留；未改动消息复用原引用、`changed:false` 返回原数组引用；非数组/畸形/循环/Proxy 一律 `changed:false` 不抛；注记与 `rewrites` 不得含 payload | `O0`–`O13` |

## 正例清单（fixtures/）

| 文件 | 变体 | 形态 | 期望 |
| --- | --- | --- | --- |
| `v1-end-multiplied.txt` | V1 结束序列增殖 | 真实调用形态：参数体是含约 40 个闭合标签的 HTML，**尾部连续 4 组 `INVOKE_END`** | `damaged:true`，命中 `END_SEQUENCE_MULTIPLIED`（`evidence.endSequenceRepeats >= 2`） |
| `v2-missing-opening.txt` | V2 开场序列缺失 | 只有参数开场标记与 `PARAM_END`，整段没有调用开场标记 | `damaged:true`，命中 `MISSING_OPENING_MARKUP` |
| `v3-leaked-markup.txt` | V3 正文泄漏 | 调用标记**混在自然语言正文里**（前后都有中文句子） | `damaged:true`，命中 `MARKUP_LEAKED_AS_TEXT`（`evidence.leakedMarkup === true`） |

V1/V3 的 payload 里各埋了一个 canary（`CANARY_V1_PAYLOAD_7f3a` / `CANARY_V3_PAYLOAD_2b91`），断言 `findings` / `evidence` / `reason` / 纠正文案都**不得**包含它（防止损坏内容被复制传播）。

## 反例清单（fixtures/，必须零误报）

| 文件 | 类型 | 为什么必须不误报 |
| --- | --- | --- |
| `ok-normal-html.txt` | 合法 HTML，约 40 个闭合标签、逐 tag 配平 | 闭合标签密度本身不是故障——只有调用标记/结构异常才判 |
| `ok-normal-js.txt` | 正常长 JS，>100 行（含 `<` 比较、模板字符串） | 长 payload 且无闭合标签，不得因「长」误报 |
| `ok-normal-markdown-table.txt` | Markdown 表格 + 说明文字 | 纯文本，无任何标记 |
| `ok-short-text-few-tags.txt` | 短文本 + 3 个配平内联标签 | 闭合标签数远低于警戒线，且逐 tag 配平 |
| `ok-single-end-sequence.txt` | 结构完好的调用，尾部恰好 1 个 `PARAM_END` + 1 个 `INVOKE_END` | R2：合法收尾不得被判 `END_SEQUENCE_MULTIPLIED` |

## 运行时构造的样例（不落盘，避免 fixture 与门槛耦合）

- `E2`/`E3`/`E4`：超长叶子（150 行 / 25000 字符 / 嵌套 object-array）→ `PAYLOAD_TOO_LONG`(warn) → `flag`
- `E5`：**大 payload**（≥2000 字符）+ 尾部连续 `INVOKE_END`×3 → `END_SEQUENCE_MULTIPLIED` → `deny`
- `E6`：大 payload 尾部是未闭合的调用/参数结构 → `TRUNCATED_PAYLOAD` → `deny`
- `E7`：配平但闭合标签密集的 HTML 叶子 → `CLOSING_TAG_DENSITY`(info) → `flag`（不 deny）
- `E8`：抬高 `maxLines`/`maxChars` 后不再 `PAYLOAD_TOO_LONG` → `ok`
- `C3`：合成截断样例 → `TRUNCATED_PAYLOAD`（DESIGN §1.3 证据 B 的「尾部丢失」形态）
- `E12[N1]`：**直接读 `docs/DESIGN.md` 全文**当叶子（它本身就是「解释本故障」的文档，正文里天然含闭合标签与调用标记片段）→ **不得 deny**
- `E12[N1b]`：200–400 字小文档 + 1 个孤立 `INVOKE_END` → 不得 deny
- `E12[N2]`：≥2000 字符 + 尾部连续 `INVOKE_END` → 必须 deny
- `E13`：大 payload + 孤立 `INVOKE_END` → `UNPAIRED_CLOSING_TAG` 为 `info` 且永不导致 deny

## 内建自检（L 组）

- `L0`：`FindingCode` 集合必须与 `docs/INTERFACE.md` 冻结集合一致（**9 个**，R5 增补 `INTERNAL_ERROR`）。
- `L1`：一批畸形/敌意输入（Proxy 全 trap 抛错、抛错 getter、`Object.create(null)`、循环引用、Symbol、30000 字符超长单行、400 行 CRLF 混排）跑三个函数 → 不抛异常、`action !== 'deny'`、**info-only 组合不得产生 deny**、非 deny 时 `reason` 为空；并对「该 deny 的样本」反向校验 `deny ⟹ 存在 error 级 finding`。
- `L2`：`scanToolResult` 遇内部异常 → `suspicious:false`、`reason` 为空串、`findings` 形状合法。
- `L3`：`scanAssistantText` 遇非法/敌对入参 → 不抛异常、`damaged:false`。
- `L4`：`SUSPICIOUS_NOOP_RESULT` **只允许出现在 `scanToolResult`**（R5）；`scanToolArguments` / `scanAssistantText` 的结果里一律不得出现。

## 静态 / 文档断言（M 组）

- `M1`/`M2`（D-0）：读 `plugin/index.js` 源码，**先剥离注释**再做静态断言（解释「旧形状为什么被拒绝」的注释是有价值的文档，不该被误伤）：代码区不得出现旧 `source` 形状 `kind:'plugin'`（`dsh-session-format-v3-to-v4` 会抛 `SessionFormatError`，可能弄坏用户会话）；`source: Object.freeze({ kind: <expr> })` 里的 `<expr>` 不得是字面量 `plugin`；代码区必须同时提供 `runtime-context` 与 `plugin:<pkg>` 两种 producer-owned kind，且 `<pkg>` 必须与 `plugin/package.json` 的 `name` 完全一致；所有 `pluginMessage()` 调用点都必须传这两种 kind 之一。
- `M3`（R8）：读 `plugin/README.md`，断言写明「≤200 个叶子 / 深度 24」的遍历边界。
- `M4[R6a]`（起点之一）：以 `PARAM_OPEN` 起头、停在开场标记内、≥2000 字符 → `TRUNCATED_PAYLOAD` → `deny`。**注意：它在"以开场标记起头"与"最后一个 token 是开场标记"两种判据下结论相同，单独存在时锁不住方向**（D-1 教训），保留为基线。
- `M4[R6b]`（**漏报方向**）：以 `INVOKE_OPEN` 起头、外层信封永不闭合、文本**以 `PARAM_END` 收尾** → 必须 `TRUNCATED_PAYLOAD` + `deny`（反向判据会认为"最后是结束标记 ⇒ 不是调用形状"而漏报）。
- `M4[R6c]`（**误报方向**）：普通 HTML 起头、**尾部才出现**未闭合的带属性开场标记 → 必须**不** deny、**不**出现 `TRUNCATED_PAYLOAD`（反向判据会认为"最后是开场标记 ⇒ 调用形状"而误报；这也是"文档里引用一次开场标记"不得触发配对走查的守卫）。
- `M4[R6d]`（**非空白门槛**）：前导换行后再以 `INVOKE_OPEN` 起头、信封不闭合 → 必须命中（对应契约的「首个**非空白**结构标记」）。
- `M4[R6-meta]`（**方向可区分性自检**）：测试内实现"正确判据"与"反向判据"两个谓词，断言 R6b/R6c/R6d 在两者下结论**不同**、漏报侧与误报侧各至少一条，且 R6a 这类基线用例**本就相同**。若日后有人把用例换成"两种判据都绿"的样本，这条会自己变红。
- `M5`（R6）：整轮测试累计产生过的 `FindingCode` 里必须出现 `TRUNCATED_PAYLOAD`（拒绝死代码）。

## I 组补充（R7 / R3 措辞修正）

- `I9`–`I11`：`0` / 非整数（`10.5`）→ 回退默认；`maxCorrectionsPerTurn:0` 例外，保留 `0`。
- `I12`：`scanAssistantText(..., {endSequenceRepeats:0})` 不得判 `END_SEQUENCE_MULTIPLIED`（除普通文本外，另用「合法收尾」fixture 做强校验：若 `0` 被采纳则任何输入都会命中）。
- `I13`/`I14`：透明 Proxy 按普通对象处理（键被采纳）；`Date` / `Map` / 敌意 Proxy → 不抛异常且回退完整默认值。
- `I15[R9]`：`noopCheck` 默认 `true`；`{noopCheck:false}` 被采纳；`'no'` / `0` / `1` / `null` / `undefined` / `{}` / `[]` 等非布尔一律回退默认 `true`。
- **键集合不再硬编码**：`I2`/`I14` 的期望键集合从被测 `DEFAULT_CONFIG` 推导（`Object.keys(DEFAULT_CONFIG).sort()`），新增 config 键自动跟随、不再误红；值仍按 `DEFAULTS` 逐字段冻结断言，`I3` 保证未知键仍被忽略。

## M3 空转检测（N 组 / R9）

背景：M3 的自由文本短语匹配在真实会话里误报 4 次（把 git status 的 `nothing to commit`、说明文里的 `unchanged` 当成静默空转），并往对话注入了"该步未执行任何操作"。R9 删除自由文本匹配、只保留机器可读证据，并加 kill switch `noopCheck`。

- `N1`（**误报回归**）：6 个"普通结果"（git status 式 `stdout` + `content[].text`、`note:'leaving that text unchanged'`、`summary:'no changes were necessary'`、`message:'本次未做任何改动…'`、`status:'no changes'` 这种自由文本、大小写/换行混排）→ 一律不得 `suspicious`。
- `N2`（**核心**）：git status 式结果**即使 args 带长 payload**（≥5000 字符）也不得 `suspicious`。
- `N3`（**真空转仍抓**）：`{isError:false, value:{written:0}}` + args 带 payload → 必须 `suspicious`、命中 `SUSPICIOUS_NOOP_RESULT`、并给出可读 `reason`。
- `N4`：布尔显式空转标志 `{unchanged:true}` → 必须 `suspicious`。
- `N5`（**kill switch**）：同一真空转在 `{noopCheck:false}` 下必须**不** `suspicious` 且**立即返回 `findings: []`**（R9 冻结的返回形状），默认（开）下必须 `suspicious`——证明差异只来自开关。
- `N6`（**宁漏勿扰**）：非写类工具名（`read`/`grep`）、`isError:true`、`result:null` → 不报。
- `N7`（**方向对照 / 方向锁**，复用 D-1 教训）：同一措辞下，机器可读证据（`status:'unchanged'`、`status:'no_changes'`、`noop:true`、`skipped:true`、`applied:false`、`written:0`）必须判 `suspicious`；自由文本/正常值（`note:'unchanged'`、`summary:'no changes'`、`text:'未做任何改动'`、`status:'no changes'`、`written:5`）必须**不**判。把自由文本匹配加回来会立刻变红。

- `N8`（**文案隔离**）：suspicious 时 `reason` 必须是 M3 语义（说明"工具自报未产生改动"），**不得复用 B 段**（不得出现 `结构校验失败` / `自动纠正` / `未执行任何操作` / `该步未执行` / `参数边界`，且 `reason !== buildCorrectionMessage(findings)`）。这正是本次事故的根因（M3 借用 M4 的 B 段文案 ⇒ "说未执行、其实执行了"）。

## M5 上下文净化（O 组 / R12）

R12 新增纯函数 `sanitizeMessages(messages, opts)` → `{changed, messages, rewrites:[{index, codes}]}`。作用域刻意很窄：只把"已经损坏的 assistant 文本"从模型可见历史里换掉（用于补救被带坏的对话），默认开关 `contextGuard:false`。

- `O0` 前置：两个损坏样本（V2 形态 → `MISSING_OPENING_MARKUP`；V3 形态 → `MARKUP_LEAKED_AS_TEXT`）确实 `damaged:true`，健康样本不 damaged。
- `O1`（**改写**）：assistant + 无 tool-call + V2 损坏 → `changed:true`；`content` 变**单个 text 块**、注记非空；**不含原 payload 正文**（canary）；`rewrites[0].index === 1`、`codes` 含预期 code；`id`/`role` 保留；未改动消息**复用原引用**；且**入参未被修改**。
- `O2`：V3 正文泄漏形态同样被改写，`codes` 含 `MARKUP_LEAKED_AS_TEXT`。
- `O3`（**保护真实调用**）：同形态损坏但消息**含 tool-call 块** → `changed:false` + **原引用**。
- `O4`（**不动健康**）：正常文本 → `changed:false` + **原引用**。
- `O5`（**不动其它角色**）：`user` / `tool` / `system` 永不改写（即使文本损坏）。
- `O6`（**默认关**）：`contextGuard` 缺省 / `{}` / `false` / `'true'` / `1` / `null` → 永不改写且原引用；空数组也走原引用。
- `O7`（**配置**）：`contextGuard` 非布尔回退 `false`；`contextGuardNote` 自定义保留、`''`=内置（值仍是 `''`）、非字符串回退 `''`。
- `O8`：`contextGuardNote` 非空时改写文本**等于该注记**。
- `O9`：缺省注记按 `lang` 出中文 / 英文（zh 含 CJK、`lang:'en'` 不含 CJK），且不含 payload。
- `O10`（**索引与引用**）：多消息混合（健康 / 损坏 / user / 损坏 / tool-call）→ `rewrites.index === [1,3]`、未改动消息复用引用、被改写的是新对象、tool-call 消息不动。**注意**：`role:'user'` 的消息按设计原样保留（窄作用域），故"不得含 payload"只针对被改写消息与 `rewrites`。
- `O11`：幂等（同输入两次 `JSON.stringify` 一致）。
- `O12`：非数组 / `null`/畸形元素 / 循环引用 / 数组 Proxy / 敌意 Proxy → 不抛异常；畸形集合 `changed:false`，循环引用中的损坏 assistant 仍能改写。
- `O13`：返回值形状恒定（`changed:boolean` + `messages` + `rewrites` 数组，元素含 `index:number` / `codes:string[]`）。

**边界说明（有意不覆盖）**：结构化字段里的**精确枚举值**仍会被判空转（如 `value.status === 'unchanged'`、`value.status === 'no_changes'`、`value.noop === true`）——这是实现刻意的"机器可读证据"，与被删除的自由文本匹配不同。本台**不**断言这些为"不得 suspicious"；只断言同一措辞放进自由文本位置时不得误报（`N7` 两侧成对）。

## 有意未覆盖 / 已知边界

- `scanToolResult` 的「假成功 / 空转」**正向**判定已按 R9 覆盖（`N3`/`N4`/`N7`：`written:0`、`unchanged:true` 与结构化枚举值）；但**证据集合的边界**（哪些键名/取值算"机器可读证据"）没有被契约逐一冻结，本台只锁「自由文本不得误报 + 上述几类显式证据必须抓」这个方向，不穷举键名（新增键名不会误红，也不会因漏测而被当成"已覆盖全部"）。
- **`INTERNAL_ERROR` 降级路径的覆盖范围（已知盲点，非"已通过"）**：`scanToolArguments` / `scanAssistantText` 的实现是逐节点防御式 try/catch，上面那批畸形/敌意输入**不会让异常穿到外层降级分支**，因此这两个函数的 `INTERNAL_ERROR` 分支**无法从公开 API 稳定触发**（属防御性死代码）；`L1` 对这些输入断言的是**可达不变式**（不抛异常、恒不 deny、info-only 不产生 deny、非 deny 时 reason 为空），而不是"必然出现 `INTERNAL_ERROR`"。实测 `scanToolResult` 的同一降级分支**可以**被稳定触发（`L2` 覆盖，`reason` 为 `''`），说明该机制本身可用。
- DESIGN §5 的 **M4 机制**（「每次纠偏 ≤1 次模型请求 / `maxCorrectionsPerTurn` 上限」）属 `plugin/index.js` 的运行时行为（事件计数），纯函数层测不到；本台只覆盖其触发条件 `silentFailure`。
- R12/M5 的**挂点行为**（`plugin/index.js` 在 `llm/stream` waterfall 里**原地**改写 `options.messages`、改写导致该前缀 prompt cache 失效等）属宿主侧行为，纯函数层测不到；本台只覆盖 `sanitizeMessages` 的纯函数语义。R10 的 logger 运行时行为（关闭时零开销、空 `debugLogPath` 由系统临时目录推导）同理，只由 `I1`/`I2` 钉住默认值与键集合。
- 端到端真实会话验收按 DESIGN §7 后半另做，不在本目录。

## 作者纪律（本目录自身遵守）

- **分块写入 + 回读校验**：fixtures 采用多分块写入并逐块 `read` 回读，`check-fixtures.mjs` 再回读一次做完整性/配平诊断。
- 本目录的 `.js` / `.mjs` **不书写连续的字面闭合标签**：需要时一律拼接构造（`T()` / `TE()` / `TA()`、`C_END` / `C_PARAM_END`）。
- 断言按 `docs/INTERFACE.md` 逐条写死，**不为让实现通过而放宽**；测试变红 = 被测实现问题或接口歧义（报 lead），不放宽断言、也不改被测实现。
- **判据的方向性必须可区分（D-1 教训）**：R6 的「叶子以开场标记起头」曾被实现反写成「最后一个 token 是开场标记」，而当时的 `M4`（`PARAM_OPEN` 起头、停在开场标记内）在两种判据下结论**相同** → `150 PASS / 0 FAIL` 全绿却没抓到。现在用 `M4[R6b]`（漏报方向）与 `M4[R6c]`（误报方向）成组锁死，并加 `M4[R6-meta]` 在测试内验证「可区分方向的用例在正确/反向判据下必须给出不同结论」。**写任何断言前先问：把判据反过来写，这条还绿吗？如果还绿，它就锁不住这个判据，必须补反向用例。**
- 退出码自检记录：曾把 `G1` 的期望值临时改错跑过一次，确认 `FAIL 1` 时退出码为 `1`（当时 134 条断言 → `PASS 133 / FAIL 1`）；改回后当前为 `PASS 182 / FAIL 0`、退出码 `0`。

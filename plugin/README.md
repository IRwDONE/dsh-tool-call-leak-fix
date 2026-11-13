# dsh-tool-call-leak-fix

Host 插件。针对**工具调用参数边界丢失**（模型侧结构化输出退化）做「检测 → 显式失败 → 同一 turn 内自愈」。

- 包名：`@irwdone/dsh-tool-call-leak-fix`（与 GitHub 仓库 `IRwDONE/dsh-tool-call-leak-fix` 同步）；版本 **0.5.1**；patch 行 id：`tool-call-leak-fix`；仅 Host 半边（无 client 资源）。
  > **确认本地插件是否更新**：看插件管理器里这个 bundle 的**版本号**；或直接看 profile 的
  > `node_modules/@irwdone/dsh-tool-call-leak-fix/package.json`（本机是 `link:`，指向**本仓库根**）。
- 依赖：**零依赖**、零构建、纯 JS（ESM）。检测核心 `src/detect.js` 是纯函数，可在普通 node 下直接跑。
- **兼容性（2026-11-13 实测）**：在 **DSH 0.2.2-rc.3** 上通过 —— 模块正常 `apply`；**M2 现场拦下**过一次真实损坏调用；`session.append`/`SurfaceOp`/`SurfaceIntent`/`PreStepDecision`/`tools/pre-execute`/`tools/post-execute`/`agent/pre-step`/`agent/turn-stopping`/`session/event`/`Config['~standard']`/`dsh.bundle.patch` 契约逐条比对未变。M4 端到端（损坏步骤 → 注入纠正 → 模型同 turn 重发调用）、M7 简报、M9 修复是在 **0.2.2-rc.1** 上观测的，rc.3 上这些接缝未变；0.2.1-rc.5 亦通过。

## 它做什么

**只在代码层做事，不往提示词里塞任何东西。**

1. **拦截**：分发前扫描已解析的参数；命中「边界丢失」时**拒绝执行**并给出可操作原因（C 段）。
2. **纠偏**：工具跑完后若发现「自报成功但其实什么都没做」，补一条纠正上下文（M3 自己的文案）。
3. **自愈**：模型把调用信封当成正文吐出来（静默 no-op）时，在 turn 即将关闭的那一刻注入纠正，让模型在**同一个 turn 内**按小块重发。
4. **净化（已停用，代码保留）**：M5 原本想在对话被带坏之后，把历史里**已损坏且没有真实工具调用**的 assistant 文本换成一句中性注记，从**模型可见历史**里移除"坏样本"，打断自我模仿。
   **但这台 harness 做不到**：`agent-loop` 交给 `llm/stream` 的请求是**深度冻结**的（D-8，证据见下），改写写不进去 —— 即**接缝是只读的**。
   按用户决策（2026-10-29）：**移除接线与公开开关，保留实现代码**（`src/detect.js` 的 `sanitizeMessages`，纯函数、已被独立验证覆盖）；将来 harness 给出可写接缝时，按 `index.js` 里那段注释重新接线即可。

## 3 个在用机制（+ M5 已停用）

| 机制 | 接缝（已核实） | 行为 |
| --- | --- | --- |
| **M2** 分发前扫描 | `tools/pre-execute` waterfall `(exec, next)` | `scanToolArguments` 判 `deny` → 返回 `{kind:'deny', reason}`（C 段）；**其它情况一律 `next()`**，不接管别人的决策 |
| **M3** 结果后纠偏 | `tools/post-execute` waterfall `(exec, result, next)` | 先 `await next()` 保留他人决策，再**只做加法**：`{...decision, additionalContexts:[...(原样保留), 纠正消息]}`；`scanToolResult` 不 suspicious 时原样返回 |
| **M4** 静默失败自愈 | 观察 `session/event` 的 `assistant/message`；纠正 `agent/turn-stopping` | 从 `message.content` 取 text 块与 `tool-call` 块 → `scanAssistantText(text, cfg, {hasToolCalls})`；**只认 `silentFailure`** → turn-stopping 时 `agent.inject(message)`（落在 `next-step`，turn 不关闭） |
| **M5** 上下文净化 | ~~`llm/stream`~~ → **接线已移除（2026-10-29）** | 设计：判定"已损坏且**无** `tool-call`"的 assistant 消息并替换 `options.messages`。**实测写不进去**：请求被 `Object.freeze`（`dsh-agent-loop/lib/index.js:1281`；`:1280` 冻数组、`:1277` deepFreeze 每条消息），严格模式下赋值抛 TypeError → **接缝只读**（D-8）。**现已不注册该监听器**；`sanitizeMessages` 保留在 `src/detect.js`，重新接线的完整做法写在 `index.js` 的注释里 |

### M4 为什么必须用 `agent.inject`

`agent/turn-stopping` 是 serial 事件，被 `await`。监听器返回后 agent-loop 会**再次判空** `inbox.nextStep`；只要监听器里 `inject` 了一条 `next-step` 消息，判空不成立 → turn 不 break → 模型在同一 turn 再跑一步。用 `followup` 会落到 `next-turn`（turn 关闭后另起一轮），所以不用它。

`inject` 的消息是本插件自己构造的 `UserMessage`：`{id, role:'user', content:[{type:'text',text}], source:{kind:...}}`。`source` 必须自带 —— 省略会被当成人类消息（权限升级），插件不得继承人类身份。

**`source.kind` 绝不能写 `'plugin'`**：v4 会话格式校验显式拒绝它（`dsh-session-format-v3-to-v4/lib/index.js:126`：`format v4 message requires a producer-owned source kind`），而 `assertV4MessageSources` 覆盖每个持久消息槽（含 `user/message`、`agent/inbox/spliced`）—— 一旦注入消息落进日志，**读取该会话就会抛错**。本插件因此使用「生产者自有」的 kind：

| 机制 | `source.kind` | 理由 |
| --- | --- | --- |
| **M4**（turn-stopping 自愈） | `runtime-context` | 框架的运行时上下文 kind（`producerKind()` 同文件 87–92 行），语义就是"注入的上下文" |
| **M3**（结果后纠偏） | `plugin:@irwdone/dsh-tool-call-leak-fix` | 第三方插件的生产者 kind 形式 `plugin:<package name>`；必须与 `package.json` 的 `name` **逐字一致** |

`id` 用 `crypto.randomUUID()`，等价于框架 `createUserMessage()` 的 `brandString(randomUUID())`（本插件无法 import `@deepseek-ai/dsh-llm`，故自行 brand）。

> **状态：未运行时证实。** 这两个 kind 是按 v4 校验器与 `producerKind()` 的源码推出的，verifier 无法在真实 turn 里注入验证；真实 `install_bundle` + 一次端到端 turn 回放才能证实。

## V4：参数被「静默清空成 `{}`」

某些容错 JSON 解析路径对非法 JSON **不抛错**，最终返回 `{}`，于是工具带着空参数执行（又是一种静默 no-op）。M2 里额外处理：当 `arguments` 为空对象/空值、**且该工具 schema 声明了非空 `required`** 时，deny 并说明「参数疑似被容错解析器清空为 `{}`，本次未执行，请重发」。
`required` 从 `exec.schema.parameters.required` 取，取不到时回退到 `ctx.tools.get(name)`（scoped ToolRuntime）。**`required` 为空的工具一律放过**，不会误伤真正无参数的工具。

## Config 字段

`plugin/cordis.patch.yml` 的 `config` 会被读取；非法值由 `mergeConfig` 回退默认（不会抛错）。数值字段一律要求**整数**：`0` / 负数 / 非整数（如 `2.5`）/ `NaN` / `±Infinity` / 字符串 → 回退默认；唯一例外是 `maxCorrectionsPerTurn` 允许 `0`（= 关闭自动纠偏）。（裁定 R7：`0` 会让 `>= threshold` 恒真，例如 `endSequenceRepeats: 0` 会把任何输入都判成结束序列增殖。）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时**不注册任何监听器**（等价于关闭插件，改后需重新激活/重启） |
| `maxLines` | `100` | 单个字符串叶子的行数上限（`PAYLOAD_TOO_LONG` warn 阈值；同时决定 prevent 区块里的行数） |
| `maxChars` | `20000` | 单个字符串叶子的字符数上限 |
| `closingTagCount` | `8` | 闭合前缀（`<` + `/`）出现次数达到该值算「密集」，是 `CLOSING_TAG_DENSITY`(info) 的证据阈值（**不**参与 deny 判定） |
| `endSequenceRepeats` | `2` | **尾部连续**结束序列个数阈值（`END_SEQUENCE_MULTIPLIED`） |
| `maxCorrectionsPerTurn` | `1` | 每个 turn 最多自动纠偏次数（按 session+turn 计数，防循环） |
| `lang` | `zh` | `zh` / `en`，决定注入文案与 deny 原因的语言 |
| `noopCheck` | `true` | **R9**：M3 空转检查的总开关。`false` 时 `scanToolResult` 直接返回 `suspicious:false`，M3 永不注入 |
| `contextGuard` | `false` | **R12（内部保留，未接线）**：M5 的门控键。**它不在 `plugin/cordis.patch.yml` 里暴露** —— 该 harness 的 `llm/stream` 接缝只读（D-8），接线已移除。键保留，是为了将来重新接线时直接复用 |
| `contextGuardNote` | `''` | **R12（内部保留，未接线）**：`sanitizeMessages` 的替换注记；空串 = 内置中英文注记 |
| `debugLog` | `false` | **R10**：诊断日志总开关。`false` 时不打开任何文件（零开销零副作用） |
| `debugLogPath` | `''` | **R10**：日志目标；空串 / 非字符串 → 由**系统临时目录**推导（不得硬编码本机路径，D-6） |

## 如何启用 / 关闭

- **启用**：用 `plugin_manager` 的 `install_bundle`，`target` 指向**本目录的绝对路径**（`...\DSH调用标签错误修复插件\plugin`），其余交给安装器，不要手改 profile。`cordis.patch.yml` 用的是 `- insert:` 列表 —— 裸 `- id:` 对新 id 是**静默空操作**。
- **临时关闭**：把 patch 行 `config.enabled` 设为 `false`（不注册任何东西）；或 `plugin_manager` `set_plugin` 把该行 `disabled: true`。
- **不要插件、只要提示词**：A 段仍保存在 `docs/PROMPTS.md`，可手动追加到 `AGENTS.md`（本插件**不再**内嵌或注入任何提示词 —— 见「变更说明」）。
- **判活要用对地方**：`install_bundle` 的 `application` 字段是首要判据，其次看它是否**真的注入了纠正**。⚠️ **不要去 grep profile 的 `cordis.patch.yml`** —— 本 bundle **自带 patch**（`plugin/cordis.patch.yml`，由 `package.json` 的 `dsh.bundle.patch` 声明），那一行**本来就不在 profile patch 里**；实测有真实会话因此误判"插件没被激活"，把排查带偏。
- **M5 默认关闭**：只有把 patch 里的 `contextGuard` 设为 `true` 并重新激活，才会改写模型可见历史（见「已知边界」）。M6 未实现。

## 已知边界（做不到什么）

- **不做预防，只做「发现 + 自愈」**：M1（system-prompt 预防块）已按用户决策移除 —— 提示词层对模型的约束力本质上不保证，且每个插件都塞提示词会分散 attention。因此本插件**完全不含提示词注入**：它不会阻止模型第一次写坏，只能发现、显式失败并当场纠正。仍想要预防文案的用户，请自己从 `docs/PROMPTS.md` 取 A 段。
- **改不了模型**：只能缩短故障窗口、把静默失败变响、并在同一 turn 内重试一次。
- **M2/M3 在用户主诉场景下根本不会被触达**：本机路由是 provider 原生 JSON function-calling，DSH 全树没有 `<invoke>/<parameter>` 文本协议解析器；「信封当正文吐出」时 `assistant/message` 里只有 text 块、`toolCalls.length === 0`，不会有任何 dispatch。**该场景只能靠 M4**；M2 防的是「原生调用 + 参数 JSON 被修复/截断」那一类。
- **⚠️ M5（上下文净化）在本机 harness 上「做不到」（缺陷 D-8，高危）**：这是**能力缺失**，不是配置问题。
  `agent-loop` 用 `buildRequest()` 组装请求后 `Object.freeze` 整个 envelope（`dsh-agent-loop/lib/index.js:1214` → `:1281`；`:1280` 冻结 `messages` 数组、`:1277` deepFreeze 每条消息），并在 `:1084` 把**同一个冻结对象**交给 `llm.stream`；`dsh-llm/lib/index.js:2397` 的 `llm/stream` waterfall 收到的就是它。ESM 是严格模式 → `options.messages = …` 抛 `TypeError`。
  我最初只验证了"下游闭包读同一个引用"（成立）与"`callConfigEquals` 不比 messages"（成立），却**漏了"这个引用是只读的"** —— 于是 M5 会**静默失效**。现已改为：打开开关后若检出冻结，记录 `skipped:'frozen-options'` 并照常 `next()`，**失败是显式的**。
  **要真正修好，需要 harness 提供可写接缝**（例如允许 listener 返回替换后的请求，或在 envelope 冻结之前介入），插件侧无法绕过。在此之前请把 `contextGuard` 视为**无效开关**。
  纯函数部分（`sanitizeMessages`）本身是达标的、已被独立验证覆盖：只改 `role:'assistant'`、**无 `tool-call` 块**、且被判损坏的消息；不改入参、未改动消息复用引用、`changed:false` 返回原引用、不抛异常。
  **处置（2026-10-29，按用户决策「暂时收手，开关可以不保留，代码留着」）**：**移除 `llm/stream` 接线与公开开关**（留着它等于每个请求白扫一遍历史），**保留 `sanitizeMessages` 实现**。因此 M5 在本 README 与 `docs/INTERFACE.md` 里一律标注为**已停用**，不要当作可用能力。
- **M6（强制小块写入工具）未实现**：契约与产品形态不够明确（会与内置 `write`/`edit` 竞争），按「宁缺勿错」不做。
- **参数叶子的 deny 双门槛（`INTERFACE.md` §2 裁定 R4）**：`scanToolArguments` 返回 `deny` 必须**同时**满足
  ① **损坏信号**：该叶子命中 `END_SEQUENCE_MULTIPLIED`（尾部连续结束序列）或 `TRUNCATED_PAYLOAD`；
  ② **体量**：同一叶子 `chars >= ceil(maxChars/10)`（默认 2000）**或** `lines >= ceil(maxLines/5)`（默认 20）。
  只满足 ① 不满足 ② → 最高 `flag`，detail 里追加 `below the deny gate ... downgraded to flag, not denied`。
  `UNPAIRED_CLOSING_TAG` 在**参数叶子**上一律 `info`，只作证据、永不导致 deny（合法文档的标签天然不配对）。
  原因：本仓库 `docs/DESIGN.md` 就是「描述这个故障、含孤立结束序列、>10KB」的文档 —— 守卫拒绝写「解释自己的文档」不可接受。
- **`TRUNCATED_PAYLOAD` 的门槛与结论（裁定 R6，二者不可互换）**：① 文本里必须出现调用结构标记，否则普通代码里的 `i < n`、`a<b` 会被误判；② **门槛 = "起头"**：去掉空白后，文本必须**以调用开场标记开头**（`<invoke` 或 `<parameter`，二者皆可）；③ **结论 = "栈非空"**：配对走查结束后仍有未闭合的开场标记。
  门槛若写成"最后一个 token 是开场标记"会**双向出错**：以非调用内容起头、尾部信封被砍的叶子会误报 `deny`；而以 `<invoke …>` 起头、末尾丢了一个结束序列的叶子会漏报。没有门槛时，本仓库 `docs/*.md`（讨论本故障、正文里天然引用标记）会被整体判截断并 deny。
  已知漏检（有意接受）：**不以调用标记起头**的叶子即使尾部结构被砍也不判截断（例如 `html…<invoke name=…><parameter name=…>abc`）—— 这是为了避免把合法文档判成损坏。
- **叶子遍历是有界的（有意设计，非 bug）**：`scanToolArguments` 最多检查 **200 个字符串叶子**、递归深度 **≤ 24**；`scanToolResult` 的取值走查最多 **400 次访问**、深度 **≤ 8**；一次调用最多报 **4 条** `INTERNAL_ERROR`。因此**深层叶子（深度 > 24）或第 221 个之后的叶子会被漏检**（`action: ok`）—— 宁可漏检，也不允许一个插件把长会话的每个大对象都完整展开。
- **`INTERNAL_ERROR` 的含义**：宿主对象的 getter/Proxy trap 抛错时会报 `INTERNAL_ERROR`（`severity:'info'`、`reason:''`、绝不 deny），因为这表示**守卫自己没看全**，而不是发现了损坏。这也是为什么内部异常绝不复用业务 code（裁定 R5）。
- **M3 只认显式证据（R9 后重做）**：`scanToolResult` 只对**写入类工具**生效（工具名匹配 `write|edit|append|patch|apply|replace|insert|update|create|save|mkdir|delete|remove|move|copy|rename|truncate|touch`），且只认机器可读证据：显式 no-op 布尔/状态字段（如 `noop:true`、`status:"noop"`、`changed:false`），或 `written*` 类计数为 0 且本次调用真的带了 payload（`MIN_PAYLOAD_CHARS = 16`）。
  **自由文本短语匹配已删除**：它会把 git status、grep 输出、含 `unchanged` / `no changes` 的说明文字误判成「静默空转」，并在真实会话里注入误导性纠正（实测 4 次）。判不准就不报；`config.noopCheck:false` 可整体关闭。
- **Config 校验生效，但没有配置表单**：安装后 `Config.listConfigs` 复查该行 `status` = **`"unsupported"`**（不再是 `absent`）—— Cordis 会用 `~standard.validate` 校验并归一化该行 config，但**没有 JSON Schema 投影**，因此 Plugin Manager 不会渲染配置表单。要拿到表单，必须在 `package.json` 声明 `@deepseek-ai/schemastery` 依赖并把安装方式从 `link:` 改成真实包安装 —— **本插件不做**（零依赖是硬约束）。
- **有自愈就有额外模型调用**：M4 触发会多一次请求，用 `maxCorrectionsPerTurn` 与 `enabled` 约束。
- **未在本 profile 安装/联调**：本目录只做了语法、纯函数与假 ctx 接线自测；真实 `install_bundle` 与端到端 turn 回放尚未执行（见交付报告的「未证实」清单）。

## 变更说明

- **2026-10-28 · 新增 `Config` schema**：`plugin/index.js` 增加 `export const Config`，使该行的 `config` 经 Cordis 的 `resolveConfig` 校验/归一化（此前 Config 缺失 → 原样投递、不校验）。实现是**手写的 Standard Schema v1**（`~standard.validate`）且**可调用**，因为 Cordis 只读 `runtime.Config['~standard'].validate(raw)`；而本 bundle 以 `link:` 挂在工作区，`@deepseek-ai/schemastery` / `zod` 在那里**解析不到**（实测 `ERR_MODULE_NOT_FOUND`），import 会让插件整个激活失败。归一化规则与 R7 完全一致（阈值整数 ≥1、`maxCorrectionsPerTurn` ≥0、`lang` ∈ zh|en、未知键忽略、非法值回退默认），且**永不返回 issues**，所以坏 config 不会让插件掉线。
  **已复查（lead，安装后）**：该行 `status` = **`"unsupported"`** —— 校验确实生效，但没有 JSON Schema 投影（原因与后果见「已知边界」）。
- **2026-10-28 · M3 重做（R9）**：删除 `scanToolResult` 的自由文本短语匹配（真实会话中 4 次误报的来源）；改为只对**写入类工具**生效、只认显式 no-op 证据；M3 注入改用 `scanToolResult.reason`，**不再复用 M4 的 B 段文案**（避免把「工具没干活」说成「参数边界损坏」）；新增 `noopCheck`（默认 `true`）总开关。
  **哈希再次变化**：`verify/REPORT.md` 需按 `verify/run-all.sh` 重跑。
- **2026-10-28 · 移除 M1（提示词层）**：按用户决策删除 `ctx.systemPrompt.section(...)` 注册及只服务于它的常量与插值（`SECTION_NAME` / `SECTION_ORDER` / `PREVENTION_TEXT` / `preventionText`），`export const inject` 由 `['systemPrompt','tools']` 收紧为 **`['tools']`**（缺少该 service 的 profile 不再被无谓判为不可用）。**理由**：提示词层对模型的约束力本质上不保证，且每个插件都塞提示词会分散 attention —— 能在代码层解决就只在代码层解决。**没有留"默认关闭的开关"**：用户要的是"不加入"，不是"能打开"；预防文案仍保存在 `docs/PROMPTS.md`，供用户将来手动选择。本插件自此只做**发现与自愈**。
  **哈希又变（`index.js`）**：需重跑验证。
- **2026-10-29 · 新增 M5 上下文净化（R12）+ 独立开关**：`detect.js` 新增纯函数 `sanitizeMessages(messages, opts)`；新增配置 `contextGuard`（**默认 false**）与 `contextGuardNote`（默认 `''`）→ `DEFAULT_CONFIG` 现 **12 键**；`index.js` 接线 `llm/stream`。
  机制依据（已取证）：`dsh-llm/lib/index.js:2397` 的 `ctx.waterfall(this,"llm/stream",options,()=>this.adapterStream(options,prepared))` 说明下游读**同一 options 引用**（所以必须原地赋值）；`callConfigEquals`（:367-371）**不比 messages**，故改 messages 不会触发 `INVALID_PREPARED_CALL`；`prepared` 只含 `{registration, modelInfo, config, dispatch}`。
  **按用户要求默认关闭**：这是"发现对话有问题后再打开"的事后补救开关，不适合常开。
  **附**：修正了「如何启用 / 关闭」里一处乱码路径（曾写成 `DSH调用标签错误修复主机插件修复插件`）。
- **2026-10-29 · D-8（高危）：M5 的改写在本机 harness 上写不进去 —— 上面那条 M5 记录的"可改写历史"是错的。**
  独立验证员逐行核对后发现：`agent-loop` 交给 `llm/stream` 的请求是 `Object.freeze` 的（`dsh-agent-loop/lib/index.js:1281`，另 `:1280`/`:1277`），严格模式下原地赋值抛 `TypeError`，被本插件的 `try/catch` 吞掉 → **改写永不落地，且连日志行都不写**（属于"静默失效"，正是本项目最讨厌的失败形态）。
  修正：listener 现在**先检测冻结**，命中就记 `skipped:'frozen-options'` 并照常 `next()`；文档与 Config 说明全部改为**"当前无效"**。**未修的部分**：让改写真正生效需要 harness 给可写接缝，插件侧无法绕过。
- **2026-10-29 · 按用户决策停用 M5**：用户口径「暂时收手，开关可以不保留，代码留着，后续看情况再决定」。落地：删除 `llm/stream` 监听器注册与 `sanitizeMessages` 的 import；`plugin/cordis.patch.yml` **不再暴露 `contextGuard`**；`sanitizeMessages` **保留在 `src/detect.js` 并仍导出**；`index.js` 原地留下"为什么不能做 + 将来如何重新接线"的注释（含 D-8 行号，以及三条重新接线必须遵守的规则：先查 `Object.isFrozen`、失败要显式报告、任何路径恰好一次 `next()`）。
  于是插件的"在用机制"回到 **M2 / M3 / M4**（M2 与 M4 均已现场验证），M5 状态为**已停用**。
- **2026-10-30 · M4 两档有界升级（R13，现场证据驱动）**：在一个**真实用户会话**里，M4 确实走通（检测 → `agent.inject` → turn 未关闭、多跑一步），但**那一步又写坏了**（还把 ~23 KB 当正文吐出），随后 `maxCorrectionsPerTurn: 1` 用尽、turn 正常关闭 —— 即"自愈"此前只到"不静默关闭"。
  现在按 `count` 分档注入（**只在 `index.js`，不动冻结的 `detect.js`**）：tier 1 = 原语义（B 段 + R11 指令，`buildCorrectionMessage` 空则**不注入**）；tier 2 = 丢掉长解释、换成更硬更短的指令（"这一步只发一个调用、参数不超过 40 行、不要解释、不要把内容打在正文里"+ 判定 code）。上限仍是 `maxCorrectionsPerTurn`；`DEFAULT_CONFIG` 冻结值**不动**（仍为 `1`），但**本 bundle 的 patch 设为 `2`**。
  **诚实标注**：tier 2 的有效性**尚未**在真实故障中观测到。M4 的现场证据同时把 README 里"自愈能让模型真正重做"一条从"待办"改为"**真实故障中观测到：没有**"。

## 文件

```
plugin/
  index.js            Host 入口：M2–M5 接线，全部监听器 try/catch + effect 注册（无提示词注入）
  src/detect.js       纯函数检测核心（冻结接口见 docs/INTERFACE.md）
  cordis.patch.yml    - insert: 一行 patch（含默认 config）
  package.json        dsh.bundle.patch / exports(locale, icon) / files
  locale/zh.json      meta.title / meta.description（中文）
  locale/en.json      同上（英文）
  icon.svg            原创图标：盾 + 边界括号
```

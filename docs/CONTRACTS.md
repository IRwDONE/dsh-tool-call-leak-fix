# DSH「结构化输出守卫」Host 插件 —— 契约调研（CONTRACTS）

> 任务：task-1（contracts-digger）。本文是编码前的事实底稿，**每条结论后跟「证据」小节**；无法证实的写「未证实」。
> 版本：v1（增量落盘，标注 TBD 的条目后续补）。采样时间 2026-10-28。

---

## 0. 调研方法（先读，决定你怎么复现证据）

1. **桌面版 asar 里没有任何 `.d.ts`。** 我解出 `app.asar` 头部的文件表：共 18188 个文件条目，其中以 `.d.ts` 结尾的为 **0** 个（`app.asar.unpacked/dsh/node_modules` 只有原生二进制，没有非打包副本）。
   - 证据：`ops_bash` 运行 Python 解析 `<dsh-install>\resources\app.asar` 的 asar 头部 JSON（`{"files":{...}}`），遍历叶子路径后统计 `TOTAL 18188`、`dts count 0`；`ls <dsh-install>/resources/app.asar.unpacked/dsh` → 只有 `node_modules`，其下为 `node-pty`、`koffi`、`@img/sharp-win32-x64` 等原生包。
   - 因此任务书里「读 `lib/types/**/*.d.ts`」**在本机不可行**（不是路径写错，是文件不存在）。
2. **但精确 TS 签名仍有来源**：每个包的 `lib/typert.host.js` / `lib/types/api-catalog.js` 里嵌有生成的 `"declaration": "export interface ..."` 字符串，内容就是 `.d.ts` 的原文（含完整字段）。下面凡标 `[typert 声明]` 的都是这一类。
3. **行号可复现的做法**：我把 asar **按字节原样解包**到会话临时目录
   `<extracted-asar-tree>\dsh\node_modules\...`（16605 个文件，1583 个 unpacked 条目跳过），解包文件与 asar 内文件**逐字节相同，行号一致**，于是可以正常 grep/read。本文引用的绝对路径给出 **asar 内的规范路径**（`<dsh-install>\resources\app.asar\dsh\node_modules\...`），行号与该解包副本一致。
   - profile 目录 `C:\Users\<user>\.dsh\profiles\desktop\` 是真实目录，直接 read/grep 即可。
4. **本机实际生效的模型路由**（第 7 条结论的前提）：profile patch 把默认模型钉成 **provider `nvidia` / model `deepseek-ai/deepseek-v4.1-flash`**。
   - 证据：`C:\Users\<user>\.dsh\profiles\desktop\cordis.patch.yml:8-13`
     ```yaml
     - id: agent-default-model
       name: "@deepseek-ai/dsh-agent-default-model"
       config:
         provider: nvidia
         model: deepseek-ai/deepseek-v4.1-flash
         reasoningEffort: high
     ```

---

## 7. 【决定性】模型输出的 tool call 参数在哪里解析？（先看这条）

### 结论

**1）是 provider 原生 JSON function-calling，不是文本协议。** 本项目（DSH）的代码里**不存在**形如 `<invoke name="X"><parameter name="code">...</parameter></invoke>` 的文本协议解析器：全树 grep `antml`、`function_calls`、`</parameter>`、`invoke name=` 均无命中（唯一命中是 devtools/Lighthouse 的无关 i18n 串）。

**2）本机当前路由是 OpenAI 风格的 `openai-completions` native tool_calls。** 参数以 JSON 字符串 **流式分片** 到达（`delta.tool_calls[].function.arguments`），由第三方库 `@earendil-works/pi-ai` 累积后解析成对象，再由 `@deepseek-ai/dsh-llm-pi-ai` 重新 `JSON.stringify` 成 Harness 的 `tool-call` 块。

**3）解析失败不会变成「普通正文」，但会静默退化成 `{}`（参数全丢）** —— 这是比报错更危险的一类静默失败：
`parseStreamingJson()` 的设计目标是「永远返回合法对象」，`JSON.parse` 失败后依次尝试 `repairJson` → `partial-json` 容错解析 → 最后 `return {}`，**从不抛错**。

**4）对用户故障场景的判定（最重要）：**
- 若模型把 tool-call 信封**当正文吐出来**（文本里出现 `</invoke>`、`<parameter ...>` 之类），DSH 侧**没有任何解析器会把这段文本变成真实的 tool call**；它只会成为 `assistant/message.content` 里的 `text` 块。
- 此时 `agent-loop` 的执行判据是 `message.content.filter(b => b.type === 'tool-call')`，长度 0 → 该 step **直接返回 `{ kind: 'completed' }`**：**工具不执行、不报错、turn 正常关闭**。这就是「静默失败 + 上下文自我强化」的完整机制。
- 推论：**`tools/pre-execute` 在这类故障下根本不会被触达**（没有 ToolExecution 被构造）。因此插件的「静默失败检测」**不能**挂在 `tools/pre-execute`，只能挂在 `session/event`（读 `assistant/message`）+ `agent/turn-stopping`（同 turn 内纠正）。→ 详见 §2、§3。

### 证据

**(a) 本机路由 = openai-completions（native function calling）**
- asar 内 `<dsh-install>\resources\app.asar\dsh\node_modules\@earendil-works\pi-ai\dist\providers\data\nvidia.json:1`（单行 JSON）：
  ```json
  "chat:deepseek-ai/deepseek-v4.1-flash":{"id":"deepseek-ai/deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash",
   "api":"openai-completions","provider":"nvidia","baseUrl":"https://integrate.api.nvidia.com/v1",
   "compat":{"supportsStore":false,...,"supportsStrictMode":false,"thinkingFormat":"deepseek"},...}
  ```
- `...\@deepseek-ai\dsh-llm-pi-ai\lib\index.js:9-12`：该适配器同时载入 `anthropicMessagesApi`、`openAICompletionsApi`、`openAIResponsesApi`，按模型目录声明的 `api` 选择 —— 即**参数解析由 pi-ai 的对应 API 实现负责**。
- `...\@earendil-works\pi-ai\dist\api\openai-completions.js:426-427`：
  ```js
  if (choice?.delta?.tool_calls) {
      for (const toolCall of choice.delta.tool_calls) {
  ```
  → 明确是 OpenAI 原生 `tool_calls` 流式分片。

**(b) 到达 Harness 的形态：`tool-call` 内容块（arguments 是 JSON 字符串）**
- `...\@deepseek-ai\dsh-llm-pi-ai\lib\index.js:1423-1432`（模块 JSDoc）：
  > “pi-ai tool-call arguments are parsed objects while the Harness keeps their raw JSON representation.”
- 同文件 `1537-1626`（`toStreamChunks`）：
  - `toolcall_start` → `{type:'block-start', blockType:'tool-call'}`（1597-1601）
  - `toolcall_delta` → `{type:'tool-call-delta', id, name, argumentsDelta: event.delta}`（1604-1613）
  - `toolcall_end` → `{type:'block-end', block:{type:'tool-call', id, name, arguments: JSON.stringify(event.toolCall.arguments)}}`（1615-1626）
- 另一条（备用）适配器 `dsh-llm-deepseek`（Anthropic Messages 形状）同样原生：
  - `...\@deepseek-ai\dsh-llm-deepseek\lib\index.js:1868-1876`（`case "tool_use"` → `{type:'tool-call'}`）、`1913-1917`（`input_json_delta` → `tool-call-delta`）、`2013`（`return malformed("tool input is invalid JSON")`）。
  - 注意差异：**deepseek Messages 适配器遇到非法 JSON 是报错**（`malformed(...)`），而 pi-ai 路线是静默 `{}`。

**(c) 非法 JSON → 静默 `{}`（不是正文，但参数全丢）**
- `...\@earendil-works\pi-ai\dist\utils\json-parse.js:90-112`：
  ```js
  export function parseStreamingJson(partialJson) {
      if (!partialJson || partialJson.trim() === "") return {};
      try { return parseJsonWithRepair(partialJson); }
      catch { try { const r = partialParse(partialJson); return (r ?? {}); }
              catch { try { const r = partialParse(repairJson(partialJson)); return (r ?? {}); }
                      catch { return {}; } } }
  }
  ```
- 同文件 `71-82` `parseJsonWithRepair`：先 `JSON.parse`，失败则 `repairJson`（转义字符串内控制字符、修补非法转义）重试。
- `openai-completions.js:7` `import { parseStreamingJson } from "../utils/json-parse.js";`

**(d) 没有 tool-call 块 = step 正常完成、工具不执行（静默失败机制）**
- `...\@deepseek-ai\dsh-agent-loop\lib\index.js:1156-1167`：
  ```js
  live.settle("assistant/message", () => this.session.append("assistant/message", {
      turn, step, message, ...stream }));
  if (finish.kind === "max-tokens") return { kind: "max-tokens" };
  const toolCalls = message.content.filter((block) => block.type === "tool-call");
  if (toolCalls.length === 0) return { kind: "completed" };
  const { concluded } = await executeToolCalls(this.loopCtx, turn, step, toolCalls, signal, ...);
  ```
  → 只含文本的 assistant 输出 = `{kind:'completed'}`，**没有异常、没有 tool 事件**。

**(e) 全树无文本协议解析器**
- grep（对整个解包树 `<tmp>\<解包目录>\dshx`）：`antml|function_calls|</parameter>` → 仅 2 条命中，均在
  `...\@deepseek-ai\dsh-experimental-inspector\lib\devtools\entrypoints\lighthouse_worker\lighthouse_worker.js:190795,190838`，内容是 `"javascript.operators.spread.spread_in_function_calls"` 之类的 i18n key，**与工具调用无关**。
- grep `invoke name=` / `<parameter name=`（在 `@deepseek-ai/**`，含各包 `lib/index.js`）→ 0 条工具协议命中（其余为 typert 的 `validateWireName('parameter name', ...)` 等无关命中）。

**(f) `run_code`（PTC 关键工具）定义位置与参数 schema**
- 名字常量：`...\@deepseek-ai\dsh-tools\lib\types\ptc.js:17` → `export const RUN_CODE_NAME = 'run_code';`
- 定义工厂：同文件 `240-289` `export function createRunCodeTool(registry, options, ctx)`，`defineTool({...})`：
  - `parameters`：`code`(string, required)、`description`(string, required)、`...RUN_CODE_CONTROLS`（`timeoutMs` / `sandbox_permissions` / `justification`，见 `54-73`）；`sandbox_permissions` 的 enum 来自 `ESCALATION_TARGETS`（`read-only|workspace-write|danger-full-access`，见 `output.schema` 与 `RUN_CODE_CONTROLS`）。
  - `output.schema`：`{logs: string[](required), result: json, sandbox:{mode,denied,enforcement}}`（`262-279`）。
  - `output.render:_args,value` → `[{type:'text', text: ...}]`（`280-288`）。
- 保留名（不可被注册/遮蔽）：`...\@deepseek-ai\dsh-tools\lib\index.js:2981`；`restrict()` 不能点名它：`3001`；PTC 下模型直呼其它工具会被解析为不可调用：`3196` `return !nested && this.modeFor(scope) === "ptc" && name !== "run_code";`
- 本机 preset 默认值：`C:\Users\<user>\.dsh\profiles\desktop\cordis.patch.yml:102-106`（`agent-preset-registry` → `default: standard, selectedDefault: ptc`）。→ **PTC 模式下模型可见的直接工具只有 `run_code`**（+ 生成的 SDK 声明）；工具的实际分发发生在 PTC 子调用里，仍走同一 `ctx.tools` 管线。

### 未证实 / 待补
- **用户实际故障会话里模型到底吐了什么**：未证实。需要该 session 的持久日志（`~/.dsh` 下 session jsonl）确认是「文本信封」还是「原生 tool_call + 被修复的 JSON」。本文的结论是**框架侧能力判定**，不是对该次会话的取证。
- 是否还有别的（非 `@deepseek-ai`）插件提供文本协议回退解析：**已排除**。
  - asar 全树（含 `@earendil-works/pi-ai`）grep `antml|function_calls|</parameter>|invoke name=` → 无工具协议命中。
  - profile 安装的第三方 bundle：grep `antml|</parameter>|invoke name=` 于 `C:\Users\<user>\.dsh\profiles\desktop\node_modules` → **No matches found**。
  - 结论：本机 composition 内**没有任何文本协议工具解析器**。

---

## 5. `ToolDefinition` 注册最小可用写法（`output: {schema, render}`）

### 结论

- 注册入口是 Service `tools`：`ctx.tools.register(definition) → 卸载函数`；插件声明 `export const inject = ['tools']`（Host 插件导出形态见 §6）。
- 一等公民写法是用 **`defineTool(options)`**（`@deepseek-ai/dsh-tools` 的 `lib/types/schema.js` 导出）：它把「作者 DSL」编译成真 JSON Schema，并强制参数校验。
- `output` 是**必填**（`defineTool` 内部直接读 `options.output.schema` / `options.output.render`，缺了会 TypeError）。
- 参数 DSL 要点：每个属性写 `type`（`string|number|integer|boolean|null|array|object|json|oneOf`）+ `description`，必填用 `required: true`；`object` 必须显式写 `additionalProperties: true|false`；`output.schema` 也走同一 DSL（根可以是 `object`/`json` 等）。

### 真实可跑例子 A（原样摘录）：`run_code` 的 `output`

出处：`<dsh-install>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-tools\lib\types\ptc.js:240-289`

```js
export function createRunCodeTool(registry, options, ctx) {
    const { requireRuntime, peekRuntime, maxParallel, shapeDispatchLog } = options;
    const stateOwners = new WeakMap();
    const calls = new PtcCalls(ctx);
    const definition = defineTool({
        name: RUN_CODE_NAME,
        description: TYPESCRIPT_FLAVOR.description,
        parameters: {
            code: { type: 'string', required: true, description: TYPESCRIPT_FLAVOR.codeDescription },
            description: {
                type: 'string',
                required: true,
                description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION,
            },
            ...RUN_CODE_CONTROLS,
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    logs: { type: 'array', required: true, items: { type: 'string' } },
                    result: { type: 'json' },
                    sandbox: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            mode: { type: 'string', required: true, enum: ['read-only', 'workspace-write', 'danger-full-access'] },
                            denied: { type: 'boolean', required: true },
                            enforcement: { type: 'string', enum: ['full', 'partial'] },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const rendered = value.result === undefined ? '' : renderValue(value.result);
                const parts = [value.logs.join('\n'), rendered].filter(part => part.length > 0);
                if (value.sandbox?.enforcement === 'partial')
                    parts.push('File sandbox enforcement is partial on this host.');
                if (value.sandbox?.denied)
                    parts.push(`The ${value.sandbox.mode} file sandbox denied an operation.${escalationGuidance(peekRuntime())}`);
                return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(run_code completed with no output)' }];
            },
        },
        async execute(args, exec) { /* ... */ },
    });
```

### `defineTool` 的确切契约（运行时构造，等价于类型声明）

出处：`...\@deepseek-ai\dsh-tools\lib\types\schema.js:274-354`（`export function defineTool(options)`）

- 读取的字段：`options.name`、`options.description`、`options.parameters`、**`options.output.render`、`options.output.presentationMeta`**、`options.execute`、`options.finalizeContent`、`options.projectContent`、`options.presentCall`、`options.presentResult`、`options.isConcurrencySafe`、`options.deferLoading`、`options.timeoutMs`。
- 编译：`parameterSchemaSpecToJsonSchema(options.parameters)`（`schema.js:238-247`）、`valueSchemaSpecToJsonSchema(options.output.schema)`（`228-232`）。
- 返回对象形状（`schema.js:298-321`）：
  ```js
  { name, description, parameters /* JSON Schema */,
    output: { schema /* JSON Schema */, render(args, value), presentationMeta? },
    deferLoading?, timeoutMs?,
    execute(args, exec) /* 先跑 validate，violations>0 抛 ToolArgsError('INVALID_ARGS') */ }
  ```
- 校验失败错误类型：`ToolArgsError extends HarnessError`，`code: 'INVALID_ARGS'`，消息 `invalid arguments: <violations>`（`schema.js:249-256`）。
- `presentCall`/`presentResult`/`isConcurrencySafe` 会先软校验、不通过就回退（`332-352`）——**展示路径永不抛错**，执行路径会抛。

### 真实例子 B（另一个内置工具，可作最小模板）

出处：`...\@deepseek-ai\dsh-tool-todo\lib\index.js:120`（`output: {`），同类还有 `dsh-tool-present/lib/index.js:47`、`dsh-tool-working-directory/lib/index.js:23`、`dsh-tool-fs/lib/index.js:268` 等共 50+ 处 `output: {` 命中（见 `grep "output: \{"` 结果）。

### 未证实
- `ToolDefinition` / `ToolOutputDefinition` 的 **TS interface 原文**未在构建产物中定位到（`.d.ts` 已被剥离；`dsh-tools/lib/types/types.js` 与 `presentation.js` 只以 JSDoc 引用这两个名字）。
  - 已搜：`grep "interface ToolDefinition|interface ToolOutputDefinition"` 于 `@deepseek-ai/**` → 无；`grep "ToolDefinition|ToolOutputDefinition"` 于 `dsh-tools/lib/types/**` → 仅 2 条 JSDoc 提及（`ptc.js:229`、`presentation.js:3`）。
  - **替代证据**：上面的 `defineTool` 源码就是权威运行时契约。
- `tools.register` 的服务方法签名（`register(definition: ToolDefinition): () => void`）来自 `cordis_inspect_query`（见 §1 的 Service 目录），非 `.d.ts`。

---

## 6. Host 插件包的最小文件清单 + patch 写法

### 结论

**最小文件清单（Host-only bundle）：**
```
<包目录>/
  package.json        # 声明 dsh.bundle.patch 指向 patch
  index.js            # export function apply(ctx, config) / export const inject / export const Config
  cordis.patch.yml    # - insert: [ {id, name, config} ]
  locale/en.json      # meta.title / meta.description（Plugin Manager & Settings 读）
  locale/zh.json      # 同上的中文
  icon.svg            # 或 PNG/JPEG/WebP，≤256 KiB，必须在包内
```
（display 元数据不是运行时必需，但出货清单要求，见下。）

**`package.json` 字段（Host-only 最小）** —— 出处：skill `cordis-plugin-development` 的 `references/host-plugin.md:9-18`
```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```
**加 display 资源后**（`host-plugin.md:44-49`）：
```json
{
  "exports": { "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"]
}
```
locale 内容（`host-plugin.md:38-42`）：`{ "meta": { "title": "My Decoration", "description": "Draws a badge under the composer." } }`

**`index.js` 导出形状**（`host-plugin.md:57-64`）：二选一，不可混用
- `export function apply(ctx, config) {}`（可另加 `export const inject = ['tools']`、`export const Config`）
- 或默认导出 Service class。
- 所有资源必须用 `ctx.effect` / `ctx.on` 注册并返回卸载函数（`host-plugin.md:64`）。

**`cordis.patch.yml` 的确切 YAML（新增行必须用 `- insert:`）** —— `host-plugin.md:22-27`
```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

### 证据（真实在用的 patch）
- 本机 profile 里已有同款写法：`C:\Users\<user>\.dsh\profiles\desktop\cordis.patch.yml:86-101`
  ```yaml
  # --- DSH migration (v2 2026-10-22): local SearXNG via native MCP client ---
  # A NEW plugin must be mounted with an insert list; a bare - id row only overrides an existing row by id.
  - insert:
      - id: mcp-searxng
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          serverName: searxng
          transport: stdio
          command: '<node.exe 的本机路径>'
          args:
            - '<<mcp-script> 的本机路径>'
          ...
  ```
- 出厂 patch 同样用 `- insert:`：`...\@deepseek-ai\dsh-web-app\cordis.patch.yml:44,590`、`dsh-base\cordis.patch.yml:15`、`dsh-acp-app\cordis.patch.yml:11`、`dsh-headless\cordis.patch.yml:19`、`dsh-sdk-app\cordis.patch.yml:11,28` 等 20+ 处（grep `insert:` with `include=cordis.patch.yml`）。
- 语法细则（`cordis-composition-reference` skill）：
  - `insert: [rows]` 追加行；若给 `insert` 配一个已存在的 `group: true` 行 id，则插入该 group 的 `config` 列表内。
  - **带 `id` 且无 `insert` 的 patch 是「按 id 覆盖已有行」，`config` 整体替换（不是深合并）**；`id` 匹配不到行的非 insert patch 会被 warn 并跳过 —— 这就是「裸 `- id:` 对新插件等于空操作」的原因。
  - 行字段：`id`、`name`（包名）、`config`、`disabled`、`inject`、`intercept`、`isolate`；`config` 内可用 `!!js` 表达式。
- 安装方式（`cordis-plugin-development` skill 正文）：**不要手写 profile 的 `package.json`/`cordis.patch.yml`**，用 `plugin_manager` `action: install_bundle`、`target` = 包的绝对目录；安装后 `application` 字段决定是否 live（换已安装包需重启，新装 bundle 可经 HMR 生效）。
- 验证不靠 `list_plugins`（要审批）：用免审批的 `cordis_inspect_query`（`Config.listConfigs` 按 `name` 过滤 → 取 `entry` 得 `packageDir`；`Tool.listTools` 看工具是否真的可调用）。

### 未证实 / TBD
- `Config`（schemastery/JSON Schema）在本插件里的具体字段尚未定稿（取决于我们是否暴露开关，如 `mode: 'off'|'warn'|'repair'`、`maxPayloadBytes`）。
- 新插件的 `id` / `name` / 图标资源尚未选（交付时应给 `meta.title`、`meta.description` 中英双份）。

---

## 1. Agent 完整接口（`inject` / `followup` / `ctx` / `id` / steering）

### 结论

**精确接口（[typert 声明]，等价 `.d.ts` 原文）：**
```ts
export interface Agent {
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    readonly inbox: Inbox;
    readonly status: AgentStatus;
    readonly ctx: Context;
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    whenIdle(): Promise<void>;
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    followup(message: UserMessage): void;
    steer(message: UserMessage): void;
    inject(message: UserMessage): void;
}
```

**语义（源码实现，最权威）：**
```js
send(message, target, wakeup) { ... this.inbox.splice(resolvedTarget, Infinity, 0, [message]); if (wakeup) this.wakeDriver(wakingAfterAbort); }
followup(input) { this.send(input, "next-turn", true); }   // 排队「下一轮」提示并唤醒驱动器
steer(input)    { this.send(input, "next-step", true); }   // 提交「下一步」输入并唤醒
inject(input)   { this.send(input, "next-step", false); }  // 「下一步」上下文，不唤醒
```
- `InboxTarget` 只有两个值：`"next-turn"` / `"next-step"`。
- **对本插件的意义**：`inject()` 写入 `next-step` 但不唤醒；在 `agent/turn-stopping` 里调用它时 turn **本来就是活的**，所以不需要唤醒 —— 只需让 `next-step` 非空（见 §2）。
- **source 归属**：调用方省略 `source` 时，`followup()`/`steer()` 会被赋予 `{ kind: 'user' }`；插件/调度器等非人类生产者**必须自己传入 source**，不能继承人类权限。

### 证据
- [typert 声明] `<dsh-install>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-client-file-upload\lib\typert.host.js:158`（同一字符串在同版本多包重复：`dsh-agent-preset-registry\lib\typert.host.js:277`、`dsh-api-session-controller\lib\typert.host.js:2191,3242`、`dsh-commands\lib\typert.host.js:237`、`dsh-cordis-host-runner\lib\typert.host.js:1230,2069`、`dsh-goal\lib\typert.host.js:683`、`dsh-session-reference\lib\typert.host.js:133`、`dsh-subagent\lib\typert.host.js:297`、`dsh-user-questions\lib\typert.host.js:232`、`dsh-api-terminal-controller\lib\typert.host.js:684`）。
- 实现：`...\@deepseek-ai\dsh-agent-loop\lib\index.js:800-814`（`send`/`followup`/`steer`/`inject`）、`773`（`this.id = id`）、`779`（`this.ctx = this.scope.ctx`）、`790-792`（`get status()`：`idle|maintenance` → `idle`，否则 `running`）、`815-821`（`cancel`，`!keepInbox` 时 `inbox.clear()`）、`822-845`（`runMaintenance`）、`870-875`（`whenIdle`）。
- Inbox 两个目标：`...\@deepseek-ai\dsh-agent-loop\lib\index.js:21-24`（`"next-turn"` / `"next-step"`）、`103-111`（`claim(target, turn)` 取批：先取完 `next-step`，`target==='next-turn'` 时再取 1 条 `next-turn`）、`88-90`（`hasPending`）。
- 语义 JSDoc/README：
  - `...\@deepseek-ai\dsh-agent\README.md:47`
    > “The handle's methods route identified user-role messages into the agent's inbox. `followup()` queues an ordinary next-turn prompt and wakes the driver; `steer()` submits next-step input and wakes it; `inject()` adds model-facing context without waking the driver, so it lands in the next admitted step.”
  - 同文件 `143`：三者都是「identified user-role messages」，被接纳的内容成为后续 step 模型读取的派生历史的一部分。
  - `...\@deepseek-ai\dsh-agent\README.zh.md:47`、`143`（中文对照）。
- source 归属规则：`...\@deepseek-ai\dsh-tool-goal\README.md:72`
  > “`{ kind: 'user' }` is assigned by `Agent.followup()` and `steer()` when their caller omits a source, so plugins, schedulers, and other non-human producers must pass their own source rather than inheriting human authority.”
  （实现引用见 `...\@deepseek-ai\dsh-tool-goal\lib\index.js:46`）
- 构造消息：`...\@deepseek-ai\dsh-llm\lib\index.js:59-64`（`createUserMessage(input)` → `createMessage({...input, role:'user'})`，`createMessage` 在 `37-42` 内部 `deepFreeze(structuredClone({...input, id: brandString(randomUUID())}))`）；同文件 `2429` 的导出清单里确有 `createUserMessage`、`createAssistantMessage`。
- 还有「别的向当前 turn 追加 steering / 唤醒 agent 的方法」：
  - `agent` 作用域事件 `agent/inbox/inserted|claimed|discarded`（见 §3 的 Event 目录）—— 只观察，不写入。
  - `Session.append('user/message', msg, { surfaceOp:'append' })` 可写持久日志，但**不会**唤醒驱动器/推进当前 turn（`agent-loop` 只在 inbox 取批时消费）；生产级做法仍应走 `agent.followup/steer/inject`。
  - `agents` service（`ctx.agents`）提供 `create/resume/register/enter/announce/get/list/roots/currentInitiator/requireInitiator/withInitiator/withoutInitiator`（`Service.listService` 目录），**不含 steeting**。

### 未证实
- `Inbox` 接口的完整成员（只从实现用到 `splice/claim/append/prepend/replace/clear/nextTurn/nextStep/hasPending` 推断）。
- `AgentStatus` / `AgentCancelCause` / `CancelOptions` 的字段原文未逐一定位（TBD；不影响本插件：只用 `inject` + 读 `status`）。

---

## 2. `agent/turn-stopping` 语义（serial 模式）：此时注入能让 turn 不关闭

### 结论

**能。** 在 `agent/turn-stopping` 的 listener 里向 `next-step` 追加输入（`agent.inject(...)`），**同一个 turn 会继续跑下一个 step，不会关闭**。

机制（`agent-loop` 的 turn 循环）：
```js
if (turnEnds && this.inbox.nextStep.length === 0) {
    await this.dispatch.serial("agent/turn-stopping", { turn, signal });  // 等待所有 listener
    signal.throwIfAborted();
}
if (turnEnds && this.inbox.nextStep.length === 0) break;   // ← 注入后这里为 false，不 break
target = "next-step";                                       // ← 继续回圈，从 next-step 取批
```
- `dispatch.serial(...)` 是 **await 的**（serial 模式按序等待所有 listener 完成），所以 listener 里同步/异步写入 inbox 都一定在第二次判空之前生效。
- 触发前提：`turnEnds` 非空 **且** `next-step` 为空。也就是说 **turn 正在收尾的那一刻**才发这个事件；它是「最后一个可以挽救 turn 的钩子」。
- `turnEnds` 为 `{kind:'completed'}` 的路径之一正是「assistant 消息里没有 tool-call」（§7(d)）→ 所以 `turn-stopping` 是捕获用户所述「什么都没执行」的**天然时机**。

### 证据
- 事件契约（`cordis_inspect_query` host/Event/listEvents，原文）：
  ```json
  { "name": "agent/turn-stopping",
    "description": "The turn is about to close: the model owes no response (no live tool calls, no fresh steering).",
    "mode": "serial",
    "signature": "'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void" }
  ```
- 发射/判定点：`...\@deepseek-ai\dsh-agent-loop\lib\index.js:999-1008`（上引代码逐行对应）。
- listener 收到 `payload.agent`，可直接 `payload.agent.inject(createUserMessage({content:[...], source:{kind:'runtime-context', ...}}))`。
- 收尾路径的另一处：`...\@deepseek-ai\dsh-agent-loop\lib\index.js:964-968`（`phase.step===0 && decision.messages.length===0` → `{kind:'completed'}`，不进入 step，`turnEnds` 已置位 → 仍会走到 turn-stopping）。

### 完整链路（已逐行确认，v1.1 关闭 TBD）
`...\@deepseek-ai\dsh-agent-loop\lib\index.js`
```
938  async turn() {
943      const turn = phase.turn + 1;           // 本 turn 的编号
951      let target = "next-turn";
953      while (true) {                         // ← turn 内的 step 回圈
955          const step = phase.step + 1;       // 注意：step 号在每个回圈递增（回来一次就是新 step）
956          const decision = await this.preStep(target, { turn, step });
906  预 step: const claimed = this.inbox.claim(target, position.turn);   // ← 从 target 取批
909          const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ... });
...
1000         if (turnEnds && this.inbox.nextStep.length === 0) {
1001             await this.dispatch.serial("agent/turn-stopping", { turn, signal });   // 等待 listener
1005             signal.throwIfAborted();
1006         }
1007         if (turnEnds && this.inbox.nextStep.length === 0) break;   // 注入后为 false
1008         target = "next-step";                                      // 下一圈从 next-step 取批
1009     }
```
→ 在 `agent/turn-stopping` 里注入 `next-step` 后：`1007` 不 break → `1008` 把 `target` 切到 `next-step` → 回 `953` 开新 step → `956 preStep("next-step")` → `906 claim("next-step", turn)` **取到刚注入的消息** → 模型在**同一个 turn** 再跑一步。**闭环确认。**
- 相关旁证：`acceptContext`（工具结果回注）用的是同一套 next-step 机制 —— `index.js:1166`
  `executeToolCalls(..., (context) => this.inbox.splice("next-step", this.inbox.nextStep.length, 0, [context]))`
  → 「把一条消息塞进 next-step 就能让同一 turn 继续」是框架自己在用的既有模式。

### 未证实 / TBD（剩余）
- `Scoped<Agent>` 的 `this` 绑定（listener 第一个参数）——实现上是 `dispatch.serial(name, {turn, signal})`，`agent` 由 agentEvents 总线补进 payload；对本插件无影响（用 `payload.agent` 即可）。
- 若 listener 抛错/abort：`serial` 传播异常 → `turn()` 的 catch（`1010-1026`）把 turnEnds 置 `error` 并 `throwError`。→ **注入代码不要抛错**。
- 注入的 `UserMessage` 是否被 `agent/pre-step` 的 default 分支附加 runtime-context（`index.js:913-920`）：`inject` 的消息走 `claimed`，default 决策会 `[...claimed, context]`；自定义 source 为 `runtime-context` 时另有 `1067-1073` 的特殊追加逻辑（`decision.messages` 中 source.kind==='runtime-context' 的只取一次）。→ 编码时建议 source 用 `runtime-context`（可与框架自身的上下文注入对齐），并接受「可能多一条 context 消息」。

---

## 3. `session/event` 中 assistant 消息的事件类型与载荷形状

### 结论

- 事件名：**`'assistant/message'`**（surface 事件，持久化；相邻的 `'assistant/attempt'` 是失败/重试尝试，**不进模型历史**）。
- 载荷（`SessionEventMap['assistant/message']`）：
  ```ts
  'assistant/message': {
      turn: number;
      step: number;
      message: AssistantMessage;          // 组装后的模型可见消息
      stream: AssistantStreamRecord[];    // 紧凑的 provider 流（回放/诊断）
      usage?: TokenUsage;
      interrupted?: true;
  };
  ```
- 外层信封（`SessionEvent<T>`）：
  ```ts
  { type: K; seq: SessionSeq; time: number; data: SessionEventMap[K]; ignorable?: true }
  ```
  surface 事件**还带** `surfaceOp`（append/replace）；`assistant/message` 因内嵌 `stream` 而**禁止** `sourceEventSeqs`。
- **如何在一个 listener 里拿「本 step 的 assistant 输出文本 + 是否含 tool call」**：
  1. listener 挂在 `ctx.on('session/event', (session, event) => {...})`（emit 模式），过滤 `event.type === 'assistant/message'`；
  2. 用 `event.data.step` / `event.data.turn` 定位本 step（`data.step` 就是 step 号）；
  3. `const blocks = event.data.message.content;`
     - 文本：`blocks.filter(b => b.type === 'text').map(b => b.text).join('')`
     - tool call：`blocks.filter(b => b.type === 'tool-call')` —— 每块含 `id` / `name` / `arguments`（**arguments 是 JSON 字符串**，与 `agent-loop:1164` 的判据同源）
  4. 另有 log-only 的 `'tool/call'` 事件：`{ turn, step, callId, name, arguments: string }`（可作「本 step 是否真的分发了工具」的交叉验证）。
- **重要时序**：`session/event` 是 `emit` 且 **post-commit**（写盘之后），所以此处**只能检测、不能撤销**已经落盘的 assistant 文本；同 turn 自愈要靠 §2 的 `agent/turn-stopping` 注入。

### 证据
- 事件目录（`cordis_inspect_query` host/Event/listEvents，原文）：
  ```json
  { "name": "session/event", "description": "Post-commit, fire-and-forget append feed.", "mode": "emit",
    "signature": "'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void" }
  ```
- 事件名白名单（本构建认识的全部类型）：`...\@deepseek-ai\dsh-session\lib\types\known-event-types.js:21-84`，其中 `27: 'assistant/attempt'`、`28: 'assistant/message'`、`74: 'tool/call'`、`77: 'tool/result'`、`79: 'turn/start'`、`78: 'turn/end'`、`59-60: 'step/start'|'step/end'`。
- `SessionEventMap['assistant/message']` 全文（多行、未截断）：`...\@deepseek-ai\dsh-tool-cordis\lib\types\api-catalog.js:7028`（同一文本在 `...\dsh-session-reference\lib\typert.host.js:565` 等处以单行转义形式重复出现，但被行宽截断，故以 `api-catalog.js:7028` 为准）。
- `SessionEvent<T>` 信封：`...\@deepseek-ai\dsh-tool-cordis\lib\types\api-catalog.js:7020`（多行原文）。
- 发射点：`...\@deepseek-ai\dsh-agent-loop\lib\index.js:1156-1162`（成功结算：`session.append("assistant/message", {turn, step, message, usage?, stream}, {surfaceOp:"append"})`）、`1098-1112`（中断结算：`interrupted: true`）。
- `Session` 相关方法（[typert 声明]）：`...\dsh-session-reference\lib\typert.host.js:557` / `api-catalog.js:6932`
  ```ts
  get surface(): SessionSurface; get id(): SessionId; get seq(): SessionLogOffset;
  eventAt(seq): SessionEvent | undefined;
  snapshotEvents(fromSeq = SessionLogOffset(0), toSeqExclusive = this.seq): readonly SessionEvent[];
  ownEvents(): readonly SessionEvent[];
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts): SessionEvent<T>;
  requestHeader(); requestContext(); toolHistory();
  deriveMessages(): Message[]; deriveEventMessage(event): Message | null;
  ```
- 语义说明（surface / 模型可见性 / 插件投影）：
  - `...\@deepseek-ai\dsh-session\README.md:50`（surface 事件必须带 `surfaceOp`；`assistant/message` 内嵌 stream 且禁止 `sourceEventSeqs`）
  - 同文件 `100`（event sourcing；`assistant/message` 携带组装后的消息 + 紧凑流；`assistant/attempt` 不加模型历史）
  - 同文件 `127`（**“Plugin-owned projections change derived content without mutating recorded messages.”**）
  - 同文件 `157`（模型实际收到的是 `system/developer/user/assistant/tool/result` 五类 surface 条目「with logged projections applied」）

### 未证实 / TBD
- `AssistantMessage` 与 `ContentBlock`（`text` / `tool-call` / `reasoning` / `image`）的 TS 声明原文未定位（同因 `.d.ts` 被剥离）。已知字段来自实现：`tool-call` 块为 `{ type, id, name, arguments: string }`（`...\dsh-llm-pi-ai\lib\index.js:1615-1626`）、`text` 块为 `{ type:'text', text }`（同文件 `1555-1564`）。→ 编码前建议补读 `dsh-llm/lib/types/message.js` / `content.js`。
- 「插件投影改写派生消息」的**运行时注册点**未证实是否存在于 `ctx.sessionProjections`（该 service 是 `ProjectionUnit` 表，按 `README.md:116-120` 「registers nothing model-facing」）；`Session.create(..., projections?: readonly SessionMessageProjection[])`（`api-catalog.js:6932`）暗示投影是**构造期**传入。→ 若要「把已损坏的 assistant 文本对模型隔离」，目前只有两条候选路径：**(a) `llm/stream` 改写 `options.messages`（见 §4）**、**(b) SessionMessageProjection（构造期，插件不可用）**。建议按 (a) 设计。

---

## 4. `LlmCallConfig` 形状；`agent/request` 能否改写模型可见历史

### 结论

- **`messages` 不在 `LlmCallConfig` 里。** 它只含路由/采样控制项：
  ```ts
  export interface LlmCallControls {
      reasoningEffort?: ReasoningEffortId;
      temperature?: number;
      maxTokens?: number;
      stop?: string[];
  }
  export interface LlmCallConfig extends LlmCallControls {
      provider: string;
      model: string;
  }
  ```
- 因此 **`agent/request`（waterfall → `LlmCallConfig`）只能替换 provider/model/温度/上限/stop，不能改写模型可见历史（messages）**。
- 真正带 `messages` 的是 **`GenerateOptions`**（provider 请求的最终形态），而它是 **`llm/stream` waterfall 的 `options`**：
  ```ts
  export interface GenerateOptions {
      provider: string; model: string;
      reasoningEffort?: ReasoningEffortId;
      messages: RequestMessage[];      // ← 模型可见历史在这里
      system?: string;
      tools?: ToolSchema[];
      toolHistory?: ToolHistory;
      temperature?: number; maxTokens?: number; stop?: string[];
      signal?: AbortSignal;
      sessionId?: Branded<'SessionId'>;
      purpose?: 'compaction' | 'session-title';
  }
  ```
  - 事件契约：`'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>`（waterfall，**围绕每一次流式模型调用**，含 retry/replay/routing）。
  - `sessionId` / `purpose` 可用来把改写限定到「本会话、非 compaction/title 调用」。
- 另一条「进入 step 的输入」钩子是 **`agent/pre-step`**（waterfall）：
  ```ts
  'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
                  next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  ```
  > “Reject a proposed step or replace the messages that enter it.”
  - 注意：这里替换的是**即将进入该 step 的 `UserMessage[]`**（inbox/prompt 侧），**不是**已落盘的 assistant 历史。

**对「隔离已损坏的 assistant 文本」的可用性判定：**
- ❌ `agent/request`：不含 messages，做不到。
- ⚠️ `agent/pre-step`：只能换「即将进入本 step 的 user 消息」，不能删/改上一条 assistant 文本。
- ✅ `llm/stream`：`options.messages` 就是模型真正读到的数组，可在此过滤/替换 → **这是唯一确证可用的「对模型隔离」点**（代价：全局 waterfall，需按 `sessionId`/`purpose` 收窄，且要保证缓存/一致性策略不被破坏）。
- 另注：`callConfigEquals` 说明变化会被**记录 header 快照**而不是静默漂移（只比较 provider/model/reasoningEffort/temperature/maxTokens/stop）。

### 证据
- [typert 声明] `<dsh-install>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-llm\lib\typert.host.js:360`（`GenerateOptions` 多行原文）、`:392`（`LlmCallConfig`）、`:400`（`LlmCallControls`）；同版本多包重复（`dsh-agent-preset-registry\lib\typert.host.js:573,581`、`dsh-api-session-controller\lib\typert.host.js:2503,2511`、`dsh-tool-cordis\lib\types\api-catalog.js:5504,5844,5852` 等）。
- `callConfigEquals` 逐字段比较：`...\@deepseek-ai\dsh-llm\lib\types\call-config.js:18-28`；模块 JSDoc `1-7`（“request waterfalls replace them and the loop logs changed snapshots instead of allowing silent per-call drift”）。
- `agent/request` 使用点（只产出 config，随即 `llm.prepareCall(config)`）：`...\@deepseek-ai\dsh-agent-loop\lib\index.js:1191-1206`。
- `agent/request` 事件契约（`cordis_inspect_query` host/Event/listEvents，原文）：
  ```json
  { "name": "agent/request", "description": "Replace the frozen call configuration.", "mode": "waterfall",
    "signature": "'agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>" }
  ```
- `agent/pre-step` 事件契约（同上，原文）：
  ```json
  { "name": "agent/pre-step", "description": "Reject a proposed step or replace the messages that enter it.", "mode": "waterfall",
    "signature": "'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>" }
  ```
- `llm/stream` 事件契约（同上，原文）：
  ```json
  { "name": "llm/stream", "description": "Waterfall around every streaming model call (retry, replay, routing).", "mode": "waterfall",
    "signature": "'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>" }
  ```

### 未证实 / TBD
- `PreStepDecision` 的字段原文（`messages` / `kind: 'reject'` 等）未定位；`agent-loop:960-968` 的实现只显示用到 `decision.kind === 'reject'` 与 `decision.messages`、`decision.startsRequestSeries`。(TBD)
- `RequestMessage` / `ToolSchema` / `ToolHistory` 的字段未逐一定位。(TBD)
- `llm/stream` 改写 `messages` 的**合法性/一致性代价**（是否触发 request-header 快照、是否影响 prompt cache、是否被 `markAgentLoopRequest` 校验）未证实 —— 需要时补读 `dsh-llm/lib/index.js` 的 `LlmRuntime.stream` 与 `dsh-llm/lib/types/assembler.js`。

---

## 附：一页速查（给插件实现者）

| 需要做的事 | 用什么 | 关键证据 |
| --- | --- | --- |
| 注入预防性 system prompt 规则 | `systemPrompt.section(...)` / `system-prompt/assemble` waterfall | Service `systemPrompt`：`section`/`context`/`tools`/`variable`/`assemble`；事件 `'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next) => Promise<PromptAssembly>` |
| 检测「本 step assistant 只吐文本、无 tool-call」 | `ctx.on('session/event')` + `event.type==='assistant/message'` | §3；`agent-loop:1164-1165` |
| 同 turn 内自愈（注入纠正提示让模型继续） | `agent/turn-stopping` listener 里 `agent.inject(createUserMessage({content, source:{kind:'runtime-context'}}))` | §2；`agent-loop:1000-1008` |
| 拒绝/干预工具参数（native 分发） | `tools/pre-execute` waterfall（`ToolExecution` → `PreToolDecision`）；`tools/execute` 可在分发外围做超时/指标 | Event 目录；`'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>` |
| 对模型隔离已损坏文本 | `llm/stream` 改写 `options.messages`（按 `sessionId`/`purpose` 收窄） | §4 |
| 注册一个新工具 | `defineTool({...})` + `ctx.tools.register(def)`（`inject = ['tools']`） | §5 |
| 出厂包 + patch | `package.json(dsh.bundle.patch)` + `index.js(apply)` + `cordis.patch.yml(- insert:)` + `locale/*.json` + `icon.svg` | §6 |

**「静默失败」判定链（本插件的核心可行性结论）：**
```
模型文本里出现 </invoke>/<parameter>（或任何非原生 tool_call 的信封）
  → provider 只上报 text 块（无 tool-call）
  → agent-loop:1164 toolCalls.length === 0
  → agent-loop:1165 return {kind:'completed'}     ← 不报错
  → tools/pre-execute 永不触达                    ← 插件拦不到
  → agent-loop:1000 turn-stopping 触发             ← 唯一挽救点
  → 在 listener 内 agent.inject(纠正提示)          ← next-step 非空
  → agent-loop:1007 不 break → 同 turn 继续         ← 自愈
```

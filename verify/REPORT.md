# 独立验证报告 **v9** · 结构化输出守卫（task-4 / verifier）

> 验证者：teammate `verifier`。写入范围仅 `verify/`；**未**改动 `plugin/`、`tests/`，**未**安装任何东西，**未**改 profile。发现问题只记录并回报，由 owner 修。
> **本 v9 取代 v8**：v8 之后新增 **M9/R18（idle compaction）**，发布版本 **0.3.0**（提交 `2eccb68`）。本轮另修了两条**我自己的硬编码预期**（见 §0 末）。
> 每条结论绑定 §1 的哈希；`run-all.sh` 跑前/跑后哈希一致。
> 公开发布隐私说明：`verify/` 也在公开仓库中，本目录不含本机账号名（`run-all.sh` 用 `ls -lg`）。

## 0. 结论

**一句话：达标，全绿，零未解决缺陷。** `probe.mjs` **539 / 0**、`probe-index.mjs` **149 / 0**、作者测试台 **193 / 0**（版本 0.3.0）。

| 对象 | 基线哈希 | 我的独立结果 |
| --- | --- | --- |
| `plugin/src/detect.js` | `59e657799366eff2cb5fe7b2441190195578e495eaeb4697d57612d9d2e54b0a` | `verify/probe.mjs` → **539 PASS / 0 FAIL** |
| `plugin/index.js` | `5f12074a2d01e7866a396805441d6821892a84dfc6600811222039c155df30b9`（工作树；HEAD 仍是 `2eccb68`） | `verify/probe-index.mjs` → **149 PASS / 0 FAIL** |
| `tests/run.mjs` | `b04e04c52beb01a5d11db38c10f6d0d30922052becf3d115a9f97f8e1cc47946` | 我独立执行 → **193 PASS / 0 FAIL** |
| `docs/INTERFACE.md`（R1–R18） | `1ce7719067820f547f1864706cd49c6a6feb55588e3fd5861d2e890b78081e55` | R18 与实现一致；**15 个配置键**已文档化 |
| `plugin/package.json` / `cordis.patch.yml` | `04d798f6…` / `75e52805…` | 0.3.0；patch `autoCompact: false`（默认关，刻意） |

### M9/R18（最重要的一条）：**接口不是 D-12 同型的幻影，已用运行时契约正查**
lead 明确要求确认 `ctx.get('compaction')` 是否真的挂载。我用 **`cordis_inspect_query`(host/Service/listService)** 取到**当前 profile 的运行时服务目录**，`compaction` **在册**，且契约逐条对上：

| 插件用法 | 运行时契约原文（我的查询结果） | 判定 |
| --- | --- | --- |
| `ctx.get('compaction')`（并检查 undefined/非函数） | access.optional：`ctx.get("compaction")`，**`requiresUndefinedCheck: true`** | ✅ 与声明一致（可选依赖就要判空，插件确实判了） |
| `compactIfNeeded({session, options:{}}, 'context-overflow', abort)` | `abstract compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult \| null>` | ✅ 参数个数/顺序一致 |
| 第一参 `{session, options:{}}` | `CompactionAgentContext = { session: Session; options: { provider?: string; model?: string } }` | ✅ 形状一致 |
| trigger `'context-overflow'` | `CompactionTrigger = 'pressure' \| 'context-overflow'` | ✅ 是合法字面量 |
| 引用的机制前提 | "context-overflow policy **may force a useful balanced reduction even below the normal threshold**"；"A successful run **replaces the selected surface span with one summary node**" | ✅ 原文一致（lead 引用无误） |

**⇒ M9 走的是 harness 的真实正路，不是又一次"读了一个不存在的接口"。** 我把这条做成静态锁（`probe-index §6d (g)`）：源码里的调用形状必须匹配 `compactIfNeeded({ session, options: {} }, 'context-overflow'`。

### 独立覆盖（`probe-index §6d`，20 条，全绿）
用假 ctx（可记录 `ctx.get('compaction')` 与 `compactIfNeeded` 调用）+ 假 `agent/status`，并把内部日志导向临时文件后读回（`debugLog`）：
- ✅ `autoCompact:false` → **一次都不调用**、也无 `status.compacted`；
- ✅ 非 idle（`running`）→ 不调用；idle + 未污染 → 不调用；
- ✅ idle + 已污染 → **恰好一次**，参数 `({session, options:{}}, 'context-overflow', AbortSignal)` 且 **`ctx.session === agent.session`**；
- ✅ 成功 → 记 `status.compacted`（含 `shadowedSeqs` / `shadowedTokens`）；**每 session 最多一次**（第二次 idle 不再调用）；
- ✅ **服务缺失** → 不抛，且显式记 `status.compact-skip` + `no-compaction-service`（R5 精神）；`agent.session` 缺失 → 记 `status.compact-skip` + `no-session`；
- ✅ **同步抛错** → 不冒泡，记 `status.compact-failed`；**rejected promise** → 被 rejection handler 接住（非未被处理），记 `status.compact-failed`；
- ✅ **不 await**：`compactIfNeeded` 永不 settle 时 listener 仍立即返回 `undefined`（<50ms）。

### 本轮修掉的两条"我的硬编码预期"（lead 指出，非插件缺陷）
1. `probe.mjs`：删掉手抄的 `KNOWN_KEYS`。**键集合一律从 `DEFAULT_CONFIG` 推导**；值表只冻结值（新增 `autoCompact: false`）；并新增**派生交叉校验**：从 `INTERFACE` 文本解析 `共 N 个键` 与实得键数比对。顺带补了 R18 的 `mergeConfig` 回退断言。
2. `probe-index.mjs`：允许事件集加入 **`agent/status`**（M9 的挂点）。

---

## 1. 基线 / 复现方式

```bash
bash verify/run-all.sh          # 哈希守护 + node --check + manifest + 作者测试台 + 两个 probe
node verify/probe.mjs           # detector 契约 + 攻击性 + D-10/D-11（539/0）
node verify/probe-index.mjs     # 接线（M4 两档 / M7 / M9 / M5 收手态）（149/0）
node verify/corpus-recall.mjs   # 全部真实会话：D-10/D-11 增量分离复算
node verify/session-trace.mjs 929b19b0 25   # 真实 turn 重建（R11 阳性 + D-11 现场）
```

基线：`git HEAD = 2eccb68`（release 0.3.0），node `v24.19.0`，Windows。
对比基准：`verify/_pre-d10-detect.mjs`（`4ea090ce`）、`verify/_pre-d11-detect.mjs`（`16227b7b`），均已落盘。

---

## 2. 契约核对（R14–R18）

| 裁定 | 结果 | 证据 |
| --- | --- | --- |
| **R15**（D-11 伪造工具结果标记）三点：影响面收口 / 护栏 / 零漂移 | ✅ | probe §5c（三变体 + 5 类护栏 + 3 类作用域；与 pre-D-11 逐字节对比 8 fixture 相同） |
| **R16**（M7 fork 简报）：读 `agent.session.header`；spread；不 reject；每 session 一次；异常返回原 decision | ✅ | probe-index §6c（含 **D-12 回归锁**：只有 `session.events` 的 agent 不得被简报 + 静态断言不读 `.events`） |
| **R18**（M9 idle compaction）：挂点 `agent/status`；仅 idle；仅已污染；每 session 一次；不 await；三种日志；异常不冒泡；`autoCompact` 默认 false | ✅ | probe-index §6d（20 条）+ §0 的运行时契约正查 |
| R9 / R10 / R11 / R12 / R13 / R14 既有断言 | ✅ | probe / probe-index 对应段全绿 |

`DEFAULT_CONFIG` 现 **15 键**（R9 +1、R10 +2、R12 +2、R16 +2、R18 +1 相对最初 7 键）。

---

## 3. `plugin/src/detect.js` 契约核对

暴露 8 项/ESM/零依赖 ✅；`DEFAULT_CONFIG` 15 键、**键集从模块推导**、每个键都必须在 INTERFACE 有文档、且**契约文本声明的键数**与实得一致 ✅；声明键值逐条冻结 ✅；R3/R7 ✅；R5 ✅；§1 形状/evidence/R1 真值表 ✅；3 正例 + 5 反例 ✅；R2/R4/R6/R8 ✅；R14 零漂移/召回 ✅；R15 ✅；不抛（Symbol/BigInt/循环/Proxy/`Object.create(null)`/抛异常 getter）✅；不改入参/幂等/不打日志/无 payload 泄漏 ✅；`buildCorrectionMessage`/`buildDenyReason` ✅；code 集合（9）不变 ✅。

---

## 4. `plugin/index.js` 接线核对（mock ctx 真实执行）

- **注册集**（从事件集合推导）：`CORE_EVENTS` = pre-execute / post-execute / session/event / agent/turn-stopping / **agent/pre-step** / **agent/status**；`OPTIONAL_EVENTS` = `llm/stream`（M5 已收手）。当前 **6** 个注册，无越界事件。
- M1 已移除（回归断言）✅；M2 ✅；M3（R9）✅；M4（R11/R13 两档）✅；M5（收手态）✅；M7/R16 ✅（含 D-12 回归锁）；**M9/R18** ✅（20 条）。

---

## 5. 攻击性输入（全部通过）

非字符串入参、5 MB 文本/标签、≈2.6 MB 调用标记串、10 万 `<`+10 万 `>`、深 31 层/221 叶子（按 R8 有界）、循环引用、良性/敌意 Proxy、Symbol/BigInt/函数/抛异常 getter、正常 HTML、短文档含孤立闭合标签、大 payload + 尾 `</invoke>`×2、30000 字符单行、`\r\n` 混排、6 篇整文档不 deny；`sanitizeMessages` 非数组/畸形/循环/Proxy/深冻结；D-10 零漂移 6 类 + 前缀方言 4 类；D-11 三变体 + 5 类护栏 + 3 类作用域；**M9 的异常/缺服务/永不 settle 三类**。

## 5b. 语料与现场（独立重建，沿用 v8 结论）

- **语料**（`verify/corpus-recall.mjs`，逐帧解 zstd，对每条 assistant 文本同时跑当前与两份基线）：`damagedOnlyViaD11 = 1`，正是 **`session-929b19b0-…`**（43 字符伪造结果，`hasResultMarkup=true`）；`damagedOnlyViaD10` 随语料增长而变（**绝对数不是基线**，稳定的是"每个增量 ≥1 且 D-11-only 命中该 session"）。
- **真实 turn 重建**（`verify/session-trace.mjs 929b19b0 25`）：step1 damaged(calls=0) → **step2 模型真的重发 `run_code`(calls=1)** → step3 成功 → step4 damaged → step5 即 D-11 的 43 字符伪造结果；原始日志中可见 **tier 1 与 tier 2 两条 `inbox/spliced` 注入**。→ **R11 首次真实阳性**。

---

## 6. 缺陷清单

| 编号 | 状态 | 摘要 |
| --- | --- | --- |
| **D-12** | **已解决**（本轮验证期间发现并修复） | M7 读了不存在的 `agent.session.events` → 简报静默 no-op；`f7c9d3c6` 改为 `session.header`，契约同步更正，探针留**回归锁** |
| D-11 / R15 | 已解决 | 伪造工具结果标记（真实故障驱动） |
| D-10 / R14 | 已解决 | 命名空间前缀方言（真实故障驱动） |
| **D-8**（M5） | **已确认能力缺失 · 按用户决策不做** | `llm/stream` 收到冻结请求 → 原地写必抛；接线移除、纯函数保留 |
| D-0 / D-1 / D-5 / D-6 / D-7 / D-9 / D-13 | 已解决 | source kind / R6 判据 / 契约同步 / `debugLogPath` 推导 / patch 开关 / §R12 矛盾 / 键集硬编码 |
| 探针自身缺陷 | 已修 | 7 键冻结、硬编码注册数、`sections[0]` 无保护解引用、D-9 将来时误判、D-10 取样、D-11 过严、**本轮：`KNOWN_KEYS` 手抄 + 漏 `agent/status`**、**M1 静态守卫过严**（"代码里不得出现 `systemPrompt` 字样" → 被 M9 挂载探针把 `'systemPrompt'` 当服务名列出而误伤；已收紧为"不得出现 `ctx.systemPrompt` 访问或 `systemPrompt.section` 注册"这一真正不变量） |

### D-8 证据链（保留；重新接线前必须解决）
`dsh-agent-loop/lib/index.js:1214` `buildRequest` → `:1281` `Object.freeze({...messages...})`（`:1280` 冻结数组、`:1277` deepFreeze 每条）→ `:1084` `llm.stream(request)` → `dsh-llm/lib/index.js:2397` 的 `llm/stream` waterfall。冻结复现保留在探针（重新接线时若未先查冻结会转红）。

---

## 6b. 失败类教训：**"看起来合理、其实不存在的接口"**

**形状**：读写一个**看似合理、实际不存在/不被接纳**的接口或取值；失败被 try/catch 或默认分支无声吞掉 → 机制什么都不做、不报错，而单测用"被发明的那套形状"搭台 → **全绿却无效**。

| # | 实例 | 被误用/缺失的东西 | 真实契约 | 后果 | 抓法 |
| --- | --- | --- | --- | --- | --- |
| 1 | **D-0** | `source: { kind:'plugin', … }` | `MessageSourceMap`；`assertV4MessageSources` 对 `kind==='plugin'` 抛 `SessionFormatError` | 注入消息可能让会话不可读 | 读 `MessageSourceMap` + v3→v4 迁移代码 |
| 2 | **D-8 / M5** | 对 `options` 原地写 | 机制依据成立，但**该引用被 deep-freeze** | M5 完全失效 | 追 `buildRequest:1281` 的冻结链 + 冻结复现 |
| 3 | **D-12 / R16** | `agent.session.events` + `type==='session'` | `Session` 只有 `header`；无裸 `'session'` 事件 | fork 简报永不注入 | typert 声明 + 运行时 `Event` 目录 + 实解 session 文件头 |

**M9 是这条线上第一个"先正查契约、再信任接缝"的机制**（可作为正面对照）：
1. 用 `cordis_inspect_query`(host/Service) 确认 **`compaction` 在运行时目录里真的挂载**，并取到 `access.optional: ctx.get("compaction") / requiresUndefinedCheck: true`；
2. 逐字比对参数与字面量（`CompactionAgentContext` / `CompactionTrigger = 'pressure'|'context-overflow'` / `AbortSignal`），并核对 lead 引用的机制前提原文；
3. 把调用形状**钉成静态锁**（§6d (g)），未来签名漂移会转红；
4. 缺服务时**显式记 `status.compact-skip`**，而不是静默什么都不做。

**纪律（建议固化）**：只从 typert 声明或运行时 inspect 取接口；缺失即显式记录而非静默兜底；每个机制都要现场级验收（mock 全绿不足以放行）；每个修好的实例留回归锁。

---

## 7. 未闭合项（均非缺陷）

1. **M9 的真实效果**：机制已独立验证，但 INTERFACE R18 自己标注"效果尚未在真实会话中观测到"——需要一次 `autoCompact:true` 的真实会话：预期 turn 结束后 idle 时出现 `status.compacted`，且**下一个 turn 不再模仿坏样本**。（且压缩是**真实付费摘要调用**，必须由用户显式开启。）
2. **R16/M7 的有效性**：机制已打通（D-12 已修），但"模型是否真的停止模仿"仍需一次真实 fork 验收。
3. **M3 真实会话不再误报**：unit/mock 已按 R9 判定，现场确认待做。
4. **tier 2 的相对有效性**：tier 1 已被现场证明能让模型重发调用；tier 2 尚未单独观测。

---

## 8. 未能验证 / 已知边界

- Cordis `ctx.effect` 卸载语义（只验证"被调用 + 返回 disposer + 调用不抛"）。
- `exec.schema.parameters` 真实形状（V4 守卫在其上取 `required`；mock 全覆盖，最坏不拦截）。
- **`compaction` 的实现体**：我确认了服务**在册**且契约一致，但没有在插件运行中真正触发一次真实压缩（默认关 + 会产生付费调用，按 AGENTS.md §1 未获授权，故**不触发**）。
- 语料持续增长 → 绝对数不是基线。
- **上游在验证过程中持续写入 `plugin/index.js`**：`2d13e30b` → `53131363`(0.3.0) → `02654eba` → `314e0b16` → **`5f12074a`**（当前工作树，HEAD 仍是 `2eccb68`）。我在每个快照上跑 probe，结果恒为 **539 / 149 / 193 全绿**；最终一轮 `run-all.sh` 前后哈希一致（`5f12074a`）。**任何后续改动都需重跑。**
- **这些未提交改动是"挂载探针"，不是新机制**：① activation 行里多记 `compactionService: <bool>`；② 首次事件时记一次 `{where:'probe.compaction', available, at:'event-time'}`，并且会**同时探测多个已知在册服务**（`compaction/commands/llm/session/tools/agentLoop/systemPrompt`）——这样"compaction 读不到"可与"`ctx.get` 这个访问器本身不对"区分开。理由是 Loader 行按序激活，activation 时可能还看不到 `compaction-basic`，所以要**在真正查询的那一刻**再确认。**这正是不再"假设接缝存在"（D-12 教训）**；我已为它加 4 条断言（§6d (h)），它不改变 M9 的对外行为。
- **`compaction` 的实现体**未在插件运行中真实触发（默认关 + 会产生用户账户上的付费摘要调用，按 AGENTS.md §1 未获授权，故意不触发）。

---

## 9. 修订变更日志

| 文件 | 观测序列 |
| --- | --- |
| `plugin/src/detect.js` | … → `89a93d1f`(D-11) → **`59e65779`**(当前) |
| `plugin/index.js` | … → `f7c9d3c6`(修 D-12) → `2d13e30b`(M9) → `53131363`(0.3.0) → `02654eba` → `314e0b16` → **`5f12074a`**(挂载探针，未提交，当前工作树) |
| `docs/INTERFACE.md` | … → `2890c973`(R16 更正) → **`1ce77190`**(R18，当前) |
| `plugin/package.json` | … → `c26fac16` → **`04d798f6`**(0.3.0，当前) |
| `plugin/cordis.patch.yml` | … → `d0167b5b` → **`75e52805`**(当前；`autoCompact:false`) |
| `tests/run.mjs` | … → **`b04e04c5`**(当前；193 PASS / 0 FAIL) |
| git | … → `aa5ad76`(M7/R16+D-12) → **`2eccb68`**(release 0.3.0，当前 HEAD) |

---

## 10. 复现命令

```bash
bash verify/run-all.sh                      # 全量 + 哈希守护 → 全绿
node verify/probe.mjs;      echo $?         # 539 PASS / 0 FAIL
node verify/probe-index.mjs; echo $?        # 149 PASS / 0 FAIL
node verify/corpus-recall.mjs               # D-10/D-11 增量分离
node verify/session-trace.mjs 929b19b0 25   # 真实 turn 重建（R11 阳性 + D-11 现场）
node verify/repro-d1.mjs                    # D-1 三例（历史）
sha256sum plugin/src/detect.js plugin/index.js docs/INTERFACE.md
```

## 附：本次验证产出

| 文件 | 用途 |
| --- | --- |
| `verify/probe.mjs` / `verify/probe-out.txt` | detector 契约 + 攻击性 + D-10/D-11 + 派生键集校验（539/0） |
| `verify/probe-index.mjs` / `verify/probe-index-out.txt` | 接线：M4 两档 / M7（D-12 回归锁）/ **M9 20 条（含挂载探针）** / M5 收手态（149/0） |
| `verify/corpus-recall.mjs` / `verify/corpus-recall-out.txt` | 真实语料的 D-10/D-11 增量分离复算 |
| `verify/session-trace.mjs` / `verify/session-trace-out.txt` | 单会话 turn 重建（R11/D-11 现场取证） |
| `verify/_pre-d10-detect.mjs` / `verify/_pre-d11-detect.mjs` | 两份基线快照 |
| `verify/run-all.sh` / `verify/run-all-out.txt` | 可复现全量 battery（哈希守护；`ls -lg` 不泄漏账号名） |
| `verify/tests-run-out.txt` | 作者测试台独立执行（193 PASS / 0 FAIL） |

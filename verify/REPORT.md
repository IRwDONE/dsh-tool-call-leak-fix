# 独立验证报告 **v7** · 结构化输出守卫（task-4 / verifier）

> 验证者：teammate `verifier`。写入范围仅 `verify/`；**未**改动 `plugin/`、`tests/`，**未**安装任何东西，**未**改 profile。发现问题只记录并回报，由 owner 修。
> **本 v7 取代 v6**：v6 之后新增 **D-10/R14（命名空间前缀方言）** 与 **R11/R13（M4 有界二次升级）**，本轮全部独立复核；v6 的 D-9 已由 owner 修好。
> 每条结论绑定 §1 的哈希；`run-all.sh` 跑前/跑后哈希一致。上游若再写入，需按 §1 重跑。
>
> **公开发布说明（2026-10-30，继承自 v6）**：为公开发布做过**隐私清理 + 历史压缩**。提交历史被压缩，本报告 §9 引用的旧提交号（如 `fe549ba` / `0b9f631`）在公开仓库中**不存在**；**文件级 sha256 基线不受影响**——被清理的只是本机绝对路径与账号名（`C:\Users\<user>\...`、`<repo>`、`<dsh-install>` 等占位符），检测器与插件代码**逐字节未变**。
> **本 v7 追加的隐私处理**：`verify/` 也是公开追踪的，本轮把 `run-all.sh` 的清单步骤从 `ls -la` 改为 `ls -lg`（去掉 owner 列），并重生成全部捕获输出；随后用本机账号名做了一次全目录扫描，现为 **0 命中**（本报告自身也不再出现该串）。

## 0. 结论

**一句话：达标且全绿；唯一未闭合项是"有效性"验收而非缺陷** —— D-10/R14 与 R11/R13 的**机制**已独立验证；R11/R13 的**真实有效性**（真实故障下模型是否真的重做那一步）仍未被观测到，`docs/INTERFACE.md` 自己就如此标注（§R11/R13 的"诚实标注"），本报告不弱化它。

独立结果（哈希前后一致）：

| 对象 | 基线哈希 | 我的独立结果 |
| --- | --- | --- |
| `plugin/src/detect.js` | `16227b7baf2b4686ddaae5aba7aa50aff29ca808501c550971f389b1174a67fd` | `verify/probe.mjs` → **480 PASS / 0 FAIL**（exit 0） |
| `plugin/index.js` | `9d038734b249ef3b68ab771a65aa5497fba60cc7a8735f81b4b304f02f164292` | `verify/probe-index.mjs` → **102 PASS / 0 FAIL**（exit 0） |
| `tests/run.mjs`（作者测试台） | `c51ff70dc579105d65ce77eea84bcccdca2c48bf77c8fc83a6a846e2166e0248` | 我独立执行 → **187 PASS / 0 FAIL**（exit 0） |
| `docs/INTERFACE.md`（契约，R1–R14） | `08a80ce9c4b9b9d2243730c0a24c1aff87fcdfd2286956287659df495de94810` | R1–R14 逐条核对 |
| `plugin/package.json` / `cordis.patch.yml` | `c26fac16…` / `3ec76bfa…` | manifest 合法；patch 显式 `maxCorrectionsPerTurn: 2` |

**D-10（R14）零漂移 + 召回，我都独立复算**（不是复述 lead 数字）：
- **零漂移**：6 类含冒号但非命名空间调用标签的输入（URL、属性里的 URL、`<svg:path>`、`<http://x/>`、普通 HTML、XML 命名空间声明）→ 全部 `damaged=false`，且与 **pre-D-10 检测器逐字节同判**；**8 个既有 fixture 的 findings+evidence 与 pre-D-10 完全相同**。
- **召回**：4 类 `<antml:...>` 前缀方言（V2 缺开场 / 尾部结束序列增殖 / 结构截断 / 正文泄漏）→ 现在全部 `damaged=true` 且命中预期 code，且**在 pre-D-10 上全部 `damaged=false`**（直接对比，非推断）。
- **语料级**（全部 75 个真实会话，多帧 zstd 逐帧解）：三次运行里 **`damagedOnlyViaD10` 恒为 1**，且恒是同一个 **`session-c8741511-…`**（原始文本 `hasNamespacePrefix=true / hasBareInvoke=false / hasBareParameter=false`）；绝对数随日志追加而增长，详见 §5b。

**R11/R13（M4 有界二次升级）已独立验证**：tier 1 = `【立即执行】…` + B 段；tier 2 = 丢掉长解释、只给硬短指令 + 判定 code；上限由 `maxCorrectionsPerTurn` 约束；默认仍为 1、**patch 显式为 2**；每 turn 重置；注入文本是 `buildCorrectionMessage()` 的**超集而非全等**（R11 明示）。

---

## 1. 基线 / 复现方式

```bash
bash verify/run-all.sh          # 哈希守护 + node --check + manifest + 作者测试台 + 两个独立 probe
node verify/probe.mjs           # detector 契约 + 攻击性 + D-10/R14（480/0）
node verify/probe-index.mjs     # 接线（含 R11/R13 两档、M5 收手态）（102/0）
node verify/corpus-recall.mjs   # 全部真实会话的 D-10 召回/零漂移复算（独立逻辑）
node verify/repro-d1.mjs        # D-1 三例（历史）
```

产出：`verify/probe-out.txt`、`verify/probe-index-out.txt`、`verify/tests-run-out.txt`、`verify/corpus-recall-out.txt`、`verify/run-all-out.txt`。
基线：`git HEAD = ee911b0`，node `v24.19.0`，Windows。
**D-10 对比基准**：`verify/_pre-d10-detect.mjs` = `git show 0fc8402^:plugin/src/detect.js` 的快照，sha256 前缀 **`4ea090ce`**（正是 v6 的 detect.js），已落盘，重跑不依赖 git 历史。

---

## 2. 契约逐条核对（R9 / R10 / R12 / R13 / R14）

### R14（D-10：命名空间前缀方言）
| 契约条目 | 结果 | 证据 |
| --- | --- | --- |
| 结构分析跑在"去前缀影子副本"上；`(?!\/)` 排除 URL；标识符须字母/下划线开头 | ✅ | probe §5b（6 类零漂移用例） |
| **不含冒号的文本返回同一字符串**（零漂移） | ✅ | probe §5b：8 个 fixture 的 findings+evidence 与 pre-D-10 **完全相同** |
| 数值证据（行数/字符数/`</` 计数）仍取自**原文** | ✅ | probe §5b (d)：`evidence.length`/`closingTagCount` 与原文一致 |
| 作用域 = `scanAssistantText` + `scanToolArguments` 的结构检查 | ✅ | probe §5b（assistant 侧）；leaf 侧由既有 §6/§7 断言 + 前缀用例覆盖 |
| `sanitizeMessages` 自动继承 | ✅ | probe §5b (e) |
| R4 双门槛 / R6 起头门槛 / 叶子 UNPAIRED 降 info **均不放宽** | ✅ | probe §7b/§7 与 v6 相同断言仍全绿 |
| 语料级验收 2505 / 25 / 1 | ✅（实质一致） | §5b，我独立算得 25 / 20 / 1，命中同一 session |

### R13（M4 有界二次升级）
| 契约条目 | 结果 | 证据 |
| --- | --- | --- |
| tier 1（`count===0`）：B 段 + R11 指令；`buildCorrectionMessage` 为空则不注入 | ✅ | probe-index §6a（tier-1 文本 = 指令 + B 段；B 为空的分支见代码审查） |
| tier 2（`count===1`）：丢长解释、硬短指令 + 判定 code | ✅ | probe-index §6a（无"结构校验失败"、含"第二次尝试仍失败/只发一个调用/40 行"、"（判定："） |
| 仍是有界：`count >= maxCorrectionsPerTurn` 一律不注入 | ✅ | probe-index §6a（max=2 时第三次不注入；max=1 时第二次不注入） |
| `DEFAULT_CONFIG.maxCorrectionsPerTurn` **保持 1** | ✅ | probe §1/§2（键值冻结） |
| patch 显式设 **2** | ✅ | probe-index §6a（读 `cordis.patch.yml`） |

### R11（注入必须"可执行"）
| 契约条目 | 结果 | 证据 |
| --- | --- | --- |
| M4 注入在 B 段**之前**加一行硬指令；不改动冻结的 `buildCorrectionMessage` | ✅ | probe-index §6a（`startsWith('【立即执行】')`；detect.js 未被改去承载它） |
| 注入文本 ≠ `buildCorrectionMessage()` 返回值（**超集关系**） | ✅ | probe-index §6a（`includes(b) && !== b`） |
| M3 也遵守同一原则（用自己的 reason，不复用 B 段） | ✅ | probe-index §5b（v6 断言仍在） |

### R9 / R10 / R12（延续，全部通过）
R9：kill switch、只对写入类工具、只认显式结构化证据、自由文本不抓（按有意设计）、文案不复用 B 段 ✅。
R10：`debugLog:false` 零副作用；`debugLogPath:''` → `tmpdir()` 推导 ✅。
R12：`sanitizeMessages` 纯函数纪律 + M5 停用态（无 `llm/stream` 注册、无调用点、patch 无开关、实现保留、注释含 D-8 行号与再接线规则）✅。

---

## 3. `plugin/src/detect.js` 契约核对

暴露 8 项（含 `sanitizeMessages`）/ESM/零依赖 ✅；`DEFAULT_CONFIG` **12 键**、键集从模块推导、每个键都必须在 INTERFACE 有文档 ✅；声明键值逐条冻结 ✅；R3/R7 ✅；R5 ✅；§1 形状/evidence/R1 真值表 ✅；3 正例 + 5 反例 ✅；R2/R4/R6/R8 ✅；不抛（Symbol/BigInt/循环/Proxy/`Object.create(null)`/抛异常 getter）✅；不改入参/幂等/不打日志/无 payload 泄漏 ✅；`buildCorrectionMessage`/`buildDenyReason` ✅；冻结 code 集合（9）✅；**R14 零漂移与召回** ✅。

---

## 4. `plugin/index.js` 接线核对（mock ctx 真实执行）

- **注册集**：`CORE_EVENTS`（pre-execute / post-execute / session/event / agent/turn-stopping）必注册；`OPTIONAL_EVENTS`（`llm/stream`）允许存在但非必需；数量**从 handler 集合推导**（`effects.length === handlers.size`）。当前 **4 个**注册。
- **M1 已移除**（回归断言全绿）；**M2** deny 短路 / 其余 `next()` / V4 只对非空 `required`；**M3** 恒 `await next()` + R9 规则；**M4** `session/event`→`turn-stopping`→`agent.inject()` + **R11/R13 两档**（§6a）；**M5 停用**（§6b：无注册、无调用点、patch 无开关、实现可用、注释保留；将来接线时会自动转 wired 分支并要求"冻结必须显式报告"）。

---

## 5. 攻击性输入（全部通过）

非字符串入参、5 MB 纯文本/全 `</div>`、≈2.6 MB 调用标记串、10 万 `<`+10 万 `>`（11–30 ms）、深 31 层/221 叶子（按 R8 有界）、循环引用、良性/敌意 Proxy、Symbol/BigInt/函数/抛异常 getter、正常 HTML、短文档含孤立闭合标签、大 payload + 尾 `</invoke>`×2、30000 字符单行、`\r\n` 混排、6 篇整文档不 deny；`sanitizeMessages` 另加非数组/畸形元素/循环/Proxy/深冻结输入；**D-10 新增** 6 类零漂移 + 4 类前缀方言。

## 5b. D-10 语料级复算（独立）

方法：`verify/corpus-recall.mjs` 用 lead 提供多帧解码器 `scratch/zstd-frames.mjs`（append-only zstd 必须逐帧解，Node 只解第一帧），但**计数逻辑我自己写**，并对每条 assistant 文本**同时跑当前检测器与 pre-D-10 检测器**，因此"仅 D-10 能发现"是**直接对比**得出。语料：`~/.dsh/sessions/**/session.v4.jsonl.zstd` 共 **75** 个文件。

| 指标 | run A | run B | run C（= 已落盘的 `corpus-recall-out.txt`） |
| --- | --- | --- | --- |
| assistant/message 事件 | 3533 | 3536 | **3578** |
| 其中含 ≥1 text 块 | 2533 | 2535 | **2569** |
| damaged（当前） | 25 | 25 | **27** |
| └ 无 tool-call（silentFailure 口径） | 20 | 20 | **22** |
| damaged（pre-D-10） | 24 | 24 | **26** |
| **仅 D-10 才能发现** | **1** | **1** | **1** |

那条唯一的命中：`session-c8741511-54b9-4cc9-be7e-8860fb22234f`，codes `MARKUP_LEAKED_AS_TEXT:error` + `UNPAIRED_CLOSING_TAG:warn`，`silentFailure=true`，`textLength=745`，原始文本 `hasNamespacePrefix=true / hasBareInvoke=false / hasBareParameter=false`。

**与 lead 数字的差异说明（如实）**：lead 记 `2505 / 25 / 1`。**实质结论在三次运行中稳定成立** —— `damagedOnlyViaD10` 恒为 **1**，且恒是同一个 `session-c8741511`；而**绝对数随时间单调增长**（上表 A→C：damaged 25→27，pre-D-10 24→26，分母 2533→2569）。原因有二：① 会话日志是**追加式**（append-only），只增不减；② 语料现在**包含本次验证会话自身**——我的 assistant 正文大量引用调用标记，本身就会被判 damaged。因此**绝对总量不是稳定基线**；可复算的不变量是「**D-10-only = 1，且命中 `session-c8741511`**」。lead 的 `2505` 是更早的快照。我按"含 ≥1 个 text 块的 assistant 消息"计分母；若按 assistant/message 事件总数为 3578。

---

## 6. 缺陷与处置清单

| 编号 | 状态 | 摘要 |
| --- | --- | --- |
| **D-10** | **已解决** | 命名空间前缀方言（`<antml:invoke>` 等）此前全漏 → 新增 `normalizeNamespaces`；零漂移与召回均经我独立复算（§5b） |
| D-9 | 已解决 | INTERFACE §R12 自相矛盾 → 改为将来时 + "当前并未接线" |
| D-6 / D-7 / D-5 | 已解决 | `debugLogPath` 推导 / patch 开关回退 / 键与裁定入契约 |
| D-0 / D-1 | 已解决（历史） | source kind / R6 判据方向反 |
| **D-8** | **已确认能力缺失 · 按用户决策不做** | M5 在 `llm/stream` 上永远写不进去（options 被冻结）；接线移除、纯函数保留 |

**D-10 的教训（保留）**：真实失败至少存在**三种标签方言** —— 裸标签（`<invoke`）、**带命名空间前缀（`<antml:invoke`，本次真实故障）**、以及完全无信封的正文泄漏（V3）。检测器现在容忍可选前缀，且用影子副本保证既有方言零漂移。

**D-8 证据链（保留；将来任何重新接线都必须先解决它）**：解包树 `.../dshx/dsh/node_modules/`
1. `@deepseek-ai/dsh-agent-loop/lib/index.js:1214` `buildRequest()` → **`:1281`** `markAgentLoopRequest(Object.freeze({ ...messages: boundaryMessages ... }))`；`:1280` `Object.freeze(boundaryMessages)`、`:1277` 逐条 `deepFreeze`。
2. `:1075` `const request = this.buildRequest(...)`，`:1084` `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)` → 传的就是这个**冻结对象**。
3. `@deepseek-ai/dsh-llm/lib/index.js:2397` `ctx.waterfall(this,"llm/stream",options,()=>this.adapterStream(options,prepared))`；prepared 路径 `:2249-2253` 同走 `streamWithRegistration`。
4. `dsh-llm:2328` 有 `Object.isFrozen(options) ? deepFreeze({...})` 分支 → 冻结是常规形态。
⇒ `options.messages = …` 在 ESM 严格模式下抛 `TypeError`，被 catch 吞掉 → 改写永不落地。
**可执行复现**（保留在探针；重新接线时若未先查冻结会自动转红）：
```
FAIL  M5 harness-realism: rewrite still lands when options is frozen like agent-loop builds it
      :: options.messages is the ORIGINAL frozen array (rewrite blocked)
PASS  M5 harness-realism: next() still called exactly once on frozen options (fails safe)
```

### 探针自身缺陷（已修，非插件缺陷）
曾出现：7 键配置冻结 / 硬编码注册数 / `sections[0]` 无保护解引用 / D-9 检查把"将来时规则"误判为"已实现声明" / D-10 继承用例取样不 damaged。均已修；本轮还追加了"公开仓库不得泄漏 OS 账号名"的 `ls -lg` 处理。

---

## 7. 唯一未闭合的验收项（非缺陷）

**R11 / R13 的有效性尚未在真实故障中观测到。** 机制层我已验证到位（tier 1/tier 2/上限/patch=2/每 turn 重置/前缀超集），但"模型看到注入后**是否真的重做**"这一点：
- 此前唯一的现场观测（v3 记录）是：M4 注入成功、同一 turn 内多开一步，但 **step 19 只有 45 字符文本、没有真正重做**。
- R13 正是由"一次没拦住（模型又写坏、把 23 KB 当正文吐出来）"的真实证据驱动；但 INTERFACE §R13 自己也标注"tier 2 的**有效性尚未在真实故障中观测到**"。
- **结论**：当前自愈能力达到"**不静默关闭 + 有界二次升级**"，**未**达到"已证实能救回真实故障"。这是唯一未闭合项，本报告不弱化。

（另：M3 修复后"真实会话里不再误报"仍需一次现场确认。）

---

## 8. 未能验证 / 已知边界

1. **R11/R13 真实有效性**（见 §7）——唯一未闭合验收。
2. **M3 现场不再误报**：unit/mock 已按 R9 判定，现场确认待做。
3. **Cordis `ctx.effect` 卸载语义**：只验证到"被调用 + 返回 disposer + 调用不抛"。
4. **`exec.schema.parameters` 真实形状**：V4 守卫在其上取 `required`；mock 分支全覆盖（最坏不拦截）。
5. **Config 投影**：`listConfigs` 仍 `status:"unsupported"`（无 JSON-Schema 表单）。
6. **URL 护栏不可行为观测**：`(?!\/)` 属纵深防御（即便误剥，`<http://x/>` → `<//x/>` 也不是调用标记）；probe 只证明"无判据漂移"。
7. **上游/语料都在动**：会话日志持续追加（分母漂移见 §5b）；若 `plugin/` 再变，按 §1 重跑。

---

## 9. 修订变更日志（`stat`/`sha256` 实测）

| 文件 | 观测序列 |
| --- | --- |
| `plugin/src/detect.js` | … → `4ea090ce`(R12) → **`16227b7b`**(R14/D-10，当前) |
| `plugin/index.js` | … → `3de47da7`(M5 停用) → **`9d038734`**(R11/R13 两档，当前) |
| `docs/INTERFACE.md` | … → `e91269d3`(D-9 修复) → **`08a80ce9`**(R11/R13/R14，当前) |
| `plugin/cordis.patch.yml` | … → `11fd098c` → **`3ec76bfa`**(`maxCorrectionsPerTurn: 2`，当前) |
| `plugin/package.json` | … → `4510ae71` → **`c26fac16`**(公开发布元数据，当前) |
| `tests/run.mjs` | … → `8c101540` → **`c51ff70d`**(R14 断言，当前；187 PASS / 0 FAIL) |
| git | … → `4f4b585`("Initial public release") → `37b1865`(R13) → `0fc8402`(D-10) → **`ee911b0`**(当前 HEAD) |

---

## 10. 复现命令

```bash
bash verify/run-all.sh                     # 全量 + 哈希守护 → 全绿
node verify/probe.mjs;      echo $?        # 480 PASS / 0 FAIL
node verify/probe-index.mjs; echo $?       # 102 PASS / 0 FAIL
node verify/corpus-recall.mjs              # 75 会话：25 damaged / 20 silent / 1 D-10-only
node verify/repro-d1.mjs                   # D-1 三例（历史）
sha256sum plugin/index.js plugin/src/detect.js docs/INTERFACE.md
```

## 附：本次验证产出

| 文件 | 用途 |
| --- | --- |
| `verify/probe.mjs` / `verify/probe-out.txt` | detector 契约 + 攻击性 + **D-10/R14 零漂移与召回**（480/0） |
| `verify/probe-index.mjs` / `verify/probe-index-out.txt` | 接线：**R11/R13 两档** + M5 收手态 + M2/M3/M4（102/0） |
| `verify/corpus-recall.mjs` / `verify/corpus-recall-out.txt` | 真实会话语料的 D-10 召回/零漂移复算（独立逻辑 + 逐帧解码） |
| `verify/_pre-d10-detect.mjs` | pre-D-10 检测器快照（`4ea090ce`），零漂移对比基准 |
| `verify/repro-d1.mjs` / `verify/repro-d1-out.txt` | D-1 最小复现（历史） |
| `verify/run-all.sh` / `verify/run-all-out.txt` | 可复现全量 battery（哈希守护；`ls -lg` 不泄漏账号名） |
| `verify/tests-run-out.txt` | 作者测试台在验证者处的独立执行（187 PASS / 0 FAIL） |

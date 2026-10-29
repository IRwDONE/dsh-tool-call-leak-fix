# 独立验证报告 **v6（最终版）** · 结构化输出守卫（task-4 / verifier）

> 验证者：teammate `verifier`。写入范围仅 `verify/`；**未**改动 `plugin/`、`tests/`，**未**安装任何东西，**未**改 profile。发现问题只记录并回报，由 owner 修。
> **本 v6 取代 v5**：v5 唯一残留 D-9（INTERFACE §R12 自相矛盾）已由 owner 修好，本轮复跑**全绿**。
> 每条结论绑定 §1 的哈希；`run-all.sh` 跑前/跑后哈希一致。上游若再写入，需按 §1 重跑。
>
> **公开发布说明（2026-10-30）**：为公开发布做过**隐私清理 + 历史压缩**。提交历史被压缩为「GitHub 的 Initial commit + 一个发布提交」，因此本报告 §7「修订变更日志」里引用的旧提交号（如 `fe549ba` / `0b9f631` 等）在公开仓库中**不存在**；**文件级 sha256 基线不受影响**——被清理的只是本机绝对路径与账号名（`C:\Users\<user>\...`、`<repo>`、`<dsh-install>` 等占位符），检测器与插件代码**逐字节未变**。重跑判据仍以 `run-all.sh` 为准。

## 0. 结论

**一句话：达标。全绿，零未解决缺陷。** 三个独立套件：`probe.mjs` **436 PASS / 0 FAIL**、`probe-index.mjs` **86 PASS / 0 FAIL**、作者测试台 **182 PASS / 0 FAIL**。

- **D-8（M5 的能力缺失）** 标为「**已确认能力缺失、按用户决策不做**」——不是待修缺陷；证据链与 `Object.freeze` 复现原样保留在 §6。
- **D-5 / D-6 / D-7 / D-9 均已解决**（见 §6）。
- **唯一待办项：R11** —— M4 注入后模型**没有真正重做那一步**（见 §7/§8，措辞不弱化）。

独立结果（哈希前后一致）：

| 对象 | 基线哈希 | 我的独立结果 |
| --- | --- | --- |
| `plugin/src/detect.js` | `4ea090ce921e181caca9f90e85f2da414812691b2e770bd0cd7c860bb2df5efb` | `verify/probe.mjs` → **436 PASS / 0 FAIL**（exit 0） |
| `plugin/index.js` | `3de47da7d68190d66ed8d35d9142c21b112e21383e9ea7ebe8d40d8f67bdc6b7` | `verify/probe-index.mjs` → **86 PASS / 0 FAIL**（exit 0） |
| `tests/run.mjs`（作者测试台） | `8c101540f13ce606688ccebe5ed988a6aa4ea5103ec32dc5c037af759df959a9` | 我独立执行 → **182 PASS / 0 FAIL**（exit 0） |
| `docs/INTERFACE.md`（契约，R1–R12） | `e91269d3f498c4205bd36e045c53f096153f294ee9f6c5c5347ca08985762fdf` | 逐条核对，R12 无自相矛盾（D-9 已修） |
| `plugin/package.json` / `cordis.patch.yml` | `4510ae71…` / `11fd098c…` | manifest 合法；patch 已下架 `contextGuard`，`debugLog:false` |

**M5 停用状态（用户决策）已被独立验证**：`llm/stream` **不再注册**；`index.js` 代码区**无 `sanitizeMessages` 调用点**（无死路径）；`cordis.patch.yml` **不再暴露 `contextGuard`**；`sanitizeMessages` 仍在 `src/detect.js` **导出且可用**；"为何不做 + 将来如何重新接线"的注释**保留**（D-8 行号、`Object.isFrozen` 先检查、失败显式报告、任何路径恰好一次 `next()`）。

---

## 1. 基线 / 复现方式

```bash
bash verify/run-all.sh        # 哈希守护 + node --check + manifest + 作者测试台 + 两个独立 probe
node verify/probe.mjs         # 独立 detector 契约 + 攻击性 probe（436/0）
node verify/probe-index.mjs   # mock Cordis ctx 真实执行接线（86/0）
```

产出：`verify/probe-out.txt`、`verify/probe-index-out.txt`、`verify/tests-run-out.txt`、`verify/run-all-out.txt`。
基线：`git HEAD = 6b0bf01`，node `v24.19.0`，Windows。
**活体绑定**：profile 安装项是指向本工作区的**符号链接**。

---

## 2. `docs/INTERFACE.md` R9 / R10 / R12 逐条核对

### R12（M5 + `contextGuard`）
| 契约条目 | 结果 | 证据 |
| --- | --- | --- |
| `sanitizeMessages(messages, opts)` 形状 `{changed,messages,rewrites}`；只改"assistant + 无 tool-call + `damaged`" | ✅ | probe §9c |
| 纯函数纪律：不改入参、健康时返回**原引用**、`changed:false` 返回**原数组引用**、内部异常降级、note/rewrites 无 payload | ✅ | probe §9c（含深冻结、循环、Proxy、抛异常 getter、非数组/畸形元素） |
| `DEFAULT_CONFIG` 仍含 `contextGuard`/`contextGuardNote`，共 **12 键**，标注"内部保留、未接线" | ✅ | probe §1/§2 |
| 处置：移除 `llm/stream` 接线、下架公开开关、保留实现 | ✅ | probe-index §2/§6b |
| 文档不再声称"已实现"、且标注未接线/已停用（D-9 修复） | ✅ | probe-index §6b（`claimsImplemented=false && marksUnwired=true`） |
| 机制依据（`dsh-llm:2397` 同一 options 引用；`callConfigEquals :367-371` 不比 messages） | ✅（成立，但前提缺失→D-8） | 解包树逐行核对 |

### R9 / R10（延续）
R9：kill switch 形状、只对写入类工具、只认显式结构化证据、自由文本不抓（按有意设计）、文案不复用 B 段 ✅。
R10：`debugLog:false` 零副作用；`debugLogPath:''` → `tmpdir()` 推导（D-6 已修）；写入包 try/catch ✅。
**Config 导出**：可调用 + `['~standard'].validate`（从不返回 `issues`，clamp 与 `mergeConfig` 一致，覆盖 12 个已文档键）✅。

---

## 3. `plugin/src/detect.js` 契约核对

暴露 8 项（含 `sanitizeMessages`）/ESM/零依赖 ✅；`DEFAULT_CONFIG` 12 键、键集从模块推导、每个键都必须在 INTERFACE 有文档 ✅；声明键值逐条冻结 ✅；R3/R7 ✅；R5 ✅；§1 形状/evidence/R1 真值表 ✅；3 正例 + 5 反例 ✅；R2/R4/R6/R8 ✅；不抛（Symbol/BigInt/循环/Proxy/`Object.create(null)`/抛异常 getter）✅；不改入参/幂等/不打日志/无 payload 泄漏 ✅；`buildCorrectionMessage`/`buildDenyReason` ✅；冻结 code 集合（9）✅。

---

## 4. `plugin/index.js` 接线核对（mock ctx 真实执行）

`CORE_EVENTS`（pre-execute / post-execute / session/event / agent/turn-stopping）全部注册；`OPTIONAL_EVENTS`（`llm/stream`）允许存在但非必需；数量**一律从 handler 集合推导**（`effects.length === handlers.size`），无硬编码。当前实测 **4 个**注册，无越界事件。
M1 已移除（回归断言）；M2 deny 短路/其余 `next()`/V4 只对非空 `required`；M3 恒 `await next()` + R9 规则；M4 `session/event`→`turn-stopping`→`agent.inject()` + 上限/跨 turn 重置/畸形载荷安全；**M5 停用**（无注册、无调用点、patch 无开关、实现仍导出可用、注释保留；将来重新接线时探针自动转 wired 分支，含"冻结必须显式报告"）。

---

## 5. 攻击性输入（全部通过）

非字符串入参、5 MB 纯文本/全 `</div>`、≈2.6 MB 调用标记串、10 万 `<`+10 万 `>`（11–30 ms）、深 31 层/221 叶子（按 R8 有界）、循环引用、良性/敌意 Proxy、Symbol/BigInt/函数/抛异常 getter、正常 HTML、短文档含孤立闭合标签、大 payload + 尾 `</invoke>`×2、30000 字符单行、`\r\n` 混排、6 篇整文档不 deny；`sanitizeMessages` 另加非数组/畸形元素/循环/Proxy/深冻结输入。

---

## 6. 缺陷与处置清单

| 编号 | 状态 | 摘要 |
| --- | --- | --- |
| **D-8** | **已确认能力缺失 · 按用户决策不做** | M5 在 `llm/stream` 上永远写不进去（options 冻结）；接线已移除，纯函数保留 |
| **D-9** | **已解决** | `INTERFACE §R12` 自相矛盾（"已按此实现" vs "已移除"）→ 改为将来时条件句 + 明确"当前并未接线/已停用" |
| **D-5** | **已解决** | R10/R12 新键与裁定均已进 INTERFACE |
| **D-6** | **已解决** | `debugLogPath` 默认 `''` + `join(tmpdir(), …)` 推导，不再硬编码本机路径 |
| **D-7** | **已解决** | `cordis.patch.yml` 现 `debugLog:false`、无 `contextGuard` |
| D-0 / D-1 | 已解决（历史） | source kind / R6 判据方向反 |

### D-8 证据链（保留；将来任何重新接线都必须先解决它）
解包树 `.../dshx/dsh/node_modules/`：
1. `@deepseek-ai/dsh-agent-loop/lib/index.js:1214` `buildRequest()` → **`:1281`** `return markAgentLoopRequest(Object.freeze({ ...messages: boundaryMessages ... }))`；`:1280` `Object.freeze(boundaryMessages)`、`:1277` 逐条 `deepFreeze`。
2. 同文件 `:1075` `const request = this.buildRequest(...)`，`:1084` `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)` → 传下去的就是这个**冻结对象**。
3. `@deepseek-ai/dsh-llm/lib/index.js:2397` `ctx.waterfall(this,"llm/stream",options,()=>this.adapterStream(options,prepared))`；prepared 路径 `:2249-2253` 也走同一 `streamWithRegistration`。
4. `dsh-llm:2328` 有 `Object.isFrozen(options) ? deepFreeze({...})` 分支 → "options 被冻结"是常规形态。
⇒ `options.messages = …` 在 ESM 严格模式下抛 `TypeError`，被 listener catch 吞掉 → 改写永不落地（静默失效）。

**`Object.freeze` 可执行复现**（保留在探针；将来重新接线时若未先查冻结会自动转红）：
```
FAIL  M5 harness-realism: rewrite still lands when options is frozen like agent-loop builds it
      :: options.messages is the ORIGINAL frozen array (rewrite blocked)
PASS  M5 harness-realism: next() still called exactly once on frozen options (fails safe)
```

### 探针自身缺陷（已修，非插件缺陷）
`probe.mjs` 曾冻结 7 键配置 → 改为从模块推导键集；`probe-index.mjs` 曾硬编码注册数、M1 移除后无保护解引用 `sections[0]`、且 D-9 检查曾把"将来时规则"误判为"已实现声明" → 均已修（改为**从事件集合推导**、M5 分支化、按"是否声称当前实现 + 是否标注未接线"判定）。

---

## 7. 待办项（**唯一**）：R11

**R11：M4 注入后模型没有真正重做那一步。** 现场实况（lead 真实会话，我直接读日志复核）：`session/event.scan turn:5 step:18 damaged:true silentFailure:true codes:[MISSING_OPENING_MARKUP,MARKUP_LEAKED_AS_TEXT]` → `turn-stopping hasRecord:true injectType:"function"` → `turn-stopping.injected textLength:257` → `agent/inbox/spliced` → `step/start` → **`session/event.scan turn:5 step:19 textLength:45`**（turn 号仍 5）→ 第二次 `turn-stopping hasRecord:false correctionsUsed:1`。

即 **M4 的机械链路是现场阳性（plumbing 全通）：检测 → 注入成功 → 落盘 → 同一 turn 内多跑一步（turn 未关闭）**；但 **step 19 只输出 45 字符短文本，没有真正重做被损坏的那一步**。故当前"自愈"只做到"**不静默关闭**"，**尚未**做到"**真正重做**"——这是本项目自愈能力的**上限**，未解决。

（另一项现场证据：M2 ≥22 行结构截断参数 → 当场 deny、文件未落盘，**现场阳性**。）

---

## 8. 未能验证 / 已知边界

1. **R11**（见 §7）：唯一待办，措辞不弱化。
2. **M3 现场不再误报**：unit/mock 已按 R9 判定；真实会话"不再出现那 4 次误报"仍需一次现场确认。
3. **Cordis `ctx.effect` 卸载语义**：只验证到"被调用 + 返回 disposer + 调用不抛"。
4. **`exec.schema.parameters` 真实形状**：V4 守卫在其上取 `required`；mock 分支全覆盖（最坏不拦截）。
5. **Config 投影**：`listConfigs` 仍 `status:"unsupported"`（无 JSON-Schema 表单）；无法区分进程是否已重载最新 `index.js`。
6. **上游可能仍写入**：本报告取自哈希前后一致的稳定轮；若再变，按 §1 重跑。

---

## 9. 修订变更日志（`stat`/`sha256` 实测）

| 文件 | 观测序列 |
| --- | --- |
| `plugin/src/detect.js` | … → `d359f2a2`(R10) → **`4ea090ce`**(R12 纯函数，当前) |
| `plugin/index.js` | … → `0e66d51b`(M5 接线) → **`3de47da7`**(M5 停用，当前) |
| `docs/INTERFACE.md` | … → `3e322604`(R12) → `fca168a0` → `5613d982`(R12 处置) → **`e91269d3`**(D-9 修复，当前) |
| `plugin/cordis.patch.yml` | … → `2284a801`(临时测试态) → **`11fd098c`**(下架 contextGuard，当前) |
| `tests/run.mjs` | … → **`8c101540`**(当前；182 PASS / 0 FAIL) |
| git | … → `00c8a1b`(M5 停用) → **`6b0bf01`**(D-9，当前 HEAD) |

---

## 10. 复现命令

```bash
bash verify/run-all.sh                     # 全量 + 前后哈希守护 → 全绿
node verify/probe.mjs;     echo $?         # 436 PASS / 0 FAIL
node verify/probe-index.mjs; echo $?       # 86 PASS / 0 FAIL
node verify/repro-d1.mjs                   # D-1 三例（历史，已修）
sha256sum plugin/index.js plugin/src/detect.js docs/INTERFACE.md
```

## 附：本次验证产出

| 文件 | 用途 |
| --- | --- |
| `verify/probe.mjs` / `verify/probe-out.txt` | detector 契约 + 攻击性 probe（436/0；含 R12 `sanitizeMessages` 纪律） |
| `verify/probe-index.mjs` / `verify/probe-index-out.txt` | 接线 probe（86/0；M5 分支化 + 文档漂移检查） |
| `verify/repro-d1.mjs` / `verify/repro-d1-out.txt` | D-1 最小复现（历史） |
| `verify/run-all.sh` / `verify/run-all-out.txt` | 可复现全量 battery（哈希守护） |
| `verify/tests-run-out.txt` | 作者测试台在验证者处的独立执行（182 PASS / 0 FAIL） |

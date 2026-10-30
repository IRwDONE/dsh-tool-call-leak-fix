# 独立验证报告 **v8（终版）** · 结构化输出守卫（task-4 / verifier）

> 验证者：teammate `verifier`。写入范围仅 `verify/`；**未**改动 `plugin/`、`tests/`，**未**安装任何东西，**未**改 profile。发现问题只记录并回报，由 owner 修。
> **本 v8 取代 v7**：v7 之后新增 **D-11/R15（伪造工具结果标记）** 与 **R16/M7（fork 简报）**；本轮在验证过程中发现 **D-12（高危）**，owner 当场修复，我复测并加了回归锁。**本终版对应提交 `aa5ad76`。**
> 每条结论绑定 §1 的哈希；`run-all.sh` 跑前/跑后哈希一致。
> 公开发布隐私说明（继承 v6/v7）：`verify/` 也在公开仓库中，本目录已不含本机账号名（`run-all.sh` 用 `ls -lg`）。

## 0. 结论

**一句话：达标，全绿，零未解决缺陷。** `probe.mjs` **533 / 0**、`probe-index.mjs` **128 / 0**、作者测试台 **190 / 0**。

| 对象 | 基线哈希 | 我的独立结果 |
| --- | --- | --- |
| `plugin/src/detect.js` | `89a93d1fb117f5b59d183b5e678e84e6fade678b1843301a97db3f2faa767029` | `verify/probe.mjs` → **533 PASS / 0 FAIL** |
| `plugin/index.js` | `f7c9d3c61a326137ba71a1522ed3ac8430415e7e2c008fcb37e0a01eb85a0eaa` | `verify/probe-index.mjs` → **128 PASS / 0 FAIL** |
| `tests/run.mjs` | `2c0c257f2651ccc51c6d7a8328d3ca22b56e22b6468476fd22e7be3a607a47db` | 我独立执行 → **190 PASS / 0 FAIL** |
| `docs/INTERFACE.md`（R1–R16） | `2890c973db06efe4edad76c561d5d54378061ecdf940f4aaeb0ac81a9ec6a90a` | R15/R16 与实现一致（R16 已改为 `session.header`） |
| `plugin/package.json` / `cordis.patch.yml` | `c26fac16…` / `d0167b5b…` | manifest 合法；patch `maxCorrectionsPerTurn: 2` + `forkBrief: true` |

**本轮发现并已修复的缺陷（我复测 + 回归锁）**：
- **D-12（高危）**：`forkHeadline()` 读 **`agent.session.events`**（不存在）→ fork 简报恒不注入（静默 no-op）。我在 `index.js e7faf003` / `INTERFACE 9b350510` 上发现并上报；owner 在 **`f7c9d3c6` / `2890c973`（提交 `aa5ad76`）** 改为读 **`agent.session.header`**，契约同步更正。现 probe-index 有一条**回归锁**：只有 `session.events` 的 agent **不得**被简报，且静态断言"代码只读 `session.header`、不读 `session.events`"。
- **D-11（已解决）**：伪造工具结果标记（`<tool_result>v24.12.0\ndirs ok</tool_result>`，43 字符、该步无调用）此前全漏；现复用 `MARKUP_LEAKED_AS_TEXT` 捕获，code 集合不变。

**lead 要求的三点，全部独立复核通过**：
1. **影响面收口**：同文本在 `hasToolCalls:true` 时 `damaged` 仍 true，而 **`silentFailure` 必为 false**（接线级：带 `tool-call` 的消息 → M4 不注入）。
2. **护栏**：只提及字段名（`tool_result`/`tool-result`/`toolresult`，无尖括号）不判 damaged；`<tool-resultx>`、仅闭合标记也不判；`<tool-result>` 在**工具参数**里（小叶子与 ≥2000 字符大叶子）**不新增 deny**。
3. **零漂移**：与 **pre-D-11 基线**（`16227b7b`，`verify/_pre-d11-detect.mjs`）逐字节对比 **8 个 fixture 完全一致**；伪造结果标记在 pre-D-11 上不可见。

**同时独立重建了那条真实会话**（`verify/session-trace.mjs`）：turn 25 的序列与 lead 描述一致，并**首次确认 R11 真实有效**（tier 1 注入后，下一步真的重发了一个 `run_code` 调用），tier-1/tier-2 两条注入在原始日志中均可见。

---

## 1. 基线 / 复现方式

```bash
bash verify/run-all.sh          # 哈希守护 + node --check + manifest + 作者测试台 + 两个 probe
node verify/probe.mjs           # detector 契约 + 攻击性 + D-10/D-11（533/0）
node verify/probe-index.mjs     # 接线（R11/R13、M5 收手态、R16 + D-12 回归锁）（128/0）
node verify/corpus-recall.mjs   # 全部真实会话：D-10/D-11 增量分离复算
node verify/session-trace.mjs 929b19b0 25   # 真实 turn 重建（R11 阳性 + D-11 现场）
```

基线：`git HEAD = aa5ad76`，node `v24.19.0`，Windows。
对比基准：`verify/_pre-d10-detect.mjs`（`4ea090ce`，R12）与 `verify/_pre-d11-detect.mjs`（`16227b7b`，D-10），均已落盘，不依赖 git 历史。

---

## 2. 契约核对（本轮相关的 R14 / R15 / R16）

### R15（D-11 伪造工具结果标记）——全部通过
| 契约条目 | 结果 | 证据 |
| --- | --- | --- |
| 结果形状开场标记 → `MARKUP_LEAKED_AS_TEXT`，**不新增 code** | ✅ | probe §5c；code 集合仍为 9（probe §11） |
| `tool[-_]?result` 三变体 + 命名空间前缀 | ✅ | probe §5c (b) |
| **不依赖 `meta`**、**不要求自然语言句子** | ✅ | probe §5c (a)(d)（43 字符纯标记即 damaged） |
| **影响面收口**：有调用时 `damaged=true` 但 `silentFailure=false` | ✅ | probe §5c (d) + probe-index §6（接线级） |
| **作用域仅 assistant 文本** | ✅ | probe §5c (e)（3 类叶子不 deny、无该 code） |
| 护栏：字段名提及不算 | ✅ | probe §5c (c)（4 类） |

### R16（M7 fork 简报）——修复后全部通过
| 契约条目 | 结果 | 证据 |
| --- | --- | --- |
| 新增 `forkBrief:true` / `forkBriefNote:''`；**共 14 键**且已进 INTERFACE | ✅ | probe §1/§2（键集从模块推导；文档全覆盖） |
| 挂点 `agent/pre-step`；先 `await next()`；`kind !== 'enter'` 原样返回；必须 spread；绝不 reject；异常返回原 decision | ✅ | probe-index §6c（reject 透传、字段保留、畸形 agent 不抛、`next()` 恰一次） |
| 每 session 最多一次；`forkBrief:false` 关闭；文案按 `lang` 或 `forkBriefNote`；source kind 合法 | ✅ | probe-index §6c |
| **fork 判定必须读 `agent.session.header`**（`parentSession?` / `isSeeded`） | ✅ | probe-index §6c（文档化 header → 注入；只有 `session.events` → **不**注入；静态断言不读 `.events`） |
| 异常安全：探测 `session`/`header` 抛错时必须返回**原 decision** 且不抛 | ✅ | probe-index §6c (g)（抛错 `session` getter / 抛错 `header` getter，且 `ret === 原 decision`） |

R9/R10/R11/R12/R13/R14 的既有断言全部仍绿。

---

## 3. `plugin/src/detect.js` 契约核对

暴露 8 项/ESM/零依赖 ✅；`DEFAULT_CONFIG` **14 键**、键集从模块推导、每个键都必须在 INTERFACE 有文档 ✅；声明键值逐条冻结 ✅；R3/R7 ✅；R5 ✅；§1 形状/evidence/R1 真值表 ✅；3 正例 + 5 反例 ✅；R2/R4/R6/R8 ✅；R14 零漂移/召回 ✅；R15 ✅；不抛（Symbol/BigInt/循环/Proxy/`Object.create(null)`/抛异常 getter）✅；不改入参/幂等/不打日志/无 payload 泄漏 ✅；`buildCorrectionMessage`/`buildDenyReason` ✅；code 集合（9）不变 ✅。

---

## 4. `plugin/index.js` 接线核对（mock ctx 真实执行）

- **注册集**（从事件集合推导）：`CORE_EVENTS` = pre-execute / post-execute / session/event / agent/turn-stopping / **agent/pre-step**；`OPTIONAL_EVENTS` = `llm/stream`（M5 已收手）。当前 5 个注册，无越界事件。
- M1 已移除（回归断言）✅；M2 ✅；M3（R9）✅；M4（R11/R13 两档、上限、每 turn 重置）✅；M5（收手态：无注册、无调用点、patch 无开关、实现保留、注释含 D-8 与再接线规则）✅；**M7/R16** ✅（含 D-12 回归锁）。

---

## 5. 攻击性输入（全部通过）

非字符串入参、5 MB 文本/标签、≈2.6 MB 调用标记串、10 万 `<`+10 万 `>`、深 31 层/221 叶子（按 R8 有界）、循环引用、良性/敌意 Proxy、Symbol/BigInt/函数/抛异常 getter、正常 HTML、短文档含孤立闭合标签、大 payload + 尾 `</invoke>`×2、30000 字符单行、`\r\n` 混排、6 篇整文档不 deny；`sanitizeMessages` 非数组/畸形/循环/Proxy/深冻结；**D-10 零漂移 6 类 + 前缀方言 4 类**；**D-11 三变体 + 5 类护栏 + 3 类作用域**。

## 5b. 语料与现场（独立重建）

**语料**（`verify/corpus-recall.mjs`；`~/.dsh/sessions/**/session.v4.jsonl.zstd` 逐帧解；对每条 assistant 文本同时跑当前与两份基线）：

| 指标 | 本轮快照 |
| --- | --- |
| 会话文件 / assistant 事件 / 含 text 块 | 78 / 3734 / 2671 |
| damaged（当前） | 34（无 tool-call 29） |
| damaged（R12 基线）/（D-10 基线） | 27 / 33 |
| **仅 D-10 能发现** | **6** |
| **仅 D-11 能发现** | **1** ← `session-929b19b0-…`，43 字符，`hasResultMarkup=true` |

> 修正 v7 的措辞："`D-10-only` 恒为 1"当时是**快照式表述**，已作废——语料随新会话持续增长（D-10-only 现为 6）。稳定的是**每个增量 ≥1**，且 D-11-only 恒命中 `session-929b19b0`。

**真实 turn 重建**（`node verify/session-trace.mjs 929b19b0 25`）：
```
header: parentSession="session-c8741511-…" isSeeded=true
step 1  calls=0 textLen=499  damaged=true silent=true  codes=[MARKUP_LEAKED_AS_TEXT]  text="…<antml:invoke name=\"run_code\">…"
step 2  calls=1 textLen=0    damaged=false            (tool/call name=run_code)      ← 模型真的重发了调用
step 3  calls=1 textLen=115  damaged=false            (tool/call run_code → 成功)
step 4  calls=0 textLen=1004 damaged=true silent=true  codes=[MARKUP_LEAKED_AS_TEXT]
step 5  calls=0 textLen=43   damaged=true silent=true  codes=[MARKUP_LEAKED_AS_TEXT]  text="<tool_result>v24.12.0\ndirs ok</tool_result>"
inbox/spliced next-step inserted=1 source=runtime-context text="【立即执行】…[结构校验失败 · 自动纠正…"   ← tier 1
inbox/spliced next-step inserted=1 source=runtime-context text="【第二次尝试仍失败】…只发一个调用…"        ← tier 2
```
→ **R11 首次真实阳性**：tier 1 注入后，step 2 真的重发了一个 `run_code` 调用；**tier 2 也真实触发**；step 5 就是 D-11 的伪造结果（现被捕获）。v7 的"R11 有效性未观测"由本轮现场**关闭**。

---

## 6. 缺陷清单

### D-12（**高危 · 本轮发现并已修复**）R16/M7 fork 简报读了不存在的 API
- **现象**：`forkHeadline()` 读 `agent.session.events`、找 `event.type === 'session'` → 真实 `Session` 无 `events`，也无裸 `'session'` 事件 → 恒 null → 简报永不注入（静默 no-op）。
- **独立取证**：① 接口声明 `dsh-session-reference/lib/typert.host.js:557` 的 `class Session` 无 `events`、有 `readonly header: SessionHeader`（`parentSession?`/`isSeeded`）；② `dsh-session/lib/index.js` 无 `get events`/`this.events`（只有内部 `eventsSnapshot`）；③ 运行时 Event 目录只有 `session/created|disposed|event|flush`；④ 文件侧：真实 fork 日志第一行确是 `{"type":"session",…,"parentSession":…,"isSeeded":true}` —— 但那是**物理头部行**，经 `session.header` 暴露，不在事件流里（解释了"实测证据"的来源）。
- **可执行复现（修复前）**：`probe-index §6c` → `FAIL R16 (documented agent.session.header): … messages=1 (expected 2)`；给"被发明的" `session.events` 形状反而会注入 → 说明单测全绿而真实 fork 无效。
- **修复**：`f7c9d3c6` 改为 `agent.session.header`；`INTERFACE R16 :395-397` 同步更正并记载该教训。
- **回归锁（现在仍生效）**：`D-12 regression: an agent with ONLY session.events is NOT briefed` + 静态断言 `index.js code reads session.header, never session.events`。

### D-11（**已解决**）伪造工具结果标记
真实故障驱动（`session-929b19b0` step 5）。修法复用 `MARKUP_LEAKED_AS_TEXT`、code 集合不变；三点复核 + 语料增量全部通过。**保留教训**：真实失败已有**三种方言**——裸标签、命名空间前缀、伪造结果标记（外加无信封的正文泄漏）。

### D-8（**已确认能力缺失 · 按用户决策不做**）
M5 在 `llm/stream` 上永远写不进去（agent-loop 把请求 `Object.freeze`）：`dsh-agent-loop/lib/index.js:1214` `buildRequest` → `:1281` `Object.freeze({...messages...})`（`:1280` 冻结数组、`:1277` deepFreeze 每条）→ `:1084` `llm.stream(request)` → `dsh-llm/lib/index.js:2397` 的 `llm/stream` waterfall。**可执行复现**保留在探针（重新接线时若未先查冻结会自动转红）。

### D-0 / D-1 / D-5 / D-6 / D-7 / D-9 / D-13（历史 · 均已解决）
source kind / R6 判据方向 / 契约键与裁定同步（R10–R16）/ `debugLogPath` 推导 / patch 开关回退 / INTERFACE §R12 自相矛盾 / R16 键未入契约（修复过程中已同步，本轮无 D-13）。

### 探针自身缺陷（已修）
7 键配置冻结、硬编码注册数、`sections[0]` 无保护解引用、D-9 检查把将来时误判为已实现、D-10 继承用例取样不 damaged、D-11 封闭标签检查过严（`</` 前缀其实被 `docs/PROMPTS.md` 明确允许）。

---

## 6b. 失败类教训：**"看起来合理、其实不存在的接口"**（lead 要求单列）

**这一类失败的形状**：实现（或人）读写了一个**看似合理、但实际不存在/不被接纳**的接口或取值；失败被 try/catch 或默认分支无声吞掉 → 机制**什么都不做**、**不报错**，而单测用"被发明的那套形状"搭台，于是**全绿却无效**。这正是本项目要消灭的失败形态，只是从"模型输出"搬到了"我们的接线"。

**这条线上已经出现三次**：

| # | 实例 | 被误用/缺失的东西 | 真实契约 | 后果 | 抓法（均为独立验证） |
| --- | --- | --- | --- | --- | --- |
| 1 | **D-0** | `source: { kind:'plugin', plugin:… }` | 当前 v4 用 `MessageSourceMap`；`assertV4MessageSources` 对 `kind==='plugin'` 直接抛 `SessionFormatError`（旧版本曾用过这个形状） | 注入消息一旦落盘可能让会话不可读 | 读 `MessageSourceMap` 与 `dsh-session-format-v3-to-v4` 的准入/迁移代码 |
| 2 | **D-8 / M5** | `options.messages = …`（原地写） | 机制依据"下游闭包读同一引用 + `callConfigEquals` 不比 messages"**成立**，但漏了**该引用被 deep-freeze**（agent-loop `buildRequest` → `Object.freeze`） | 赋值抛错被吞 → M5 完全失效 | 顺着 `llm.stream(request)` 追到 `buildRequest:1281` 的 `Object.freeze`，并写冻结复现 |
| 3 | **D-12 / R16** | `agent.session.events` + `type==='session'` | `Session` 只暴露 `header: SessionHeader`；事件目录里没有裸 `'session'`（文件首行是**物理头部**，不是事件流） | 恒 `null` → fork 简报永不注入 | 查 typert 声明的 `class Session` 成员 + 运行时 `Event` 目录 + 实解 session 文件头行 |

**为什么单测抓不到**：三次的单测都**自己构造了那个不存在的形状**——D-0 的 mock 直接给了合法 kind；悬念在"真实校验"；D-8 的 mock `options` 没冻结；D-12 的 mock `session.events` 是发明的。**mock 通过 ≠ 生产可用**。

**已经采用的缓解（建议固化为纪律）**：
1. **只从声明取接口**：typert 的 `declaration` 字符串或运行时 inspect provider（Service/Event/Config）——**不从日志里的一行、也不凭记忆**推断成员名。
2. **缺失即报错，不要静默兜底**：当假设的成员不存在时，`return null` 等于把 bug 藏起来；应显式记录（`debugLog`）或可见降级。
3. **每个机制都要"现场级"验收**：M4 曾因等"显眼消息"被判阴性；M5/D-8 靠读冻结链才推翻；R11 靠真实 turn 重建才拿到阳性；R16 靠文档化 header 的复现才暴露。**mock 全绿不足以放行。**
4. **每个修好的实例留回归锁**：D-12 现有一条（"只有 `session.events` 的 agent 不得被简报" + 静态断言）；D-8 保留冻结 `options` 复现（重新接线时若未先查冻结会自动转红）；D-0 的 kind 名单在探针里。

---

## 7. 未闭合项（均非缺陷）

1. **M7 的有效性**：机制现已打通（D-12 已修），但 INTERFACE R16 自己标注"模型是否真的停止模仿、是否恢复小块调用**尚未在真实 fork 中观测到**"——需要一次现场验收（`debugLog:true` + 一次真实 fork 首步，看 `pre-step.forkBrief` 是否出现）。
2. **M3 真实会话不再误报**：unit/mock 已按 R9 判定，现场确认待做。
3. **tier 2 的相对有效性**：tier 1 已被现场证明能让模型重发调用；tier 2 在 turn 25 出现，但其后一步仍是坏输出，**"tier 2 是否比 tier 1 更有效"未被单独观测**。

---

## 8. 未能验证 / 已知边界

- Cordis `ctx.effect` 卸载语义（只验证"被调用 + 返回 disposer + 调用不抛"）。
- `exec.schema.parameters` 真实形状（V4 守卫在其上取 `required`；mock 全覆盖，最坏不拦截）。
- `Session.header` 在真实 fork 上的取值我只从**日志头行**与**接口声明**双重确认，未在插件运行中直接断言（D-12 修好后可由 `pre-step.forkBrief` 日志一并确认）。
- 语料持续增长 → 绝对数不是基线（§5b）。

---

## 9. 修订变更日志

| 文件 | 观测序列 |
| --- | --- |
| `plugin/src/detect.js` | … → `16227b7b`(D-10) → `08c6d91b`(D-11) → `f6b50f57` → **`89a93d1f`**(当前) |
| `plugin/index.js` | … → `9d038734`(R13) → `e7faf003`(R16，**含 D-12**) → **`f7c9d3c6`**(修 D-12，当前) |
| `docs/INTERFACE.md` | … → `008b5f81`(R15) → `9b350510`(R16，含错的取法) → **`2890c973`**(更正为 `session.header`，当前) |
| `plugin/cordis.patch.yml` | … → `3ec76bfa` → **`d0167b5b`**(当前) |
| `tests/run.mjs` | … → **`2c0c257f`**(当前；190 PASS / 0 FAIL) |
| git | … → `a7b897b`(D-11) → **`aa5ad76`**(M7/R16 + 修 D-12，当前 HEAD) |

---

## 10. 复现命令

```bash
bash verify/run-all.sh                      # 全量 + 哈希守护 → 全绿
node verify/probe.mjs;      echo $?         # 533 PASS / 0 FAIL
node verify/probe-index.mjs; echo $?        # 128 PASS / 0 FAIL
node verify/corpus-recall.mjs               # D-10/D-11 增量分离
node verify/session-trace.mjs 929b19b0 25   # 真实 turn 重建（R11 阳性 + D-11 现场）
node verify/repro-d1.mjs                    # D-1 三例（历史）
sha256sum plugin/src/detect.js plugin/index.js docs/INTERFACE.md
```

## 附：本次验证产出

| 文件 | 用途 |
| --- | --- |
| `verify/probe.mjs` / `verify/probe-out.txt` | detector 契约 + 攻击性 + D-10/D-11（533/0） |
| `verify/probe-index.mjs` / `verify/probe-index-out.txt` | 接线：R11/R13、M5 收手态、R16 + **D-12 回归锁**（128/0） |
| `verify/corpus-recall.mjs` / `verify/corpus-recall-out.txt` | 真实语料的 D-10/D-11 增量分离复算 |
| `verify/session-trace.mjs` / `verify/session-trace-out.txt` | 单会话 turn 重建（R11/D-11 现场取证） |
| `verify/_pre-d10-detect.mjs` / `verify/_pre-d11-detect.mjs` | 两份基线快照（零漂移/增量对比基准） |
| `verify/run-all.sh` / `verify/run-all-out.txt` | 可复现全量 battery（哈希守护；`ls -lg` 不泄漏账号名） |
| `verify/tests-run-out.txt` | 作者测试台独立执行（190 PASS / 0 FAIL） |

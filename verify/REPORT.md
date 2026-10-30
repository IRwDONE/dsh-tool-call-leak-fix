# 独立验证报告 **v8** · 结构化输出守卫（task-4 / verifier）

> 验证者：teammate `verifier`。写入范围仅 `verify/`；**未**改动 `plugin/`、`tests/`，**未**安装任何东西，**未**改 profile。发现问题只记录并回报，由 owner 修。
> **本 v8 取代 v7**：v7 之后新增 **D-11/R15（伪造工具结果标记）**、**R16/M7（fork 简报）**，并首次拿到 **R11 真实有效性阳性**。
> 每条结论绑定 §1 的哈希；`run-all.sh` 跑前/跑后哈希一致。**注意：本轮被验的 `plugin/index.js`、`plugin/src/detect.js`、`docs/INTERFACE.md` 当时是未提交的工作树状态**（HEAD 仍是 `a7b897b`），下游若按提交行走需先确认哈希。
> 公开发布隐私说明（继承 v6/v7）：`verify/` 也在公开仓库中，本目录已不含本机账号名（`run-all.sh` 用 `ls -lg`）。

## 0. 结论

**一句话：D-11/R15 达标；但 R16/M7 有 1 项高危缺陷（D-12）——fork 简报在当前 harness 上是静默 no-op，读了一个不存在的 API。** 故**整体判定：不达标**（修好 D-12 即可转达标）。

| 对象 | 基线哈希（工作树） | 我的独立结果 |
| --- | --- | --- |
| `plugin/src/detect.js` | `89a93d1fb117f5b59d183b5e678e84e6fade678b1843301a97db3f2faa767029` | `verify/probe.mjs` → **533 PASS / 0 FAIL** |
| `plugin/index.js` | `e7faf003d0cdf32ac4eef3de052aa97ba602d353b4591ed864f5f6abc6a4bdc6` | `verify/probe-index.mjs` → **124 PASS / 1 FAIL / 1 defect**（那 1 = **D-12**） |
| `tests/run.mjs` | `2c0c257f2651ccc51c6d7a8328d3ca22b56e22b6468476fd22e7be3a607a47db` | 我独立执行 → **190 PASS / 0 FAIL** |
| `docs/INTERFACE.md`（R1–R16） | `9b350510e89d0951e1b5b213f9ec74d9898b4cf75492185940133e704add3f83` | R15 一致；**R16 自身描述的取法（`session.events`）与 harness 接口不符** |
| `plugin/package.json` / `cordis.patch.yml` | `c26fac16…` / `d0167b5b…` | manifest 合法；patch `maxCorrectionsPerTurn: 2`、`forkBrief: true` |

**lead 要求的三点，我都独立验过（全绿）**：
1. **影响面收口**：伪造结果标记文本在 `hasToolCalls:true` 时 `damaged` 仍为 true，而 **`silentFailure` 必为 false**；接线级也验了（带 `tool-call` 的消息 → M4 不注入）。
2. **护栏**：只提及 `tool_result` / `tool-result` / `toolresult`（无尖括号）→ 不判 damaged；`<tool-resultx>`、仅闭合标记 `</tool-result>` 也不判；`<tool-result>` 出现在**工具参数**里（小叶子与 ≥2000 字符的大叶子都测）→ **不新增 deny**、叶子上无 `MARKUP_LEAKED_AS_TEXT`。
3. **零漂移**：与 **pre-D-11 基线**（`16227b7b`，已落盘 `verify/_pre-d11-detect.mjs`）逐字节对比 **8 个 fixture 完全一致**；伪造结果标记在 pre-D-11 上**不可见**。

**语料复算（独立）**：`damagedOnlyViaD11 = 1`，正是 **`session-929b19b0-…`**（43 字符、`hasResultMarkup=true`、`wasVisibleAtR12=false`）——与 lead 的现场完全对上。**D-11 已解决。**

**同时独立重建了那条真实会话**（`verify/session-trace.mjs`，见 §5b）：turn 25 的序列与 lead 描述一致，且**首次确认 R11 真实有效**（tier 1 注入后，下一步**真的重发了一个 `run_code` 调用**），tier-1/tier-2 两条注入都在原始日志里可见。

**D-12（高 · 未解决）**：`index.js` 的 `forkHeadline()` 读 **`agent.session.events`** 并找 `type === 'session'`，但真实的 `Session` **没有 `events`**（只有 `header`），且运行时事件目录里**没有裸 `'session'` 事件** → 恒返回 null → **fork 简报永不注入**。证据、可执行复现与一行修法见 §6。

---

## 1. 基线 / 复现方式

```bash
bash verify/run-all.sh          # 哈希守护 + node --check + manifest + 作者测试台 + 两个 probe
node verify/probe.mjs           # detector 契约 + 攻击性 + D-10/D-11（533/0）
node verify/probe-index.mjs     # 接线（R11/R13、M5 收手态、R16）（124/1：1 = D-12）
node verify/corpus-recall.mjs   # 75+ 会话：D-10/D-11 增量分离复算
node verify/session-trace.mjs 929b19b0 25   # 真实 turn 重建（R11/D-11 现场）
```

基线：node `v24.19.0`，Windows；HEAD `a7b897b`（被验文件未提交，见上）。
对比基准：`verify/_pre-d10-detect.mjs`（`4ea090ce`，R12）与 `verify/_pre-d11-detect.mjs`（`16227b7b`，D-10），均已落盘，不依赖 git 历史。

---

## 2. 契约核对（本轮相关的 R14 / R15 / R16）

### R15（D-11 伪造工具结果标记）
| 契约条目 | 结果 | 证据 |
| --- | --- | --- |
| 结构分析（经 `normalizeNamespaces`）出现结果形状开场标记 → `MARKUP_LEAKED_AS_TEXT`，**不新增 code** | ✅ | probe §5c；code 集合仍为 9 个（probe §11） |
| `tool[-_]?result` 三变体 + 命名空间前缀都识别 | ✅ | probe §5c (b)（`<tool_result>` / `<toolresult>` / `<antml:tool-result>`） |
| **不依赖 `meta`**、**不要求自然语言句子** | ✅ | probe §5c (a)(d)：43 字符纯标记 + 伪造版本号即 damaged；`meta` 只改 `silentFailure` |
| **影响面收口**：有工具调用时 `damaged=true` 但 `silentFailure=false` | ✅ | probe §5c (d) + probe-index §6（接线级） |
| **作用域仅 assistant 文本**，`scanToolArguments` 不加（否则 deny 解释性文档） | ✅ | probe §5c (e)（小/大/2000+ 字符三种叶子都不 deny、无该 code） |
| 护栏：字段名提及不算 | ✅ | probe §5c (c)（4 类） |

### R16（M7 fork 简报）
| 契约条目 | 结果 | 证据 |
| --- | --- | --- |
| 新增 `forkBrief:true` / `forkBriefNote:''`；**共 14 键**，已进 INTERFACE | ✅ | probe §1/§2（键集从模块推导；每个键都被文档覆盖） |
| 挂点 `agent/pre-step`；先 `await next()`；`kind !== 'enter'` 原样返回；必须 spread；绝不 reject；异常返回原 decision | ✅ | probe-index §6c（reject 透传、`startsRequestSeries` 保留、畸形 agent 不抛、`next()` 恰一次） |
| 每 session 最多一次；`forkBrief:false` 关闭；文案按 `lang` 或由 `forkBriefNote` 覆盖；source kind 合法 | ✅ | probe-index §6c |
| **"如何识别 fork：`agent.session.events` 里第一个 `type==='session'`"** | ❌ **D-12** | §6 |

R9/R10/R11/R12/R13/R14 的既有断言全部仍绿（probe/probe-index 的对应段）。

---

## 3. `plugin/src/detect.js` 契约核对

暴露 8 项/ESM/零依赖 ✅；`DEFAULT_CONFIG` **14 键**、键集从模块推导、每个键都必须在 INTERFACE 有文档 ✅；声明键值逐条冻结 ✅；R3/R7 ✅；R5 ✅；§1 形状/evidence/R1 真值表 ✅；3 正例 + 5 反例 ✅；R2/R4/R6/R8 ✅；R14 零漂移/召回 ✅；R15 ✅；不抛（Symbol/BigInt/循环/Proxy/`Object.create(null)`/抛异常 getter）✅；不改入参/幂等/不打日志/无 payload 泄漏 ✅；`buildCorrectionMessage`/`buildDenyMessage` ✅；code 集合（9）不变 ✅。

---

## 4. `plugin/index.js` 接线核对（mock ctx 真实执行）

- **注册集**（从事件集合推导）：`CORE_EVENTS` = pre-execute / post-execute / session/event / agent/turn-stopping / **agent/pre-step**（R16）；`OPTIONAL_EVENTS` = `llm/stream`（M5 已收手，可再接线）。当前 5 个注册，无越界事件。
- M1 已移除（回归断言）✅；M2（deny 短路 / `next()` / V4 守卫）✅；M3（R9 规则）✅；M4（R11/R13 两档、上限、每 turn 重置）✅；M5（收手态：无注册、无调用点、patch 无开关、实现保留、注释含 D-8 与再接线规则）✅。
- **M7/R16**：逻辑层全绿，但**判定 fork 的取法错误** → D-12。

---

## 5. 攻击性输入（全部通过）

非字符串入参、5 MB 文本/标签、≈2.6 MB 调用标记串、10 万 `<`+10 万 `>`、深 31 层/221 叶子（按 R8 有界）、循环引用、良性/敌意 Proxy、Symbol/BigInt/函数/抛异常 getter、正常 HTML、短文档含孤立闭合标签、大 payload + 尾 `</invoke>`×2、30000 字符单行、`\r\n` 混排、6 篇整文档不 deny；`sanitizeMessages` 非数组/畸形/循环/Proxy/深冻结；**D-10 零漂移 6 类 + 前缀方言 4 类**；**D-11 三变体 + 5 类护栏 + 3 类作用域**。

## 5b. 语料与现场（独立重建）

**语料**（`verify/corpus-recall.mjs`；全部 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，逐帧解；对每条 assistant 文本同时跑当前与两份基线，增量直接对比）：

| 指标 | 值（本轮快照） |
| --- | --- |
| 会话文件 / assistant 事件 / 含 text 块 | 78 / 3734 / 2671 |
| damaged（当前） | 34（无 tool-call 29） |
| damaged（R12 基线）/（D-10 基线） | 27 / 33 |
| **仅 D-10 能发现** | **6** |
| **仅 D-11 能发现** | **1** ← `session-929b19b0-…`，43 字符，`hasResultMarkup=true` |

> 修正 v7 的措辞：我当时写"`D-10-only` 恒为 1"是**快照式表述**，已作废——语料随新会话持续增长，两个增量都会变（D-10-only 现为 6）。**稳定不变量只有"D-11-only = 1 且命中 `session-929b19b0`"与"每个增量 ≥1"**。

**真实 turn 重建**（`node verify/session-trace.mjs 929b19b0 25`，原文要点）：
```
header: parentSession="session-c8741511-…" isSeeded=true
step 1  assistant  calls=0 textLen=499  damaged=true silent=true  codes=[MARKUP_LEAKED_AS_TEXT]  text="…<antml:invoke name=\"run_code\">…"
step 2  assistant  calls=1 textLen=0    damaged=false            (tool/call name=run_code)
step 3  assistant  calls=1 textLen=115  damaged=false            (tool/call run_code → 成功)
step 4  assistant  calls=0 textLen=1004 damaged=true silent=true  codes=[MARKUP_LEAKED_AS_TEXT]
step 5  assistant  calls=0 textLen=43   damaged=true silent=true  codes=[MARKUP_LEAKED_AS_TEXT]  text="<tool_result>v24.12.0\ndirs ok</tool_result>"
inbox/spliced next-step inserted=1 source=runtime-context text="【立即执行】…[结构校验失败 · 自动纠正…"     ← tier 1
inbox/spliced next-step inserted=1 source=runtime-context text="【第二次尝试仍失败】…只发一个调用…"          ← tier 2
```
→ **R11 首次真实阳性**：tier 1 注入后，**step 2 模型真的重发了一个 `run_code` 调用**（`calls=1, textLen=0`）；tier 2 也真实触发；step 5 就是 D-11 的伪造结果（现被捕获）。v7 标的"R11 有效性未观测"由本轮现场**关闭**。

---

## 6. 缺陷清单

### D-12（**高危 · 未解决**）R16/M7 fork 简报静默 no-op（读了不存在的 API）
**现象**：`forkHeadline(agent)` 读 `agent.session.events`、找 `event.type === 'session'`；真实 `Session` 无 `events`、也没有名为 `'session'` 的事件 → 恒 `null` → 简报永不注入（不报错、不崩，功能为空）。

**独立取证（三层 + 现场反例）**：
1. **接口声明**：`dsh-session-reference/lib/typert.host.js:557` 的 `class Session` 成员：`surface / header / inheritedEventCount / id / firstLiveSeq / firstLifecycleSeq / eventAt / snapshotEvents / ownEvents / isOwnSeq / seq / append / requestHeader / requestContext / toolHistory / deriveMessages / deriveEventMessage` —— **无 `events`**；有 **`readonly header: SessionHeader`**（含 `parentSession?` / `isSeeded`）。
2. **实现**：`dsh-session/lib/index.js` 只有内部 `this.eventsSnapshot` 与 `snapshotEvents()`，**没有 `get events`**、没有 `this.events`。
3. **运行时事件目录**：`cordis_inspect_query`(host/Event/listEvents) 只有 `session/created | session/disposed | session/event | session/flush`，**无裸 `'session'`**。
4. **文件侧反例（解释"实测证据"从哪来）**：我解了真实 fork 的日志文件，第一行确实是 `{"type":"session",…,"parentSession":"…","isSeeded":true,…}` —— 但那是**物理头部行**，由 `session.header` 暴露，**不在事件流里**。

**可执行复现**（`node verify/probe-index.mjs` §6c）：
```
FAIL  R16 (documented agent.session.header): a forked session gets a brief prepended  :: messages=1 (expected 2)
PASS  R16: with the INVENTED session.events shape the branch does fire (cause isolation)
PASS  R16: brief is prepended before the inherited messages / decision fields survive / source kind ok
```
给它**文档化**的 `agent.session.header = {parentSession, isSeeded}` → 不注入；给它**被发明的** `session.events=[{type:'session',…}]` → 注入。这解释了为什么单测全绿而真实 fork 无效。

**一行修法**：
```js
const h = agent && agent.session && agent.session.header;
if (!h) return null;
const parent = typeof h.parentSession === 'string' ? h.parentSession : '';
if (!parent && h.isSeeded !== true) return null;
return { parent, seeded: h.isSeeded === true };
```
**契约也要同步**：`docs/INTERFACE.md` R16 `:392-395` 现在明文要求 `agent.session.events` + `type==='session'`，与 harness 接口不符，应改述为 `session.header`。
**现场确认配方**：`debugLog:true` + 一次真实 fork 首步；修好前 `pre-step.forkBrief` 不会出现。

### D-11（**已解决**）伪造工具结果标记
真实故障驱动（`session-929b19b0` step 5，43 字符 `<tool_result>v24.12.0\ndirs ok</tool_result>`，该步无任何调用）。修法复用 `MARKUP_LEAKED_AS_TEXT`、code 集合不变；三点复核 + 语料增量全部通过（§0/§5b）。**保留教训**：真实失败已有**三种方言**——裸标签、命名空间前缀、伪造结果标记（外加无信封的正文泄漏）。

### D-8（**已确认能力缺失 · 按用户决策不做**）
M5 在 `llm/stream` 上永远写不进去（agent-loop 把请求 `Object.freeze`）。证据链：`dsh-agent-loop/lib/index.js:1214` `buildRequest` → `:1281` `Object.freeze({...messages...})`（`:1280` 冻结数组、`:1277` deepFreeze 每条）→ `:1084` `llm.stream(request)` → `dsh-llm/lib/index.js:2397` 的 `llm/stream` waterfall。**可执行复现**保留在探针（重新接线时若未先查冻结会自动转红）。

### D-0 / D-1 / D-5 / D-6 / D-7 / D-9（历史 · 均已解决）
source kind / R6 判据方向 / R10-R12-R16 键与裁定入契约 / `debugLogPath` 推导 / patch 开关回退 / INTERFACE §R12 自相矛盾。

### 探针自身缺陷（已修）
7 键配置冻结、硬编码注册数、`sections[0]` 无保护解引用、D-9 检查把将来时误判为已实现、D-10 继承用例取样不 damaged、D-11 封闭标签检查过严（把 `</` 前缀当违规，实际 `docs/PROMPTS.md` 明确允许只写该前缀）。

---

## 7. 未闭合项

1. **D-12**（唯一高危）：见 §6。
2. **M7 的有效性**：即使修好 D-12，INTERFACE R16 自己也标注"模型是否真的停止模仿、是否恢复小块调用**尚未在真实 fork 中观测到**"——修好后需要一次现场验收。
3. **M3 真实会话不再误报**：unit/mock 已按 R9 判定，现场确认待做。
4. **R11/R13 有效性**：**本轮已由现场关闭**（§5b），但"tier 2 是否比 tier 1 更有效"仍未单独观测（它只在 step 4→5 出现，而 step 5 仍是坏输出）。

---

## 8. 未能验证 / 已知边界

- Cordis `ctx.effect` 卸载语义（只验证"被调用 + 返回 disposer + 调用不抛"）。
- `exec.schema.parameters` 真实形状（V4 守卫在其上取 `required`；mock 全覆盖，最坏不拦截）。
- `Session.header` 在真实 fork 上是否**确有** `parentSession/isSeeded`：接口声明与真实日志**都支持**，且日志头行实测有值；我未在插件运行中直接断言（D-12 修好后可由 `pre-step.forkBrief` 日志一并确认）。
- 被验文件**未提交**（工作树状态）；下游若按提交行走需先对齐哈希。
- 语料持续增长 → 绝对数不是基线（§5b）。

---

## 9. 修订变更日志

| 文件 | 观测序列 |
| --- | --- |
| `plugin/src/detect.js` | … → `16227b7b`(D-10) → `08c6d91b`(D-11) → `f6b50f57` → **`89a93d1f`**(当前，未提交) |
| `plugin/index.js` | … → `9d038734`(R13) → **`e7faf003`**(R16/M7，未提交) |
| `docs/INTERFACE.md` | … → `008b5f81`(R15) → **`9b350510`**(R16，未提交) |
| `plugin/cordis.patch.yml` | … → `3ec76bfa` → **`d0167b5b`**(当前) |
| `tests/run.mjs` | … → **`2c0c257f`**(当前；190 PASS / 0 FAIL) |
| git | … → `a58f0dd` → **`a7b897b`**(D-11；HEAD，其后改动未提交) |

---

## 10. 复现命令

```bash
bash verify/run-all.sh                      # 全量 + 哈希守护
node verify/probe.mjs;      echo $?         # 533 PASS / 0 FAIL
node verify/probe-index.mjs; echo $?        # 124 PASS / 1 FAIL（1 = D-12）
node verify/corpus-recall.mjs               # D-10/D-11 增量分离
node verify/session-trace.mjs 929b19b0 25   # 真实 turn 重建（R11 阳性 + D-11 现场）
node verify/repro-d1.mjs                    # D-1 三例（历史）
sha256sum plugin/src/detect.js plugin/index.js docs/INTERFACE.md
```

## 附：本次验证产出

| 文件 | 用途 |
| --- | --- |
| `verify/probe.mjs` / `verify/probe-out.txt` | detector 契约 + 攻击性 + D-10/D-11（533/0） |
| `verify/probe-index.mjs` / `verify/probe-index-out.txt` | 接线：R11/R13 两档、M5 收手态、**R16（含 D-12 复现）**（124/1） |
| `verify/corpus-recall.mjs` / `verify/corpus-recall-out.txt` | 真实语料的 D-10/D-11 增量分离复算 |
| `verify/session-trace.mjs` / `verify/session-trace-out.txt` | 单会话 turn 重建（R11/D-11 现场取证） |
| `verify/_pre-d10-detect.mjs` / `verify/_pre-d11-detect.mjs` | 两份基线快照（零漂移/增量对比基准） |
| `verify/run-all.sh` / `verify/run-all-out.txt` | 可复现全量 battery（哈希守护；`ls -lg` 不泄漏账号名） |
| `verify/tests-run-out.txt` | 作者测试台独立执行（190 PASS / 0 FAIL） |

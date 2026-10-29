# dsh-structured-output-guard

**English** — A DSH (DeepSeek Harness) Host plugin that turns *silent* tool-call failures into explicit, recoverable ones: it detects damaged tool-call arguments, blocks the broken call with an actionable reason, and self-heals a silently-closed turn by making the model retry inside the **same turn**.

**中文** — 一个 DSH（DeepSeek Harness）宿主插件，把**静默**的工具调用失败变成**显式且可恢复**的失败：检测损坏的调用参数、带可操作原因拦下这次调用；当 turn 被静默关闭时，让模型**在同一个 turn 内**重试。

> **Status / 状态** — Usable today; `M2` (block) and `M4` (self-heal) are **field-verified on a live profile**. Not everything is possible — see [Verified vs. not verified](#verified-vs-not-verified) and [Limitations](#limitations--已知边界). / 当前可用；`M2`（拦截）与 `M4`（自愈）已在真实 profile 上**现场验证**。并非所有设想都能实现，见「已验证 / 未验证」与「已知边界」。

---

## 1. The problem / 问题

**English.** When a model writes a very large tool-call argument — especially when the payload itself is full of `</`-prefixed closing tags (HTML, CSS, XML, JSX) — it can lose the argument's boundary while generating. Three shapes have been observed:

- **V1 — multiplied end sequence**: the call's closing marker repeats at the tail;
- **V2 — missing opening marker**: only a parameter opening appears, with no outer call opening;
- **V3 — leaked as prose**: the call envelope ends up in the assistant's **text** instead of becoming a real tool call.

All three fail **silently**: nothing executes, nothing errors, and the turn closes as though the work had been done. A related fourth shape (**V4**) comes from the harness's tolerant JSON parser — malformed arguments degrade to `{}`, so the tool runs with empty arguments.

**Worse**, the damaged output stays in the conversation. The model starts imitating its own broken formatting, so one bad step tends to reproduce itself, and **compaction does not remove the sample** — it only shrinks the surrounding text.

**中文.** 当模型要写一个非常大的工具调用参数时——尤其当内容本身就充满以 `</` 开头的闭合标签（HTML / CSS / XML / JSX）——它可能在生成过程中**丢掉参数的边界**。已观测到三种形态：

- **V1 结束序列增殖**：调用结尾的结束标记在尾部重复；
- **V2 开场标记缺失**：只剩参数开场标记，没有外层调用开场标记；
- **V3 泄漏为正文**：调用信封混进 assistant 的**正文**，没有被识别为真正的工具调用。

三种都**静默失败**：不执行、不报错，turn 正常关闭，流程上像是做完了。还有第四种相关形态 **V4**：harness 的容错 JSON 解析把非法参数降级成 `{}`，工具于是带着空参数执行。

**更麻烦的是**：损坏输出会留在对话里，模型开始模仿自己那份坏格式，于是一次坏步骤很容易**自我复制**；而 compact **不会删掉这个样本**，只会压缩它周围的文本。

### A real, abridged example / 一个真实的（节选）例子

Notation / 记号：`INVOKE_END` = the token formed by `<` + `/invoke` + `>` (written this way on purpose — the guard's whole point is not to emit literal closing-tag runs) / 即 `<`+`/invoke`+`>` 组成的 token（刻意这样书写：这个守卫存在的意义就是不写连续的字面闭合标签）。

**English.** One call whose argument body was long and tag-dense ended like this (abridged; the original repeated the outer end sequence **four** times):

**中文.** 一次参数体很长、闭合标签很密的调用，尾部变成了这样（节选；原文里外层结束序列重复了**四组**）：

```
<parameter name="code">…some long JS…</parameter>
<parameter name="description">Read ui.html size and profile job output</parameter>
INVOKE_END × 4   ← the outer end sequence repeats here / 外层结束序列在此重复
```

**English.** That step produced **no tool call at all**. The agent loop saw zero tool calls, returned `{kind:'completed'}`, and the turn closed. **Nothing errored anywhere.** The user's experience: the model appears to "stop working" mid-thought, output quality degrades, and every following turn keeps reproducing the same broken format.

**中文.** 那一步**一张工具卡都没产生**。agent 循环看到零个工具调用，直接返回 `{kind:'completed'}`，turn 就此关闭。**任何地方都没有报错。** 用户的体感是：模型像是在思考中途"停工"，输出质量持续下滑，而且后续每一轮都在重复同一种坏格式。

## 2. What changes after installing it / 装上之后的变化

| Before / 以前 | After / 现在 |
| --- | --- |
| The broken call does **not** run, and **no error appears** — it looks like it succeeded. / 坏的调用**不执行**、也**不报错**，看起来像成功了。 | The call is **blocked at dispatch** with an actionable reason: "argument boundary looks lost, **this call did not run**; split into ≤100-line chunks" — a silent no-op becomes a loud one. / 调用在**分发前被拦下**并给出可操作原因：「参数疑似边界丢失，**本次未执行**；请拆成 ≤100 行分块重发」——静默 no-op 变成显式失败。 |
| The envelope leaks as text, the step ends, and the turn is closed with nothing done. / 信封泄漏成正文，这一步什么都没做，turn 却正常关闭。 | The turn is **kept open** and a correction is injected, so the model retries **inside the same turn**. / **turn 不关闭**，并注入一条纠正，让模型**在同一个 turn 内**重发。 |
| A write tool reports success while having changed nothing. / 写入类工具自报成功、其实什么都没改。 | A one-line note is appended to the result: "reported no change — re-read to confirm". / 结果后面补一句：「工具自报未产生任何改动，请回读确认」。 |
| The damaged sample stays in history and keeps being imitated. / 坏样本留在历史里，持续被模仿。 | **Not solved.** The plugin cannot rewrite history on this harness build (see [Limitations](#limitations--已知边界)). It shortens the failure window; it does not launder the past. Workaround: start a fresh session, or tell the model in one line to ignore the damaged turn. / **没解决。** 在这版 harness 上插件改不了历史（见「已知边界」）。它缩短故障窗口，**不洗白过去**。绕法：新开会话，或用一句话让模型忽略那段损坏内容。 |

## 3. What it does (plain language) / 它做什么（人话）

**English.** Three guards, each one silent until something is actually wrong:

1. **Block (M2)** — before a tool call is dispatched, scan its parsed arguments. If a string argument has a damaged boundary — a multiplied trailing end sequence, or a structure that was cut off mid-way — **and** the payload is substantial (≥2000 chars or ≥20 lines), refuse the call and explain what to do instead. It also catches the `{}` case (empty arguments on a tool that declares required parameters).
2. **Nudge (M3)** — after a *write-class* tool runs, look for **machine-readable** evidence that it did nothing (`noop: true`, `status: "noop"`, `written: 0` with a real payload) and append a short note. It does **not** guess from free text.
3. **Self-heal (M4)** — watch committed assistant messages. If a step's output is damaged **and** that step produced **no tool call**, then at the moment the turn is about to close, inject a correction so the turn stays open and the model re-issues the call. This is the mechanism that targets the example in §1.

**中文.** 三个守卫，平时都不出声：

1. **拦截（M2）**——工具调用分发前扫描已解析的参数。若某个字符串参数的边界已损坏（尾部结束序列增殖，或结构中途被截断）**且**体量够大（≥2000 字符或 ≥20 行），就拒绝这次调用并说明该怎么改。它同时兜住 `{}` 那种情况（声明了必填参数的工具却收到空参数）。
2. **纠偏（M3）**——**写入类**工具跑完后，检查是否有**机器可读**的空转证据（`noop: true`、`status: "noop"`、`written: 0` 且确实带了内容），有就补一句短提示。它**不**做自由文本猜测。
3. **自愈（M4）**——观察已提交的 assistant 消息。若某一步的输出损坏**且**该步**没有任何工具调用**，就在 turn 即将关闭的那一刻注入一条纠正，让 turn 保持打开、模型重发调用。§1 里那个例子，正是靠它。

**Deliberately not done / 刻意没做**：no prompt injection at all (a system-prompt rule block was implemented and then **removed by design decision** — prompt-level rules are not enforceable and cost attention) / **完全不注入提示词**（曾经实现过 system-prompt 规则块，后按设计决策**移除**——提示词层约束力不保证，且会分散 attention）；no forced small-chunk write tool / 不做强制小块写入工具。

## 4. Install (for DSH users) / 安装（DSH 用户怎么装）

**English.** The plugin is installed through the Harness's own Plugin Manager — `install_bundle` accepts an absolute local path, a `file:`/`link:` path, a **git spec**, a tarball URL, or a registry name. Do not hand-edit the profile.

```text
# A. From a clone — works today, no extra infrastructure
git clone https://github.com/IRwDONE/dsh-structured-output-guard.git
#   then: plugin_manager -> install_bundle -> target = <abs path to the clone>\plugin
#   (the target must be the PACKAGE directory: the one holding package.json + cordis.patch.yml)

# B. One command straight from GitHub — needs a small repo change
#   target = https://github.com/IRwDONE/dsh-structured-output-guard
#   A git spec installs the package at the REPOSITORY ROOT. This repo keeps the bundle
#   in plugin/, so this form does not work until the bundle is moved to the root.

# C. Registry (npm), versioned
#   target = <scope>/dsh-structured-output-guard@<version>

# D. Tarball — a private/unpublished distribution channel
#   npm pack  (inside plugin/)  ->  host the .tgz  ->  target = <https URL to the .tgz>
```

**中文.** 用 Harness 自带的插件管理器安装——`install_bundle` 的 `target` 接受：**绝对本地路径**、`file:`/`link:` 路径、**git spec**、tarball URL、或 registry 包名。**不要**手改 profile。

- **A 克隆后本地安装**（现在就能用）：`git clone` 之后，`install_bundle` 的 target 指向**克隆目录下的 `plugin/`**——必须是**包目录**（含 `package.json` 与 `cordis.patch.yml` 的那层）。
- **B 直接用 GitHub 链接**（需先做一个小改动）：git spec 会按**仓库根**找包；本仓库的包在 `plugin/`，所以这条**现在不生效**，除非把包挪到仓库根。
- **C npm**：`<你的scope>/dsh-structured-output-guard@<版本>`。
- **D tarball**：在 `plugin/` 里 `npm pack`，把 `.tgz` 放到任意可下载处，target 填它的 https 直链——适合不发布到 registry 的分发。

**After installing / 安装之后**

```text
1. install_bundle returns application: "applied"  -> live.
   If it reports a restart is required, restart the Harness.
2. Confirm the row is mounted (Plugin Manager, or the Harness's Config inspection).
3. Disable at any time: Plugin Manager -> disable the bundle,
   or set  enabled: false  in the row's config (registers nothing at all).
```

**What is *not* needed / 不需要的东西**：no build step, no dependencies, no client-side half — the bundle is plain ESM JavaScript with a Node built-in only (`node:fs`, `node:os`, `node:path`) / 无构建、无依赖、无前端半边，纯 ESM + 仅用 Node 内置模块。

## 5. Configuration / 配置

**English.** The row's `config` is validated and normalised; invalid values fall back to defaults instead of throwing. Numeric thresholds must be integers ≥ 1 (only `maxCorrectionsPerTurn` may be `0`).

**中文.** 该行的 `config` 会被校验与归一化；非法值回退默认而不是抛错。数值阈值必须是**整数且 ≥1**（只有 `maxCorrectionsPerTurn` 允许 `0`）。

| Key / 键 | Default | Meaning / 含义 |
| --- | --- | --- |
| `enabled` | `true` | `false` registers nothing at all (equivalent to switching the plugin off) / 为 `false` 时**不注册任何监听器**，等同关闭插件 |
| `maxLines` | `100` | line ceiling for a single string leaf (`PAYLOAD_TOO_LONG` warning) / 单个字符串叶子的行数上限（`PAYLOAD_TOO_LONG` 预警） |
| `maxChars` | `20000` | character ceiling for a single string leaf / 单个字符串叶子的字符数上限 |
| `closingTagCount` | `8` | how many `</`-prefixes count as "dense" — evidence only, **never** causes a block / `</` 前缀出现多少次算「密集」——**只作证据**，永不导致拦截 |
| `endSequenceRepeats` | `2` | how many **consecutive trailing** end sequences count as damage / 尾部**连续**结束序列达到几个即判损坏 |
| `maxCorrectionsPerTurn` | `1` | self-heal attempts per turn (anti-loop) / 每个 turn 最多自愈几次（防循环） |
| `lang` | `zh` | `zh` / `en` — language of injected notes and block reasons / 注入文案与拦截原因的语言 |
| `noopCheck` | `true` | kill switch for `M3` / `M3` 空转检查的总开关 |
| `debugLog` | `false` | diagnostic log; `false` opens no file at all / 诊断日志；`false` 时不打开任何文件 |
| `debugLogPath` | `''` | empty ⇒ derived from the system temp directory (never hardcoded) / 空串 ⇒ 由系统临时目录推导（绝不硬编码） |
| `contextGuard` | `false` | **internal, not wired** — see Limitations / **内部保留、未接线**，见「已知边界」 |
| `contextGuardNote` | `''` | **internal, not wired** / **内部保留、未接线** |

## 6. Verified vs. not verified / 已验证 / 未验证

**English.** Verification is split deliberately: "the code does what the contract says" is proven by automated probes; "the plugin changes a real conversation" is only proven where it was actually observed.

**中文.** 验证刻意分两层：「代码是否符合契约」由自动化探针证明；「插件是否真的改变了真实对话」只在**亲眼观测到**的地方才算数。

| Claim / 结论 | Status | Evidence / 证据 |
| --- | --- | --- |
| `M2` blocks a damaged call instead of silently failing / `M2` 真的拦住了损坏调用 | ✅ **observed live** / **现场观测** | A real call with a ≥22-line, structure-truncated argument was rejected at dispatch, and the target file was confirmed **not created** / 一次真实的、22 行以上且结构截断的参数在分发前被拒，并确认目标文件**未被创建** |
| `M4` keeps the turn open and the model continues / `M4` 让 turn 不关闭并继续 | ✅ **observed live** / **现场观测** | The diagnostic log shows: `damaged:true, silentFailure:true` → `turn-stopping` found the record → `agent.inject()` succeeded → `agent/inbox/spliced` → a **new `step/start` in the same turn number** / 诊断日志完整链条：检测 → 命中记录 → 注入成功 → 落盘 → **同一 turn 号内新开一步** |
| `M3` fires only on explicit, machine-readable no-op evidence / `M3` 只认显式证据 | ✅ probed / 探针 | Independent probe; the earlier free-text heuristic was **removed** after it misfired 5 times in real sessions / 独立探针；早先的自由文本启发式在真实会话误报 5 次后**已删除** |
| Detector contract (shapes, rulings, purity) / 检测器契约 | ✅ probed / 探针 | 436 independent detector assertions + 86 wiring assertions, plus the author's 182, all green / 独立 436 + 接线 86，加作者测试台 182，全绿 |
| `M1` prevention prompt / `M1` 预防提示词 | ➖ **removed by design** / **按设计移除** | Prompt-level rules are not enforceable and dilute attention / 提示词层约束力不保证且分散 attention |
| `M5` history rewriting / `M5` 改写历史 | ❌ **impossible on this build** / **本版做不到** | See D-8 in Limitations / 见「已知边界」D-8 |
| The self-heal makes the model **actually redo** the lost work / 自愈能让模型**真正重做** | ⚠️ **pending** | In the observed case the continuation step did produce a tool call, but the sample was artificially constructed, so "does it redo the *right* work in a genuine failure" is still unproven / 观测到的那次后续步骤确实产生了工具调用，但样本是人工构造的，所以「真实故障下会不会重做**对的事**」仍未证实 |

**How it was verified / 怎么验的**：an independently authored probe (`verify/probe.mjs`, `verify/probe-index.mjs`) that does **not** reuse the author's assertions, plus a reproduction battery (`verify/run-all.sh`) that guards file hashes before and after each run. / 由**独立作者**编写的探针（不复用作者断言），外加一套带**前后哈希守护**的复现脚本。

## 7. Technical details / 技术细节

### 7.1 Two harness facts that shape the whole design / 决定设计的两条 harness 事实

1. **There is no text-protocol tool-call parser in DSH.** This build routes through provider-native OpenAI-style `tool_calls` (via `pi-ai`). So when the model emits the envelope as **prose**, nothing turns it into a call: the message contains zero `tool-call` blocks and the agent loop returns `{kind:'completed'}`. **Consequence: `tools/pre-execute` is never reached in that scenario — detection must happen on `session/event`.**
   **中文**：DSH 里**不存在**文本协议的调用解析器，本版走 provider 原生 `tool_calls`。所以信封被当正文吐出时，没有任何东西会把它变成调用——消息里零个 `tool-call` 块，循环直接返回 `{kind:'completed'}`。**结论：那个场景下 `tools/pre-execute` 根本不会被触达，检测只能挂在 `session/event` 上。**
2. **`llm/stream` receives a frozen request.** `dsh-agent-loop` builds the request and then `Object.freeze`s the whole envelope (and deep-freezes every message) before `dsh-llm` hands it to the waterfall. A listener therefore **cannot** rewrite the model-visible history — which is exactly why `M5` was stood down.
   **中文**：`dsh-agent-loop` 组装完请求后把整个 envelope `Object.freeze`（并 deepFreeze 每条消息），才交给 `dsh-llm` 的 waterfall。所以监听器**无法**改写模型可见历史——`M5` 停用的直接原因。

### 7.2 Seams / 接缝

| Mechanism | Seam / 接缝 | Discipline / 纪律 |
| --- | --- | --- |
| `M2` | `tools/pre-execute` waterfall `(exec, next)` | deny, or `next()` — never take over another listener's decision / 要么拒绝，要么 `next()`，绝不接管别人的决策 |
| `M3` | `tools/post-execute` waterfall `(exec, result, next)` | `await next()` first, then **only add** `additionalContexts` / 先 `await next()`，然后**只做加法** |
| `M4` observe | `session/event` → `assistant/message` | observer only; a committed append is never disturbed / 只观察，绝不干扰已提交的事件 |
| `M4` correct | `agent/turn-stopping` (serial) + `agent.inject()` | inject puts a message on the next step **without waking the driver**, which is what keeps the closing turn open / `inject` 把消息放进 `next-step` 且**不唤醒驱动**，这正是 turn 不关闭的原因 |

### 7.3 Contract & evidence / 契约与证据

- `docs/INTERFACE.md` — the **frozen** detector contract and every ruling (R1–R12), including the ones that were changed after evidence contradicted them. / **冻结**的检测器契约与全部裁定（R1–R12），含那些被证据推翻后修正过的。
- `docs/CONTRACTS.md` — the pre-implementation contract dig, every claim carrying a file path + line number. / 实现前的契约调研，每条结论都带文件路径与行号。
- `docs/DESIGN.md` — failure taxonomy, trigger conditions, mechanism design, and the corrections made after measurement. / 故障分类、触发条件、机制设计与实测后的修正。
- `docs/PROMPTS.md` — the prevention/correction/denial texts, kept even though the plugin no longer injects any prompt (available for manual use). / 预防/纠正/拒绝三段文案——插件已不注入提示词，文本留作手动选用。
- `verify/REPORT.md` — the independent verification report, including the defects that were found and fixed. / 独立验证报告，含查出的缺陷与修复。

### 7.4 Defects found during verification / 验证期间查出的缺陷

Recorded because they are the useful part: two of them were only findable by reading source or by attacking the implementation, not by running the happy path. / 列出来是因为它们才是真正有用的部分——其中两个只能靠读源码或对抗性测试发现，跑正常路径永远跑不出来。

| ID | Severity | What it was / 是什么 |
| --- | --- | --- |
| `D-0` | high | Injected messages used the retired `source.kind = 'plugin'`, which the v4 session format **hard-rejects** (it can make a session unreadable). Fixed to a producer-owned kind. / 注入消息用了已退休的 `source.kind='plugin'`，被 v4 会话格式**硬拒绝**（可能让会话不可读）。已改为生产者自有 kind。 |
| `D-1` | medium‑high | The truncation predicate was inverted: it missed real truncation **and** blocked legitimate documents — including the plugin's own README. Fixed, and the test suite gained direction-sensitive cases. / 截断判据方向写反：既漏报真截断，又误拦合法文档（含插件自己的 README）。已修，并补了能区分判据方向的用例。 |
| `D-8` | high (accepted) | `M5` cannot rewrite a frozen request ⇒ `contextGuard` was a capability gap, not a bug. Wiring removed; implementation kept. / `M5` 改不了冻结的请求 ⇒ 属能力缺失而非 bug。已移除接线，保留实现。 |
| `D-5/D-6/D-7/D-9` | low | Contract drift, a hardcoded local path in a default, a diagnostic switch left on in the shipped patch, and a self-contradictory doc paragraph. All fixed. / 契约漂移、默认值里硬编码本机路径、发布件里留着诊断开关、以及自相矛盾的文档段落。全部修复。 |

## 8. Limitations / 已知边界

1. **It cannot clean up an already-poisoned conversation.** History rewriting needs a writable seam (`M5`, `D-8`). Workaround: new session, or one line asking the model to ignore the damaged turn. / **治不了已经被带坏的对话**：改写历史需要可写接缝（`M5`，D-8）。绕法：新开会话，或一句话让模型忽略那段。
2. **It does not prevent the first failure.** Prompt-level prevention was removed by design, so the first bad write still happens — it just stops being silent. / **不阻止第一次失败**：提示词层预防已按设计移除，第一次照样写坏，只是不再静默。
3. **Bounded scanning.** At most 200 string leaves and depth 24 are inspected; deeper or later leaves can be missed (fail-quiet, by design). / **有界扫描**：最多 200 个字符串叶子、深度 24，更深或更靠后的会漏检（有意为之，宁漏勿扰）。
4. **Config is validated but has no UI form.** It uses a hand-written Standard Schema v1 (so the bundle stays dependency-free), which the manager reports as `unsupported` — validation works, no JSON-Schema form. / **配置会被校验但没有 UI 表单**：手写 Standard Schema v1（保持零依赖），管理器报 `unsupported`。
5. **Self-heal costs one extra model call** when it fires, bounded by `maxCorrectionsPerTurn`. / **自愈触发时多一次模型请求**，由 `maxCorrectionsPerTurn` 限次。
6. **`M4` never touches real tool calls.** Only messages with **zero** `tool-call` blocks are ever rewritten or judged for self-heal. / **`M4` 绝不碰真实工具调用**：只处理**没有任何** `tool-call` 块的消息。

## 9. Repository layout / 仓库结构

```text
plugin/            the installable bundle (package.json + cordis.patch.yml + index.js + src/)
  src/detect.js    pure detection core — no DSH imports, runnable under plain node
  index.js         Host wiring: M2/M3/M4, every listener in try/catch + effect-scoped
docs/              design, frozen contract (R1–R12), contract dig, prompt texts
tests/             182 assertions: fixtures for V1/V2/V3 + counter-examples, property tests
verify/            independent verification: separate probes + reproduction battery + report
```

`plugin/` is the package; everything else is evidence. / `plugin/` 是包本体，其余都是证据。

## 10. License / 许可

MIT — see [LICENSE](LICENSE). / MIT，见 [LICENSE](LICENSE)。

## 11. Feedback / 反馈

Issues and reproductions are welcome, especially **a genuine silent failure** with the raw transcript: that is the one case `M4`'s effectiveness has not yet been proven against. / 欢迎 issue 与复现，尤其是**真实的静默失败**＋原始记录——那正是 `M4` 有效性唯一还没被证实的场景。



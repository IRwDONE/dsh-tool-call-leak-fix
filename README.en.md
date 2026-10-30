# dsh-structured-output-guard

[简体中文](README.md) | **English**

> Package `@irwdone/dsh-structured-output-guard` (same name as the GitHub repo) | current version **0.2.0**.
> **How to tell the local plugin really updated**: read this bundle's version in the Plugin Manager, or look at
> `node_modules/@irwdone/dsh-structured-output-guard/package.json` in the profile.

A **DSH (DeepSeek Harness) Host plugin** that turns **silent** tool-call failures into **explicit, recoverable** ones.

It detects damaged tool-call arguments, blocks the broken call with an actionable reason, and — when a turn would otherwise close silently — makes the model retry **inside the same turn**.

> **Status.** Usable today. `M2` (block) and `M4` (self-heal) are **field-verified on a live profile**. Not every idea turned out to be possible: please read [Verified vs. not verified](#6-verified-vs-not-verified) and [Limitations](#8-limitations).

---

## 1. The problem

When a model writes a very large tool-call argument — especially when the payload itself is full of `</`-prefixed closing tags (HTML, CSS, XML, JSX) — it can **lose the argument's boundary** while generating. Three shapes have been observed:

- **V1 — multiplied end sequence**: the call's closing marker repeats at the tail;
- **V2 — missing opening marker**: only a parameter opening appears, with no outer call opening;
- **V3 — leaked as prose**: the call envelope ends up in the assistant's **text** and is never recognised as a tool call.

The leaked markup also comes in **more than one dialect**: bare tags (`<invoke` / `<parameter`) *and* **namespace-prefixed** ones (e.g. `<antml:invoke>` / `<antml:parameter>`). The prefixed form once made the detector miss a real failure **entirely** — `<antml:parameter` contains no `<parameter` substring. That is defect **D-10**, now fixed (see §7.4).

A worse variant is the **fabricated tool result**: the text contains a tool-result-shaped block while that step made **no tool call at all** — the model reports a result it never obtained (down to a specific version number). That is a **false fact**, worse than a silent no-op. Defect **D-11**, now fixed (see §7.4).

The cleanest variant of all is the **bare envelope**: the message *is* a **complete, balanced** call envelope with **no prose whatsoever** (that step's `toolCallCount === 0`). It slipped past every rule — no prose, so the prose rule stays quiet; balanced structure, so truncation and unpaired-closer checks stay quiet — leaving `damaged=false`, no M4, and a silently closed turn. Defect **D-13**, now fixed (see §7.4).

All three fail **silently**: nothing executes, nothing errors, and the turn closes as though the work had been done.

A related fourth shape (**V4**) comes from the harness's tolerant JSON parser: malformed arguments degrade to `{}`, so the tool runs with empty arguments.

**Worse**, the damaged output stays in the conversation. The model starts imitating its own broken formatting, so one bad step tends to reproduce itself — and **compaction does not remove the sample**, it only shrinks the text around it.

### A real, abridged example

> Notation: `INVOKE_END` is the token formed by `<` + `/invoke` + `>`. It is spelled that way on purpose — **not emitting literal closing-tag runs is the entire point of this guard**.

One call whose argument body was long and tag-dense ended like this (abridged; the original repeated the outer end sequence **four** times):

```
<parameter name="code">…some long JS…</parameter>
<parameter name="description">Read ui.html size and profile job output</parameter>
INVOKE_END × 4   ← the outer end sequence repeats here
```

That step produced **no tool call at all**. The agent loop saw zero tool calls, returned `{kind:'completed'}`, and the turn closed. **Nothing errored anywhere.**

What the user experiences: the model appears to stop working mid-thought, output quality degrades, and every following turn keeps reproducing the same broken format.

## 2. What changes after installing it

| Before | After |
| --- | --- |
| The broken call does **not** run, and **no error appears** — it looks like it succeeded. | The call is **blocked at dispatch** with an actionable reason: "argument boundary looks lost, **this call did not run**; split into ≤100-line chunks". A silent no-op becomes a loud one. |
| The envelope leaks as text, the step does nothing, and the turn is closed anyway. | The turn is **kept open** and a correction is injected, so the model retries **inside the same turn**. |
| A write tool reports success while having changed nothing. | A one-line note is appended to the result: "reported no change — re-read to confirm". |
| The damaged sample stays in history and keeps being imitated. | **Not solved.** The plugin cannot rewrite history on this harness build (see [Limitations](#8-limitations)). It shortens the failure window; it does not launder the past. Workaround: start a fresh session, or tell the model in one line to ignore the damaged turn. |

## 3. What it does (plain language)

Three guards, each one silent until something is actually wrong:

1. **Block (M2)** — before a tool call is dispatched, scan its parsed arguments. If a string argument has a damaged boundary — a multiplied trailing end sequence, or a structure cut off mid-way — **and** the payload is substantial (≥2000 chars or ≥20 lines), refuse the call and explain what to do instead. It also catches the `{}` case: a tool that declares required parameters receiving empty arguments.
2. **Nudge (M3)** — after a **write-class** tool runs, look for **machine-readable** evidence that it did nothing (`noop: true`, `status: "noop"`, `written: 0` with a real payload) and append a short note. It does **not** guess from free text.
3. **Self-heal (M4)** — watch committed assistant messages. If a step's output is damaged **and** that step produced **no tool call**, then at the moment the turn is about to close, inject a correction so the turn stays open and the model re-issues the call. This is the mechanism aimed at the example in §1.
   It is **two-tier, and bounded**: the first correction says "that step did not run — here is how to retry"; if the very next step is damaged **again** (which really happened in a live session), one **shorter, harder** instruction follows — "this step: issue exactly one call, keep it under 40 lines, add no explanation". The cap is `maxCorrectionsPerTurn` (this bundle ships `2`); at the cap it stops instead of looping.
4. **Fork brief (M7)** — a **forked session inherits the parent's history**, and forking is exactly what you do after a failure. That history cannot be rewritten (frozen request, D-8), but the plugin can place **one code-generated briefing before the fork's first model step**: stray call markup with **no matching tool card** is declared **damaged and never executed** — ignore it, do not imitate it, and re-issue calls in small chunks. **Once per session**; zero overhead for sessions that are not forks.

**Deliberately not done**: **no prompt injection at all** (a system-prompt rule block was implemented and later **removed by design decision** — prompt-level rules are not enforceable and cost attention), and no forced small-chunk write tool.

## 4. Install (for DSH users)

Install through the Harness's own **Plugin Manager**. `install_bundle`'s `target` accepts an **absolute local path**, a `file:` / `link:` path, a **git spec**, or a tarball URL. Do **not** hand-edit the profile.

**Option A · clone, then install locally (works today; recommended)**

```bash
git clone https://github.com/IRwDONE/dsh-structured-output-guard.git
```

Then run `install_bundle` with the **absolute path to `plugin/` inside the clone**:

```
<your-clone-path>\dsh-structured-output-guard\plugin
```

⚠️ The target must be the **package directory** — the one holding `package.json` and `cordis.patch.yml`.

**Option B · one command straight from GitHub (does not work yet)**

```
https://github.com/IRwDONE/dsh-structured-output-guard
```

A git spec looks for the package at the **repository root**, and this repo keeps its bundle in the `plugin/` subdirectory, so this form **currently fails**. It will work once the bundle is moved to the root (an optional improvement, not done).

**After installing**

```
1. install_bundle returns application: "applied"  -> live.
   If it reports that a restart is required, restart the Harness.
2. Confirm the row is mounted — check the right place:
   - OK: the Plugin Manager list, or the Harness's Config inspection (it shows
     `include:structured-output-guard`).
   - OK: the strongest signal is that it actually injects a correction.
   - NOT OK: do **not** grep the profile's
     `~/.dsh/profiles/<profile>/cordis.patch.yml`. A bundle ships **its own**
     patch (this package's `plugin/cordis.patch.yml`, declared by
     `dsh.bundle.patch`), so that row is **not** in the profile patch by design.
     A real session concluded "the plugin is not activated" from exactly that
     grep and sent the whole investigation off course.
3. Disable at any time: disable the bundle in the Plugin Manager, or set the row
   config's `enabled` to false (that registers nothing at all).
```

**Not needed**: a build step, any runtime dependency, or a client-side half. The bundle is plain ESM JavaScript using only Node built-ins (`node:fs`, `node:os`, `node:path`).

## 5. Configuration

The row's `config` is **validated and normalised**; invalid values **fall back to defaults** instead of throwing. Numeric thresholds must be **integers ≥ 1** (only `maxCorrectionsPerTurn` may be `0`).

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` registers **nothing at all** (equivalent to switching the plugin off) |
| `maxLines` | `100` | line ceiling for a single string leaf (`PAYLOAD_TOO_LONG` warning) |
| `maxChars` | `20000` | character ceiling for a single string leaf |
| `closingTagCount` | `8` | how many `</`-prefixes count as "dense" — **evidence only**, never causes a block |
| `endSequenceRepeats` | `2` | how many **consecutive trailing** end sequences count as damage |
| `maxCorrectionsPerTurn` | `1` | self-heal attempts per turn (anti-loop). **This bundle's patch sets `2`**, which enables the harder second correction when the first one did not take |
| `lang` | `zh` | `zh` / `en` — language of injected notes and block reasons |
| `noopCheck` | `true` | kill switch for `M3` |
| `debugLog` | `false` | diagnostic log; `false` opens no file at all (zero overhead) |
| `debugLogPath` | `''` | empty ⇒ derived from the **system temp directory** (never hardcoded) |
| `contextGuard` | `false` | **internal, not wired** — see [Limitations](#8-limitations) |
| `contextGuardNote` | `''` | **internal, not wired** |
| `forkBrief` | `true` | **R16 (M7)**: a forked session gets one "session brief" **before its first step**, marking the inherited damaged artifacts as invalid. Set `false` to disable |
| `forkBriefNote` | `''` | **R16**: briefing text; empty ⇒ the built-in localized text |

## 6. Verified vs. not verified

Verification is split deliberately: "the code does what the contract says" is proven by automated probes; "the plugin changes a real conversation" counts only where it was actually observed.

| Claim | Status | Evidence |
| --- | --- | --- |
| `M2` blocks a damaged call instead of silently failing | ✅ **observed live** | A real call with a ≥22-line, structure-truncated argument was rejected at dispatch, and the target file was confirmed **not created** |
| `M4` keeps the turn open and the model continues | ✅ **observed live, in a real user session** | In a genuine session: `damaged:true, silentFailure:true` → `turn-stopping` found the record → `agent.inject()` (`kind=runtime-context`) → `agent/inbox/spliced` → **a new `step/start` in the same turn** |
| `M3` fires only on explicit, machine-readable no-op evidence | ✅ probed | Independent probe; the earlier free-text heuristic was **removed** after it misfired 5 times in real sessions |
| Detector contract (shapes, rulings, purity) | ✅ probed | **480** independent detector assertions + **102** independent wiring assertions, plus the author's **187**, all green |
| `M1` prevention prompt | ➖ **removed by design** | Prompt-level rules are not enforceable and dilute attention |
| `M5` history rewriting | ❌ **impossible on this build** | See D-8 in [Limitations](#8-limitations) |
| The self-heal makes the model **actually redo** the lost work | ⚠️ **observed: it did not** | In that live session M4 worked end to end (detected → injected → turn stayed open for one more step) — but **that step was damaged again** (it dumped ~23 KB as prose), the cap ran out, and the turn closed. This is what motivated the second tier; the second tier itself is **not yet** observed against a genuine failure |

**How it was verified**: an independently authored probe (`verify/probe.mjs`, `verify/probe-index.mjs`) that does **not** reuse the author's assertions, plus a reproduction battery (`verify/run-all.sh`) that guards file hashes before and after every run.

## 7. Technical details

### 7.1 Two harness facts that shape the whole design

1. **There is no text-protocol tool-call parser in DSH.** This build routes through provider-native OpenAI-style `tool_calls` (via `pi-ai`). So when the model emits the envelope as **prose**, nothing turns it into a call: the message contains zero `tool-call` blocks and the agent loop returns `{kind:'completed'}`. **Consequence: `tools/pre-execute` is never reached in that scenario — detection must happen on `session/event`.**
2. **`llm/stream` receives a frozen request.** `dsh-agent-loop` builds the request and then `Object.freeze`s the whole envelope (and deep-freezes every message) before `dsh-llm` hands it to the waterfall. A listener therefore **cannot** rewrite the model-visible history — which is exactly why `M5` was stood down.

### 7.2 Seams and discipline

| Mechanism | Seam | Discipline |
| --- | --- | --- |
| `M2` | `tools/pre-execute` waterfall `(exec, next)` | deny, or `next()` — never take over another listener's decision |
| `M3` | `tools/post-execute` waterfall `(exec, result, next)` | `await next()` first, then **only add** `additionalContexts` |
| `M4` observe | `session/event` → `assistant/message` | observer only; a committed append is never disturbed |
| `M4` correct | `agent/turn-stopping` (serial) + `agent.inject()` | `inject` puts a message on the next step **without waking the driver**, which is what keeps the closing turn open |

### 7.3 Docs and evidence

- `docs/INTERFACE.md` — the **frozen** detector contract and every ruling (R1–R17), including the ones changed after evidence contradicted them.
- `docs/CONTRACTS.md` — the pre-implementation contract dig; every claim carries a file path and line number.
- `docs/DESIGN.md` — failure taxonomy, trigger conditions, mechanism design, and the corrections made after measurement.
- `docs/PROMPTS.md` — the prevention/correction/denial texts, kept even though the plugin no longer injects any prompt (available for manual use).
- `verify/REPORT.md` — the independent verification report, including the defects found and fixed.

### 7.4 Defects found during verification

Listed because they are the useful part: two of them were only findable by reading source or by attacking the implementation, never by running the happy path.

| ID | Severity | What it was |
| --- | --- | --- |
| `D-0` | high | Injected messages used the retired `source.kind = 'plugin'`, which the v4 session format **hard-rejects** (it can make a session unreadable). Fixed to a producer-owned kind |
| `D-1` | medium-high | The truncation predicate was inverted: it missed real truncation **and** blocked legitimate documents — including the plugin's own README. Fixed, with direction-sensitive test cases added |
| `D-8` | high (accepted) | `M5` cannot rewrite a frozen request ⇒ a **capability gap**, not a bug. Wiring removed, implementation kept |
| `D-10` | high | The detector only knew **bare** tags, so it could not see the **namespace-prefixed** form that a real failure used (`<antml:invoke>` / `<antml:parameter>`) ⇒ `damaged=false` ⇒ M4 never fired and the turn closed silently. Fixed (R14: structural analysis runs on a namespace-stripped shadow copy; text without a colon is returned as the identical string, so nothing drifts). **Corpus-level check (an invariant, not a snapshot)**: running every real session's text through the pre- and post-fix detector changes the verdict for exactly **1** message — the very fork the user hit. Absolute totals keep growing because the log is append-only (verification itself writes into it), so they are not a baseline |
| `D-11` | high | **Fabricated tool result**: a step with `toolCallCount === 0` whose text was a `tool_result`-shaped block around a version string (observed in a real session) — the model reported a result it **never obtained**, i.e. a **false fact**. Fixed (R15: result-shaped markup in assistant prose reports `MARKUP_LEAKED_AS_TEXT`; the existing code is reused, `meta` is not consulted, and no natural-language sentence is required; when the step *did* make tool calls, `silentFailure` stays false so R1 blocks the injection) |
| `D-12` | high | **M7 read an API that does not exist**: the first version read `agent.session.events` looking for a `type === 'session'` entry, but `Session` has no `events` and no such event (the fork marker lives on `session.header`) ⇒ the function always returned null ⇒ **M7 was a silent no-op**. Caught by independent verification with three independent proofs (interface declaration, implementation, runtime event catalog). Fixed by reading `session.header`. **Same failure class as D-8/M5: a plausible-looking API that is not there, then silently doing nothing** |
| `D-13` | high | **Bare-envelope miss**: a step with `toolCallCount === 0` whose message was a **complete, balanced, prose-free** call envelope (325 chars, observed live) **slipped past every existing rule** (the prose rule needs a natural-language sentence; a balanced structure defeats the truncation and unpaired-closer checks) ⇒ `damaged=false`, M4 never fired, the turn closed silently. Fixed (R17: after normalisation, if `trimStart()` **starts with a call opening marker** it reports `MARKUP_LEAKED_AS_TEXT` — no prose and no structural damage required; code-fenced quotes and prose explanations stay clean). The negative fixture `ok-single-end-sequence.txt` was reclassified to a **quoted** form (its old content *was* a bare envelope) and the assertions were only **added to**, never weakened |
| `D-5 / D-6 / D-7 / D-9` | low | Contract drift, a hardcoded local path in a default, a diagnostic switch left on in the shipped patch, and a self-contradictory doc paragraph. All fixed |

## 8. Limitations

1. **It cannot clean up an already-poisoned conversation.** History rewriting needs a writable seam (`M5`, `D-8`). Workaround: a new session, or one line asking the model to ignore the damaged turn.
2. **It does not prevent the first failure.** Prompt-level prevention was removed by design, so the first bad write still happens — it just stops being silent.
3. **Bounded scanning.** At most 200 string leaves and depth 24 are inspected; deeper or later leaves can be missed (fail-quiet, by design).
4. **Config is validated but has no UI form.** It uses a hand-written Standard Schema v1 (so the bundle stays dependency-free), which the manager reports as `unsupported` — validation works, no JSON-Schema form.
5. **Self-heal costs one extra model call** per attempt, bounded by `maxCorrectionsPerTurn`.
6. **`M4` never touches real tool calls.** Only messages with **zero** `tool-call` blocks are judged for self-heal.

## 9. Repository layout

```text
plugin/           the installable bundle (package.json + cordis.patch.yml + index.js + src/)
  src/detect.js   pure detection core — no DSH imports, runnable under plain node
  index.js        Host wiring: M2/M3/M4, every listener in try/catch + effect-scoped
docs/             design, frozen contract (R1–R13), contract dig, prompt texts
tests/            182 assertions: fixtures for V1/V2/V3 + counter-examples + property tests
verify/           independent verification: separate probes + reproduction battery + report
```

`plugin/` is the package; everything else is evidence.

## 10. License

MIT — see [LICENSE](LICENSE).

## 11. Feedback

Issues and reproductions are welcome, especially **a genuine silent failure** with the raw transcript: the one live case so far showed M4 keeping the turn open while the model failed again — which is exactly what the second tier now targets.




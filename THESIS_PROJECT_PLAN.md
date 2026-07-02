# DebugMCP Thesis — Full Project Plan & Research Proposal

**Working title:** *Does Runtime Visibility Help? Evaluating Interactive Debugging (DebugMCP) for Autonomous Bug Resolution by LLM Agents.*

**Research question:** Does equipping AI agents with programmatic, interactive debugging tools (via DebugMCP) significantly improve bug-resolution *performance* and *operational efficiency* vs. non-debugger baselines?

**Artifact under test:** DebugMCP — a VS Code extension exposing 12 DAP-backed MCP tools to any MCP agent:
`start_debugging, stop_debugging, restart_debugging, step_over, step_into, step_out, continue_execution, add_breakpoint, remove_breakpoint, clear_all_breakpoints, list_breakpoints, get_variables_values, evaluate_expression`.
Runs locally on `localhost:3001`; companion `/debug-live` skill supplies the workflow prompt.

---

## 0. Document map
1. Background & Motivation
2. Related Work & Positioning
3. Hypotheses & Success Criteria
4. Metrics (performance / resource / time)
5. Benchmark & Dataset
6. Evaluation Design (factors & controls)
7. System Architecture & Harness
8. Data Preparation & Difficulty Labelling
9. Statistical Analysis Plan
10. Ablations & Secondary Studies
11. Work Breakdown & Timeline
12. Budget Estimate
13. Reproducibility & Artifacts
14. Threats to Validity & Limitations
15. Risk Register & Contingencies
16. Ethics, Licensing & Compute
17. Deliverables

---

## 1. Background & Motivation
AI agents increasingly resolve bugs/PRs autonomously, but usually operate *blind* to runtime state — iterating over code rewrites and parsing large logs, which caps capability and inflates latency + token cost. DebugMCP gives agents direct, structured access to execution state (variables, call stack, expression evaluation, breakpoints) via the Debug Adapter Protocol. This study asks whether that runtime visibility yields measurable gains in resolution rate and resource efficiency, and under budget constraints (the cost-effective-agent framing, Einy/Milo et al., 2025/2026).

## 2. Related Work & Positioning
- **Debug2Fix — "Can Interactive Debugging Help Coding Agents Fix More Bugs?"** (Microsoft, arXiv:2602.18571) — **the most directly related work.** Integrates interactive debugging into coding agents via a *subagent architecture* with debuggers for Java & Python; on **GitBug-Java** and **SWE-Bench-Live** it reports **>20% bug-fixing improvement** for some models, and — critically — lets weaker/cheaper models (GPT-5, Claude Haiku 4.5) match or beat stronger ones (Claude Sonnet 4.5). Ablations show both the subagent architecture *and* debugger integration matter. **How we differ:** (i) DebugMCP exposes a *real IDE debugger* (VS Code DAP via MCP) rather than a bespoke subagent harness; (ii) we cover **5 languages** (Python, JS/TS, Go, Rust, +.NET stretch) vs. their Java/Python; (iii) we explicitly isolate the effect of the **workflow-instruction skill** (`/debug-live`) as its own arm — i.e., tools-alone vs. tools+skill; (iv) we add an explicit **time** dimension and **budget-capped ROI** analysis. Debug2Fix strongly *motivates* the thesis; our job is independent, cross-language, IDE-debugger confirmation + the skill/time/budget decomposition.
- **LDB** (ACL 2024, arXiv:2402.16906): verifies runtime execution block-by-block; +up to ~9.8% on HumanEval/MBPP/TransCoder. **Limitation vs. us:** synthetic code-gen benchmarks, Python-only, not real-world PR repos.
- **debug-gym** (Microsoft, arXiv:2503.21557, 2025): text-based interactive debugging env exposing pdb-like tools to agents. **Limitation vs. us:** simulated env, single-language focus; not a real IDE debugger across 5 languages.
- **Live-SWE-agent** (2025): self-modifying "live" agent scaffold with runtime state tracking; SOTA on SWE-bench Verified (Claude Opus 4.5 ~79%). Relevant as a strong runtime-aware baseline scaffold.
- **SWE-agent / Agentless / OpenHands**: agent scaffolds for SWE-bench; strong on file/terminal access but no first-class runtime-state tooling.
- **Benchmarks in the space:** SWE-bench (+ Verified / Lite / Multilingual / Multimodal), **Multi-SWE-bench**, **SWE-Bench-Live**, **GitBug-Java** (the last two used by Debug2Fix — worth adopting for direct comparability).
- **Surveys / meta:** "Dissecting the SWE-Bench Leaderboards" (ICSE 2026, arXiv:2506.17208); surveys on LLM-based automated program repair and code-generation agents (2025) — for taxonomy and positioning.
- **Cost-effective agentic AI / budget-constrained LLMs** (Einy/Milo et al.): resource-allocation and ROI-under-budget framing we adopt for the efficiency analysis.

**Novelty of this thesis (relative to Debug2Fix and the rest):** (1) a *real IDE debugger* (DAP) exposed as generic MCP tools, harness-agnostic, rather than a bespoke subagent; (2) *broader multilingual* coverage (5 languages); (3) a controlled **skill ablation** — does the runtime-visibility gain come from the *tools* or from the *instruction on how to use them*?; (4) explicit **time** metrics and **budget-capped ROI** across a newer model tier (incl. Claude Opus).

## 3. Hypotheses & Success Criteria
- **H1 (capability):** DebugMCP arms (B, C) achieve higher Resolved % than the vanilla baseline (A), with the largest gap on **high-difficulty / state-dependent** bugs. *Pre-registered success:* >= +5 percentage points A→C overall (paired), p < 0.05 (McNemar), and a larger absolute gap in the high-difficulty stratum than the low.
- **H1b (skill effect):** the tools+skill arm (C) outperforms tools-only (B), quantifying the value of workflow instruction. *Success:* significant B→C improvement in Resolved % and/or steps.
- **H2 (efficiency):** DebugMCP (C) uses fewer **agent steps** and fewer **tokens per solved instance** than A despite added debug-session latency. *Success:* statistically significant reduction (Wilcoxon, p < 0.05) in tokens-per-solved.
- **H3 (budget ROI):** Under tight budget caps, DebugMCP has higher **solved-per-$** than the vanilla baseline; a *cheaper model + DebugMCP* can match a premium model without it (cf. Debug2Fix). *Success:* dominates on the solved-vs-budget Pareto curve at >= 1 cap level.
- **Null result is publishable:** if H1–H3 fail, the contribution is a rigorous negative / "when-does-it-help" characterization.

## 4. Metrics

### 4A. Performance / Capability
| Metric | Definition |
|---|---|
| Resolution success rate (Resolved %) | patch makes all fail-to-pass tests pass and keeps pass-to-pass tests passing |
| Success by difficulty | Resolved % split low/med/high |
| Success on state-dependent bugs | Resolved % on runtime-state-heavy subset |
| Empty/invalid-patch rate | % runs producing no applicable diff |
| Regression rate | % patches breaking previously passing tests |

### 4B. Resource efficiency
| Metric | Definition |
|---|---|
| Input / output / total tokens per instance | prompt+completion tokens across trajectory |
| Tokens per *solved* instance | total tokens / resolved (efficiency-adjusted) |
| Agent steps / iterations | LLM turns + tool calls until stop |
| Tool-call breakdown | count per tool (esp. `get_variables_values`, `evaluate_expression`, breakpoints) |
| Context-window peak | max tokens in any single turn |
| $ cost per instance / per solved | tokens x model price |

### 4C. Time (explicit)
| Metric | Definition |
|---|---|
| Wall-clock latency per instance | task start -> final patch |
| Wall-clock per *solved* instance | latency / resolved |
| LLM-time vs tool/exec-time split | model-thinking vs DAP/step/test-run time |
| Time-to-first-hypothesis | until first patch attempt / root-cause statement |
| Debugger-session overhead | added latency from launching/stepping the debug session (DebugMCP arm) |

> Report mean +/- std **and** median (latency & tokens are heavy-tailed).

## 5. Benchmark & Dataset
- **Primary: Multi-SWE-bench** (ByteDance, NeurIPS 2025) — 1,632 real issue->PR pairs; Java, TS, JS, Go, Rust, C, C++ (+Python); Docker fail-to-pass/pass-to-pass oracle. Use `mini`(400) / `flash`(300) slices for thesis scale.
- **For direct comparability with Debug2Fix: SWE-Bench-Live** (fresh, contamination-resistant real issues) **and GitBug-Java** — adopting these lets us report numbers side-by-side with arXiv:2602.18571.
- **Secondary: SWE-bench Multilingual** (300 curated, 9 langs) — leaderboard-comparable cross-check.
- **Python anchor: SWE-bench Verified** subset — ties to widely reported Python baseline; validates harness.
- **Language mapping (proposal: Python, JS/TS, Go, .NET, Rust):**
  - Python -> SWE-bench Verified
  - JS/TS, Go, Rust -> Multi-SWE-bench + SWE-bench Multilingual
  - **.NET/C# not natively covered** -> (a) scope out & document as limitation *(recommended)*, or (b) build a 10–20 instance custom C# mini-set from real PRs w/ xUnit fail-to-pass tests *(stretch)*.
- **Study sample:** ~150–200 instances, stratified across 4–5 languages x 3 difficulty bins; identical set reused across every arm & model (paired design).

## 6. Evaluation Design (factors & controls)

> **What is an "arm"?** An *arm* is one experimental condition (a treatment group) that an agent is run under. All arms solve the *same* instances with the *same* scaffold; only the **available tools and/or instructions differ**. Comparing arms isolates the effect of adding debug tools and of adding the workflow skill.

**Primary arms (the independent variable):**
| Arm | Tools available | Skill / instructions | Purpose |
|---|---|---|---|
| **A — Vanilla baseline** | read / write / execute files (like a default GitHub Copilot session); **no debug tools, no runtime state** | none | Control: today's typical agent |
| **B — DebugMCP tools, no skill** | A + the 12 DebugMCP debug tools | **no** `/debug-live` skill (tools exposed, no guidance on when/how to use them) | Isolates the effect of the *tools alone* |
| **C — DebugMCP tools + skill (full)** | A + the 12 DebugMCP debug tools | `/debug-live` workflow skill loaded | Isolates the added value of *instruction on how to use the tools* |

*Contrast A→B = effect of runtime-debugging tools; B→C = effect of the workflow skill; A→C = full DebugMCP effect.*

**Optional supplementary arm (from original proposal, if time permits):** *Prompt-level optimization* ("Caveman"-style terse prompting, no debugger) — a non-structural token-saving comparison point.

| Factor | Levels |
|---|---|
| **Model** | **Premium:** Claude **Opus 4.5** · **Mid:** Claude **Sonnet 4.5**, **GPT-5-class** (e.g. GPT-5 / GPT-5 Codex) · **Cheap (budget-scaling):** Claude **Haiku 4.5** (optionally add a Gemini variant). Model mix mirrors Debug2Fix (GPT-5, Haiku 4.5, Sonnet 4.5) plus Opus for a premium tier. |
| **Language** | Python, JS/TS, Go, Rust (+ .NET stretch) |
| **Difficulty** | low / medium / high |
| **Budget cap** | {unlimited, $0.50, $0.25} or {40, 20, 10 steps} per instance |

**Fixed controls (confound management):** identical agent scaffold across arms — only toolset/skill differs; same temperature, max-turn ceiling, retry policy, repo snapshot. **3 seeds/repeats** per (instance x arm x model). **Design:** paired within-instance; full grid ~ instances x 3 arms x 3–4 models x 3 seeds.

## 7. System Architecture & Harness
```
Benchmark instance (repo snapshot + gold tests)
        |  provision
        v
Agent Runner --(arm-specific toolset)--> LLM Agent
        |                                   |
        |      Arms B & C only              v
        |                          DebugMCP (localhost:3001) --> VS Code Debug (DAP)
        v
Patch applier --> Docker test oracle (fail-to-pass / pass-to-pass)
        |
        v
Trajectory + token + time + tool-call logger --> results DB
```
- Reuse Multi-SWE-bench / SWE-bench Docker eval images for the oracle.
- Per-arm toolsets injected at agent-config time; scaffold otherwise identical.
- Logger captures per-turn token counts, phase timestamps (LLM vs tool vs test), and full tool-call trace.

## 8. Data Preparation & Difficulty Labelling
- **Difficulty proxies:** patch size (LOC / #files), #hunks, gold-test count, dependency depth -> bin into low/med/high; manually validate a ~10% sample.
- **State-dependent tagging:** flag bugs whose fix depends on runtime values (concurrency, off-by-one loop state, mutation, null/None propagation, floating point, cache/state invalidation). Two-annotator subset with agreement (Cohen's kappa) reported.
- **Sampling procedure:** stratified random by (language x difficulty), fixed seed, documented instance IDs for reproducibility.

## 9. Statistical Analysis Plan
- **Primary success comparison:** **McNemar's test** (paired binary Resolved/not, same instances across arms) + odds ratio.
- **Efficiency (tokens/steps/time):** **Wilcoxon signed-rank** on paired instances; report medians + Hodges–Lehmann effect size.
- **Multiple comparisons:** Holm–Bonferroni across arm-pairs x metrics.
- **Sample-size / power:** target detecting +5pp at 80% power; back-calculate n; justify the ~150–200 sample.
- **Nondeterminism:** aggregate across 3 seeds (majority-solve and mean); report run-to-run variance.
- **Subgroup analyses:** per-language, per-difficulty, state-dependent subset — pre-registered to avoid p-hacking.

## 10. Ablations & Secondary Studies
- **Skill effect (now a primary arm, B vs C):** does the runtime-visibility gain come from the *tools* or from the *instruction on how to use them*? (Arm A→B→C decomposition.)
- **Tool ablation:** DebugMCP with only stepping vs. only `evaluate_expression`/`get_variables_values` vs. full set — which capability drives gains?
- **Qualitative case studies:** trajectories where runtime inspection flipped failure->success (and failure modes where it didn't help / hurt via overhead).
- **Cost-scaling curves:** solved-vs-budget across cap levels and models (does a cheaper model + DebugMCP beat a premium model without it, echoing Debug2Fix?).

## 11. Work Breakdown & Timeline (~12–16 weeks)
1. **Setup (wk 1–2):** DebugMCP local; verify each language's VS Code debug extension launches under the harness; wire `/debug-live`.
2. **Harness (wk 2–5):** agent runner (provision -> arm toolset -> patch apply -> Docker oracle) + logging.
3. **Instrumentation (wk 4–5):** trajectory/token/time/cost + phase timing.
4. **Pilot (wk 5–6):** 15–20 instances x 3 arms x 1 model; calibrate metrics & difficulty tags; fix flaky tests.
5. **Main runs (wk 6–10):** full grid on sampled set, 3 seeds.
6. **Budget-capped runs (wk 9–11):** re-run under cap levels.
7. **Analysis (wk 11–14):** stats, breakdowns, ROI curves, case studies, ablations.
8. **Writing (wk 13–16):** thesis chapters, threats-to-validity, limitations.

*Go/no-go gates:* after pilot (metrics stable, oracle reliable per language) and after main runs (before budget sweep).

## 12. Budget Estimate
**Assumptions:** ~175 instances x 3 arms x 3 seeds = **1,575 runs per model**; ~120k tokens/run (~70% input, i.e. ~84k in / 36k out).

**Per-model cost (order-of-magnitude list prices; verify at run time):**
| Model | ~Price (in / out per M) | ~$/run @120k | 1,575 runs |
|---|---|---|---|
| Claude **Opus 4.5** (premium) | $5 / $25 | ~$1.32 | ~$2,080 |
| Claude **Sonnet 4.5** (mid) | $3 / $15 | ~$0.79 | ~$1,245 |
| **GPT-5-class** (mid) | $1.25 / $10 | ~$0.47 | ~$740 |
| Claude **Haiku 4.5** (cheap) | $1 / $5 | ~$0.26 | ~$410 |
| **Main-grid subtotal (4 models)** | | | **~$4,475** |

- **Pilot** (~60 runs, 1 model): ~$80.
- **Budget-capped sweep** (~2 models x 175 x 3 caps, capped/cheaper): ~$500.
- Subtotal ~$5,050; **retry/failure buffer (x1.4) -> ~$7,000**.
- **Compute / Docker** (~400 machine-hrs across more runs @ $0.5–1/hr, or $0 on a lab workstation): $0–400.

| | Estimate |
|---|---|
| **Total (4-model grid incl. Opus)** | **~$6,500–8,000 LLM + $0–400 compute** |

*Cost levers to roughly halve (~$3–4k):* drop Opus to the budget-capped sweep only; use `flash`/`mini` benchmark slices; 2 seeds instead of 3; or run the full grid on 2–3 models and reserve Opus for a single headline comparison. *Note:* Debug2Fix's finding — cheap model + debugging ≈ premium model — means the **cheap-model arms are scientifically the most interesting**, so under-investing in Opus is low-risk.

## 13. Reproducibility & Artifacts
- Pin model versions/snapshots + API dates; fixed seeds; record instance-ID manifest.
- Release harness code, per-arm configs, Dockerfiles, and anonymized trajectory logs.
- Deterministic re-run script; results DB schema published.
- Note benchmark version hashes (Multi-SWE-bench / SWE-bench release).

## 14. Threats to Validity & Limitations
- **Benchmark contamination** (models trained on these PRs) — affects all arms equally, but note; consider a small *recent held-out* PR set.
- **.NET gap** in standard benchmarks — custom mini-set or scoped out.
- **Agent nondeterminism** — mitigated by seeds + paired stats.
- **Debugger flakiness** across languages — pilot per-language before main runs.
- **Scaffold confounds** — keep scaffold identical; only toolset/prompt varies.
- **External validity** — benchmark PRs may not represent industrial bug distributions.
- **Construct validity of difficulty labels** — proxy-based; validated on a sample.

## 15. Risk Register & Contingencies
| Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|
| A language's VS Code debugger unreliable in headless harness | Med | High | Drop that language or run its subset manually; document |
| Budget overrun | Med | Med | Switch to `flash` slice, 2 seeds, 1 primary model |
| Flaky benchmark tests | Med | Med | Retry policy + exclude non-deterministic instances (logged) |
| DebugMCP session hangs/timeouts | Med | Med | Per-op timeout (existing `timeoutInSeconds`), auto-restart, cap debug ops/turn |
| API rate limits / deprecation | Low | Med | Queue+backoff; pin versions early |
| Contamination undermines claims | Med | Med | Held-out recent-PR set as robustness check |

## 16. Ethics, Licensing & Compute
- Respect repo licenses of benchmark instances; use only permissively licensed data or as the benchmark license permits.
- Comply with model-provider ToS for automated/agentic usage and data handling.
- No PII; code-only. Disclose AI-agent involvement per venue norms.
- Compute: single workstation or one cloud VM (8–16 vCPU, 32–64 GB); log energy/cost if required by program.

## 17. Deliverables
- Reproducible harness + logging (repo).
- Result tables/plots: Resolved % (x arm x language x difficulty); tokens & time per solved; cost-ROI under budget caps.
- Statistical tests (McNemar, Wilcoxon) with effect sizes + power justification.
- Ablation results and qualitative case studies.
- Thesis write-up with related work, threats-to-validity, and the .NET-coverage limitation.

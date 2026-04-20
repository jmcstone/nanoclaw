# Trading-Research Telegram Group

Branch: `main`

## Goal
Stand up a second Telegram group powered by NanoClaw that becomes Jeff's world-class trading-strategy research assistant: ingests 20 years of S&C Magazine PDFs into the synced Obsidian vault, conducts nightly web research for new strategies, orchestrates backtests through AlgoTrader, and uses a researcher + skeptic agent swarm to suppress curve-fit/overfit findings.

## Guiding constraints
- **Anti-curve-fit is a first-class feature**, not a nice-to-have. The skeptic subagent enforces AlgoTrader's anti-overfit rubric (single-variable testing, cross-asset validation, no grid-search, `.shift(1)` hygiene, "pick one good filter", out-of-sample holdout required).
- **Reports land in the synced vault** (`~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/`) so Jeff can read them on any device. Raw-extraction byproducts may stay local; final artifacts must be synced.
- **AlgoTrader is the source of truth for backtests.** NanoClaw shells out to it; it does not reimplement strategy logic.
- **Secrets via OneCLI only.** No API keys in container env.

## Operating model

The system operates as a continuous funnel: trading ideas enter from any source at any granularity (component or complete strategy) → land in a unified ranked backlog → triage promotes top items into nightly testing → results accumulate in the Component Library and Findings KB → KB drives both targeted iteration on existing strategies and creative composition of new ones. The funnel runs daily forever once seeded.

### Four workflows + daily connector

The system has four primary workflows. They share artifacts, agents, and scheduling — they differ in what triggers them and what they produce.

**Workflow A — Component ingestion.** Sources contribute trading ideas at any granularity: entries, exits, stops, take-profits, position-sizing, equity-curve (performance-conditional sizing/gating), entry-timing, regime-filters, indicators — *or* complete strategies. A single S&C article might contribute only a stop pattern; a book chapter might contribute a complete strategy plus three reusable components; a paper might contribute an indicator and an entry signal but no exit. Ingestion populates the Component Library and produces 0-N strategy compositions per source. **Ingestion is not always strategy-producing** — many sources contribute only components.

**Workflow B — Component evaluation.** Two evaluation modes depending on the component type:

- **Standalone edge analysis** (entry and exit signals). Fire the signal and measure the forward-bar return distribution at 1, 2, 3, …, N bars, attributed by regime/asset. **The meaningful baseline is a random-entry benchmark into the same asset/regime** — not zero. A positive forward return proves nothing if random entries into the same pool produce the same positive return (e.g. equities are up on average). What matters is the *delta* of the signal vs. random. If the signal's bar-N edge isn't beating random entry, there's no signal. Bar-by-bar forward-return profiling (with random-entry baseline) is the starting-point evaluation for entry/exit signals — cheap, composition-free, and produces a well-defined "edge profile" for each signal that lives on its Component Library page.
- **Comparative swap-in** (for stops, take-profits, position-sizing, equity-curve, entry-timing, regime-filters). Swap component X into one or more host strategies; measure the delta vs. the strategy's incumbent component, attributed by regime/asset. Evidence accumulates on the component's library page across every host strategy it's been tried in.

Both modes write findings to the same component-library page — the component's track record is the union of its standalone edge profile and its swap-in deltas.

**Bucketed conditional analysis — the cheap first-line diagnostic.** Before spending backtest budget on new strategy variants, slice the *existing* trade log (or bar-by-bar forward returns) against any market metric with a well-defined decision-time value. Bucket the metric by percentile or threshold, compute strategy/signal performance per bucket, spot where the edge lives and where it breaks.

- **The bucketing is free** given existing results. No new backtest runs — only metric-computation + groupby. This is the primary way to discover strategy weaknesses cheaply, *before* committing Workflow C iteration budget. **Runs are the budgeted resource; bucketed analysis is not.** The 25-run nightly budget pays for backtest executions; conditional-attribution passes run essentially unbounded on every baseline's trade log.
- **The metric catalog is open-ended.** Any metric with a well-defined decision-time value qualifies: VIX, ATR(N), opening gap, distance-from-MA(200), distance-from-MA(100), breadth (% above 50/200DMA), yield-curve slope, credit spread, COT positioning, day-of-week, days-from-FOMC, and whatever else proves useful. Catalog lives at `AlgoTrader/Knowledge/metrics/` alongside `components/` and `findings/`. Each metric entry carries: its computation + default bucketing methodology (percentile windows, fixed thresholds, MA-distance bands, etc.) + **accumulated findings/observations** (where it's proved discriminating, where it hasn't, for which strategy families) + **"when to apply" guidance** (strategy-family tags, hold-duration relevance, mechanism applicability) so the selecting agent can pick intelligently.
- **Metric selection per baseline is LLM-judgment-driven, not auto-run-all.** The Regime Analyst (or whichever agent is diagnosing) consults the catalog and picks metrics relevant to the strategy being tested — intraday strategies get intraday-relevant metrics; daily trend-followers get trend-relevant metrics; mean-reversion strategies get vol + range metrics; etc. **Err toward selecting too many rather than too few**, because conditional analysis is cheap. The promoted classifiers often end up among the picks but are not privileged — the selection is strategy-aware, not classifier-only.
- **Regime classifiers are the curated, promoted subset.** The five classifiers (`vix-tier`, `gap-size`, `price-range`, `trend-basic`, `sqn-market-type`) are metrics that graduated to classifier status: stable labels, locked bucketing, KB-wide tag namespace (`#regime/<classifier>/<label>`). Any metric in the catalog that consistently discriminates performance across many strategies can be promoted to the classifier registry. Classifier registry = view over promoted metrics.
- **What bucketed analysis feeds:**
  - *Standalone edge profile per signal* (bar-by-bar returns × metric buckets → heatmap; signal vs. random-entry baseline in each bucket)
  - *Strategy weakness identification* ("underperforms when VIX > p75 AND MA(200) posture flat" → Workflow C hypothesis input)
  - *Metric-informativeness scoring per strategy* — for this strategy, which metrics discriminate performance?
  - *Classifier-promotion candidates* — metrics that discriminate consistently across many strategies become classifier-registry promotion candidates.

**Workflow C — Strategy iteration.** Existing strategy + identified weakness → pre-stated hypothesis → investigation bundle → Skeptic verdict. Candidate components for the hypothesis come from the Component Library (where Workflow B has been building evidence on each). This is the bundle cycle described in "Research methodology" below.

**Workflow D — Strategy creation from corpus.** The swarm composes a *novel* strategy from library components — not from any single source. Triggers: newly-ingested entry signal looking for an exit/stop/sizing pairing already in the library; Sweeper-detected composition gap ("we have 12 stop patterns but no swing strategy on vol ETFs uses any of them"); explicit synthesis hypothesis ("never-tried combination of X + Y + Z"); Researcher proposal during ingestion. A created strategy then enters Workflow C's testing pipeline as a freshly-composed candidate.

**Workflow E — Daily flow (connector).** Each daily cycle: ingestion runs (Workflow A) on whatever's in the day's source queue; daily catch produced; new components/strategies enter the backlog with triage ranks; Sweeper runs (per its cadence) to match new arrivals against existing backlog and findings; nightly testing budget is allocated across workflows per the current allocation policy; Documenter writes morning digest.

### Unified ranked backlog (cross-corpus)

Every ingested strategy enters one ranked queue, regardless of source. The S&C 2018 article, the TradingView post from yesterday, the Ehlers book chapter from 2004, and the Workflow-D-composed candidate all compete on the same axis.

**Ranking is structured-reason-driven, not opaque-score-driven.** Each backlog item carries a rank (frontmatter cursor) and inline tagged reasons describing why it ranks where it does. The Sweeper matches blocker tags against newly-resolved capabilities to trigger re-ranking.

Storage follows the project's locked Obsidian-native convention: minimal frontmatter (`triage_rank`, `triaged_at`, `last_re_ranked_at`, `status`) + inline hierarchical tags co-located with the claim they describe + prose narrative. Tag namespaces:
- `#triage-credit/<axis>/<detail>` — positive factors (e.g. `#triage-credit/source-type/peer-reviewed`, `#triage-credit/author/credible`)
- `#triage-blocker/<axis>/<detail>` — blocking factors (e.g. `#triage-blocker/asset-class/individual-stocks-coverage-thin`, `#triage-blocker/decomposition/pattern-not-systematic`)

Example triage section in a backlog strategy file:

```markdown
## Triage
**Rank:** #437. Low — testing not warranted given current knowledge + universe.

Established-magazine source, author credible.
#triage-credit/source-type/established-magazine #triage-credit/author/credible

Targets individual stocks; we trade ETFs predominantly with only a small Tier-1.5 stock list.
#triage-blocker/asset-class/individual-stocks-coverage-thin

Move-up triggers: if we expand individual-stock universe.
```

When (e.g.) the Engineer adds individual-stock universe support, the Sweeper greps for `#triage-blocker/asset-class/individual-stocks-coverage-thin`, finds matching items, re-ranks them with that blocker dropped.

**Triage criteria themselves evolve.** Owned by Documenter at `AlgoTrader/Knowledge/_triage-criteria.md`. Versioned; periodic re-triage sweeps re-evaluate older items against current criteria. Don't over-engineer initial criteria — early ranking is necessarily rough; sharpens as the KB matures and we learn what discriminates.

**Items persist in the backlog indefinitely.** Even very-low-ranked items stay — they may resurface years later when a blocker resolves. Only `retired` items (explicit "this will never work in our universe") leave.

**Triage authority:**
- Researcher ranks at ingestion using current criteria.
- Skeptic vetoes promotion to "test now" priority — methodology auditor pre-screen.
- Documenter owns criteria evolution and runs re-triage sweeps on a periodic cadence.

### Daily Catch — Researcher's nightly journal

Each day's discovery produces a first-class artifact at `AlgoTrader/Daily Catches/YYYY-MM-DD.md`. Records:
- New components found (with source links)
- Complete strategies found
- Suggested compositions (Workflow D candidates)
- Per-item disposition: `test now` | `queue` | `park` | `reject` (with reason)
- Outputs of the night's testing on items marked `test now`

The Daily Catch is the upstream input that the Sweeper has not yet matched — it's the day's raw arrivals before they've propagated through the backlog and KB. Persistent journal of what entered the system each day.

### Onboarding new sources — pilot-then-bulk

Any new source-type gets a pilot before bulk ingestion. Two distinct pilot scopes:

| Pilot type | When | Scope | Exit criteria |
|---|---|---|---|
| **Concept pilot** | Once, at system inception | Entire stack: ingestion + decomposition + triage + first-bundle execution + KB accumulation + Sweeper + daily-catch + agent coordination | The four workflows actually work end-to-end; artifacts are well-formed; pipeline issues found and fixed |
| **Source-type pilot** | When adding any new source-type (Trader's World, TradingView, etc.) | Just the ingestion side: extraction quality on this source's PDFs/HTML/format; source-specific metadata captures correctly; new tags or schema fields added if needed | Extraction is acceptable; downstream pipeline already proven elsewhere |

The very first S&C ingestion is *both* — concept pilot wrapped around an S&C-specific pilot. Every subsequent corpus is just source-type.

### Concept pilot is staged (additive ramp on S&C)

Rather than one-shot "small pilot → fix → commit to all 132 issues," the concept pilot ramps additively, with full re-triage of the entire backlog at each stage gate:

| Stage | Cumulative S&C | Delta added |
|---|---|---|
| 1 | 6 months | +6 |
| 2 | 12 months | +6 |
| 3 | 24 months | +12 |
| 4 | 48 months | +24 |
| 5 | 96 months | +48 |
| 6 | full archive | +remaining |

Stage sizes roughly double — early stages small for fast learning, later stages large because criteria are stable. Numbers are starting suggestions, tunable per-stage based on how the prior stage went.

Each stage is a complete cycle:
1. Ingest the next slice (Workflow A)
2. **Re-rank the entire backlog** using sharpened triage criteria from prior stage's learning (Sweeper)
3. Test the top N from the now-larger, now-sharper backlog (Workflow C; some Workflow D as the library matures)
4. Capture findings into KB
5. Update triage criteria; document what we learned about ranking
6. Decide whether to proceed to next stage, repeat the same stage size, or pause

Smooth transition into steady-state operations — the last pilot stage just becomes the first day of steady-state daily flow.

### Evolving budget allocation (not "modes")

There is no hard "Mode 1 / Mode 2" boundary. There is one daily flow with four input sources whose share of the nightly run budget evolves as the corpus matures:

| Allocation | Day 1 | After ~6 months | After ~2 years |
|---|---|---|---|
| Backlog dip (top of ranked queue) | 80% | 40% | 15% |
| Daily catch processing | 10% | 25% | 25% |
| Workflow C iteration on parked/active strategies | 5% | 20% | 35% |
| Workflow D creativity | 5% | 15% | 25% |

Numbers are starting allocations; the policy is reviewed monthly (or per stage in the pilot) and tuned with telemetry.

Rationale: in early days, almost the entire budget should drain the backlog because that's where signal lives and the corpus to be creative with is thin. Over time the backlog ages, daily-catch becomes a meaningful slice, the library becomes rich enough to compose novelly, and ongoing iteration on tested strategies eats a growing share.

### First-bundle shapes by onboarding type

The first bundle (F0) is the entry point into the testing pipeline for any newly-onboarded item. Its shape depends on *what* was onboarded. Five shapes:

| Shape | Onboarding type | Run budget | Composition |
|---|---|---|---|
| **A** | Complete strategy ingested (S&C full-strategy article, book chapter strategy, paper with full strategy) | ~6-8 runs | 1 sanity + 1 QQQ baseline + auto regime attribution across 5 classifiers (free) + LLM-selected bucketed conditional analysis (free) + 2-4 robustness probes (data-window + hyperparameter jitter) + 1 walk-forward |
| **B** | Standalone entry signal ingested | ~1-2 runs | 1 edge profile (bar-by-bar forward returns across history) + random-entry baseline (free; same data) + delta check + LLM-selected bucketed analysis (free). **No full-strategy backtests yet** — signal must compose into a strategy via Workflow C swap-in or Workflow D before reaching Shape A. |
| **C** | Standalone exit signal ingested | ~1-2 runs | Like Shape B but baseline is random-exit on a reference set of entries in the target regime |
| **D** | Standalone non-signal component (stop, TP, sizing, equity-curve, entry-timing, regime-filter) | ~3-6 runs | Can't be tested alone — Workflow B comparative swap-in against 1-3 host strategies in the library. Delta measured per host, attributed by regime. |
| **E** | Newly-composed strategy (Workflow D output) | ~6-8 runs | Same as Shape A but each component already has evidence from its own prior Shape-B/C/D bundle, so the initial hypothesis can be sharper and some robustness probes may be trimmed |

**Shape A locked defaults:**
- **QQQ-only baseline.** Leveraged variants (SOXL, TQQQ) become F1 if Shape A looks promising — avoids spending cross-leverage budget on a strategy that can't PROMOTE from F0 anyway.
- **Walk-forward in F0**, not deferred. One run is cheap insurance; failure here means F1+ is wasted effort.

**Verdicts (all shapes):**
- **PROMOTE** — impossible from F0. Cross-year + cross-asset + walk-forward evidence insufficient after a single bundle.
- **INVESTIGATE FURTHER** — promising; hand off to F1 with named weakness dimension + pre-stated hypothesis.
- **PARK** — survived F0 but no clear next move. Record `unresolved_weaknesses:`; Sweeper picks up when relevant findings arrive later.
- **RETURN TO INGESTION** — mechanism didn't reproduce or extraction bug surfaced. Whoever notices (Skeptic during methodology audit, Corpus Researcher during sanity) flags; Corpus Researcher owns the extraction fix since they authored the ingested record.

### Why the operating model is compounding

Three reinforcing loops:

1. **Backlog → KB → Backlog re-ranking.** Tested items add findings; findings sharpen triage criteria; sharper criteria re-rank the backlog; better next-night picks; more findings. The system gets better at choosing what to test as it tests more.
2. **Components → Strategies → Component evidence.** Library components feed strategies; strategy results refine each component's track record; richer component evidence makes Workflow D creativity sharper; new compositions exercise components further.
3. **Daily catch → Library + Backlog → Sweeper revisits.** New arrivals continuously enrich both; Sweeper continuously matches; old parked work resurfaces when its blocker resolves. Nothing is one-and-done.

## Research methodology (the core loop)

*This section details the bundle cycle — the mechanics of Workflow C above. Workflow A (ingestion), B (component evaluation), and D (creativity) are described in the Operating Model section. This section describes how a single investigation bundle runs once a strategy is in the testing pipeline.*

A strategy is developed through a **multi-run iterative cycle**, not a single nightly backtest. Evidence: Jeff's manual ORB work at `~/Projects/AlgoTrader/obsidian_vault/Strategies/opening-range-breakout/Runs/` shows ~30+ runs per day across QQQ / SOXL / cross-asset, chained into investigative sequences (e.g. `005→010→011 regime analysis pre-vs-post-2021`, `011→015 btr regime refined sweep`, `025→026→027→028→029 bar-size jitter widening`, `023 problem period diagnostic` revisiting `005`).

**The ORB runs are an illustrative example, not a template.** That investigation happened to focus on entry filters and regime conditioning, because those were the open questions for that strategy. Other strategies will need very different shapes of investigation — a mean-reversion strategy might spend most of its run budget on exit rules, stops, and take-profit patterns; a trend-follower might spend most of it on regime filters and position sizing. The cycle structure (baseline → hypothesis → bundle of linked runs → verdict → next hypothesis) generalizes; the specific run *types* in the bundle are chosen per-strategy by the swarm based on what the strategy's weakness demands.

### Run-type taxonomy (illustrative, growing, strategy-dependent)

Every run emitted by the swarm is tagged with a type so the Documenter can map investigation chains. **The list below is illustrative, not prescriptive.** The ORB example above explored entry filters and regime conditioning; other strategies will warrant very different run types (e.g. a mean-reversion strategy will need extensive exit/stop/TP exploration that ORB didn't). The swarm chooses the right run type for the current hypothesis, and new types are added as needed — the Documenter owns keeping the tag vocabulary curated.

**Universal types** (apply to most strategies):
- **Baseline** — strategy alone, full history, all assets. Establishes reference.
- **Diagnostic** — zoom into a specific failure window (drawdown period, problem year).
- **Regime analysis** — slice performance by one regime axis.
- **Sanity check** — test a safety property that must hold.
- **Walk-forward** — rolling train/test on `walkforwards.py`.
- **Cross-asset validation (same class)** — repeat on another ticker in the same asset class. Required for Validated tier.
- **Cross-asset-class validation** — repeat on a different asset class (equities → commodities / bonds / FX / crypto). Required for Cross-asset-class-robust tier. Failures here are *informative findings*, not strategy rejections.

**Entry-side types** (strategies with non-trivial entry logic):
- **Filter test** — binary on/off test of one candidate entry filter.
- **Parameter sweep** — coarse threshold scan on one axis. Skeptic watches for grid-search creep.
- **Stacking test** — whether two filters combine orthogonally or redundantly.
- **Entry-timing test** — e.g. open vs pullback vs breakout confirmation.

**Exit/stop/TP types** (critical for mean-reversion, swing, trend-following; under-explored in ORB):
- **Exit-rule test** — time-based vs indicator-based vs trailing vs close-on-opposite-signal.
- **Stop-loss pattern test** — fixed %, ATR-based, volatility-adjusted, chandelier, no-stop. Stop placement can be more important than entry signal on many strategies.
- **Take-profit pattern test** — fixed R:R, trailing, partial scaling-out, tiered targets.
- **Hold-duration analysis** — performance by hold length; identifies whether edge decays with time-in-trade.

**Sizing / portfolio types**:
- **Position-sizing test** — fixed fraction, Kelly-fraction, vol-scaled, regime-conditioned sizing.
- **Allocation sweep** — for multi-leg or multi-asset strategies.
- **Correlation / hedge test** — strategy A's performance when paired against strategy B or an index hedge.

**Robustness types**:
- **Bar-size jitter / hyperparameter jitter** — small perturbations on ostensibly fixed choices. Catches fragility that parameter sweeps miss.
- **Data-window jitter** — shift the in-sample window by ±6 months, check if results survive.
- **Regime-boundary jitter** — move regime bucket edges slightly; a strategy that survives is regime-robust, not regime-edge-fit.

Types not in this list that a strategy demands get proposed by whichever agent spots the need, and added to the taxonomy by the Documenter. The taxonomy is curated vocabulary, not a fixed contract.

### The cycle (per strategy, multi-run)

```
┌─────────────────────────────────────────────────────────────────┐
│  Baseline → performance attribution (regime, asset class,       │
│  exit behavior, hold duration, sizing posture — whichever       │
│  dimensions the strategy's mechanics actually exercise)         │
│     │                                                           │
│     ▼                                                           │
│  Weakness identification: "Strategy underperforms when ___"     │
│  (could be: regime X, exit rule Y leaves money, stops too tight │
│   in regime Z, sizing wrong in trend regime, etc.)              │
│     │                                                           │
│     ▼                                                           │
│  Hypothesis stated *before* testing                             │
│  ("If we tighten the stop in high-vol, drawdown falls because") │
│     │  Regime Analyst owns the statement; Skeptic witnesses     │
│     ▼                                                           │
│  Investigation bundle — a sequence of linked runs chosen from   │
│  the taxonomy to *match the hypothesis*. May include:           │
│    • Diagnostics that characterize the failure                  │
│    • KB lookup for candidates (indicators, exit rules, stops,   │
│      sizing schemes) that targeted the same weakness before     │
│    • One-at-a-time tests of the candidate                       │
│    • Coarse parameter sweep if the candidate shows promise      │
│    • Sanity checks                                              │
│    • Stacking/interaction tests with existing strategy elements │
│    • Robustness probes (jitter, data-window shift)              │
│    • Cross-asset validation (same class, then cross-class)      │
│    • Walk-forward validation                                    │
│  (The specific shape of the bundle depends on the hypothesis.   │
│   An exit-rule hypothesis gets an exit-rule bundle; a regime-   │
│   filter hypothesis gets a regime-filter bundle. The swarm      │
│   chooses, not a fixed recipe.)                                 │
│     │                                                           │
│     ▼                                                           │
│  Skeptic reviews the full bundle:                               │
│    • Cross-year gate (≥N of last K years)                       │
│    • Tiered cross-asset / cross-asset-class gate                │
│    • Walk-forward pass                                          │
│    • No look-ahead, no redundant filter stacking                │
│    • Plausible economic rationale stated                        │
│    • No grid-search creep across runs                           │
│     │                                                           │
│     ▼                                                           │
│  Verdict: PROMOTE / REJECT / INVESTIGATE FURTHER                │
│    • PROMOTE → Strategy Author updates canonical strategy       │
│                Documenter writes positive finding to KB         │
│    • REJECT → Documenter writes negative finding if             │
│               instructive (curve-fit modes, misapplied          │
│               filters, asset-specific fragility, overly tight   │
│               stops, brittle exit rules)                        │
│    • INVESTIGATE → new hypothesis, back to top of cycle         │
│     │                                                           │
│     ▼                                                           │
│  Re-baseline; identify next weakness; repeat                    │
└─────────────────────────────────────────────────────────────────┘
```

### What a team of agents beats manual work on

Jeff's ORB investigations were rigorous but bounded by one person's memory, attention, and context-switching cost. The swarm changes:

1. **No forgotten threads.** Every hypothesis is stated, tagged, and tracked to conclusion. Documenter surfaces stale "investigate further" verdicts daily.
2. **No skipped gates.** Cross-year, cross-asset, walk-forward, stacking, sanity checks are non-negotiable — a run bundle without all of them cannot reach a verdict.
3. **Hypothesis-first.** Regime Analyst must state the hypothesis in words *before* the bundle runs. Retrofitted narratives ("here's why the result happened") are a classic overfit pattern.
4. **Reuse across strategies.** KB findings from ORB automatically inform the next strategy worked on. Jeff couldn't have that on strategy #5 recalling a lesson from strategy #1 without rereading old notes.
5. **Documented negative space.** Rejected ideas are written up as findings when instructive. Manual work tends to drop these.
6. **Parallel investigation.** Multiple hypotheses on multiple strategies can run concurrently (each in its own bundle) without confusion — the Documenter maintains the map.

### Budgeting the cycle

- A nightly window runs **one investigation bundle per strategy under active development** (not one run per strategy). Target ~1–3 strategies active simultaneously; expand as budget allows.
- An investigation bundle is typically 8–20 runs (matching observed ORB session sizes).
- A verdict is reached when the bundle is complete. "One more quick test" is an anti-pattern the Skeptic flags.

### Lessons-learned + finding escalation (three levels)

Every piece of research produces lessons. The value of the swarm comes from **capturing them at the right level and propagating them across strategies and across time.** Three levels, each owned by the Documenter:

**Level 1 — Per-run lesson (captured on every run writeup).**
Each run report has a required `## Lessons` section with two sub-sections:
- *Strategy-local* — only relevant to this strategy. Stays in the run report and links from the strategy's canonical file.
- *Candidate cross-cutting* — might be broader. Captured here raw; evaluated for promotion at bundle or strategy level. Examples: "ATR-on-leveraged-ETF behaves differently than on unlevered index", "this exit rule leaves money in trending tape regardless of strategy".

**Level 2 — End-of-bundle escalation review (after each verdict).**
When Skeptic issues a verdict, Documenter reviews the bundle's Level-1 candidates. Three outcomes per candidate:
- *Stays local* — not actually broader than one strategy.
- *Promoted to KB* — written into `AlgoTrader/Knowledge/` (regimes/ or indicators/ or asset-classes/ or cross-cutting/). Metadata: source bundle, confidence, regime/asset tags.
- *Held for confirmation* — promising but needs corroboration from another bundle before promotion. Sits in `AlgoTrader/Knowledge/_pending.md`.

**Level 3 — End-of-strategy retrospective (when a strategy is parked or promoted).**
When a strategy is set aside (no open hypotheses, or promoted to production status) the Documenter + Skeptic do a fuller retrospective: what worked, what didn't, what's the reusable insight, what's specifically scoped to this strategy's mechanics. Level-3 findings are the highest-quality inputs to the cross-cutting KB.

### Retroactive applicability — time-phased sweep + Revisit Queue

The system is built on **time-phased records** and a **scheduled Sweeper** (a cron task owned by the Documenter; not a separate chat agent). Everything — ingested strategies, promoted findings, strategy weakness records, KB entries — carries `ingested_at` / `promoted_at` / `last_swept_at` timestamps. The Sweeper periodically asks "what pairings haven't I evaluated since the newer side of the pair last changed?" and produces proposed matches for the Documenter to interpret.

**Why time-phase it:** triggering only on the single event "new finding promoted" misses three cases:
- **Strategy ingested later than relevant findings** — a web-scraped strategy pulled in today might benefit immediately from KB findings promoted six months ago. No finding event fires when the *strategy* is the new thing.
- **Sweeper offline / batched runs** — if the matcher doesn't run on every event, a watermark-based sweep catches up without re-matching the entire history.
- **Finding corroboration across time** — `_pending.md` items may be corroborated by bundles run much later. A scheduled cross-reference catches this.

### Sweep directions (all four run in the Sweeper's cadence)

**Forward: new/updated findings → old strategies.** For each finding where `promoted_at` or `last_updated` is newer than the strategy's `last_swept_at`, check whether the finding's regime/dimension/asset tags overlap the strategy's `unresolved_weaknesses`. Hit → Revisit Queue with citation + hypothesis.

**Reverse: newly-ingested strategies → existing KB.** For each strategy where `ingested_at` is newer than the KB's `last_swept_against_strategies`, check whether any existing cross-cutting finding is directly applicable (e.g. the ingested strategy is a mean-reversion system, and an existing KB finding says "mean-reversion on high-vol days needs Y"). Hit → annotation on the strategy's canonical file: "relevant KB findings at ingestion time: X, Y, Z" so the first investigation bundle on this strategy starts with that context.

**Cross-finding: new findings → `_pending.md`.** For each newly-promoted finding, check whether it corroborates (or contradicts) any held-for-confirmation item. Corroboration → promote `_pending` item. Contradiction → surface to Documenter for reconciliation (and to chat).

**Stub-resolution: ingested parent → orphaned children.** When a new source is ingested, check whether any previously-ingested child records (with `implementation_of:` pointing at this source) are waiting for it. If yes, upgrade their stub placeholders to real parent links and re-run the reverse sweep on those children so they pick up the parent's KB context. Handles the cross-issue Traders' Tips case where a January 2020 child was ingested before the October 2019 parent, and the general out-of-order-ingestion problem.

### Cursors and idempotency

- Each **strategy** carries `last_swept_at: {timestamp}` in its frontmatter. Sweeper only re-evaluates against findings where `promoted_at > strategy.last_swept_at`.
- Each **finding** carries `last_matched_against_strategies: {timestamp}`. Sweeper only checks strategies where `ingested_at > finding.last_matched_against_strategies`.
- The Sweeper updates both cursors after a successful pass.
- Idempotent by design — re-running the Sweeper produces no duplicate queue entries.

### Sweeper cadence

- **Weekly** by default, adjustable. Runs off-hours (e.g. Sunday evening) so Monday's cycle starts with a refreshed Revisit Queue.
- **On-demand** triggerable in chat (`@Documenter sweep` or similar) when Jeff or a swarm agent has reason to suspect a match exists before the scheduled run.
- Sweeper outputs a **proposed matches staging file** (`AlgoTrader/_sweep-staging.md`) that the Documenter reviews before any artifact (Revisit Queue, strategy frontmatter) is modified. Keeps the sweep auditable and prevents silent writes.

**Canonical example (Jeff's scenario, generalized):**
1. Strategy A worked 2 weeks ago, parked with `unresolved_weaknesses: [high-vol]` and `last_swept_at: 2026-04-14`.
2. Strategy B's bundle yesterday promotes a volatility-predictor finding; `promoted_at: 2026-04-28`.
3. Weekly Sweeper runs Sunday 2026-05-03. Forward sweep finds `finding.promoted_at (2026-04-28) > strategy_A.last_swept_at (2026-04-14)` AND tag overlap → stages a proposed match.
4. Monday morning, Documenter reviews the staging file, confirms the match, writes Revisit Queue entry, updates `strategy_A.last_swept_at = 2026-05-03`.
5. Nightly cycle picks up Strategy A revisit.

**Same mechanism, reverse direction:** An S&C article from 2019 is ingested today as a new strategy candidate. Sweeper's reverse pass finds the KB has 40 cross-cutting findings about regime behavior, exit patterns, vol prediction — writes an annotation to the candidate's file so the first investigation bundle starts with that context rather than rediscovering it.

### Unresolved-weakness record (required at parking/promotion)

For retroactive matching to work, every strategy must carry a machine-readable record of unresolved weaknesses at the time it's parked or promoted. Frontmatter or a dedicated section in the strategy's canonical file:

```yaml
unresolved_weaknesses:
  - dimension: regime
    regime_tags: [high-volatility]
    asset_tags: [qqq, soxl]
    description: "Underperforms when VIX > p80; no robust predictor identified"
    last_investigated: 2026-04-14
  - dimension: exit
    description: "Trailing stop leaves money in sustained trends; tested alternatives failed walk-forward"
    last_investigated: 2026-04-10
```

Without this record, a strategy cannot be marked parked/promoted. Strategy Author writes it at end-of-strategy; Documenter reads it during retroactive matching.

## Phased checklist

### Phase 1 — Group foundation ✅ complete
- [x] Create `groups/telegram_trading/CLAUDE.md` with trading-group persona, tools allowlist, and Obsidian paths (a14c646)
- [x] Register the new Telegram chat ID (`tg:-5211322204`) in NanoClaw config and verify Madison responds in the new group without leaking context from `telegram_main` (a14c646)
- [ ] Add a nightly scheduled-task stub that writes a heartbeat file, to prove scheduling + mounts work end-to-end *(deferred — Phase 5 builds real scheduling; heartbeat stub adds little)*
- [x] Confirm `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/` is mounted read-write into the trading group container (a14c646)
- [x] **a-mem MCP installed** — per-group ChromaDB mounted at `/workspace/extra/a-mem/`, isolated from other groups (a14c646)

### Phase 2 — Multi-source PDF ingestion
Ingestion handles **three source types**, not just S&C. Each has its own extraction workflow and per-source-type conventions. The downstream artifact is a **multi-artifact output**: 0-N strategies + 0-N usage-component additions + 0-N indicator additions + 0-N platform-implementation snippets + 0-N findings per article. Not 1:1.

- [ ] **Docling is the primary extraction tool** (pending final bake-off vs marker/pymupdf4llm). Validation on 2020-01 S&C 8-day-article (4 pages): good prose/numbers/structure extraction, small post-processing needs:
  - Small-caps section headers in S&C come through as mixed-case artifacts (`paTTern`, `SimulaTionS`) — regex normalization pass
  - Running page headers leak into content mid-article — dedup pass
  - Images inline as base64 by default — config docling with `--image-mode referenced` so charts save to disk as PNGs for reference via wikilink
  - Speed: ~10 sec/page warm → ~15 min per S&C issue → ~33 hours for 11 years of S&C → overnight batches viable
- [ ] **Ingest chronologically (oldest first)** so Traders' Tips cross-issue parents land in the KB before their children. Stub-resolution sweep (4th Sweeper direction) handles unavoidable out-of-order cases.
- [ ] Build ingestion scripts (TypeScript or Python) for each source type:
  - **`ingest-magazine.*`** — S&C, SFO, Traders, Traders World, Expiring Monthly, Bloomberg Markets. One issue → index file + per-article strategy markdown. Articles are typically 1 strategy each (S&C adds software-vendor "Traders' Tips" sections with implementation variants).
  - **`ingest-book.*`** — books from Calibre. One book → index file + per-chapter strategy markdown; some chapters contain multiple strategies (decompose further). Author's claimed backtest results recorded but explicitly tagged as cherry-picked (authors don't publish failed books).
  - **`ingest-web.*`** — web articles scraped via Scrapling / Playwright / trafilatura. One article → one strategy markdown (typically).
- [ ] Source-provenance frontmatter varies by type (see findings.md "Source type taxonomy"). All three types emit `ingested_at`, `status: untested`, tags, and link to raw extract under `AlgoTrader/Sources/{type}/`.
- [ ] Backfill existing half-done 2023 S&C issues once PDFs are migrated into Calibre.
- [ ] Multi-source backfill is a long-running job — batch by year (magazines) or by author (books); resumable; emits progress to `AlgoTrader/_ingestion-log.md`.
- [ ] Mirror key insights into a-mem MCP for semantic recall.

**Notable book authors worth prioritizing once general ingestion works** (source quality varies by author — Skeptic should weight accordingly):
- **John Ehlers** — DSP-based indicators (MAMA, FAMA, Hilbert transforms). Contributes distinctive entry-component candidates.
- **Perry Kaufman** — systematic-trading encyclopedia; many complete strategies with parameter studies across asset classes.
- **Jeffrey Katz** — neural net + evolutionary algorithm approaches; dated but component-rich.
- **Larry Williams** — COT-report strategies (requires CFTC weekly data; Engineer work to ingest).
- **Jeff Augen** — options volatility strategies (note: options is an asset class *not currently in the universe*; either scope-in or explicitly scope-out).
- **Ernie Chan** — modern quant strategies with detailed backtest code.
- **Alexander Elder** — classic TA; cross-reference against S&C for corroboration.

### Phase 3 — Web research pipeline
- [ ] Curate a seed list of high-signal sources (SSRN, Alpha Architect, Quantpedia, SeekingAlpha quant posts, ArXiv q-fin, etc.) in `groups/telegram_trading/sources.yaml`
- [ ] Add Scrapling + trafilatura to the trading container; reuse the existing Playwright MCP for JS-heavy sites
- [ ] Nightly research task: fetch → extract → dedupe against `AlgoTrader/Strategies/` (a-mem fuzzy match) → write new strategy markdown with provenance
- [ ] Rate-limit + polite-crawl guardrails; robots.txt respect; source attribution preserved in frontmatter

### Phase 4 — Regime classifier framework + performance attribution
- [ ] Build the pluggable **regime-classifier framework** in AlgoTrader (`trade/regimes/` package): a `Classifier` base class exposing a consistent `label(bars) → Series[str]` interface, a registry for registered classifiers, `.shift(1)`-safe forward-looking computation, NaN-during-warmup semantics.
- [ ] Implement the five initial classifiers (see findings.md "Regime classifier registry"):
  - `vix-tier` (asymmetric-tail 7-bucket percentile on trailing-10y VIX)
  - `gap-size` (per-asset percentile on trailing-252d gap distribution)
  - `price-range` (Donchian-style within / breakout-up / breakout-down)
  - `trend-basic` (200DMA × 50DMA-slope 4-way)
  - `sqn-market-type` (Van Tharp 6-way: SQN × vol axis)
- [ ] Add a regime-attribution step to AlgoTrader's `analysis/` pipeline: per-strategy, per-asset, slice CAGR/drawdown/hit-rate **by each classifier's labels**. Output a per-classifier heatmap + a cross-classifier matrix.
- [ ] Output: `AlgoTrader/Regime Reports/{strategy}/{asset}/YYYY-MM-DD.md` in the synced vault. Reports show attribution under every registered classifier, not just a single "regime" view.
- [ ] Classifier-informativeness report per strategy — for each classifier, how much does its labeling discriminate performance? (ANOVA-style F-stat or simpler: spread of per-label expectancy divided by aggregate.) Regime Analyst uses this to decide which classifiers to weight when targeting weaknesses.
- [ ] Stability-by-contract invariant: classifier label names are immutable; evolution is additive (new classifier, or versioned `v2`) — documented in the registry file.

### Phase 5 — Backtest orchestration + iterative indicator addition
- [ ] Define the "AlgoTrader invocation contract": given a strategy markdown + a candidate indicator, how is a runnable Python variant produced under `~/Projects/AlgoTrader/scripts/`?
- [ ] Mount `~/Projects/AlgoTrader/` into the trading container (read-write for script outputs + vault; consider a dedicated `scripts/_nanoclaw-generated/` subtree).
- [ ] Nightly loop (per strategy):
  - (a) regenerate baseline regime attribution if stale
  - (b) Regime Analyst picks the weakest regime needing help
  - (c) Researcher queries Findings KB for candidate indicators targeting that regime
  - (d) Skeptic filters candidates through the anti-overfit rubric
  - (e) Generate single-variable test scripts, run via `uv run`, parse results
  - (f) Apply cross-year + cross-asset + walk-forward gates
  - (g) Write `AlgoTrader/Backtests/YYYY-MM-DD {strategy} {indicator}.md` in synced vault
  - (h) If promoted: update strategy frontmatter + write finding to KB
- [ ] Post the day's promotions + rejections summary to Telegram in the morning.

### Phase 6 — Component library + findings KB + lessons loop
- [ ] Scaffold `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/Knowledge/` with:
  - `components/` — **nine subfolders**: `indicators/` (primitives), `entries/`, `exits/`, `stops/`, `take-profits/`, `position-sizing/`, `equity-curve/`, `entry-timing/`, `regime-filters/`
  - Each `indicators/{slug}/` carries `_indicator.md` (math, prose, Python for AlgoTrader) + `implementations/{platform}.ext` for vendor-specific code snippets from Traders' Tips
  - `findings/` — `regimes/`, `asset-classes/`, `cross-cutting/`, `meta/`
  - `metrics/` — open-ended metric catalog for bucketed conditional analysis; promoted subset is the regime classifier registry
  - `_pending.md` — Level-2 held-for-confirmation items
  - `_conventions.md` — tag vocabulary, component/finding schemas, single-writer ownership
- [ ] **Bootstrap the component library** by decomposing ORB into its components with evidence cross-referenced from the existing 30+ ORB runs in `~/Projects/AlgoTrader/obsidian_vault/Strategies/opening-range-breakout/Runs/`. This gives the library a seeded set on day one.
- [ ] AlgoTrader Engineer mirrors the **eight-category structure** in code under `~/Projects/AlgoTrader/trade/components/{indicators,entries,exits,stops,take-profits,position-sizing,entry-timing,regime-filters}/` (or an equivalent fitting the three-layer architecture). Indicators are primitives consumed by the 7 usage-role categories. Each component is a reusable Python primitive a strategy composes.
- [ ] Define the "finding entry" schema (frontmatter: regime tags, asset tags, strategies-tested, confidence, sources, walk-forward-validated yes/no) — see findings.md.
- [ ] Enforce a required `## Lessons` section on every run writeup with `strategy-local` and `candidate-cross-cutting` sub-sections.
- [ ] Documenter runs **end-of-bundle escalation review** after each Skeptic verdict: promote / hold / localize each Level-1 candidate.
- [ ] Documenter runs **end-of-strategy retrospective** when a strategy is parked or promoted, producing the highest-quality KB inputs.
- [ ] Create `AlgoTrader/Revisit Queue.md` as a first-class artifact, populated by the Sweeper (see below).
- [ ] Every strategy's canonical file must carry `unresolved_weaknesses:`, `ingested_at:`, and `last_swept_at:` fields before it can be parked or promoted. Strategy Author owns writing them; Documenter (via Sweeper) reads and updates `last_swept_at`.
- [ ] Every KB finding carries `promoted_at:` and `last_matched_against_strategies:` cursors. Documenter maintains.
- [ ] Implement **Sweeper** — a scheduled task (owned by Documenter, not a separate agent) that runs weekly off-hours. Three sweep directions: forward (findings → strategies), reverse (new strategies → existing KB), cross-finding (new findings → `_pending.md`).
- [ ] Sweeper writes proposed matches to `AlgoTrader/_sweep-staging.md`; Documenter reviews before committing to Revisit Queue or strategy frontmatter. Keeps the sweep auditable.
- [ ] On-demand sweep: `@Documenter sweep` (or equivalent) triggers a run out-of-band.
- [ ] Nightly cycle start: Documenter surfaces top Revisit Queue candidates; swarm decides whether to pursue a revisit or start a new strategy.
- [ ] KB-health audits (dead links, orphan findings, stale confidence, contradictions between entries, stale `_pending` items) run on a weekly cadence by the Documenter.

### Phase 7 — Specialist agent swarm
Apply `/add-telegram-swarm` to provision multiple bot identities. **Seven agents in three lanes. Each agent owns a specific artifact type — one writer per file; everyone else reads.** This single-writer discipline keeps lanes clean and prevents swarm merge conflicts.

**Research lane** (operates on strategy results, uses AlgoTrader as a black box):
- [ ] **Corpus Researcher** — internal-first. *Continuously:* re-decomposes older ingests as component knowledge grows; finds composition gaps (Workflow D seeds); spots cross-source patterns ("three sources describe essentially the same entry — promote to its own component"); runs re-triage passes as criteria evolve. *On quest:* responds with internal findings — what the corpus already knows about the problem. Maps ingested strategies to existing components; proposes new component files for genuinely novel pieces; actively counters entry-signal bias. *Owns:* `AlgoTrader/Sources/magazine/`, `AlgoTrader/Sources/book/`, backlog triage, internal quest findings (`AlgoTrader/Web Research/Quests/{date}-{slug}/internal-findings.md`).
- [ ] **Web Researcher** (Research Scout) — external-first. *Continuously:* scheduled scrape of curated sources (SSRN, Alpha Architect, Quantpedia, ArXiv q-fin, reputable quant blogs); opportunistic new-source exploration. *On quest:* responds with external findings. Maintains a **scout notebook** (`AlgoTrader/Web Research/_scout-notebook.md`) — accumulated expertise: productive sources, unproductive ones, credible authors, search patterns that worked, dead ends not to revisit. Compounds over time; makes quests faster because prior scouting informs where to look first. Tools: Playwright MCP, Scrapling, trafilatura, web search. *Owns:* `AlgoTrader/Web Research/` (including the scout notebook and quest external-findings files), `AlgoTrader/Sources/web/`, `AlgoTrader/Sources/academic_paper/`.
- [ ] **Regime Analyst** — regime classification, performance attribution, weak-regime mapping, regime-targeted candidate selection from the Findings KB + Metric Catalog. Proposes new metrics and classifier-promotion candidates. Fires quests to both researchers when a hypothesis needs external/internal lookup; integrates returned findings into its weak-regime reports. *Owns:* `AlgoTrader/Regime Reports/`, metric-catalog proposals.
- [ ] **Skeptic** — enforces anti-overfit rubric, demands out-of-sample + walk-forward + cross-year + cross-asset evidence, **hard veto** on promotion. *Owns:* promotion verdicts (emits a structured verdict object; does not write most files directly).

**Authoring lane** (turns decisions into durable artifacts):
- [ ] **Strategy Author** — sole owner of individual strategy definitions. Strategies are **wikilink compositions of library components** with parameters, not free-form code. Python variants for test runs are generated by composing the AlgoTrader component primitives. *Owns:* `AlgoTrader/Strategies/*.md` (composition manifests + narrative) and `~/Projects/AlgoTrader/scripts/_nanoclaw-generated/`. Does not pick *which* components to try (Regime Analyst + Researcher do) and does not decide if a test passes (Skeptic does) — purely a composition + authoring role.
- [ ] **Documenter** — sole owner of the Findings Knowledge Base, the Component Library, and all run-report writeups. Curates by topic (merges new findings into existing entries rather than appending chronologically), maintains cross-links between regimes ↔ components ↔ asset classes ↔ strategies, keeps frontmatter tags consistent, runs KB-health audits (dead links, orphan findings, stale confidence labels, components without recent evidence). Merges Researcher component proposals into the library after reviewing for duplication. *Owns:* `AlgoTrader/Knowledge/` (both `components/` and `findings/`), `AlgoTrader/Backtests/`, all cross-linking/tagging across `AlgoTrader/`.

**Platform lane** (writes Python inside `~/Projects/AlgoTrader/`):
- [ ] **AlgoTrader Engineer** — extends and maintains the framework: new indicators in `trade/indicators.py`, the regime-classifier framework in `trade/regimes/`, the **component library implementations in `trade/components/`** (eight subpackages mirroring the KB's usage-role categories), new analysis pipeline stages, new walk-forward modes, test coverage, the `trade/inverse_pairs.py` reference table, and the pre-promotion divergence-check tooling. When the Research lane proposes a new component, the Engineer ships its Python implementation; component code is paired one-to-one with its KB entry. Follows AlgoTrader's own lode + practices (pre-commit hooks, ruff + mypy + pytest, three-layer architecture). *Owns:* `~/Projects/AlgoTrader/{trade,strategies,analysis}/` (reusable framework code — **not** the nanoclaw-generated strategy scripts, which belong to the Strategy Author).

**Coordination:**
- [ ] **Quests** — the inter-agent research primitive. Any agent can fire a quest to the two researchers in parallel by writing `AlgoTrader/Web Research/Quests/{YYYY-MM-DD}-{slug}/prompt.md`. Both researchers work the quest concurrently and return findings to sibling files: `internal-findings.md` (Corpus Researcher) and `external-findings.md` (Web Researcher). The requesting agent writes `integration.md` with disposition + next steps (ingest, park, reject). Single-writer discipline preserved — each file has one owner.
- [ ] Nightly workflow becomes: Regime Analyst produces weak-regime report → Regime Analyst fires quests to both researchers for candidates → parallel internal + external findings returned → Skeptic pre-filters via rubric → Strategy Author creates single-variable test variant → backtest runs → Skeptic issues verdict → Documenter records the run + updates KB → if promoted, Strategy Author updates the canonical strategy file.
- [ ] Feature requests flow Research lane → AlgoTrader Engineer via in-chat @-mentions (e.g. "Engineer, we need a `days_from_fomc` regime axis"). Engineer files a plan in AlgoTrader's own `lode/plans/active/`, ships, notifies chat.
- [ ] Escalation: Skeptic veto is final on promotion; disagreements across lanes surface to Jeff via @-mention, not auto-resolve.
- [ ] **Chat-noise control:** agents post at milestone events only (candidate selected, verdict issued, KB updated, quest fired, quest returned) — not running commentary. Documenter posts a single **morning digest** consolidating the night's activity (promotions, rejections, KB deltas, platform changes, quests fired and returned, continuous-discovery highlights).
- [ ] Shadow mode: one week where verdicts are issued and documented but nothing auto-writes to canonical strategy files, to calibrate signal-to-noise.
- [ ] **Defer** until Phase 8 retro: Portfolio Theorist (cross-asset suitability specialist), Walk-Forward Auditor (temporal-robustness specialist). Add only if Phase 7 demonstrates a real gap — Skeptic currently covers both responsibilities.

### Phase 8 — Hardening
- [ ] Cost ceiling per nightly run (stop if exceeded; page Jeff).
- [ ] Backups of the `AlgoTrader/` vault subset (beyond Obsidian Sync).
- [ ] Retrospective after first month: false-positive/false-negative rate of the Skeptic; regime-attribution accuracy; KB hit-rate (how often a KB lookup produces a *useful* indicator candidate).
- [ ] Decide whether to add specialist agents deferred in Phase 7.

## Decisions
| Decision | Rationale |
|----------|-----------|
| Store extracted content as Obsidian markdown, not a vector DB | ~720 docs is trivially small for grep + direct reads; a-mem MCP provides the semantic layer for free |
| Use Docling as primary PDF extractor (pending bake-off) | S&C has charts, tables, formulas; Docling preserves layout best of OSS options |
| Playwright (existing MCP) + Scrapling + trafilatura for scraping | No paid service; Playwright already in the stack; Scrapling handles anti-bot on financial blogs |
| Write all research artifacts to `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/`, not AlgoTrader's vault | Synced across Jeff's machines; AlgoTrader's vault is project-local |
| AlgoTrader is a black-box backtester from NanoClaw's perspective | Don't reimplement; defer to its proven methodology and existing ORB research |
| Indicator addition is weakness-targeted, not random | Jeff's explicit methodology: measure regime weaknesses, then pick indicators from the Findings KB that have helped in those regimes on other strategies |
| Cross-year robustness gate (≥7 of 10 years positive, tunable) | Prevents "10 indicators each good in 1 year" — a major curve-fit mode |
| Cross-asset gate is **tiered by asset class**, not just "≥2 tickers" | QQQ + SOXL + TQQQ is one underlying (NDX leveraged variants). True robustness tests across structurally different classes (equities / commodities / bonds / FX / crypto). Promotion tier recorded per finding. See asset-class taxonomy in findings.md. |
| Regime Analyst owns asset-class attribution (not a separate Portfolio Theorist yet) | Natural extension of the regime-attribution role; avoids a 7th agent until the retro demonstrates a real gap. |
| Walk-forward validation is mandatory for promotion | AlgoTrader already has `walkforwards.py`; no reason to skip |
| Findings Knowledge Base is a first-class artifact, not a side-effect | It's what makes the nightly loop compounding rather than one-shot; every promoted AND instructively-rejected run feeds it |
| Start swarm at 6 roles in 3 lanes (Researcher / Regime Analyst / Skeptic / Strategy Author / Documenter / AlgoTrader Engineer) | Narrow lanes produce higher-quality work than one agent juggling everything. Coordination cost mitigated by single-writer discipline and morning-digest noise control. |
| Single-writer discipline: each artifact has exactly one owning agent | Prevents swarm merge conflicts and fuzzy responsibility. Other agents read and propose; only the owner writes. |
| AlgoTrader Engineer is part of this group, not a separate NanoClaw group | Engineer's work is primarily driven by feature requests from the Research/Authoring lanes. Same chat keeps the feedback loop tight. |
| Documenter is a first-class chat agent, not a background job | *Supersedes earlier decision.* KB curation is judgment work (merging, cross-linking, confidence calibration) that benefits from being in-lane with the rest of the swarm and surfacing its reasoning in chat. Scheduled-job mode is insufficient. |
| Strategy Author separated from Researcher and Engineer | Creating/updating strategy files is its own focused role. Researcher sources *ideas*; Engineer builds *framework pieces*; Strategy Author *composes* pieces into strategies. Matches AlgoTrader's existing `trade/` vs `strategies/` separation. |
| Chat-noise control via milestone-only posts + morning digest | Multiple agents (7 with the researcher split) chattering per event would drown the channel. Agents post at decision points; Documenter summarizes nightly. |
| Three-level lessons capture (per-run, per-bundle, per-strategy) with escalation at bundle+strategy level | Fine-grained enough to never lose an insight, coarse enough that not every run promotes something to the KB. Level-2 and Level-3 are the filters that keep the KB high-signal. |
| Retroactive matching + Revisit Queue make the KB proactive | Without this, a new finding sits passively. With it, two-week-old parked strategies are automatically reconsidered when the blocker that stalled them is resolved elsewhere. The KB becomes a compounding asset, not a log. |
| Unresolved-weakness records are required before parking/promotion | Makes retroactive matching possible. Without a structured record of "what blocked this strategy", there's nothing for future findings to match against. |
| Time-phased cursors + scheduled Sweeper (weekly, off-hours) | Event-trigger-only matching misses the case where the *strategy* (not the finding) is the new thing, and misses catch-up after offline windows. Cursors + scheduled sweep is idempotent, resilient, and catches all three directions (finding→strategy, strategy→KB, finding→pending). |
| Sweeper is a scheduled task owned by Documenter, not a separate agent | Matching is mechanical; interpretation is judgment. Keep the mechanical step out of chat; surface only the judgment work. Staging file preserves auditability. |
| Python research framework keeps `_AllocationPct ∈ [-1, 1]` — shorts are shorts in backtests | Research measures idealized edge; avoid polluting strategy logic with production-execution concerns. Matches existing AlgoTrader convention and keeps ORB code unchanged. |
| Inverse-ETF substitution is a **production-migration concern**, handled in the C# live-trading deployment (via the existing `_ShortSymbol` / soon-to-be `_InverseSymbol` setting), not in Python research | Research vs. production decoupled. C# strategy already shows the pattern: strategy logic speaks signed direction, position-adjustment layer resolves inverse routing. Replicating this in Python would duplicate a concern that doesn't affect research conclusions. |
| AlgoTrader Engineer maintains an inverse-pair reference table (`trade/inverse_pairs.py`) — a lookup, not a resolver | Used by the pre-promotion divergence check and by future C# deployment configuration. Populated with the agreed Tier 1 pairs (QQQ↔PSQ/QID/SQQQ, SPY↔SH/SDS/SPXU, SOXL↔SOXS, etc.). |
| Skeptic requires a **pre-promotion production-path divergence check** for any strategy whose signals include shorts | Before promotion, run the strategy once with native shorts and once substituting each short leg for its inverse-ETF long; measure divergence in CAGR / MDD / per-trade P&L. Significant divergence = documented execution risk. Small divergence = production path is safe. The divergence numbers themselves are KB-worthy findings (which inverse pairs track cleanly, which drift). |
| Strategy schema carries a `production_migration` block (null during research, populated at promotion) | Fields: `short_leg_handling` (native_short | inverse_etf:<TICKER> | long_only_dropped) and `inverse_divergence_report` link. Skeptic checks these before promoting. |
| Obsidian-native properties + inline hierarchical tags + prose — not nested YAML schemas | Agents write prose naturally and drift on rigid schemas. Obsidian's properties panel, tag pane, and Dataview give queryability for free. Tags evolve via hierarchy (`#weakness/unresolved` → `#weakness/unresolved/data-limited`) without migration. Metrics sidecar YAML stays as an escape hatch for cross-strategy numeric aggregation if/when needed. |
| Inline tags live *next to the claim they describe*; frontmatter `tags:` holds always-true classification | The weakness paragraph carries its own regime/asset tags so the Sweeper can match paragraph-local tag sets to findings. Whole-file tag bags would lose that co-location. |
| Strategy frontmatter carries 5 headline metrics for a stated `primary_asset`: CAGR, MDD, Calmar (CAGR/\|MDD\|), Ulcer, Sharpe | Small, queryable, sortable in Dataview; covers return, drawdown peak, risk-adjusted return, sustained drawdown pain, and volatility-adjusted return. Per-asset breakdowns stay in the prose body. `primary_asset` is explicitly stated so readers don't confuse which asset's numbers they're seeing. |
| 4-way asset classification in properties: `works_on` / `marginal_on` / `fails_on` / `untested_on` | Queryable by Dataview ("which strategies fail on UVXY?", "which haven't tried commodities?"). `fails_on` is preserved rather than discarded — it's KB-worthy evidence about asset-class suitability. |
| Charts are mandatory artifacts for every run; sweeps produce combined/overlay charts by default | Matches existing AlgoTrader practice (combined equity chart, 3-panel equity+drawdown+signal). Combined charts make relative performance eyeball-able and surface "sweep values barely matter" as a robustness signal. Small-multiples fallback when combined gets unreadable. Charts live in a shared `AlgoTrader/Charts/` flat directory with wikilinks from run reports, mirroring `~/Projects/AlgoTrader/obsidian_vault/Strategies/*/Charts/` convention. |
| Regime classification is a **pluggable registry of classifiers**, not a fixed axis list | Reflects how quant research actually treats regimes — multiple methodologies (VIX tier, SQN market type, HMM, Donchian range, etc.) coexist; the meaningful question is *which classifier informs which strategy*. Validates the Regime Analyst specialty role. |
| Five initial classifiers ship in Phase 4: `vix-tier`, `gap-size`, `price-range`, `trend-basic`, `sqn-market-type` | Covers volatility (universal), gap (per-asset), range (per-asset), trend (placeholder for more sophisticated successors), and brings Van Tharp's externally-recognized SQN market-type into the KB. Breadth / rate / seasonality deferred to on-demand. |
| VIX tiers use asymmetric cumulative-tail cutoffs (top 1% / 5% / 10% / 25% / 50% / 75%) on trailing-10y rolling window | Tails carry the highest-stakes decisions (stop trading, flip) AND have the least data. Fine-grained at the extremes + coarse in the middle concentrates resolution where decisions are made. |
| Classifier label names are stable-by-contract; evolution is additive only | Renaming an existing label would orphan every finding tagged with it. New classifiers, new labels (if the space literally grows), or versioned successors (`vix-tier-v2`) — never renames. KB longevity depends on this. |
| Tag namespace is `#regime/<classifier>/<label>`, not `#regime/<label>` | Classifier-qualified tags keep KB matching precise as the registry grows. A `#regime/high-vol` tag is ambiguous; `#regime/vix-tier/high` vs. `#regime/sqn/bear-volatile` is not. |
| Regime Analyst has standing mandate to propose new classifiers as first-class research output | "A classifier that better discriminates strategy performance" is itself a KB-worthy finding. Avoids the trap of treating classifier design as framework plumbing only. |
| Classifier-informativeness scoring per-strategy is a Phase 4 deliverable | For each classifier, quantify how much its labeling discriminates the strategy's performance. Tells the Regime Analyst which lens to look through when attributing weakness. Simple first cut: spread of per-label expectancy / aggregate expectancy. |
| Strategies are compositions of reusable components across eight orthogonal usage-role categories (plus indicators as primitives) | Entries, exits, stops, take-profits, position-sizing, equity-curve (performance-conditional), entry-timing, regime-filters. Knowledge accumulates per-component, not just per-strategy — "fixed-ATR stop fails on leveraged ETFs" learned in one strategy transfers instantly to every strategy considering that component. Counters the field-wide entry-signal bias where exits/stops/TPs/sizing/equity-curve are under-researched. |
| Component Library coexists with Findings KB under `AlgoTrader/Knowledge/` | `components/{7 subfolders}/` holds the composable pieces with their own track records; `findings/{regimes,asset-classes,cross-cutting,meta}/` holds effect-oriented insights. Both curated by the Documenter. |
| Strategy files' `components:` section is a **wikilink composition manifest**, not free-form prose | One strategy's composition referencing library components by wikilink means a component's evidence is queryable across every strategy that uses it. Prose on the strategy page narrates *why* the composition; component pages narrate *what each piece does*. |
| Component identity is stable-by-contract; evolution = new versioned component, not mutation | Same rationale as regime-classifier label stability: mutating a component silently misattributes prior findings. `fixed-atr-stop-v2` is a new file, not an edit of v1. |
| Researcher actively counters entry-signal bias at ingestion | When reading an S&C article, map it to existing components first; promote genuinely novel pieces (often exits/stops/TPs/sizing) as new library entries. An article's most valuable contribution may be its stop rule, not its entry signal. |
| Phase 6 bootstraps the library by decomposing ORB | ORB has 30+ runs of evidence already; decomposing its components (OR-breakout entry, EOD-flat exit, ATR filter, BtR cap-flips regime filter, etc.) seeds the library with components that have real track records on day one. Future strategies compose against a non-empty library. |
| AlgoTrader component implementations live under `trade/components/{7 subpackages}/` and pair one-to-one with KB entries | Code ↔ KB mirror means implementation presence is verifiable, and the Engineer's feature-request backlog is exactly the Research lane's component proposals. |

### Operating-model decisions

| Decision | Rationale |
|----------|-----------|
| Ingestion is component-first, not strategy-first | Most sources contribute components (entries, exits, stops, etc.) rather than complete strategies. Component Library is the working medium; strategies are compositions. |
| Four workflows (A ingestion / B component evaluation / C strategy iteration / D creativity) + E daily connector | Single-workflow framing missed creativity and the component-evaluation track. Explicit four-way decomposition prevents drift back into "strategies are the only first-class artifact" thinking. |
| Unified cross-corpus ranked backlog | A TradingView post and a 1990s S&C article compete on the same axis. One ranking, not per-source queues. Allows top items from any corpus to surface together. |
| Triage is structured-reason-driven, not opaque-score-driven | Every blocker carries a tag the Sweeper can match. When a blocker's underlying capability is added (e.g. individual-stock universe), affected items auto-resurface for re-ranking. Same mechanism as `unresolved_weaknesses:` for parked strategies, extended to backlog items. |
| Triage uses Obsidian-native style (frontmatter cursors + inline `#triage-blocker/*` and `#triage-credit/*` tags + prose) | Same locked convention as strategies, findings, and weaknesses. No nested YAML schemas — agents drift on rigid YAML; tags + prose evolve naturally. |
| Triage criteria evolve as KB matures | Early ranking is necessarily rough — we don't yet know which mechanisms work in our universe. Sharpens with knowledge. Documenter owns criteria evolution at `_triage-criteria.md`. Periodic re-triage sweeps re-evaluate older items against current criteria. Don't over-engineer day-one criteria. |
| Items persist in the backlog indefinitely | Low-ranked items aren't deleted — blocker may resolve years later. Only `retired` (explicit "never will work") items leave the backlog. Preserves the option for future capability-resolution to resurface old work. |
| Pilot-then-bulk for any new source-type | Find pipeline issues on a small slice before committing to a multi-week bulk load. Recurring pattern, not one-time. Apply to S&C, Trader's World, TradingView, books, papers, etc. |
| Concept pilot vs source-type pilot are different in scope | Concept pilot tests the entire system (one-time, weeks-long, broad). Source-type pilots test only extraction for new sources (recurring, days-long, narrow). Don't conflate them. |
| Concept pilot is staged additively (6→12→24→48→96 month ramp on S&C) with re-triage at each gate | One-shot 132-issue commit would use day-one criteria for the entire bulk load. Staged ramp lets each stage's learning sharpen the next stage's triage. Stage sizes roughly double; tunable per-stage. Smooth transition into steady-state at the end. |
| No hard "Mode 1 / Mode 2" boundary | Single daily flow with four input sources (backlog dip, daily catch, iteration, creativity) whose allocation share evolves as corpus matures. Smooth transition from pilot's last stage into steady-state ops. |
| Workflow D (creativity / novel composition from library) is first-class and budgeted | Not just a reactive Sweeper output. Swarm intentionally synthesizes new strategies from library components. Allocation grows as library matures (~5% day one → ~25% by year two). |
| Daily Catch is a first-class artifact (`AlgoTrader/Daily Catches/YYYY-MM-DD.md`) | Researcher's nightly output recording new arrivals, suggested compositions, and triage decisions. Persistent journal of what entered the system each day. Owned by Researcher. |
| Source-type-aware triage scoring (baseline by source type, modified by per-item factors) | Cross-corpus ranking needs a way to weight a peer-reviewed paper vs an S&C article vs a TradingView post. Source-type baseline as starting evidence shape; per-item factors refine. |
| **Ninth component category: `equity-curve`** (performance-conditional sizing / gating — related to but distinct from `position-sizing`) | Techniques that condition trading on the strategy's *own* recent performance: trade-only-when-equity-above-MA, skip-after-N-losses, SQN-based confidence scaling, equity-drawdown-gate. Conceptually distinct from per-trade sizing (which computes "how much" from market state) — equity-curve logic is self-referential, reading the strategy's own track record. Strategies compose both (e.g. vol-scaled per-trade sizing + equity-curve on/off gate). Keeping them orthogonal makes the composition explicit. |
| Workflow B has two evaluation modes — standalone edge analysis and comparative swap-in | Entries and exits can be evaluated standalone via bar-by-bar forward-return profiling, *without* a full strategy composition. Cheap, composition-free edge profile per signal. Other component types (stops, TPs, sizing, equity-curve, timing, filters) require swap-in evaluation against host strategies. Both modes write to the same Component Library page. Starting-point evaluation for any new entry/exit signal is its edge profile. |
| **Random-entry baseline is the reference for standalone edge analysis** — not zero | A signal with positive forward-bar returns isn't a signal if random entries into the same asset/regime produce the same forward returns (e.g. equities drift up on average). The meaningful measurement is the *delta* of the signal's bar-N returns vs. a random-entry benchmark in the same pool. If the delta is ≤ 0, there's no standalone edge. Component Library edge profiles record both the signal's return distribution AND the random-entry baseline's, making the delta explicit. |
| **Bucketed conditional analysis is the cheap first-line diagnostic** | Re-slicing existing trade logs or bar-returns against arbitrary metrics costs only metric-computation + groupby — not backtest runs. This is the primary way to discover strategy weaknesses *before* committing Workflow C iteration budget. Runs are the budgeted resource; bucketed analysis is not. |
| **Metric catalog is a new top-level KB artifact** at `AlgoTrader/Knowledge/metrics/` | Metrics (VIX, ATR, opening gap, MA distance, breadth, yield-curve, COT, FOMC proximity, etc.) are the open-ended raw material for bucketed conditional analysis. Sits alongside `components/` and `findings/`. Each metric entry carries its computation and default bucketing methodology. Grows organically as diagnostics surface new useful metrics. |
| **Regime classifier registry = curated, promoted subset of the metric catalog** | The 5 Phase-4 classifiers (`vix-tier`, `gap-size`, `price-range`, `trend-basic`, `sqn-market-type`) are metrics that graduated to classifier status: stable labels, locked bucketing, KB-wide tag namespace `#regime/<classifier>/<label>`. Metrics that consistently discriminate performance across many strategies get promoted from catalog to registry. Same promotion pattern as components (many ingested, few curated). |
| **Classifier-informativeness scoring generalizes to metric-informativeness per strategy** | For each strategy, bucketed analysis can score any metric by how much its labels discriminate the strategy's performance. Classifier-informativeness (existing Phase-4 deliverable) is the same scoring applied to the promoted metrics only. Metric-informativeness sweep across the full catalog surfaces classifier-promotion candidates. |
| **Metric catalog ownership: Regime Analyst** | Natural extension of the regime-attribution specialty — metrics are the raw material regimes classify against. No new swarm role needed. Regime Analyst proposes new metrics; AlgoTrader Engineer implements the computation; Documenter curates catalog pages and cross-links. |
| **Metric selection per baseline is LLM-judgment-driven, biased toward too many** | Given the catalog's "when to apply" guidance and each metric's accumulated findings, the diagnosing agent picks strategy-relevant metrics (intraday / trend-following / mean-reversion / etc.). Err toward more rather than fewer — conditional analysis is cheap. No privileged classifier subset; selection is strategy-aware. |
| **Promotion criteria stay loose; periodic catalog curation review handles it** | Formal "promote this metric to classifier" thresholds deferred. Instead: a periodic review (per pilot stage gate during the ramp; monthly in steady state) where Regime Analyst + Documenter look at the metric catalog's accumulated observations and make promote / retire / gap-identify decisions. Aligns with the monthly allocation review cadence. |
| **Split Researcher into Corpus Researcher + Web Researcher — 7-agent roster** | Distinct skills (internal mapping vs external search), distinct memory shape (corpus familiarity vs scout notebook), distinct tooling (Obsidian / a-mem vs Playwright / Scrapling / web search). Topic-focused quest mode is a new capability that needs dedicated ownership. Early-days lean: external research is where most novel value comes from when the internal corpus is thin; specializing from day one beats splitting later. *Supersedes earlier "6 agents" decision.* |
| **Both researchers run continuously and respond to quests in parallel** | Not sequential (internal first, external backup). Quest reports carry two sibling files — `internal-findings.md` (Corpus Researcher) + `external-findings.md` (Web Researcher) — integrated by the requesting agent in `integration.md`. Over-search is self-correcting (Corpus dedups at ingestion); under-search is irrecoverable. Backtest runs are the budgeted resource; agent time is cheap. |
| **Web Researcher maintains a scout notebook as accumulated expertise** | `AlgoTrader/Web Research/_scout-notebook.md` records productive sources, unproductive ones, credible authors, communities, search patterns that worked, and dead ends to avoid. Compounds over time; makes quests faster because prior scouting informs where to look first. The scout notebook is the agent's own long-term memory artifact. |
| **Quest is the inter-agent research primitive** at `AlgoTrader/Web Research/Quests/{YYYY-MM-DD}-{slug}/{prompt,internal-findings,external-findings,integration}.md` | Any agent fires a quest by writing `prompt.md`. Both researchers respond in parallel into sibling files. The requesting agent writes `integration.md` with disposition. Preserves single-writer discipline while enabling parallel research. Quests are a first-class artifact type, not an ad-hoc chat pattern. |
| **First-bundle shape is onboarding-type-dependent** (Shape A–E) | Complete strategy, standalone entry, standalone exit, standalone non-signal component, newly-composed strategy each have different F0 shapes. Shape A (~6-8 runs: sanity + QQQ baseline + auto regime/bucketed attribution + robustness + walk-forward). Shape B/C (~1-2 runs, no full backtests). Shape D (~3-6 runs comparative swap-in). Shape E (~6-8 sharper-hypothesis runs). F0 never PROMOTEs; verdicts are INVESTIGATE FURTHER / PARK / RETURN TO INGESTION. |
| **Shape A uses QQQ-only baseline; leveraged variants deferred to F1** | F0 can't PROMOTE anyway, so spending cross-leverage budget on first bundles is waste. SOXL/TQQQ runs only happen in F1+ when Shape A is determined promising. |
| **Walk-forward stays in F0, not deferred to F1** | One run is cheap insurance against continuing on a strategy that would fail walk-forward later. Failure in F0 walk-forward saves all subsequent F1+ effort. |
| **RETURN TO INGESTION authority: whoever notices flags; Corpus Researcher fixes** | Skeptic (during methodology audit) or Corpus Researcher (during sanity review) can flag a failed-reproduction bundle. Corpus Researcher owns the extraction fix because they authored the ingested record. Not a veto — a routing decision. |

### Design changes from the S&C ingestion validation exercise (Jan 2020 + July 2015 issues)

The exercise on three Jan 2020 articles (Calhoun scaling-in, Hellal/Zhang 8-day, Traders' Tips Leavitt) plus a TOC scan of July 2015 surfaced the following design changes, all confirmed with Jeff:

| Decision | Rationale |
|----------|-----------|
| `record_type:` on every source record (strategy / technique / analysis / interview / review / column / letters) | Not every article is a strategy. Calhoun's article was a technique that contributes only to the component library; interviews and analyses enrich context but don't enter the investigation cycle. Routes ingestion downstream behavior. |
| Ingestion output is multi-artifact, not 1:1 | A single source article can emit 0-N strategies + 0-N usage-components + 0-N indicators + 0-N platform-implementations + 0-N findings. The "1 article = 1 strategy.md" assumption is wrong. |
| **Indicators are the 8th component category** (primitives layer) | Indicators (MAMA, LeavittConvSlope, RSI) are consumed by all 7 usage-role categories. They need their own home. Mirrors AlgoTrader's existing `trade/indicators.py` separation. |
| Platform-specific code snippets live under `components/{category}/{slug}/implementations/{platform}.ext` | Traders' Tips sections provide vendor code in EasyLanguage, thinkScript, EFS, C#, etc. — all implementing the same indicators/strategies. Attached to the component, not the source extract, because they're reusable across any strategy that uses the component. Also gives cross-platform verification and C# production-migration templates for free. |
| `page_continued: [list]` on magazine source records | S&C frequently splits articles across ad-breaks (2020-01 Calhoun: p.7 → p.61). Single `page:` field insufficient. |
| `column:` recurring-series metadata | Enables author-body-of-work queries. Calhoun's "Trading on Momentum" column gives us an instant "all Calhoun momentum columns" Dataview query. |
| `section:` for Traders' Tips-style sibling groupings | Hierarchical section identification within a magazine issue. |
| `implementation_of:` cross-issue parent pointer | Traders' Tips are often cross-issue: January 2020 implementations of an October 2019 parent. Single schema handles both same-issue (2015-07) and cross-issue (2020-01) cases. |
| `series:` frontmatter (name, part N, of M) for multi-part article series | Vandycke's "Laws Of Momentum" in 2015-07 was explicitly part 1 of a series. Enables cross-issue series assembly. |
| `related_sources:` cross-citation graph | Authors cite prior work (Hellal/Zhang cite two prior S&C articles + an external paper). Turning citations into wikilinks builds an author-body-of-work graph automatically. |
| `tested_universe:` + `primary_context:` replace single `primary_asset:` for universe-level studies | Hellal/Zhang tested on 238 names aggregated; the single-`primary_asset:` model breaks. `primary_context:` can be an asset name or a named universe. |
| `author_claimed_configs:` + `observed_configs:` list for parameter-sweep-heavy articles | Academic-style articles routinely sweep (Hellal/Zhang tested 17 configurations). Frontmatter's 5 headline metrics stay as "our current best config"; full sweep lives as a list. |
| `per_direction:` metrics capture (long vs short split) | Long and short legs often behave very differently (Hellal/Zhang: shorts 2x longs in same-day mode, longs dominate in long-hold modes). Aggregate metrics hide this. |
| `trade_count:` upgraded to included headline metric | Sample size is critical for Skeptic's noise-vs-signal assessment. A "Sharpe 3 on 12 trades" vs "Sharpe 1.2 on 4,656 trades" is a critical distinction readable from frontmatter alone. |
| Component parameter-context mappings | Calhoun's $2 interval is keyed to $20-$50 stock prices. Components need to record parameter-to-context relationships, not single values. |
| Author-flagged unresolved weaknesses → fast-path `unresolved_weaknesses:` entries | When the author explicitly names a gap (Hellal/Zhang: "bull-vs-bear regime awareness should be added"), that's a ready-made Revisit Queue entry at ingestion time. Free head-start. |
| Source-claim provenance tags | `#source-claim/cherry-picked-example` (Quantacula's "three consecutive wins"), `#source-claim/negative` (Calhoun's "pattern-based didn't beat $2 intervals"), `#source-claim/positive-unverified`, `#source-claim/cherry-picked-universe`. Marks the evidence shape so the Skeptic weights it correctly. |
| Sweeper gains a 4th direction: stub-resolution | When a parent ingests after its children (out-of-order ingestion), resolve stub placeholders and re-run the reverse sweep on children. Required for robustness to non-chronological ingestion. |
| Chronological ingestion is the happy path | Oldest issues first, so Traders' Tips cross-issue parents land before their children. Stub-resolution handles the remaining out-of-order cases (web articles, re-ingestions, backfills). |
| Docling is the primary extraction tool (pending final bake-off) | Validated on 2020-01 article: excellent prose/numbers/structure extraction. Known post-processing needs: normalize small-caps artifacts, dedup running headers, configure `--image-mode referenced` for disk-referenced charts. Speed ~10sec/page warm, viable for 11-year archive in overnight batches. |

### Phase 1 blocker resolutions (Jeff's input)

| Decision | Rationale |
|----------|-----------|
| **AlgoTrader vault for nanoclaw-authored Trading work moves to `~/Documents/Obsidian/Main/AlgoTrader/`** | Fresh start. Separate from `AlgoTrader/` (which holds strategies we ingest and develop in the swarm). Existing ORB work at `~/Projects/AlgoTrader/obsidian_vault/` gets migrated *after* end-to-end workflow is confirmed working. Synced across Jeff's machines like the rest of `Main/`. |
| **Nightly cost budget: max 25 runs/night** (adjustable) | Simpler than dollar-based ceiling. Runs are a natural unit the swarm produces. Start conservative; adjust once we have real-world data on cost-per-run and signal-per-run. |
| **Cross-year threshold: ≥11/15 years (15-year history preferred); ≥7/10 fallback for short-history instruments** | Most leveraged ETFs (TQQQ, SOXL, SPXL) launched 2010 → 15 clean years max. Non-leveraged underlyings have much longer history. Tier the threshold by what's actually available. |
| **First test asset: QQQ** | Longest clean history among liquid universe (1999-present); richest trader-composition variety; good baseline before broadening to SOXL / TQQQ / others with shorter history. |
| **Skeptic has heavier-than-default stance on curve-fitting** | Not merely "evaluates" strategies — actively *audits methodology*. Default stance: **"assume curve-fit until proven otherwise."** Reviews *process before results*; rejects strategies with bad methodology regardless of how impressive the numbers are. See findings.md "Skeptic's default stance" and red-flag-pattern table. |
| **Mechanism-scoped cross-asset validation requires pre-declared mechanism + failure-side evidence** | Post-hoc rationalizations ("it only worked on QQQ because X") are curve-fit dodges. Mechanism must be stated BEFORE testing; failure evidence on theoretically-different assets is required to validate an asset-specific claim. |
| **Era-decay claims require a named causal factor** | "Markets changed in 2020" is insufficient — *what* changed? Name the factor (retail-options boom, Reg NMS, decimalization, HFT dominance era), cite evidence it correlates with the observed decay. Without a specific factor, the decay is presumed statistical (rejection). |
| **Rubric expanded from 12 items to 18, emphasizing methodology-first evaluation** | New items 13-18 cover parameter-sensitivity check, search-space accounting (Bonferroni-like haircut), sweep-variance-over-sweep-best reporting, filter-stacking orthogonality proof, methodology-first review order, and failure-side evidence requirement. |
| **Deferred `trader-composition-era` classifier for the regime registry** | Markets have shifted from retail-heavy (2005) → mixed (2015) → automated-heavy (2025). A classifier tagging eras by dominant trader population would let us attribute strategy performance to era specifically, separating curve-fit drift from real-but-era-bound edge erosion. Add when a strategy demands it. |
| **a-mem MCP installed (per-group, isolated)** | *Supersedes earlier deferral decision.* a-mem MCP is now baked into the agent container with per-group ChromaDB at `/workspace/extra/a-mem/`. Each group gets its own isolated semantic-recall layer (no cross-group bleed). Used for: dedup before creating Obsidian notes, cross-folder pattern recall when tag/filename isn't obvious, ephemeral observations too small for a file. Obsidian remains the curated source of truth. See [lode/infrastructure/a-mem.md](../../../infrastructure/a-mem.md). |
| **Lode mounted read-only into trading group** | Path `~/containers/nanoclaw/lode/` → `/workspace/extra/lode/`, RO. Madison sees current plan state as it evolves; can't corrupt it. Added to mount-allowlist with `allowReadWrite: false`. |
| **Phase 1 deliberately keeps mounts minimal** | AlgoTrader framework (`~/Projects/AlgoTrader/`), TASC archive, Calibre library — all NOT mounted until the phase that needs them (4-5 for AlgoTrader, 2 for Calibre). Madison's CLAUDE.md explicitly lists unmounted paths so she asks Jeff to add them when needed rather than silently failing or working around. |

### Design changes from the book-chapter validation (Ehlers Ch 3 + Katz TOC)

| Decision | Rationale |
|----------|-----------|
| **Fourth source type: `academic_paper`** | Single-document, peer-reviewed or whitepaper-shape, distinct from `book` (no chapters, no ISBN) and `web_article` (citation / published shape rather than blog). Fields: `journal`, `authors[]`, `published_at`, `doi`, `arxiv_id`, `ssrn_id`, `peer_reviewed: bool`. Calibre library already contains several (Zarattini-Aziz-Barbon intraday momentum, Falkenstein Finding Alpha, Lyxor trend-filtering, Fooled-by-Data-Mining). |
| `chapter_references: [list]` for intra-book cross-references | Ehlers Ch 3 references Ch 2 (ITrend derivation) and Ch 15 (synthetic equity curves). Distinct from cross-publication `related_sources:`. Book-internal dependency graph. |
| `intra_book_series:` for paired/progressive chapters | Ehlers Ch 3 Trend + Ch 4 Cycle form a natural pair with parallel structure. Enables "show me the full Ehlers trend/cycle arc" queries. |
| `summary_bullets_extracted: true` + dedicated prose section | Books consistently have author-provided chapter-end TLDRs (Ehlers: "Key Points To Remember"; Katz: "What Have We Learned?"). High-value extraction target. |
| Tom-Swifty-style chapter-openers filtered at ingestion | Ehlers opens every chapter with a pun. Non-content flavor text. Filter convention documented so pipeline treats them consistently across authors with similar conventions. |
| Parameter metadata: `optimizable: bool` + `author_robustness_note: string` on component parameter-context entries | Ehlers marks `RngFrac` as tunable and `RevPct=1.015` as "robust." Valuable signal about which parameters are load-bearing vs safe-to-tune. Guides the Skeptic's interpretation of parameter-sweep bundles. |
| `#source-claim/anti-overfit-argument` tag for author self-defenses | Ehlers argues "many trades + few params + long history = not curve fit." Distinct kind of claim — a meta-argument about evidence shape rather than a performance claim. Skeptic evaluates with extra care. |
| `#source-discrepancy` tag for multi-platform implementation disagreements | Ehlers Ch 3: EasyLanguage `alpha=0.07` vs EFS `alpha=0.05`. Probably typo. Flagged for reconciliation. |
| Platform-code storage convention is source-agnostic (author-provided OR vendor-provided, both via `components/{category}/{slug}/implementations/{platform}.ext`) | Ehlers' in-book EasyLanguage+EFS snippets use the same storage as Traders' Tips vendor snippets. One convention, two origin paths. |
| **Shared-component pattern across chapters** is explicit in books | Katz's "Standard Exit Strategy" defined once in Part III, referenced by many Part II entry chapters. Maps cleanly to wikilink composition; documents that this cross-chapter-reuse is the norm for books, not edge case. |
| **Standardized test portfolios as named universes** | Katz uses a "Basic Test Portfolio and Platform" across all of Part II. Record once at `AlgoTrader/Sources/book/{slug}/_test-universe.md` and reference by name. Enables comparison across the author's own strategies. |
| **Multi-strategy-per-chapter is the norm for encyclopedia-style books** | Katz Ch 5 "Breakout Models" has 4-6 breakout variants sharing components and differing on one dimension. Ingestion output: multiple strategy records per chapter + many shared components. Matches our already-established multi-artifact output principle. |
| **Book-as-continuation-of-article-series** as a cross-source-type pattern | Katz's book consolidates his 1996+ S&C articles. When both are ingested, `related_sources:` builds a bidirectional graph (book points back to article series; articles point forward to consolidating book). The deltas are themselves research-worthy. |
| **External references populate `findings/meta/`** | Katz's Chapter 3 "How to Fail with Optimization" and "How to Succeed with Optimization" sections match our 12-item anti-overfit rubric almost verbatim. Book becomes a seed citation in `findings/meta/research-methodology/` — external validation the Skeptic cites. |
| **Design validation: 8-category decomposition independently matches Katz's book structure** | Katz organizes his 390-page encyclopedia into "Tools / Entries / Exits" with explicit sections on each entry and exit category. Not a schema change — confirmation that our component decomposition is aligned with how sophisticated practitioners think about strategy architecture. |

## Errors
| Error | Resolution |
|-------|------------|

## Current status
Phase 1 complete (group registered, mounts wired, a-mem installed, end-to-end validated). Three open design topics remain before Phase 2 starts: **Topic 6** first-bundle composition, **Topic 7** strategy state machine, **Topic 8** nightly wall-clock. See [topics-status.md](topics-status.md) for current state by topic.

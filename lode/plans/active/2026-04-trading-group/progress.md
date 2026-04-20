# Progress — Trading-Research Telegram Group

## Session log

### 2026-04-20 — Operating-model round
- Reviewed the plan; surfaced inconsistencies (Phase 1 marked incomplete in tracker but done in topics-status; a-mem marked deferred but actually installed). Synced tracker to reality (Phase 1 ✅ with commit 8e8d995; a-mem decision superseded; Current status updated).
- Walked through the three open topics and discovered the scoped question ("what does a first bundle look like") was actually a symptom of a larger missing layer: **the operating model of the system itself**.
- Major operating-model design locked in this round (all captured as decisions in tracker.md and summarized as Topic 9 in topics-status.md):
  - **Four workflows + daily connector**: A ingestion / B component evaluation / C strategy iteration / D creativity / E daily flow. Ingestion is component-first, not strategy-first — many sources contribute only components.
  - **Unified cross-corpus ranked backlog** with structured-reason triage (Obsidian-native: frontmatter cursors + `#triage-blocker/*` / `#triage-credit/*` inline tags + prose). Same Sweeper mechanism as `unresolved_weaknesses:`. Items persist indefinitely; only `retired` leaves.
  - **Triage criteria evolve** — early ranking is rough; sharpens with knowledge. Don't over-engineer day one.
  - **Daily Catch** as first-class artifact (`AlgoTrader/Daily Catches/YYYY-MM-DD.md`). Researcher's nightly journal.
  - **Pilot-then-bulk** convention — concept pilot (one-time, broad, entire stack) vs source-type pilot (recurring, narrow, extraction only) distinguished.
  - **Concept pilot is staged additively** on S&C: 6→12→24→48→96 months cumulative. Each stage = ingest + re-triage + test top + capture findings + update criteria + decide next stage.
  - **No hard Mode 1 / Mode 2 boundary.** Single daily flow with four input sources (backlog dip / daily catch / iteration / creativity) whose allocation share evolves as corpus matures. Starting allocation table documented.
  - **Workflow D (creativity) is first-class and budgeted**, not just reactive.
- **9th component category `equity-curve`** added (performance-conditional sizing/gating — related to but distinct from position-sizing; reads the strategy's own track record). Updated findings.md category table + consistency-swept 8→9 / 7→8 references.
- **Workflow B has two evaluation modes**: standalone edge analysis (for entry/exit signals — bar-by-bar forward-return profiling, cheap, composition-free) and comparative swap-in (for everything else). Bar-by-bar profiling is the starting-point evaluation for any entry/exit signal.
- **Random-entry baseline** is the reference for standalone edge analysis — not zero. A signal whose bar-N returns don't beat random entry into the same asset/regime has no edge.
- **Bucketed conditional analysis** as the cheap first-line diagnostic. Re-slice existing trade logs against any metric with decision-time value; bucket by percentile/threshold; compute performance per bucket. Runs are budgeted; bucketed analysis is not.
- **Metric catalog** at `AlgoTrader/Knowledge/metrics/` as new top-level KB artifact. Open-ended. Each metric carries computation + default bucketing + accumulated findings + "when to apply" guidance. Regime classifier registry = promoted subset.
- **Metric selection per baseline is LLM-judgment-driven**, biased toward too many (analysis is cheap). Strategy-aware — intraday gets intraday-relevant metrics, trend-followers get trend-relevant, etc.
- **Metric catalog ownership: Regime Analyst** (no new role). **Promotion criteria loose; periodic curation review handles it** — per pilot stage gate, then monthly in steady state.
- **Status:** Topic 9 (Operating model) closed 🟢; Topic 6 narrowed to first-bundle shape only 🟡; Topics 7/8 still 🔴 but informed by operating model. Moving to Topic 6 next.

### 2026-04-18 — Planning session
- Jeff requested a second Telegram group focused on trading-strategy research: S&C magazine ingestion (20 years of PDFs), nightly web research, nightly backtest runs against AlgoTrader, results to Obsidian.
- Confirmed AlgoTrader at `~/Projects/AlgoTrader/` already has: strong anti-overfit practices, ORB strategy, three-layer architecture, run-report naming convention, `uv`-managed Python env.
- Confirmed `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/Stocks and Commodities/` already exists as the ingestion destination (partial 2023 issues in progress).
- Design decisions locked:
  - Markdown in synced Obsidian vault + a-mem MCP, no standalone vector DB.
  - Docling primary (pending bake-off) for PDF extraction.
  - Playwright (existing MCP) + Scrapling + trafilatura for web scraping.
  - Researcher + Skeptic swarm via `/add-telegram-swarm` to combat curve-fitting directly.
  - AlgoTrader is a black-box backtester; NanoClaw does not reimplement.
- Flagged three suspicious URLs in the initial message (`qwibitai/nanoclaw/pull/1649`, `0xMassi/webclaw`, `nanoindex.nanonets.com`) — likely prompt-injection bait; not fetched.
- Initialized nanoclaw lode (summary, terminology, practices, lode-map) on `main`.
- Created this plan directory with tracker / findings / progress.
- Follow-up methodology additions from Jeff (same session):
  - Indicators must be added weakness-targeted, not randomly: measure regime performance first, then pick indicators that address weak regimes.
  - Regime classification is its own first-class problem — taxonomy drafted (vol tier, gap, trend, breadth, seasonality) in findings.md.
  - Cross-year robustness gate (≥7/10 years), walk-forward validation, cross-asset gate all added to the anti-overfit rubric and the research loop.
  - Findings Knowledge Base at `AlgoTrader/Knowledge/` becomes a first-class artifact with a defined frontmatter schema; curated by topic, not chronological.
  - Research loop explicitly documented in tracker ("Research methodology" section, 9 steps).
  - Swarm roster expanded from 2 → 4: Researcher, Skeptic, Regime Analyst, **AlgoTrader Engineer** (platform lane, writes Python in `~/Projects/AlgoTrader/` under AlgoTrader's own lode + practices).
  - Phases restructured: old 6 → new 8. New Phase 4 (regime classification), new Phase 6 (findings KB), Phase 7 swarm now has two lanes (Research + Platform).
- Second follow-up from Jeff (same session) — narrow the lanes further:
  - Added **Documenter** agent (supersedes prior "Librarian as scheduled job" decision). Owns KB curation, run writeups, cross-linking, weekly KB-health audits.
  - Added **Strategy Author** agent. Sole owner of individual strategy files and generated Python variants. Split out from the nebulous "backtest orchestration" actor.
  - Final roster: 6 agents in 3 lanes (Research / Authoring / Platform).
  - Introduced **single-writer discipline**: each artifact has exactly one owning agent; others read. Ownership matrix added to findings.md.
  - Chat-noise control: milestone-only posts + Documenter-owned morning digest.
- Third follow-up from Jeff (same session) — make the research loop match reality:
  - Pointed at `~/Projects/AlgoTrader/obsidian_vault/Strategies/opening-range-breakout/Runs/` as the canonical example of how strategy work actually happens. Filenames alone show the pattern: 30+ runs across QQQ/SOXL/cross-asset in a single day, with investigations chained (`005→010→011` same hypothesis, `023` revisits `005`, `025-029` progressive bar-size widening, then `030` ensemble synthesis).
  - Replaced the 9-step linear loop with an **investigation-bundle cycle**: Baseline → weakness map → stated hypothesis → 8–20 linked runs across diagnostic/regime/filter/sweep/sanity/stacking/cross-asset/walk-forward types → Skeptic verdict on the whole bundle → PROMOTE/REJECT/INVESTIGATE FURTHER → re-baseline.
  - Codified an 11-entry **run-type taxonomy** observed in the ORB runs. Every emitted run is tagged; Documenter tracks chaining.
  - Agents-vs-manual advantage is now explicit: no forgotten threads, no skipped gates, hypothesis-first discipline, KB reuse across strategies, documented negative space, parallel investigations.
  - Budgeting: one investigation bundle per active strategy per night (~1–3 active strategies), not one run per strategy.
- Seventeenth follow-up — Phase 1 infrastructure stood up + end-to-end validated:
  - New Telegram group "Madison AlgoTrader" created, chat ID `tg:-5211322204`.
  - Registered in SQLite: folder `telegram_trading`, `isMain: true`, `requiresTrigger: false`, trigger `@Madison`.
  - Agent name correction applied globally: "Mason" → "Madison" across all group CLAUDE.md files, lode, `.env`, SQL triggers, memory. Prior memory was wrong; all future sessions should refer to the agent as Madison.
  - Mount allowlist at `~/.config/nanoclaw/mount-allowlist.json` updated: added `~/Documents/Obsidian/Main/AlgoTrader` (RW), `~/Documents/Obsidian/Main/Trading` (RW), `~/containers/nanoclaw/lode` (RO).
  - Per-group mounts set for `telegram_trading`: `/workspace/extra/algotrader/` (RW), `/workspace/extra/trading/` (RW), `/workspace/extra/lode/` (RO).
  - Obsidian vault scaffolded: `~/Documents/Obsidian/Main/{AlgoTrader, AlgoTrader/{strategies, Web Research, sources/{magazine,book,web,academic_paper}, Regime Reports, Backtests, Charts, Knowledge/components/{indicators,entries,exits,stops,take-profits,position-sizing,entry-timing,regime-filters}, Knowledge/findings/{regimes,asset-classes,cross-cutting,meta}}}/`.
  - Trading-group CLAUDE.md at `~/containers/data/NanoClaw/groups/telegram_trading/CLAUDE.md` — comprehensive persona + plan pointers + mount table + explicit unmounted-paths list + deferred-tools note (no a-mem). (Path updated 2026-04-18 during NanoClaw persistence migration; originally created at `~/Data/Nanoclaw/...`.)
  - Service restarted twice (after DB register, after lode mount added); bot pool healthy: `@MadisonLumenBot` + `@MadisonSwarm1/2/3Bot`.
  - **End-to-end validation**: Madison joined group, loaded CLAUDE.md, read plan files from `/workspace/extra/lode/plans/active/2026-04-trading-group/`, accurately summarized `topics-status.md`, wrote test file `_hello-from-madison.md` to Trading vault. Full stack works.
  - Phase 1 infrastructure complete.

- Sixteenth follow-up — Phase 1 blocker resolutions + Skeptic hardening:
  - **AlgoTrader vault:** fresh start at `~/Documents/Obsidian/Main/AlgoTrader/`; existing ORB work migrates after end-to-end works.
  - **Nightly budget:** max 25 runs/night (adjustable), not dollar-based.
  - **Cross-year threshold:** ≥11/15 preferred, ≥7/10 fallback (many leveraged ETFs launched 2010). First test asset: QQQ.
  - **Skeptic stance:** *heavier* than initial default. Key quote from Jeff: "Skeptic is looking at the testing methodology and results." Corner-case patching, outlier-picking from sweeps, filter escalation without orthogonality proof, retrodictive mechanism, asymmetric investigation depth — all explicit red-flag patterns.
  - **Rubric expanded from 12 to 18 items.** New items (13-18): parameter-sensitivity check, search-space accounting (Bonferroni-like haircut), sweep-variance-over-best reporting, filter-stacking orthogonality proof, methodology-first review order, failure-side evidence for asset-specific claims.
  - **Mechanism-scoped cross-asset validation** tightened: mechanism must be *pre-declared* (not post-hoc); asset-specific claims require observed *failures* on theoretically-different assets matching the mechanism's predictions — not just successes on correlated assets.
  - **Era-decay claims** require a named causal factor. "Markets changed in 2020" is not sufficient; specific factor (retail-options launch, Reg NMS, etc.) must be cited. Without one, decay is presumed statistical (rejection).
  - **Telegram group** is the one remaining blocker; Jeff setting up next.
  - Added "Skeptic's default stance" section and red-flag-patterns table to findings.md.
  - Deferred `trader-composition-era` classifier added to regime registry backlog — enables era-attributed performance analysis to distinguish curve-fit drift from real edge erosion.

- Fifteenth follow-up — book-chapter validation (Ehlers Ch 3 + Katz TOC):
  - Processed Ehlers Ch 3 "Trading the Trend" (book pp.21-32): ITrend zero-lag DSP filter + Trigger derivative + crossover entry strategy tested on forex futures (EC, JY, SF) over 22-27 years. One chapter produced **7 new component-library entries** (2 indicators + 5 usage-role components). Books are a component-library growth engine.
  - Processed Katz *Encyclopedia of Trading Strategies* TOC (which alone delivered more design validation than any chapter read): book organized into "Tools / Entries / Exits" with 8 entry chapters and 3 entire chapters devoted to exits. **Katz's macro-structure independently matches our 8-category Component Library decomposition** — strong external validation that this is the canonical way to think about strategy decomposition.
  - Katz's Chapter 3 "Optimizers and Optimization" has explicit sections "How to Fail with Optimization" and "How to Succeed with Optimization" matching our 12-item anti-overfit rubric nearly verbatim. Book becomes a seed reference for `findings/meta/research-methodology/`.
  - Katz's "Standard Exit Strategy" (Ch 13) is used across multiple Part II entry chapters — explicit cross-chapter component reuse. Exactly the wikilink composition our library is designed for.
  - Katz's "Basic Test Portfolio and Platform" — a standardized test universe used across all Part II — establishes the "named test universe" pattern for books.
  - Katz's preface states the book consolidates his 1996+ S&C articles — a cross-source-type relationship worth capturing in `related_sources:` bidirectional graph.
  - **~14 additional design changes applied to the plan**, including: 4th source type `academic_paper`; `chapter_references:`; `intra_book_series:`; `summary_bullets_extracted:`; Tom-Swifty filter; parameter `optimizable`/`author_robustness_note`; `#source-claim/anti-overfit-argument` + `#source-discrepancy` tags; platform-code storage source-agnostic; shared-component + named-universe patterns; book-as-article-series-consolidation; external-reference-seeds for `findings/meta/`.
  - Validation exercise closed. Total across S&C + book rounds: **~33 design changes**, all folded into tracker.md + findings.md + topics-status.md. Scratch doc preserved at `lode/tmp/sc-ingestion-exercise.md`.

- Fourteenth follow-up — S&C ingestion validation exercise (major design validation):
  - Verified S&C archive at `/home/jeff/Mounts/Data/Calibre/Library-01/TASC/` (NAS mount; 2010-2020; ~132 issues).
  - Validated design against three articles in 2020-01 (Calhoun scaling-in, Hellal/Zhang 8-day, Traders' Tips Leavitt) + TOC scan of 2015-07.
  - Installed docling as isolated uv tool; ran on 4-page 8-day article; quality good (all prose, numbers, pattern rules, structure captured); minor post-processing (small-caps normalization, running-header dedup, image-mode config).
  - Exercise surfaced **~19 confirmed design changes**, all applied in this round:
    - `record_type:` routing (strategy / technique / analysis / interview / review / column / letters)
    - Multi-artifact output per article (0-N of each artifact type)
    - **Indicators as 8th component category** (primitives layer; consumed by the 7 usage-role categories)
    - Platform-specific code storage under `components/{category}/{slug}/implementations/{platform}.ext`
    - `page_continued:`, `column:`, `section:`, `series:` magazine metadata fields
    - `implementation_of:` cross-issue parent pointer
    - `related_sources:` cross-citation graph
    - `tested_universe:` + `primary_context:` for universe-level studies
    - `author_claimed_configs:` + `observed_configs:` for parameter sweeps
    - `per_direction:` metrics for long/short asymmetry
    - `trade_count:` as headline metric
    - Component parameter-context mappings
    - Author-flagged unresolved weaknesses → Revisit Queue fast-path
    - `#source-claim/*` provenance tags
    - Chronological ingestion as happy path
    - **4th Sweeper direction: stub-resolution** for out-of-order ingestion
    - Docling confirmed as primary extraction tool (pending final bake-off)
  - Scratch doc at `lode/tmp/sc-ingestion-exercise.md` preserves the detailed article-by-article analysis.

- Thirteenth follow-up — multi-source ingestion (not S&C-only):
  - Verified Calibre library at `/home/jeff/containers/data/calibre/library/` on jarvis. 90+ trading-book authors present; S&C magazines *not* currently in library (Jeff migrating from a prior location). Other trading magazines present: SFO, Traders, Traders World, Expiring Monthly, Bloomberg Markets.
  - Scope expansion from Jeff: books and non-S&C magazines are valid ingestion targets — broader corpus = more strategy variety for the KB.
  - **Three source types defined** in findings.md:
    - `magazine` — S&C + others; typically 1 strategy per article; S&C Traders' Tips sections carry software-vendor implementation variants as sibling records
    - `book` — chapter-level decomposition; author claims marked cherry-picked; books often contribute *component families* that populate the library even when individual strategies don't promote
    - `web_article` — with archived local snapshot at ingestion (web rots)
  - Phase 2 tracker updated: three ingestion scripts (`ingest-magazine.*`, `ingest-book.*`, `ingest-web.*`) all producing the same cold-start schema but handling provenance metadata differently.
  - Notable book authors flagged: Ehlers (DSP components), Kaufman (systematic-trading encyclopedia), Katz (neural-net approaches), Williams (COT — needs CFTC data), Augen (options — asset class currently not in universe), Chan (modern quant), Elder (classic TA).
  - Calibre library saved as a memory reference (`reference_calibre.md`) for future sessions; linked from `MEMORY.md`.

- Twelfth follow-up — component-oriented KB reframe (major):
  - Jeff: strategies decompose into reusable components that get mixed and matched; knowledge should accumulate along each component axis. Observed that most public literature fixates on entry signals because "you have to have a way to get in" but misses exits, stops, TPs, sizing, timing, regime-gating — where much of the real edge often lives.
  - **Seven component categories**: `entries`, `exits`, `stops`, `take-profits`, `position-sizing`, `entry-timing`, `regime-filters`.
  - **KB gains `components/{7 subfolders}/`** alongside existing `findings/`. Components are first-class curated artifacts with their own track records across every strategy they appear in.
  - **Strategy files' `components:` section becomes a wikilink composition manifest** (not free-form prose). Prose narrates the composition's logic; components themselves are referenced by library entry.
  - **Component identity is stable-by-contract** — mutating a component would misattribute prior findings. Evolution = new versioned component.
  - **Phase 6 bootstraps the library by decomposing ORB**, using its 30+ existing runs as seed evidence. Future strategies compose against a non-empty library from day one.
  - **AlgoTrader Engineer** mirrors the seven categories in Python code under `trade/components/{7 subpackages}/`. Each KB component pairs one-to-one with its Python implementation. Engineer backlog = Research lane's component proposals.
  - **Researcher responsibility expanded**: at ingestion, map strategies to existing components; promote genuinely novel pieces (often the stop rule or exit logic, not the entry) as new library entries. Actively counters entry-signal bias.
  - **Documenter** gains component-library curation (merges proposals, cross-links, track-record aggregation) and component-health audits.
  - **Strategy Author** role refined: composes strategies from library components with parameters, generates Python via composition rather than hand-rolling each strategy.

- Eleventh follow-up — regime reframe (Topic 5) resolved:
  - Jeff: trend regime is "its own type of specialty — there can be others — $VIX based, price within range, SQN (Van Tharp), etc." This reframes regime classification from a fixed 5-axis schema to a **pluggable registry of named classifiers**, each implementing a consistent `label(bars) → Series[str]` interface.
  - **Initial classifier registry (Phase 4 builds all five):**
    - `vix-tier` — 7 asymmetric-tail percentile buckets (top 1% / 5% / 10% / 25% / 50% / 75%) on trailing-10y rolling VIX window. Universal.
    - `gap-size` — 5 buckets, per-asset percentile calibration on trailing-252d gap distribution.
    - `price-range` — Donchian-style within / breakout-up / breakout-down. Per-asset.
    - `trend-basic` — 200DMA × 50DMA-slope 4-way. Named "-basic" so successors (`trend-hmm`, `trend-kama`) can be added without renames.
    - `sqn-market-type` — Van Tharp 6-way (bull/bear/sideways × quiet/volatile). Universal, indexed off SPY daily returns.
  - **Deferred classifiers**: `breadth`, `rate-regime`, `regime-of-regimes` (HMM/clustering), `credit-regime`, seasonality-*, sophisticated trend variants. Added on demand when a strategy needs them.
  - **Stability-by-contract**: classifier label names are immutable; evolution is additive only. Renames would orphan all prior-tagged findings.
  - **Tag namespace**: `#regime/<classifier>/<label>` — classifier-qualified, not bare `#regime/<label>`. Keeps KB matching precise as the registry grows.
  - **Meta-finding category emerges**: "classifier X better discriminates strategy Y than Z" becomes a first-class KB entry. Regime Analyst has mandate to propose new classifiers as research output, not just consume existing ones.
  - **Classifier-informativeness scoring** per-strategy is a Phase 4 deliverable — tells the Regime Analyst which lens to look through for a given strategy's weaknesses.
  - Seasonality: Jeff has no strong views; deferred until a strategy demands it.

- Tenth follow-up — finding schema (Topic 4) closed for initial use:
  - Finding files mirror the strategy-file style: thin frontmatter + inline hierarchical tags + prose. Parallel structure so Sweeper treats strategies and findings symmetrically.
  - Finding frontmatter: `id`, `status` (active/superseded/contradicted/retired), `category` (regimes/indicators/asset-classes/cross-cutting), `promoted_at`, `last_matched_against_strategies`, `confidence`, `direction` (positive/negative/neutral-informative), `walk_forward_validated`, `years_positive` (as string `"N/K"`), `source_bundles`, `tags`.
  - Three-way `direction` retained (not simplified to two-way) — neutral-informative findings like "Trade 1 carries 70% of return" are load-bearing but not prescriptive.
  - Tag vocabulary starter roots: `#regime/*`, `#asset/*`, `#asset-class/*`, `#indicator/*`, `#mechanism/*`, `#weakness/*`, `#strength/*`, `#era/*`, `#cross-cutting`, `#trade-number/*`, `#session-time/*`. Documented in `AlgoTrader/Knowledge/_conventions.md`, Documenter curates.
  - Jeff's note: "sounds good for now — i am sure it will expand/change once we implement." Schema accepted as initial working form; explicitly expected to evolve.

- Ninth follow-up — schema style + charts:
  - Rejected the heavy nested-YAML approach I proposed for populated strategy records. Agents drift on rigid schemas; nested YAML doesn't evolve well; and Obsidian's native properties/tags/Dataview give queryability without the tax.
  - Adopted **Obsidian-native style**: minimum frontmatter for cursors + a few typed atoms, inline hierarchical tags co-located with the claim they describe, prose for everything else.
  - **Strategy frontmatter** now: `id`, `status`, `ingested_at`, `last_swept_at`, `promotion_tier`, `source`, `strategy_family`, `hold_duration`, `primary_asset`, 5 headline metrics (CAGR, MDD, Calmar, Ulcer, Sharpe), 4 asset-classification lists (`works_on` / `marginal_on` / `fails_on` / `untested_on`), `tags` for persistent classification.
  - **Metric set rationale**: CAGR (return), MDD (peak pain), Calmar (eyeball-able risk-adjusted return), Ulcer (sustained drawdown pain — orthogonal to MDD), Sharpe (vol-adjusted return, lingua franca).
  - **Asset classification rationale**: keep `fails_on` as preserved evidence (asset-class suitability findings), `untested_on` surfaces research gaps for the nightly cycle.
  - Finding files adopt the same style — parallel schema to strategies, so the Sweeper treats them symmetrically.
  - `_conventions.md` in the Knowledge directory documents tag taxonomy; Documenter curates.
  - **Charts mandatory** on every run; sweeps produce combined/overlay charts by default with small-multiples fallback. Shared flat `AlgoTrader/Charts/` directory mirrors AlgoTrader's existing convention. Strategy Author generates; Documenter enforces presence in health audits.

- Eighth follow-up — shorts, inverse ETFs, asset universe:
  - Asset universe locked: Tier 1 ETFs (broad indices + leveraged/inverse pairs, semi-sector leveraged pairs, sector ETFs, volatility sub-class UVXY/SVIX/VXX/SVXY, commodity/rates/dollar ETFs), Tier 1.5 curated 11-name stock shortlist (AAPL, MSFT, NVDA, GOOGL, META, AMZN, TSLA, JPM, UNH, XOM, WMT), Tier 2 futures (Kibot-supported, Engineer work for sessions + rolls). Deferred: point-in-time index memberships, single-stock breadth, FX spot, crypto 24/7.
  - Priority order: ETFs → stocks → futures.
  - Hold-duration confirmed as a separate classification axis (intraday / overnight / swing / position / long-term), orthogonal to strategy_family.
  - **Shorts corrected:** Jeff pointed at the C# OpeningRangeBreakoutTradingStrategy to show his actual approach. Research framework (Python AlgoTrader) trades shorts natively with `_AllocationPct ∈ [-1, 1]`. Inverse-ETF substitution is a **production-migration concern** handled in the C# deployment via the `_ShortSymbol` setting (well-named as `_InverseSymbol`). My earlier "long-only convention" proposal was overreach — reverted.
  - Added pre-promotion divergence check (item #12 in the anti-overfit rubric): run native-shorts vs inverse-long-substitution variants before promoting any strategy with short signals; document the divergence.
  - Strategy schema gains a `production_migration` block (null during research, populated at promotion): `short_leg_handling` and `inverse_divergence_report` link.
  - AlgoTrader Engineer now also owns `trade/inverse_pairs.py` (reference table, not a resolver) and the divergence-check tooling.

- Seventh follow-up — time-phased records + scheduled Sweeper:
  - Generalized the retroactive matcher beyond "event on finding promotion". Every strategy, KB finding, and ingested item carries time-phase cursors (`ingested_at`, `promoted_at`, `last_swept_at`, `last_matched_against_strategies`).
  - **Sweeper** — a scheduled task owned by Documenter (not a separate chat agent). Runs weekly off-hours. Three sweep directions:
    - Forward: new findings → old strategies (original retroactive match)
    - Reverse: newly-ingested strategies → existing KB (strategy from S&C or web scrape gets annotated with relevant existing findings at ingestion time)
    - Cross-finding: new findings → `_pending.md` items (corroboration / contradiction detection)
  - Sweeper writes proposed matches to `AlgoTrader/_sweep-staging.md`; Documenter reviews before committing. Audit trail preserved.
  - On-demand trigger: `@Documenter sweep` runs out-of-band when there's suspicion a match exists.
  - Idempotent by cursor design — re-running the sweep produces no duplicate entries.
  - Rationale: the simple "fire on finding promotion" design missed three cases — strategy-as-new-thing, offline catch-up, and held-finding corroboration. Scheduled cursor-based sweep covers all of them.

- Sixth follow-up — lessons loop + retroactive applicability (makes the KB proactive):
  - Every run writeup now requires a `## Lessons` section with `strategy-local` and `candidate-cross-cutting` sub-sections (Level 1).
  - **End-of-bundle escalation review** after each Skeptic verdict: Documenter promotes / holds / localizes each Level-1 candidate (Level 2).
  - **End-of-strategy retrospective** when a strategy is parked or promoted (Level 3, highest-quality KB inputs).
  - `AlgoTrader/Revisit Queue.md` is a new first-class artifact. Every promoted cross-cutting finding triggers a retroactive match against all parked strategies' `unresolved_weaknesses:` records. Matches enqueue with citation + hypothesis.
  - Canonical example (Jeff's): two-week-old strategy parked with unresolved high-vol weakness; later a vol predictor is discovered on a different strategy; retroactive match auto-enqueues the old strategy for revisit with the new finding cited.
  - `unresolved_weaknesses:` structured record is *required* before any strategy can be parked or promoted. Strategy Author writes it; Documenter reads it for matching.
  - Held-for-confirmation items live in `Knowledge/_pending.md` until a second bundle corroborates them.
  - Decisions table updated with four new entries covering lessons capture, retroactive matching, unresolved-weakness records.

- Fifth follow-up — cycle is adaptive, not templated:
  - ORB runs were an *example* of iteration, not a template. That investigation happened to focus on entry filters + regime conditioning because those were ORB's open questions.
  - Other strategies will explore dimensions ORB didn't: **exit rules, stop-loss patterns, take-profit patterns, hold duration, position sizing, entry timing, correlation/hedging**. Mean-reversion strategies spend their budget on exits; trend-followers on regime filters + sizing.
  - Run-type taxonomy refactored into: universal / entry-side / exit-stop-TP / sizing-portfolio / robustness categories. List is explicitly illustrative and growing — Documenter owns curating new types as the swarm proposes them.
  - Cycle diagram updated: weakness identification is dimension-agnostic ("strategy underperforms when ___"), and investigation bundles are shaped to the hypothesis, not filled from a fixed checklist.

- Fourth follow-up — cross-asset-class dimension:
  - Cross-asset gate **tiered by asset class**, not just ticker count. QQQ+SOXL+TQQQ is one underlying (NDX leveraged variants), not real cross-asset breadth.
  - Asset-class taxonomy added (tier 1: equities supported today; tier 2: commodities, bonds, FX, crypto, sectors, international — require AlgoTrader Engineer work for data loaders + session defs + vol normalization).
  - Promotion tier recorded per finding: Experimental / Validated / Cross-asset-class robust.
  - Regime Analyst owns asset-class attribution (deferred dedicated Portfolio Theorist agent until retro).
- **Status:** Phase 0 complete with expanded scope. Awaiting Jeff's approval to begin Phase 1 (group foundation).

## Test results
| Test | Status | Notes |
|------|--------|-------|

## Error log
| Time | Error | Resolution |
|------|-------|------------|

## Reboot check (5 questions)
1. **Where am I?** — Phase 1 infrastructure complete (a14c646). Design round 2026-04-20 just locked the **Operating model** as Topic 9. Three open topics remain before Phase 2 starts: Topic 6 (first-bundle shape, narrowed 🟡), Topic 7 (strategy state machine 🔴), Topic 8 (nightly wall-clock 🔴).
2. **Where am I going?** — Work through Topic 6 → 7 → 8 in order. Topic 6 has a draft shape to confirm (~8-12 runs: sanity + 3 baselines + regime attribution + robustness probes + walk-forward). Topic 7 defines state transitions + authorities. Topic 8 defines the nightly choreography including allocation-policy enforcement.
3. **What is the goal?** — A Telegram-hosted swarm of 6 lane-focused agents running four workflows (ingestion, component evaluation, strategy iteration, creativity) through a unified ranked backlog + Component Library + Findings KB + Metric Catalog. Starts with a staged concept pilot on S&C (6→12→24→48→96 months), then runs daily forever. Anti-curve-fit discipline first-class via 18-item Skeptic rubric. Bucketed conditional analysis + random-entry baselines make evaluation cheap before committing run budget.
4. **What have I learned?** — The original plan described the system as single-workflow ("test strategies"). Real system has four workflows and ingestion is component-first, not strategy-first. Triage ranks everything with structured reasons (not binary in/out) so the Sweeper can resurface items when blockers resolve. Bucketed conditional analysis is effectively free and should be used aggressively before spending run budget. The 5 regime classifiers are a promoted subset of a broader open-ended metric catalog. Standalone edge analysis on entry/exit signals needs a random-entry baseline, not a zero baseline. Equity-curve-based sizing is a 9th component category distinct from position-sizing.
5. **What have I done?** — Initialized lode; wrote 8-phase plan with ~70+ decisions; ran S&C + book validation exercises generating ~33 design refinements; Phase 1 infrastructure landed in commit a14c646 (group registered, mounts wired, a-mem installed, end-to-end validated). 2026-04-20 round: operating-model design locked (Topic 9 🟢); tracker + findings + topics-status + progress updated; consistency-swept 8→9 / 7→8 category references.

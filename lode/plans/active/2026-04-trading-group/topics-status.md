# Topics Status — Trading-Research Telegram Group

Organized by topic (current state), not chronological. For chronological history of decisions, see [progress.md](progress.md). For full detail on settled designs, see [tracker.md](tracker.md) and [findings.md](findings.md).

**Legend:** 🟢 closed for initial use · 🟡 partially addressed · 🔴 open · ⏸ deferred

---

## Topic 1 — Asset universe  🟢

**Closed for initial use.** Universe is ETF-focused with selective major stocks and futures.

**Key decisions:**
- Priority order: **ETFs → stocks → futures** (build out in this order)
- **Tier 1** (ETFs): broad indices with their leveraged/inverse pairs (QQQ/QLD/TQQQ/PSQ/QID/SQQQ; SPY variants; IWM variants; DIA variants); semi-sector leveraged pairs (SOXL/SOXS, LABU/LABD, NAIL/DRV, GUSH/DRIP, NUGT/DUST); sector ETFs (XLK/XLE/XLF/XLU/XLV/XLI/XLP/XLY/XLB/XLRE/XLC); **volatility sub-class** (UVXY, SVIX, VXX, SVXY) treated as its own asset class; commodity/rates/dollar/international ETFs (GLD, SLV, TLT, IEF, UUP, EFA, EEM)
- **Tier 1.5** (curated 11-stock shortlist, industry-diverse): AAPL, MSFT, NVDA, GOOGL, META, AMZN, TSLA, JPM, UNH, XOM, WMT
- **Tier 2** (futures, Kibot-supported, requires Engineer work for session defs + roll logic): ES, NQ, RTY, CL, NG, HG, GC, SI, ZN, ZB, 6E, 6J
- **Inverse ETFs** are a **production-migration concern** handled in the C# live-trading layer (`_ShortSymbol` / `_InverseSymbol`), not in Python research. Python framework trades shorts natively with `_AllocationPct ∈ [-1, 1]`.
- **Liquidity-first** for major stocks; prefer ETFs because inverse ETFs handle IRA no-short constraint cleanly.

**Deferred:** point-in-time index membership, single-stock breadth, FX spot, crypto 24/7, individual-stock data coverage work.

**Open:** none material.

---

## Topic 2 — Cold-start strategy record (ingestion)  🟢

**Closed for initial use.** Strong separation between what the source claimed, our editorial classification, and observed measurements.

**Key decisions:**
- Three-part record: `claimed:` (frozen at ingestion, unverified), `classification:` (Researcher's read), `observed:` (empty until tested)
- `performance_claims` kept but explicitly not used for prioritization (often cherry-picked in sources)
- Lifecycle: `untested → investigating → parked | promoted | retired`
- `blockers:` captured explicitly (data missing, prerequisites) so the Sweeper can re-check when blockers resolve
- `overlap_with_existing:` flagged at ingestion to catch duplicate strategies
- `strategy_family`, `hold_duration` (intraday / overnight / swing / position / long-term), `signal_type` as orthogonal classification axes
- **Four source types** supported (see findings.md "Source type taxonomy"):
  - `magazine` — S&C, SFO, Traders, Traders World, Expiring Monthly, Bloomberg Markets; S&C "Traders' Tips" sections carry software-vendor implementation variants as siblings
  - `book` — chapter-level decomposition with intra-book cross-references, paired chapters, standardized test universes, shared-component patterns (one exit rule used across many entry chapters), book-as-consolidation-of-article-series, and in-chapter platform-code snippets
  - `web_article` — with archived local snapshot; quality ranges widely
  - `academic_paper` — single-document, peer-reviewed or whitepaper-shape; journal/arxiv/ssrn/doi metadata. Distinct from book (no chapters) and web_article (citation shape rather than blog)
- S&C archive lives at `/home/jeff/Mounts/Data/Calibre/Library-01/TASC/` (NAS mount); 2010-2020 currently (~132 issues). Main Calibre library at `/home/jeff/containers/data/calibre/library/` holds the trading books + non-S&C magazines.
- **Schema refinements from S&C 2020-01 + 2015-07 validation exercise (~19 new design decisions, all in tracker.md):** `record_type:` routing; multi-artifact output per article; `page_continued:` / `column:` / `section:` / `series:` metadata; `implementation_of:` for cross-issue Traders' Tips parents; `related_sources:` cross-citation graph; `tested_universe:` / `primary_context:` for universe-level studies; `author_claimed_configs:` for parameter sweeps; `per_direction:` long/short split; `trade_count:` as headline metric; component parameter-context mappings; author-flagged unresolved weaknesses → Revisit Queue fast-path; `#source-claim/*` provenance tags; chronological ingestion as happy path; 4th Sweeper direction for stub-resolution.
- **Schema refinements from book-chapter validation (Ehlers Ch 3 + Katz TOC) — ~14 additional design decisions in tracker.md:** 4th source type `academic_paper`; `chapter_references:` for intra-book links; `intra_book_series:` for paired chapters; chapter-end `summary_bullets_extracted:` convention; Tom-Swifty filter; parameter `optimizable` / `author_robustness_note` metadata; `#source-claim/anti-overfit-argument` + `#source-discrepancy` tags; platform-code storage convention source-agnostic (author OR vendor); shared-component pattern across chapters; named test-universes for books; multi-strategy-per-chapter as norm; book-as-article-series-consolidation; external-reference-seeds for `findings/meta/`; **Katz's Parts II/III structure independently validates our 8-category decomposition**.
- **Docling validated** as primary extraction tool (2020-01 8-day article: good prose/numbers/structure, minor post-processing for small-caps + running-headers + image-mode config).

**Open:** schema is explicitly expected to evolve with real ingestion experience.

---

## Topic 3 — Populated / tested strategy record  🟢

**Closed for initial use.** Major style shift to Obsidian-native: thin frontmatter + inline hierarchical tags + prose.

**Key decisions:**
- **Rejected** the heavy nested-YAML schema in favor of Obsidian properties + tags
- Minimum frontmatter: `id`, `status`, `ingested_at`, `last_swept_at`, `promotion_tier`, `source`, `strategy_family`, `hold_duration`, `primary_asset`, headline metrics, 4-way asset lists, `tags:`
- **5 headline metrics** for the `primary_asset`: CAGR, MDD, Calmar (CAGR/\|MDD\|), Ulcer, Sharpe. Per-asset breakdowns stay in prose tables
- **4-way asset classification:** `works_on` / `marginal_on` / `fails_on` / `untested_on` (all queryable)
- Components section is now a **wikilink composition manifest** pointing to Component Library entries (see cross-cutting decisions below)
- **Inline tags live next to the claim they describe** — Sweeper matches paragraph-local tag sets, not whole-file bags
- Charts mandatory on every run; sweeps produce combined/overlay charts by default (small-multiples fallback)
- `unresolved_weaknesses:` is derived from `observed_weaknesses[status==unresolved]` — single source of truth

**Open:** schema is explicitly expected to evolve. Metrics sidecar YAML remains as escape hatch if/when cross-strategy numeric aggregation becomes needed.

---

## Topic 4 — Finding / indicator record  🟢

**Closed for initial use.** Parallel schema to strategies so the Sweeper treats them symmetrically.

**Key decisions:**
- Same Obsidian-native style as strategies (thin frontmatter + tags + prose)
- Frontmatter: `id`, `status` (active/superseded/contradicted/retired), `category` (regimes/indicators/asset-classes/cross-cutting/meta), `promoted_at`, `last_matched_against_strategies`, `confidence`, `direction`, `walk_forward_validated`, `years_positive` (string `"N/K"`), `source_bundles`, `tags`
- **Three-way `direction`** (positive/negative/neutral-informative) retained — neutral observations like "Trade 1 carries 70% of return" are load-bearing
- Tag vocabulary starter: `#regime/*`, `#asset/*`, `#asset-class/*`, `#indicator/*`, `#mechanism/*`, `#weakness/*`, `#strength/*`, `#era/*`, `#cross-cutting`, `#trade-number/*`, `#session-time/*`
- Tag taxonomy documented in `AlgoTrader/Knowledge/_conventions.md`, curated by Documenter

**Open:** vocabulary is explicitly expected to expand; tag hierarchy grows as work happens.

---

## Topic 5 — Regime classifier registry  🟢

**Closed for initial use.** Reframed from "fixed 5-axis regime schema" to pluggable classifier registry.

**Key decisions:**
- Regime classification is a **pluggable registry of named classifiers**, each implementing `label(bars) → Series[str]`
- **Five initial classifiers** in Phase 4:
  - `vix-tier` — universal, percentile-based on trailing-10y VIX, asymmetric 7-bucket tail (top 1% / 1-5% / 5-10% / 10-25% / 25-50% / 50-75% / bottom 25%)
  - `gap-size` — per-asset, percentile-calibrated on each asset's trailing-252d gap distribution (5 buckets)
  - `price-range` — per-asset Donchian (within / breakout-up / breakout-down)
  - `trend-basic` — 200DMA × 50DMA-slope 4-way (named `-basic` so sophisticated successors can coexist)
  - `sqn-market-type` — Van Tharp 6-way (bull/bear/sideways × quiet/volatile), universal, indexed off SPY
- **Stability-by-contract:** classifier label names are immutable. Evolution = new versioned classifier, never mutation
- **Tag namespace:** `#regime/<classifier>/<label>` (classifier-qualified, not bare)
- **Classifier-informativeness scoring** per strategy as a Phase 4 deliverable — tells the Regime Analyst which lens to look through
- Regime Analyst has standing mandate to **propose new classifiers** as first-class research output; "classifier X better discriminates strategy Y than Z" is KB-worthy meta-finding

**Deferred:** `breadth`, `rate-regime`, `regime-of-regimes` (HMM/clustering), `credit-regime`, `seasonality-*`, sophisticated trend variants. Added on-demand when a strategy needs them.

**Open:** threshold tuning for each classifier happens during Phase 4 implementation with real histograms; starter bucket structures documented here will likely refine.

---

## Topic 6 — First-bundle composition  🟡

**Narrowed and informed by Topic 9 (Operating model).** The system has multiple onboarding paths now defined — backlog dip from bulk ingestion, daily catch arrival, Workflow-D composition. The remaining question is just the *bundle shape* itself, which is the same regardless of trigger.

**Working draft (to confirm):** ~8-12 runs per first bundle —
- 1 sanity check (catches ingestion bugs)
- 3 baseline runs (QQQ + 2 same-class leveraged variants on author's stated "best" config)
- regime attribution across all 5 classifiers (computed from baseline data, no separate runs)
- 2-4 robustness probes (data-window jitter, hyperparameter jitter)
- 1 walk-forward (early failure here = no point in subsequent bundles)

**Verdict:** F0 *never* PROMOTEs — insufficient cross-year evidence. Always one of: INVESTIGATE FURTHER (promising — hand off to F1 with named weakness), PARK (survives but no clear next move; record `unresolved_weaknesses:`), or RETURN TO INGESTION (mechanism didn't reproduce).

**Open sub-questions:**
- QQQ-only (5 runs) vs QQQ + 2 leveraged variants (8 runs)?
- Walk-forward in F0 vs deferred to F1?
- Does Researcher (who ingested) own the RETURN TO INGESTION verdict, or Skeptic?

---

## Topic 7 — Strategy state machine  🔴

**Now informed by Topic 9.** Adds at minimum a `triaged` state ahead of testing, and re-ranking transitions on backlog and parked items.

States drafted (`untested → triaged → first_bundle_running → investigating → parked | promoted | retired`) but transitions, preconditions, and reverse-transitions undefined.

**Questions to resolve:**
- Preconditions per transition (e.g. `parked` requires `unresolved_weaknesses:`; `promoted` requires all 18 rubric gates)
- Reverse transitions (`parked → investigating` from Sweeper revisit; `promoted → investigating` if production divergence found)
- Transition authority per state (Strategy Author? Skeptic verdict? Documenter?)
- Sweeper interaction (re-ranks backlog items; revisits parked items; skips retired)

---

## Topic 8 — Nightly wall-clock  🔴

**Now informed by Topic 9.** Allocation policy across the four input sources (backlog/catch/iteration/creativity) is the steady-state shape; pilot stages have their own wall-clock variant.

**Questions to resolve:**
- Cycle start time (probably 2 AM ET post-data-settle, but Jeff's morning review window matters — digest must land before he wakes)
- Intra-cycle sequence (Sweeper first → Daily Catch ingestion → triage update → run allocation → Workflow C/D execution → Documenter digest)
- Allocation enforcement point (per-bundle? Per-agent-handoff?)
- Weekly Sweeper schedule (Sunday evening so Monday starts fresh)
- Per-stage cadence during the additive concept pilot (each stage's wall-clock differs from steady-state)
- Overrun behavior (carry forward or drop?)

---

## Topic 9 — Operating model  🟢

**Closed for initial use.** The system's daily operating shape — workflows, backlog, triage, pilot strategy, allocation policy. See [tracker.md](tracker.md) "Operating model" section for full detail.

**Key decisions (~13 entries in tracker.md "Operating-model decisions" table):**

- **Four workflows + daily connector:** A ingestion / B component evaluation / C strategy iteration / D creativity / E daily flow connector. Component-first, not strategy-first.
- **Unified ranked backlog (cross-corpus).** Every ingested strategy enters one ranked queue. Source-type-aware scoring + per-item factors. Items persist indefinitely; only `retired` items leave.
- **Triage is structured-reason-driven** with Obsidian-native storage (frontmatter cursors + inline `#triage-blocker/*` and `#triage-credit/*` tags + prose). Same mechanism as `unresolved_weaknesses:`. Sweeper matches blocker tags against newly-resolved capabilities to trigger re-ranking.
- **Triage criteria evolve.** Owned by Documenter at `_triage-criteria.md`. Periodic re-triage sweeps re-evaluate older items. Don't over-engineer initial criteria — early ranking is necessarily rough.
- **Daily Catch artifact** at `AlgoTrader/Daily Catches/YYYY-MM-DD.md`. Researcher's nightly journal of arrivals, compositions, and triage decisions.
- **Pilot-then-bulk for any new source-type.** Recurring convention. Concept pilot (one-time, broad) vs source-type pilot (recurring, narrow) are different scopes.
- **Concept pilot is staged additively** on S&C: 6→12→24→48→96 months cumulative. Each stage = ingest + re-triage + test top + capture findings + update criteria + decide next stage. Smooth transition into steady-state at the end.
- **No "Mode 1 / Mode 2" boundary.** Single daily flow with four input sources whose budget allocation evolves with corpus maturity (table in tracker.md).
- **Workflow D (creativity) is first-class and budgeted**, not just reactive. Allocation grows as library matures.

**Why it's compounding:** three reinforcing loops — Backlog→KB→re-ranking, Components→Strategies→component evidence, Daily Catch→Library+Backlog→Sweeper revisits.

---

## Topic 7 — Strategy state machine  🔴

**Not yet addressed.** The lifecycle states are drafted (`untested / investigating / parked / promoted / retired`) but transitions, preconditions, and reverse-transitions are undefined.

**Questions to resolve:**
- Preconditions for each transition (e.g. `investigating → parked` requires `unresolved_weaknesses:` record; `parked → promoted` requires passing all gates in rubric)
- Reverse transitions: `parked → investigating` (Revisit Queue triggered); `promoted → investigating` if production divergence found; `retired → ...` probably one-way
- Who has transition authority per state (Strategy Author? Skeptic verdict? Documenter?)
- How does the Sweeper interact with states (only `parked` strategies are forward-matched; `investigating` strategies are reverse-matched at ingestion; `retired` strategies are skipped entirely)

---

## Topic 8 — Nightly wall-clock  🔴

**Not yet addressed.** Timing choreography for the swarm.

**Questions to resolve:**
- When does the nightly cycle start? (Probably 2 AM ET after market close + data settling, but Jeff's schedule matters — digest should land before his morning review)
- What's the intra-cycle sequence? (Sweeper maybe first; Regime Analyst weakness map; Researcher/Regime Analyst candidate selection; Strategy Author variant generation; backtest runs; Skeptic verdict; Documenter digest)
- Cost ceiling enforcement point (check at each agent handoff? At bundle boundaries?)
- Weekly Sweeper schedule (Sunday evening so Monday starts fresh)
- What happens if the cycle overruns its window (carry forward or drop work?)

---

## Cross-cutting design decisions

These decisions cut across multiple topics and are the backbone of the system:

### Agent roster — 6 agents in 3 lanes  🟢
- **Research lane:** Researcher, Regime Analyst, Skeptic
- **Authoring lane:** Strategy Author, Documenter
- **Platform lane:** AlgoTrader Engineer
- **Single-writer discipline:** each artifact has exactly one owning agent; others read. Prevents swarm merge conflicts.

### Component Library — the major KB restructure  🟢
Strategies decompose into reusable components along **nine categories** (one primitives layer + eight usage-role categories):
- **Primitives:** `indicators` (RSI, ATR, LeavittConvSlope, MAMA — consumed by the 8 below)
- **Usage-role:** `entries`, `exits`, `stops`, `take-profits`, `position-sizing`, `equity-curve`, `entry-timing`, `regime-filters`
- KB gains `components/{7 subfolders}/` alongside existing `findings/`
- Components have their own track records, accumulated across every strategy they appear in
- Strategy files reference components via wikilinks, not free-form text
- Component identity is stable-by-contract (evolution = new versioned component)
- AlgoTrader Engineer mirrors the 9 categories in `trade/components/` Python code (indicators subpackage + 8 usage-role subpackages)
- Platform-specific code snippets (from S&C Traders' Tips) stored under `components/{category}/{slug}/implementations/{platform}.ext` for cross-platform verification and C# production-migration templates
- Phase 6 bootstraps the library by decomposing ORB (seed with ~10+ real-evidence entries on day one)
- Explicit rationale: counters the field-wide **entry-signal bias**, where exits/stops/TPs/sizing/timing/regime-gating are under-researched relative to the entry signal

### Investigation-bundle cycle (not single-run nightly)  🟢
- A strategy develops through multi-run **investigation bundles** (typically 8–20 linked runs)
- Bundle types chosen to match the hypothesis, not a fixed recipe
- Run-type taxonomy is illustrative and growing (Universal / Entry-side / Exit-stop-TP / Sizing-portfolio / Robustness)
- Hypothesis stated *before* bundle runs (retrofitted narratives are a classic overfit pattern)
- Skeptic reviews the full bundle (not individual runs) before verdict

### Three-level lessons loop  🟢
- Level 1: per-run `## Lessons` section (strategy-local + candidate-cross-cutting)
- Level 2: end-of-bundle escalation review (Documenter promotes/holds/localizes each candidate)
- Level 3: end-of-strategy retrospective (highest-quality KB inputs)

### Time-phased Sweeper (proactive KB)  🟢
- Everything carries cursors: `ingested_at`, `promoted_at`, `last_swept_at`, `last_matched_against_strategies`
- **Four sweep directions**, running weekly off-hours (owned by Documenter as a scheduled task, not a separate chat agent):
  - **Forward** — new findings → parked strategies' unresolved weaknesses → Revisit Queue
  - **Reverse** — newly-ingested strategies → existing KB → annotate candidate with relevant findings at ingestion
  - **Cross-finding** — new findings → `_pending.md` items (corroboration / contradiction)
  - **Stub-resolution** — newly-ingested parent source → orphaned children with `implementation_of:` pointing at it. Upgrades stub placeholders and re-runs reverse sweep on the children. Required for out-of-order ingestion (cross-issue Traders' Tips, backfills, web articles citing later work).
- Sweeper writes proposals to `_sweep-staging.md`; Documenter reviews before any artifact update
- On-demand trigger (`@Documenter sweep`) available

### Tiered cross-asset-class validation  🟢
- **Experimental** tier: works on ≥1 asset with plausible mechanism
- **Validated** tier: ≥2 assets in different tiers, OR ≥3 same-tier with documented thresholds
- **Cross-asset-class robust** tier: works on ≥2 distinct asset classes (tier 2 diversity)
- Promotion tier recorded per KB finding; Tier-3 findings transfer across strategies

### Anti-overfit rubric (Skeptic enforcement)  🟢
12 items: single-variable testing · no grid search · `.shift(1)` hygiene · cross-asset validation · "pick one good filter" · external-claim verification · out-of-sample holdout · economic rationale · cross-year robustness (≥7/10 years) · walk-forward survival · regime-targeting justification · pre-promotion production-path divergence check (for strategies with shorts)

---

## Phase 1 blockers (all resolved ✅)

1. **AlgoTrader vault path** ✅ — Fresh vault at `~/Documents/Obsidian/Main/AlgoTrader/`. Existing ORB work in `~/Projects/AlgoTrader/obsidian_vault/` migrates *after* end-to-end workflow is confirmed.
2. **Skeptic stance** ✅ — *Heavier* than default. Methodology auditor first, results judge second. Default stance: "assume curve-fit until proven otherwise." Rubric expanded from 12 to 18 items with explicit red-flag-pattern table (corner-case patching, outlier selection from sweeps, filter escalation, retrodictive mechanism, etc.).
3. **Nightly cost budget** ✅ — Max 25 runs/night (adjustable). Run-count ceiling simpler than dollar-based.
4. **New Telegram group + chat ID** ✅ — Group created: "Madison AlgoTrader" (`tg:-5211322204`), bot routing confirmed, CLAUDE.md loaded, end-to-end test passed.
5. **Cross-year threshold** ✅ — ≥11/15 years positive preferred; ≥7/10 fallback for instruments with <15y clean history (most leveraged ETFs launched 2010). First test asset: QQQ (longest clean history).

Additional resolutions in the same round:
- **Mechanism-scoped cross-asset validation** requires pre-declared mechanism + failure-side evidence on theoretically-different assets.
- **Era-decay claims** require a named causal factor (retail-options boom, Reg NMS, HFT dominance, etc.); without one, decay is presumed statistical.
- **Deferred `trader-composition-era` classifier** added to the regime registry backlog.
- **a-mem MCP installed (per-group, isolated)** — supersedes earlier deferral. Baked into container; `/workspace/extra/a-mem/` ChromaDB per group. Used for dedup, fuzzy cross-folder recall, and ephemeral observations alongside Obsidian (which remains the curated source of truth).

## Phase 1 infrastructure — complete ✅

- Group registered in SQLite (`tg:-5211322204` / "Madison AlgoTrader" / folder `telegram_trading`, `isMain: true`, `requiresTrigger: false`)
- Mount allowlist at `~/.config/nanoclaw/mount-allowlist.json` has 4 entries: NanoClaw RW, AlgoTrader RW, Trading RW, lode RO
- Per-group mounts configured: algotrader RW, trading RW, lode RO
- Agent name corrected globally: Madison (not Mason — prior memory was wrong; all group CLAUDE.md + lode + `.env` + SQL triggers now consistent)
- Obsidian vault scaffolded with 20+ subdirectories for the Component Library + Findings KB + sources + Charts + Regime Reports + Backtests
- Trading-group CLAUDE.md written with Madison persona, plan pointers (to `/workspace/extra/lode/`), mount table, mounted-vs-unmounted list, deferred tool list (no a-mem)
- End-to-end validated: Madison connects to group, reads plan files from lode mount, summarizes topics accurately, writes test file to Trading vault successfully
- Bot pool ready: `@MadisonLumenBot` (main) + `@MadisonSwarm1/2/3Bot` (for Phase 7 swarm — partly pre-built)

---

## What's been updated where (reference)

| Artifact | Contains |
|---|---|
| [tracker.md](tracker.md) | **Operating model** (workflows, backlog, triage, pilot strategy, allocation policy), 8 phases, agent roster with responsibilities, decisions table (~70+ entries), research methodology, run-type taxonomy |
| [findings.md](findings.md) | Regime classifier registry, component library design, KB schemas, ownership matrix, anti-overfit rubric, asset-class taxonomy |
| [progress.md](progress.md) | Chronological log of refinement rounds, reboot check |
| **This file** | **Current status by topic; use as the map** |

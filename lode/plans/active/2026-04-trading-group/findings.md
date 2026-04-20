# Findings — Trading-Research Telegram Group

## Existing context (verified 2026-04-18)

### AlgoTrader framework
- Lives at `~/Projects/AlgoTrader/`. Python, `uv`-managed, `>=3.12,<3.15`.
- Three-layer architecture (enforced one-way imports): `analysis/ → strategies/ → trade/`.
- Active research: Opening Range Breakout on 15-min QQQ and SOXL. `opening_range_breakout_strategy.py` is the live strategy; others are historical.
- Run reports follow a strict naming convention: `obsidian_vault/Strategies/<strategy>/Runs/{symbol}/YYYY-MM-DD NNN <label>.md`. Symbol subfolders lowercase ticker or `_cross-asset` / `_general`.
- `RunDir` helper in `analysis/reporting/naming.py` computes paths + wikilink depths.
- **Strong anti-overfit practices already encoded** in `~/Projects/AlgoTrader/lode/practices.md`. Nanoclaw's skeptic agent should adopt these verbatim.
- Pre-commit hooks: ruff + mypy on commit, pytest on push.

### Obsidian vault (Jeff's main synced vault)
- Root: `~/Documents/Obsidian/Main/`.
- `AlgoTrader/` already exists with subfolders: `Intraday Momentum/`, `Stocks and Commodities/` (WIP issues 2023-01 through 2023-07 partial), `Walkforwards/`, plus several loose notes on slippage, VIX, margin, regime change.
- `Trading Journal/` is Jeff's personal journal — **do not write there from automation**.
- `NanoClaw/` folder exists in the vault — potentially for status notes from Madison.

### NanoClaw current state (from memory + repo inspection)
- Telegram + Gmail + Protonmail IMAP channels registered.
- Single group so far: `groups/telegram_main/`.
- OneCLI credential proxy on port 3002.
- Agent persona is "Madison".
- Persistent data at `~/containers/data/NanoClaw/` (BTRFS subvolume, snapshotted); container downloads at `/workspace/downloads`.

## Asset-class taxonomy (Phase 4 / Phase 5)

Cross-asset validation must distinguish "multiple tickers, same underlying" from "multiple asset classes". A strategy that works on QQQ + TQQQ + SOXL is one underlying (NDX leveraged variants) — that's not cross-asset, it's cross-leverage. True cross-asset robustness requires testing across structurally different classes.

### Starting class taxonomy

Tier 1 (currently supported by AlgoTrader's data loader):
- **Equity indices** (QQQ, SPY, IWM, DIA) — liquid, well-behaved, long history
- **Leveraged equity ETFs** (SOXL, TQQQ, SPXL, UPRO) — path-dependent decay, higher vol
- **Individual equities** — not currently a focus but data exists

Tier 2 (require AlgoTrader Engineer work to add data loading + indicator adjustments):
- **Commodities** (GLD, SLV, USO, DBA) or underlying futures — different seasonality, supply/demand
- **Bonds / fixed income** (TLT, IEF, HYG) — rate-regime driven
- **Currencies / FX** — 24-hour, different session structure
- **Crypto** (BTC, ETH) — 24/7, extreme vol
- **Sector ETFs** (XLK, XLE, XLF, XLU) — inter-sector rotation effects
- **International equities** (EFA, EEM) — overnight gap behavior, different timezones

### Cross-asset gate (strengthened)

The original "≥2 assets" gate is too weak. Refined gates by promotion tier:

| Tier | Requirement | Rationale |
|------|-------------|-----------|
| **Experimental** | Works on ≥1 asset with plausible mechanism | Fine to proceed to further testing |
| **Validated** | Works on ≥2 assets in **different tiers** OR ≥3 assets in same tier with documented asset-specific thresholds | True cross-asset signal |
| **Cross-asset-class robust** | Works on ≥2 **distinct asset classes** (tier 2 diversity) | Strongest promotion; mechanism is general, not tech-beta-specific |

A promoted strategy's KB entry records which tier it achieved. A tier-3 finding is much more transferable than a tier-1 one.

### Asset-class dimension in the cycle

Within an investigation bundle, cross-asset-class validation is a dedicated run type. It runs after the single-asset candidate passes its initial gates, not in parallel. Failures at this stage are *informative* — a Tier-1 strategy that collapses on commodities tells us the mechanism is equity-specific, which is a valid finding to record.

### AlgoTrader Engineer implications

Adding Tier 2 asset classes is non-trivial framework work:
- **Data loader extensions** for futures tick data (roll logic), FX (quote/base handling, 24h sessions), crypto (24/7 + different exchange handling)
- **Session definitions** — what's "opening range" for a 24h market? Needs per-class session-open definitions.
- **Volatility normalization** — ATR-based thresholds don't transfer across classes without normalization; Engineer implements per-class vol adjustment primitives.
- **Regime labelers per class** — some regimes (VIX-based) don't apply outside equities; others (rate regime) matter more for bonds.

These are Phase 5/6 AlgoTrader Engineer tasks, filed as in-chat feature requests by the Research lane when a strategy becomes a candidate for tier-2 validation.

## Source type taxonomy (ingestion)

Strategies enter the system from three distinct source types. Each has its own provenance shape but all produce the same downstream cold-start record.

### magazine
```yaml
source:
  type: magazine
  publication: sc | sfo | traders | traders-world | expiring-monthly | bloomberg-markets
  issue: 2018-06           # YYYY-MM for month-based pubs; issue number for others
  article_title: "Trading Volatility Contraction Patterns"
  author: "Mark Minervini"
  page: 34
  page_continued: [61, 62]        # continuation pages — S&C frequently splits articles after ad breaks
  column: "Trading Strategies"    # recurring-series marker (useful for author-body-of-work queries)
  section: null                   # e.g. "Traders' Tips" for child records
  implementation_of: null         # for Traders' Tips: pointer to parent source-id (may be cross-issue)
  vendor: null                    # for Traders' Tips child records (wealth-lab, tradestation, esignal, ...)
  implementer: null               # person who authored the vendor-specific implementation
  language: null                  # easylanguage | thinkscript | c-sharp | efs | metastock | ...
  code_file: null                 # path to extracted platform-specific code snippet
  series:                         # for multi-part article series
    name: "Laws Of Momentum"
    part: 1
    of: null                      # total parts if stated; null if open-ended
  related_sources:                # cross-citations (same-author prior work, cited papers, etc.)
    - "sc-2012-04-engulfing-pattern"
  raw_extract: "AlgoTrader/Sources/magazine/sc-2018-06/minervini-vcp.md"
  pdf_source: "/home/jeff/Mounts/Data/Calibre/Library-01/TASC/2018/Technical Analysis of Stocks and Commodities 2018-06-Jun.pdf"
```

Magazine-specific fields validated against 2020-01 and 2015-07 S&C issues:
- `page_continued:` — S&C articles routinely split across ad-breaks (2020-01 Calhoun: p.7 → p.61)
- `column:` — recurring-series markers ("Trading on Momentum", "Trading Strategies", "At The Close") make author-body-of-work queries trivial
- `section:` — section-level hierarchy (e.g. "Traders' Tips" children)
- `implementation_of:` — Traders' Tips vendor entries point to a parent article, which may be same-issue (2015-07) or cross-issue (2020-01 → 2019-10)
- `vendor` / `implementer` / `language` / `code_file:` — populated only for Traders' Tips child records
- `series:` — multi-part article series (e.g. Vandycke's "Laws Of Momentum" in 2015-07 was explicitly part 1 of a series)
- `related_sources:` — cross-citation graph; populated from author's footnotes ("Further Reading" sections) and our own observed overlaps

S&C PDFs live at `/home/jeff/Mounts/Data/Calibre/Library-01/TASC/{YYYY}/` (NAS mount, separate from main Calibre library). Naming: `Technical Analysis of Stocks and Commodities YYYY-MM-Mon.pdf`. Covers 2010-2020 (~132 issues). Other magazines (SFO, Traders, etc.) live under the main Calibre library at `/home/jeff/containers/data/calibre/library/Unknown/`.

- Articles are typically **1 strategy each**
- S&C's "Traders' Tips" section is special: multiple software vendors implement the same idea differently; each implementation is its own sibling record that links to a parent article
- Performance claims usually modest or absent — magazines don't have space for full backtest tables

### book
```yaml
source:
  type: book
  title: "Cybernetic Analysis for Stocks and Futures"
  subtitle: "Cutting-Edge DSP Technology to Improve Your Trading"
  author: "John F. Ehlers"
  edition: "1st"
  isbn: "0471463078"
  publisher: "John Wiley & Sons"
  year: 2004
  chapter_number: 3
  chapter_title: "Trading the Trend"
  book_pages: [21, 32]              # book's own page numbering
  pdf_pages: [30, 41]               # PDF page numbers (often offset by front matter)
  chapter_references: [2, 15]       # intra-book chapter cross-references
  intra_book_series:                # some books pair chapters (e.g. Ehlers Ch 3+4)
    name: "Trend/Cycle strategy pair"
    part: 1
    of: 2
  summary_bullets_extracted: true   # author-provided "Key Points To Remember" / "What Have We Learned?" captured
  raw_extract: "AlgoTrader/Sources/book/ehlers-cybernetic/ch03-trading-the-trend.md"
  calibre_id: 14                    # round-trip back to Calibre library
  calibre_path: "/home/jeff/containers/data/calibre/library/John F. Ehlers/..."
```

- **Chapter is typically the unit** of decomposition; some chapters contain multiple strategies
- **Multi-strategy-per-chapter is common** — Katz's Chapter 5 "Breakout Models" has 4-6 breakout variants sharing components and differing on one dimension. Chapters are essentially parameter-sweep-plus-narrative at book scale.
- **Intra-book cross-references** (`chapter_references:`) distinct from cross-publication `related_sources:`. Ehlers Ch 3 references Ch 2's math + Ch 15's evaluation methodology.
- **Intra-book series** (`intra_book_series:`) for paired chapters (Ehlers' Ch 3 Trend + Ch 4 Cycle).
- **Chapter-end summary sections** ("Key Points To Remember" — Ehlers; "What Have We Learned?" — Katz) are author-provided TLDRs. Extract to a prominent summary section in the prose body.
- **Tom-Swifty chapter-openers** (Ehlers' convention — a pun at each chapter start) are non-content flavor text. Filter at ingestion.
- **Shared components across chapters** — Katz's "Standard Exit Strategy" defined in one chapter and referenced across many entry chapters. Maps cleanly to our wikilink composition model.
- **Standardized test portfolios** — when an author uses the same test universe across many strategies (Katz's "Basic Test Portfolio and Platform"), record it once as a named universe at `AlgoTrader/Sources/book/{slug}/_test-universe.md` and reference by name from each strategy record.
- Authors' claimed backtest results are **explicitly marked as cherry-picked** (survivorship bias: authors don't publish failed books). Skeptic treats author claims with extra skepticism proportional to how much selling the author is doing
- Books often introduce a **new component family** (Ehlers' DSP indicators, Kaufman's adaptive systems) — the Researcher promotes these as library entries even if the individual strategy isn't promoted
- Multiple strategy ingests from the same book link back to a shared book-level record at `AlgoTrader/Sources/book/{slug}/_book.md`
- **Book-as-continuation-of-article-series** — Katz's book explicitly consolidates his 1996+ S&C articles. `related_sources:` builds a bidirectional graph across source types; book points back to article series, articles point forward to the consolidating book.
- **Platform-code in-book** (not just Traders' Tips) — Ehlers includes EasyLanguage + EFS implementations directly in chapters. Stored under `components/{category}/{slug}/implementations/{platform}.ext` using the same convention as vendor-provided snippets.
- **Implementation discrepancies** within a single source (Ehlers' EL used `alpha=0.07` while EFS used `alpha=0.05` — almost certainly a typo but worth flagging). Tag `#source-discrepancy` when multi-platform implementations disagree on constants.

### academic_paper
```yaml
source:
  type: academic_paper
  title: "An Effective Intraday Momentum Strategy for SPY"
  authors: ["Carlo Zarattini", "Andrew Aziz", "Andrea Barbon"]
  published_at: 2023-05
  journal: null                 # or a journal name if peer-reviewed
  doi: null
  arxiv_id: null
  ssrn_id: null
  peer_reviewed: false          # many whitepapers are not
  raw_extract: "AlgoTrader/Sources/academic_paper/zarattini-intraday-momentum/paper.md"
  pdf_local: "AlgoTrader/Sources/academic_paper/zarattini-intraday-momentum/paper.pdf"  # downloaded original, lives alongside extract in vault
  calibre_id: 145               # when also in Calibre; mutually exclusive with pdf_local for a given paper
```

Academic papers have a distinct shape from books (single document, no chapters; published in journals/arxiv/ssrn rather than having an ISBN) and from web articles (peer-review/citation shape rather than blog-post shape). Many sit in Calibre alongside books but the source-type split prevents conflating them.

- **Downloaded PDFs live alongside their extract** in the source-slug folder (e.g. `paper.pdf` next to `paper.md`). This keeps one source = one self-contained folder. The `pdf_local:` frontmatter field makes the original discoverable from metadata.
- **Mutually exclusive with `calibre_id:`** — use one or the other, not both. Calibre is for bulk-managed libraries; `pdf_local:` is for ad-hoc internet downloads that don't warrant Calibre ingestion.

### web_article
```yaml
source:
  type: web_article
  url: "https://alphaarchitect.com/..."
  title: "Momentum Rotation Across Sectors"
  author: "Wesley Gray"
  published_at: 2021-03-15
  accessed_at: 2026-05-02
  domain: alphaarchitect.com
  raw_extract: "AlgoTrader/Sources/web/alphaarchitect-com/momentum-rotation.md"
  archived_copy: "AlgoTrader/Sources/web/alphaarchitect-com/momentum-rotation.archive.html"
  pdf_local: null               # set when the source is a web-hosted PDF rather than HTML (e.g. many white papers)
```

- Quality ranges wildly from peer-review-rigor (SSRN preprints, Alpha Architect) to social-media hot takes
- **Archived copy saved at ingestion** — web sources rot; without a local snapshot, provenance is lost when the URL breaks
- Web scraping obeys `robots.txt` and rate-limit conventions; the Researcher avoids sources with unclear licensing

### Shared ingestion conventions (all source types)

- `ingested_at`, `ingested_by`, `status: untested`, `last_swept_at: null` on every cold-start record
- `record_type:` on every record: `strategy | technique | analysis | interview | review | column | letters`. Routes downstream workflow — strategies go through bundles; techniques contribute only to the component library; analyses/interviews enrich context but don't enter the cycle.
- **Ingestion produces a multi-artifact output** — per source article, we may emit 0-N strategies + 0-N usage-component additions + 0-N indicator additions + 0-N platform-implementation snippets + 0-N findings. The article→strategy mapping is NOT 1:1.
- **Chronological ingestion is the happy path** — process issues oldest first so Traders' Tips cross-issue parents are already in the KB when children arrive. Stub-placeholder mechanism (see Sweeper's 4th direction) handles unavoidable out-of-order cases.
- Raw extracts live under `AlgoTrader/Sources/{type}/{source-slug}/`
- **Internet-downloaded PDFs live alongside their extract** in the same source-slug folder: `AlgoTrader/Sources/{type}/{slug}/paper.pdf` (or appropriate filename). Record the path in `pdf_local:` frontmatter so the original is discoverable from metadata. One source = one self-contained folder.
- **PDFs already in Calibre stay in Calibre** — use `calibre_id:` / `calibre_path:` (books) or `pdf_source:` (S&C magazines). Never duplicate a Calibre-managed PDF into the vault.
- **Distinguish from `_attachments/`**: `AlgoTrader/_attachments/` is reserved for ad-hoc Telegram file drops (quick user-shared docs). Systematic ingestion output goes under `Sources/`, never `_attachments/`.
- Platform-specific code snippets (from Traders' Tips) live under `components/{category}/{component}/implementations/{platform}.ext`, not in the source-extract directory, because they're reusable assets attached to components
- Author-claimed performance goes in `claimed:` block, **never in headline metrics** — metrics only get populated from observed backtest results
- Author-flagged unresolved weaknesses (where the source explicitly names a gap — e.g. Hellal/Zhang "bull-vs-bear awareness not implemented") are lifted into the strategy's `unresolved_weaknesses:` at ingestion time as ready-made Sweeper Revisit Queue candidates. Free head-start on research planning.
- Skeptic's rubric applies regardless of source; nothing gets promoted without passing all 12 gates
- **Source-claim provenance tags** mark the evidence shape:
  - `#source-claim/cherry-picked-example` — single-chart illustrative examples (Quantacula's "three consecutive winning trades")
  - `#source-claim/negative` — author explicitly says X didn't work (Calhoun's "pattern-based adds didn't beat $2 intervals")
  - `#source-claim/positive-unverified` — author reports positive results, unverified by us
  - `#source-claim/cherry-picked-universe` — author's test universe is curated/small/biased (most S&C articles)
  - `#source-claim/anti-overfit-argument` — author explicitly argues their strategy isn't curve-fit (Ehlers: "ratio of trades to parameters is large"). Meta-claim about the evidence; Skeptic evaluates with extra care since these are rhetorical self-defenses.
  - `#source-discrepancy` — multi-platform implementations of the same indicator/strategy disagree on constants or logic (Ehlers Ch 3: EasyLanguage `alpha=0.07` vs EFS `alpha=0.05`). Flag for reconciliation during extraction bake-off.

## Regime classifier registry (Phase 4)

Regime classification is not a fixed set of axes — it's a **pluggable registry of named classifiers**, each implementing a consistent interface (take bars → produce labeled series). A strategy's performance is attributed across *multiple* classifiers in parallel; findings accumulate observations like "for ORB, vix-tier discriminates; sqn-market-type does not." Identifying which classifier informs which strategy is itself Regime Analyst work.

### Initial classifier registry (Phase 4 delivers all five)

| Classifier | Label space | Scope | Notes |
|---|---|---|---|
| **vix-tier** | `extreme` / `very-high` / `high` / `elevated` / `moderate` / `normal` / `low` | Universal (VIX is market-wide) | Percentile-based on trailing-10y rolling window; asymmetric fine-grained tail (see below). `.shift(1)`-safe. |
| **gap-size** | `large-up` / `small-up` / `flat` / `small-down` / `large-down` | Per-asset | Percentile thresholds calibrated on each asset's own trailing 252d gap distribution. SOXL's "large-up" ≠ SPY's in absolute %. |
| **price-range** | `within` / `breakout-up` / `breakout-down` | Per-asset | Donchian-style: today's price vs. trailing N-day range. Useful for mean-reversion vs. trend-following discrimination. |
| **trend-basic** | `above-200dma-rising` / `above-200dma-falling` / `below-200dma-rising` / `below-200dma-falling` | Per-asset | Named `trend-basic` so sophisticated successors (`trend-hmm`, `trend-kama`) can be added without renaming. |
| **sqn-market-type** | `bull-quiet` / `bull-volatile` / `bear-quiet` / `bear-volatile` / `sideways-quiet` / `sideways-volatile` | Universal (indexed off SPY daily) | Van Tharp's 6-way market-type classification. SQN of ~100d index returns × ATR-based vol axis. Well-known external methodology. |

### Asymmetric-tail VIX tier (fine-grained at extremes)

Tails matter more than the middle for risk decisions (stop trading, flip, reduce size) *and* have less data. Buckets are cumulative-tail cutoffs:

| Percentile | Label |
|---|---|
| Top 1% | `extreme` |
| 1–5% | `very-high` |
| 5–10% | `high` |
| 10–25% | `elevated` |
| 25–50% | `moderate` |
| 50–75% | `normal` |
| Bottom 25% | `low` |

Window: trailing 10-year rolling (long enough to span a few market cycles, short enough that post-2000 and post-2020 vol eras don't permanently distort thresholds). Minimum-sample fallback for the first 10 years of any historical dataset.

### Deferred classifiers

Not pre-built. Added when the Regime Analyst identifies a specific strategy whose performance they'd discriminate:
- `breadth` — % components above 50DMA, A/D line posture
- `rate-regime` — Fed funds level + direction, yield-curve shape
- `regime-of-regimes` — HMM or clustering over primary classifiers to find correlated meta-states
- `credit-regime` — HY vs IG spreads
- `seasonality-month`, `seasonality-dow`, `fomc-proximity` — minimal seasonality; expand on demand
- `trend-hmm`, `trend-kama` — successors to `trend-basic` when warranted

### Stability-by-contract invariant

Classifier label names are **stable-by-contract**. Renaming `vix-tier/high` → `vix-tier/elevated` would orphan hundreds of existing findings. Evolution is **additive only**: new classifiers (never rename), new labels (only if the label space literally grows), or a new versioned classifier (e.g. `vix-tier-v2`) when a label-space change is genuinely unavoidable.

### Tag namespace

Tags take the form `#regime/<classifier>/<label>`:
```
#regime/vix-tier/extreme
#regime/gap-size/large-up
#regime/sqn/bull-volatile
#regime/trend-basic/above-200dma-rising
#regime/price-range/breakout-up
```

A finding or weakness carries tags from every classifier that speaks to it. Sweeper matching is "overlap by classifier AND label" — stricter than unqualified `#regime/high-vol`, which keeps KB lookups precise as the registry grows.

### Emerging finding categories this enables

1. **Meta-findings about classifiers** — "classifier X better discriminates strategy Y's performance than classifier Z." First-class KB entries under `Knowledge/cross-cutting/`, tagged `#meta-finding/classifier`.
2. **Cross-classifier correlation findings** — "when `vix-tier/extreme` AND `sqn/bear-volatile` co-occur, the combined signal predicts mean-reversion failure more than either alone."
3. **Classifier-proposal work** — the Regime Analyst has standing mandate to propose new classifiers. Proposals file a request to the AlgoTrader Engineer; successful classifiers enter the registry permanently.

### Classification principle (preserved)

Each classifier's output is a **small set of named buckets**, not a continuous score. Named buckets keep the KB human-readable and are trivially slicable in AlgoTrader's existing `aggregation/` stage.

## Component Library — strategies as compositions

Strategies decompose into reusable components along eight orthogonal usage-role axes (plus indicators as a primitives layer consumed by all of them). Knowledge accumulates at the **component** level, not just the strategy level, because the same component (e.g. fixed-ATR stop) appears in many strategies and its track record transfers across all of them.

### Why this matters

Most public trading literature fixates on entry signals because "you have to have a way to get in." Exit rules, stop patterns, take-profit logic, position-sizing, entry-timing, and regime-gating all receive far less attention — even though they often carry more of the edge than the entry signal. The component-oriented KB design directly counters this bias: every category is a first-class citizen with its own evidence library, its own curation, and its own research output. Findings compound because "fixed-ATR stop fails on leveraged ETFs" learned in one strategy becomes immediately available to every other strategy considering that stop component.

### The nine component categories

Eight **usage-role** categories + one **primitives** category (indicators). The primitives layer exists because indicators (MAMA, RSI, LeavittConvSlope) are consumed by multiple usage-role components — they deserve their own library home rather than being buried inside whichever usage-role happened to first reference them.

| Category | Examples | Notes |
|---|---|---|
| **indicators** (primitives) | atr, rsi, leavitt-convolution-family, mama-fama, btr, sqn | The raw computational primitives. Consumed by the 8 usage-role categories below. Each indicator file carries its math definition + Python implementation for AlgoTrader + platform-specific implementation snippets (TradeStation EasyLanguage, Wealth-Lab C#, etc.) under an `implementations/` subfolder. |
| **entries** | opening-range-breakout, volatility-contraction, eight-day-continuation-pattern, atr-breakout | The entry signal itself — the thing that fires a position. *Evaluable standalone via bar-by-bar forward-return edge profile vs. random-entry baseline in same asset/regime. A signal whose bar-N edge doesn't beat random entry has no standalone signal.* |
| **exits** | eod-flat, opposite-signal-flip, ma-cross-exit, trailing-indicator, same-day-close | Signal-driven exits (distinct from stops/TPs which are risk-rule exits). *Evaluable standalone via bar-by-bar forward-return edge profile vs. random-exit baseline on entries-in-regime.* |
| **stops** | fixed-atr, fixed-pct-stop, chandelier, volatility-adjusted, breakeven-on-winner-at-midway, no-stop | Risk-rule exits on adverse movement |
| **take-profits** | fixed-r-multiple, fixed-pct-target, trailing-percent, partial-scale-out, tiered-targets, no-tp | Risk-rule exits on favorable movement |
| **position-sizing** | fixed-fraction, vol-scaled, kelly-fraction, regime-conditioned-sizing, scaled-in-incremental-dollar-interval | Per-trade sizing — computes "how much" from market state. Often carries more edge than the entry signal; historically under-researched. |
| **equity-curve** | trade-only-when-equity-above-ma, skip-after-n-losses, sqn-confidence-scaling, equity-drawdown-gate, turtle-trade-off-off-on | *Performance-conditional sizing / gating.* Reads the strategy's **own** recent track record and modifies position size or gates trading accordingly. Distinct from position-sizing (which reads market state) — equity-curve components are self-referential. Strategies compose both orthogonally. |
| **entry-timing** | session-open, pullback-to-ma, breakout-confirmation, next-day-on-bar-break, time-of-day-gate | Orthogonal to entry signal — the same signal can be acted on at different moments |
| **regime-filters** | vix-tier-block-above-high, atr-percent-lt-threshold, btr-regime-cap-flips | Session-level gates that modulate whether entries fire at all |

### KB directory structure (extended)

```
AlgoTrader/Knowledge/
├── components/
│   ├── indicators/              # primitives layer — consumed by the 7 usage-role categories
│   │   └── {indicator-slug}/
│   │       ├── _indicator.md    # math, prose, Python for AlgoTrader
│   │       └── implementations/ # platform-specific code snippets
│   │           ├── tradestation_easylanguage.txt
│   │           ├── wealthlab_csharp.cs
│   │           └── ...
│   ├── entries/
│   ├── exits/
│   ├── stops/
│   ├── take-profits/
│   ├── position-sizing/
│   ├── entry-timing/
│   └── regime-filters/
├── findings/                   # Effect-oriented findings (co-exist with components)
│   ├── regimes/
│   ├── asset-classes/
│   ├── cross-cutting/
│   └── meta/                   # Classifier-informativeness, component-selection meta-findings
└── _conventions.md
```

### Platform-implementations storage convention

Indicator (and, where relevant, usage-role component) files carry platform-specific code snippets under `implementations/{platform}.ext`. Populated primarily from Traders' Tips vendor sections across S&C issues. Two uses:

1. **Cross-platform verification** — multiple vendors' implementations converging on the same math increases our confidence in our Python implementation.
2. **Production-migration reference** — when a strategy using this component moves to the C# live-trading system, existing C# implementations (Wealth-Lab, NinjaScript, Quantacula) serve as templates.

### Component file schema

Same Obsidian-native style as strategies and findings — thin frontmatter + inline hierarchical tags + prose. A component file accumulates its track record across every strategy it's been tried in.

```markdown
---
id: fixed-atr-stop
component_type: stop            # entry | exit | stop | take-profit | position-sizing | entry-timing | regime-filter
status: active                  # active | superseded | deprecated
introduced_at: 2026-05-01
last_updated: 2026-06-14
strategies_tested_in:
  - "[[strategies/opening-range-breakout]]"
  - "[[strategies/vcp-breakout]]"
  - "[[strategies/momentum-rotation]]"
tags:
  - component/stop
  - mechanism/volatility-scaled
---

# Fixed-ATR Stop

## What it does
Exit when price moves N × ATR against the entry. Parameters: ATR lookback
(typical 14), multiplier (1.5–4 common range).

## Where it works
- Breakout on liquid equity indices, 1.5–2.5× range
  #component-context/breakout #asset-class/equity-index #strength/confirmed
- Swing on single-stocks, 2–3× range
  #component-context/swing #strength/confirmed

## Where it doesn't
- Leveraged ETF multi-day holds — leverage-decay causes stop hits on noise
  #asset-class/leveraged-equity-etf #mechanism/leverage-decay #weakness/confirmed

## Parameter patterns observed
(table by regime / asset-class → multiplier ranges that worked)

## Strategies currently using
(wikilinks with current parameter values per strategy)

## Related components
- [[components/stops/chandelier]] — trails with the move
- [[components/stops/no-stop]] — the alternative
```

### Component identity is stable-by-contract

A component's `id` is immutable once created. Evolving the definition means creating a new component (e.g. `fixed-atr-stop-v2`) rather than mutating the existing one. This preserves the evidence trail: findings tagged to v1 don't silently become misattributed to v2's different behavior.

### Strategies as compositions (schema change)

A strategy's `components:` section is no longer free-form — it's a composition manifest of wikilinks-to-library plus parameters. Prose narrates *why* these components in combination; the components themselves are referenced by their library entries.

```markdown
## Components (as of 2026-04-14)
- Entry: [[components/entries/opening-range-breakout]] (OR = first 15-min bar)
- Exit: [[components/exits/eod-flat]] + [[components/exits/opposite-signal-flip]]
- Stop: [[components/stops/no-stop]]
- Take-profit: [[components/take-profits/no-tp]]
- Position sizing: [[components/position-sizing/fixed-fraction]] (100%)
- Entry timing: [[components/entry-timing/session-open]]
- Regime filters (QQQ): [[components/regime-filters/atr-5d-avg-lt-threshold]] (0.04),
                       [[components/regime-filters/block-short-if-gap-filled-in-or]]
- Regime filters (SOXL): above + [[components/regime-filters/vix-prior-close-max]] (43.51),
                                 [[components/regime-filters/prior-day-btr-max]] (0.7),
                                 [[components/regime-filters/btr-regime-cap-flips]] (200, 0.50)
```

Strategy prose no longer re-describes what each component does; it narrates the composition's logic.

### Component-level findings vs. strategy-level findings

Both exist. Component findings live in `components/{category}/{component}.md` (the component's own evidence). Cross-cutting patterns ("volatility-scaled stops consistently beat fixed-% stops on leveraged ETFs") live in `findings/cross-cutting/`. Meta-findings about component selection ("this strategy family needs regime-conditioned sizing") live in `findings/meta/`.

### Decomposition convention

Decompose when the piece is **naturally reusable** across strategies. Keep monolithic when pieces are genuinely coupled (e.g. an entry signal whose trigger condition references its own stop level — splitting would fabricate an interface). The Researcher exercises judgment at ingestion time; Skeptic can push back if a genuinely reusable piece is buried in a monolithic blob.

### Bootstrap (Phase 6)

Component library starts empty. Seed it by decomposing ORB into its components — those become the library's initial entries with evidence from the 30+ ORB runs already in the AlgoTrader vault. Every subsequent strategy ingested either composes from existing components or contributes new ones; the library grows organically.

## Findings Knowledge Base schema

Location: `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/Knowledge/`. Folders: `regimes/`, `indicators/`, `asset-classes/`, `cross-cutting/`. Plus `_pending.md` for held-for-confirmation items and `_conventions.md` for the tag taxonomy.

**Same style as strategy files: Obsidian properties + inline tags + prose.** Not nested YAML schemas.

Finding file frontmatter (the minimum):
```yaml
---
id: atr-threshold-asset-specific
status: active            # active | superseded | contradicted | retired
category: cross-cutting   # regimes | indicators | asset-classes | cross-cutting
promoted_at: 2026-04-12
last_matched_against_strategies: 2026-05-03
confidence: high          # low | moderate | high
walk_forward_validated: true
years_positive: "11/12"   # string preserves the "of" semantics
direction: negative       # positive | negative | neutral-informative
source_bundles:
  - "[[bundles/2026-04-12 atr-filter-comparison]]"
tags:
  - indicator/atr
  - cross-cutting
  - mechanism/volatility-normalization
---
```

Inline tags in the body carry the regime/asset/mechanism specifics that describe each claim, exactly like strategies. A paragraph saying "this fails on leveraged ETFs post-2020" carries `#asset-class/leveraged-equity-etf #era/post-2020` so the Sweeper can match finding-paragraphs to strategy-paragraphs by overlapping tag sets.

Body sections (conventional, not enforced): *Mechanism* (why we think it holds), *Failure modes* (when it stops holding), *Strategies where it applies* (wikilinks — backlinks auto-populate), *Related findings* (wikilinks), *Evidence* (bundle links + key chart thumbnails).

Strategy files carry analogous cursors (see strategy schema above):
- `ingested_at` (when it entered the system — S&C extraction, web scrape, or internal)
- `last_swept_at` (most recent Sweeper pass)
- `source` (provenance trail — `S&C 2019-07` | `web:alphaarchitect.com/...` | `internal`)

**Curation principle:** the Librarian merges new findings into existing entries when the regime/indicator/asset combo already exists. Append-only chronological logs rot. Curated-by-topic files stay useful for years.

## Skeptic's default stance

**Assume every strategy is curve-fit until methodology and evidence prove otherwise.** The Skeptic audits *how the work was done* before evaluating *what the results show*. A strategy with impressive numbers and bad process gets rejected; a strategy with modest numbers and rigorous process gets promoted.

### Core methodology checks (process-first, before results)

Before looking at any performance number, the Skeptic verifies:

1. **Walk-forward was performed.** If not, the backtest is just an in-sample fit. Rubric item #10 is a hard gate.
2. **Out-of-sample holdout exists** and was genuinely blind during development. If the researcher peeked, it's no longer OOS.
3. **Parameter sensitivity has been tested.** Small perturbations (±1 bucket in a sweep) shouldn't destroy the edge. An edge that only works at exactly 0.04 and dies at 0.05 is fragile noise.
4. **Number-of-tries accounting.** If the researcher tested 100 parameter combinations, the best one has a much higher chance of being noise. Researcher must declare search-space size upfront; Skeptic applies a Bonferroni-like penalty to claimed significance.
5. **Mechanism stated *before* testing, not after.** Retrodictive mechanism ("here's why the result happened") is post-hoc narrative, not a mechanism. Pre-declared hypothesis + observed match = real mechanism.
6. **Filter-stacking orthogonality.** If a strategy adds N filters and each handles a specific weak period, that's corner-case patching, not composition. Filters must be *independently justified* and demonstrably orthogonal; stacking that just happens to produce nice aggregate numbers is curve-fit by another name.

### Red-flag patterns the Skeptic names and rejects

These patterns trigger automatic rejection unless specifically justified:

| Red flag | What it looks like | Why it fails |
|---|---|---|
| **Corner-case patching** | "Strategy had trouble in 2018-Q3, so I added this Q3-specific filter" | Filter is curve-fit to the corner case; won't generalize |
| **Outlier selection from sweep** | Sweep shows 20 configs — 19 are flat/negative, 1 is great — and the author picks that 1 | Best-of-N is by definition optimistic; the outlier is probably noise |
| **Filter escalation** | Each iteration adds a new indicator to handle a weak segment | Each indicator is overfitting to its target period; aggregate nice numbers come from cumulative curve-fit |
| **Retrodictive mechanism** | Mechanism stated only after seeing the result | Post-hoc narrative fits anything |
| **Asymmetric investigation depth** | Entry is heavily tuned (30 sweeps), exit is unexamined | The tuned side is almost certainly overfit; discipline should be symmetric |
| **Claimed era-boundedness without a specific causal factor** | "It stopped working in 2020, markets changed" | Markets always change; what specifically changed? (decimalization 2001, Reg NMS 2007, retail-options boom 2020, HFT dominance varies by year) — if you can't name it, the decay is probably statistical, not structural |
| **Headline metric on best-variant-only** | Author reports Sharpe 1.8 (best of 17 tested configs), not the variance across configs | Best-of-N always looks good; the *distribution* of N results is what matters |
| **Long parameter list + short test period** | 10 parameters tested on 3 years of data | Degrees-of-freedom explosion; noise easily beats signal |

### Component-library as curve-fit defense

The 8-category Component Library + wikilink composition actually *helps* the Skeptic distinguish legitimate composition from curve-fit patching:

- **Legitimate composition:** A strategy composes 5 components, each with its own independent track record in the library across multiple unrelated strategies. Composition is novel but pieces are proven.
- **Curve-fit stacking (red flag):** A strategy composes 5 components, each newly introduced by this strategy to patch a specific problem period. Pieces have no independent track record; the "composition" is just corner-case filter pileup.

The Skeptic uses the library's existing evidence base to detect this: if a proposed filter is genuinely useful, we'd expect it to have independent evidence from other strategies. A filter with no independent track record is guilty-until-proven-innocent.

## Anti-overfit rubric (to be enforced by Skeptic)

Lifted from AlgoTrader practices. The Skeptic agent must demand evidence against each item before allowing a strategy to be promoted to "validated":

1. **Single-variable testing** — one parameter change at a time vs. a fixed baseline. Flag any sweep that varies >1 axis simultaneously.
2. **No grid search / no gradient descent on parameters.** Only coarse sweeps with literature-grounded or round-number thresholds allowed.
3. **`.shift(1)` on daily-derived filters** to prevent look-ahead bias.
4. **Mechanism-scoped cross-asset validation** — the mechanism is *pre-declared*, then tested. The Researcher states upfront: "This edge exists because X (mechanism); it should work on assets A, B, C where X applies; it should NOT work on assets D, E where X doesn't apply." The Skeptic then validates that predictions match outcomes. **Post-hoc rationalizations ("it only worked on QQQ because retail day-traders") are rejected** unless the mechanism was declared before the test. The nuances below are *allowed* but require pre-declared justification and fail-case evidence:
   - **Asset-class behaviors differ** (trend-prone vs mean-reverting). If a strategy's mechanism predicts trend-following behavior, failing on a genuinely mean-reverting asset class is correct. But the mechanism must be stated first.
   - **Within-class differences are real** (QQQ vs SPY vs DIA vs IWM). A strategy claiming QQQ-specific retail-microstructure edge must: (a) declare this before testing, (b) test on SPY as a control that should *fail*, (c) show the failure, not just the QQQ success. Without the failure side, the asset-specificity claim is a curve-fit dodge.
   - **Timeframe matters.** Cross-asset validation must be at the *same* timeframe; cross-timeframe comparisons are a separate research axis.
   - **First test on QQQ** (longest clean history in our universe) before broadening.

   **The failure evidence is as important as the success evidence.** A strategy that works on QQQ and SPY and IWM and DIA "proves" nothing — all correlated. A strategy that works on QQQ and fails on SPY *in the predicted pattern* is better evidence.
5. **"Pick one good filter, not two."** Stacked filters must be demonstrably orthogonal, not redundant.
6. **External claims tested on data.** Anything from a blog, paper, or video must be replicated, not trusted.
7. **Out-of-sample holdout.** Strategy must be fit on e.g. 2010-2018 and validated on 2019-present (or equivalent split). No peeking.
8. **Plausible economic rationale** required, not just statistical fit.
9. **Cross-year robustness.** Default threshold: **≥11 of 15 years positive** (~73%) for strategies with 15+ years of history; **≥7 of 10 years positive** (~70%) for shorter-history instruments (many leveraged ETFs like TQQQ, SOXL launched 2010 → limit of ~15 clean years as of 2026). Reject "good in 2020 only" additions — a primary curve-fit signature. **Era-decay claims require specific causal factors, not hand-waves.** "It stopped working in X because automated trading increased" is not sufficient — *what changed in year X specifically*? Retail-options launched 2020 (Robinhood zero-commission 2019); Reg NMS 2007; decimalization 2001. Name the factor, cite evidence it correlates with the observed decay, and only then is the era-bound interpretation credible. Without a specific factor, the decay is presumed statistical (curve-fit drift-detection), and the strategy is rejected. Valid era-decay findings get tagged `#finding/edge-erosion #era/{specific-factor}-{from-to}` and the strategy's lifespan expectation is reduced accordingly.
10. **Walk-forward survival.** Must pass AlgoTrader's `walkforwards.py` with realistic lookback/holdout windows before promotion.
11. **Regime-targeting justification.** A proposed indicator must state which weak regime(s) it targets and cite a KB finding or plausible mechanism. "Throw it at the wall and see" proposals get rejected outright.
12. **Pre-promotion production-path divergence check.** For strategies with short signals: run the strategy once with native shorts and once substituting each short leg for its inverse-ETF long (from `trade/inverse_pairs.py`). Divergence in CAGR / MDD / trade P&L must be understood and documented. The divergence numbers are themselves KB findings. Not required for long-only strategies.
13. **Parameter-sensitivity check.** Every parameter in the strategy must be perturbed ±1 bucket in its sweep grid; the strategy should survive. An edge that collapses at threshold 0.04 but lives at 0.05 is fragile — likely noise. Document the sensitivity profile for each parameter; the Skeptic flags any parameter whose perturbation destroys >30% of the claimed edge.
14. **Search-space accounting.** The Researcher declares upfront how many strategies/variants/parameter combinations were tested before arriving at this candidate. The Skeptic applies a Bonferroni-style haircut to claimed significance: `effective_p = nominal_p × N_tested`. If 100 variants were tested and the best has "p=0.01", the search-adjusted p is 1.0 (noise). No accounting → Skeptic assumes the worst.
15. **Sweep-variance over sweep-best.** Results are reported as the *distribution across sweep variants*, not just the best one. If 17 configs were tested, the headline number includes the spread (median, IQR, best, worst) — not just the best. A tight distribution means robust; a wide distribution with one outlier means the "best" is probably noise.
16. **Filter-stacking orthogonality proof.** When a strategy stacks ≥2 filters, each filter must either (a) have independent evidence in the Component Library from other strategies, OR (b) be demonstrated orthogonal to the existing filters via component-level correlation analysis. Filter stacks without orthogonality proof are presumed corner-case patching.
17. **Methodology-first review order.** The Skeptic reviews process before results. A strategy with poor methodology and great numbers is rejected before anyone looks at the CAGR. A strategy with good methodology and modest numbers gets a closer read.
18. **Failure-side evidence for asset-specific claims.** An asset-specific edge claim ("works on QQQ because retail-microstructure") requires a *failure observation* on a theoretically-different asset as predicted by the mechanism. Cross-correlated success (QQQ + SPY + IWM all work) does not validate asset-specificity; it just shows the edge exists somewhere in the correlated universe.

## Agent ownership matrix (single-writer discipline)

Each artifact has exactly one owning agent. Others read; only the owner writes. This is the core concurrency discipline for the swarm.

| Artifact | Owner | Notes |
|----------|-------|-------|
| `AlgoTrader/Sources/magazine/`, `AlgoTrader/Sources/book/` | Corpus Researcher | Internal-corpus extractions |
| `AlgoTrader/Sources/web/`, `AlgoTrader/Sources/academic_paper/` | Web Researcher | External-origin extractions |
| `AlgoTrader/Web Research/` (continuous discovery notes + quest external-findings + scout notebook) | Web Researcher | Cleaned discovery notes and accumulated web-research expertise |
| `AlgoTrader/Web Research/_scout-notebook.md` | Web Researcher | Web Researcher's own long-term memory of productive/unproductive sources, credible authors, search patterns |
| `AlgoTrader/Web Research/Quests/{date}-{slug}/prompt.md` | Requesting agent | Quest trigger written by whichever agent needs the research |
| `AlgoTrader/Web Research/Quests/{date}-{slug}/internal-findings.md` | Corpus Researcher | Internal corpus response to the quest |
| `AlgoTrader/Web Research/Quests/{date}-{slug}/external-findings.md` | Web Researcher | External/web response to the quest |
| `AlgoTrader/Web Research/Quests/{date}-{slug}/integration.md` | Requesting agent | Disposition + next steps (ingest / park / reject) |
| Backlog triage (ranking + reasons on each `untested` strategy record) | Corpus Researcher | Ranks new ingests; updates existing ranks during re-triage sweeps |
| `AlgoTrader/Strategies/*.md` (canonical strategy definitions) | Strategy Author | One file per strategy |
| `~/Projects/AlgoTrader/scripts/_nanoclaw-generated/` (Python test variants) | Strategy Author | Single-variable test scripts |
| `AlgoTrader/Regime Reports/` (per-strategy × per-asset attribution) | Regime Analyst | |
| Promotion verdict (structured object, not a file per se) | Skeptic | Hard veto authority |
| `AlgoTrader/Backtests/` (run writeups with verdicts) | Documenter | Records Skeptic's verdict + run metadata. Each run report links to its chart(s). |
| `AlgoTrader/Charts/` (flat directory of all chart PNGs) | Strategy Author (generates during run) / Documenter (ensures they exist) | Shared across assets. Kebab-case filenames derived from the run stem. Sweep runs generate combined-view charts by default; small-multiples fallback when >~10 variants. |
| `AlgoTrader/Knowledge/components/` (component library, 9 categories: indicators + 8 usage-role) | Documenter (curation, cross-linking, track record), AlgoTrader Engineer (code implementations under `trade/components/` mirroring the 8 usage-role categories) | Components have stable-by-contract IDs; evolution is new-versioned-component, not mutation. Bootstrap by decomposing ORB in Phase 6. |
| `AlgoTrader/Knowledge/metrics/` (metric catalog for bucketed conditional analysis) | Regime Analyst (proposes, curates catalog entries), AlgoTrader Engineer (implements metric computations), Documenter (page-level curation, cross-links) | Open-ended; each entry carries computation + default bucketing methodology + accumulated findings + "when to apply" guidance. Regime classifier registry is the curated promoted subset. |
| `components/indicators/{slug}/implementations/{platform}.ext` (Traders' Tips vendor code) | Documenter (files from ingestion), Engineer (Python impl for AlgoTrader, cross-verification against platform variants) | Populated primarily from S&C Traders' Tips. Enables cross-platform verification and future C# production-migration templates. |
| `AlgoTrader/Knowledge/findings/` (the effect-oriented Findings KB) | Documenter | Curated, not chronological. Levels 2 & 3 feed here. Coexists with components/. |
| `AlgoTrader/Knowledge/_pending.md` (held-for-confirmation findings) | Documenter | Level-2 items awaiting a second bundle's corroboration |
| `AlgoTrader/Revisit Queue.md` (parked strategies flagged for revisit) | Documenter | Populated from Sweeper staging after Documenter review |
| `AlgoTrader/_sweep-staging.md` (proposed matches pending review) | Documenter (Sweeper writes, Documenter reviews) | Auditability layer between scheduled matcher and artifact updates |
| Time-phase cursors: `ingested_at`, `promoted_at`, `last_swept_at`, `last_matched_against_strategies` | Strategy Author writes strategy-side cursors; Documenter writes finding-side and updates sweep cursors | Enables idempotent catch-up sweeps |
| `unresolved_weaknesses:` in each strategy's canonical file | Strategy Author (writes), Documenter (reads for matching) | Required before a strategy can be parked or promoted |
| Cross-links / backlinks / tag hygiene across `AlgoTrader/` | Documenter | Weekly KB-health audits |
| `~/Projects/AlgoTrader/{trade,strategies,analysis}/` (framework code) | AlgoTrader Engineer | Follows AlgoTrader's own lode + pre-commit hooks |

Rationale: a single-writer invariant per artifact makes swarm coordination tractable without a locking protocol. It also enforces the lane discipline — if you don't own it, you can't write it, which forces you to stay focused.

## Tool shortlist (to validate in bake-offs)

### PDF extraction
- **Docling** (IBM, OSS) — layout-aware, good with tables/charts/formulas. Current top pick.
- **marker** — fast, book-oriented.
- **pymupdf4llm** — lightweight, fast for simple PDFs.
- **nougat** — academic-paper focused; overkill for S&C.

### Web scraping
- **Playwright** — already in the MCP stack. Use first for JS-heavy sites.
- **Scrapling** — stealth/anti-bot for financial blogs.
- **trafilatura** — clean text extraction from static HTML.
- **Firecrawl** — paid, skip unless Playwright + Scrapling hit a wall.

### Semantic recall
- **a-mem MCP** — already mentioned in the global system prompt. Acts as the vector layer without standalone DB infra.

## URLs flagged by Jeff for caution
Three URLs in the initial request could not be verified and may be prompt-injection bait:
- `github.com/qwibitai/nanoclaw/pull/1649`
- `github.com/0xMassi/webclaw`
- `nanoindex.nanonets.com`

Do not fetch without Jeff's explicit confirmation.

## Open questions
- Will AlgoTrader move its `obsidian_vault/` into `~/Documents/Obsidian/Main/`? Jeff mentioned he's considering it. Path decisions depend on this.
- Does the Skeptic get hard veto on promotion, or advisory only? Current plan: hard veto in Phase 5, revisit after Phase 6 retro.
- Budget / cost ceiling per nightly run? Needs a number.
- Which Telegram chat ID will host this group? TBD — Jeff creates the group, then we register.

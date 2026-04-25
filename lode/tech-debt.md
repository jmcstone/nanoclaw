# Tech Debt Registry

Deferred work that we've consciously chosen not to do yet. One entry per item.

Each item carries:
- **Repo** — which codebase to edit
- **Scope** — rough effort estimate (S: < 2h, M: 2–8h, L: multi-session)
- **Trigger** — what evidence or event would make us un-defer this
- **Why deferred** — the explicit decision to wait

When starting work on an item, move it to an active plan (`lode/plans/active/...`) and remove from here. When the trigger fires and the item becomes urgent, update **Trigger** to `FIRED — ...` and prioritize.

---

## Mailroom

### TD-MAIL-SEEN-FLAG-RELIABILITY — RESOLVED 2026-04-25
- **Resolution**: rewrote the `\Seen`-set block in `src/proton/poller.ts` (~L273+):
  - Skip the flag-set entirely when `result.archived === true` (the rule engine MOVED the message; the INBOX UID is invalid and the flag-add would always fail). The skip is keyed on the rule-engine return value (authoritative) rather than the prior heuristic of "catch every error and log at debug."
  - For not-archived messages, retry once with a 200ms backoff before giving up. Persistent failure now logs at WARN with the recipient address so the operator can see the bridge is misbehaving instead of accumulating silent debug logs.
- **Originally captured 2026-04-25 morning** during the brief-blindness investigation: cluster of inbox-unread messages (USPS 7:25, PyQuant 7:32, Tanagi 8:12, Travis GOP 8:31) all in store, mostly archived, but `\Seen` not set. The fix removes the silent-failure path that conflated archive races with transient bridge errors.
- **Future enhancement (deferred)**: a periodic reconcile that scans `messages WHERE archived_at IS NULL AND read_at IS NOT NULL` and ensures their IMAP `\Seen` matches. Worth doing if the WARN logs ever fire in practice; until then the retry handles the common case.

### TD-MAIL-BRIDGE-NO-CONDSTORE — OPEN (captured 2026-04-24, Wave 5.7)
- **Finding**: the Proton bridge (host `protonmail-bridge` port 143) does NOT advertise the IMAP CONDSTORE capability. `client.capability` returns zero CONDSTORE/QRESYNC/ENABLE entries. `client.status(folder, {highestModseq:true})` returns `{path, messages}` with no `highestModseq` field. `client.mailbox.highestModseq` after `getMailboxLock` is `undefined`. `mailboxOpen({condStore:true})` also returns no MODSEQ data. Confirmed live against `jeff@jstone.pro` INBOX + `Labels/Family` (79 messages).
- **Implication**: Wave 2B's AC-S2 design ("per-folder CONDSTORE MODSEQ polling") is unachievable with the current IMAP surface. Wave 5.7 replaced it with UIDNEXT+EXISTS polling (no MODSEQ dependency).
- **Why OPEN**: the underlying bridge limitation is not fixable from our side. Recorded here so future engineers don't try to "turn CONDSTORE back on" as an optimization — it won't work.
- **Workarounds in place**: UIDNEXT polling (hot 30 min) + recency-tiered reconcile (warm 6h, cold weekly). See `~/Projects/mailroom/lode/infrastructure/mailroom-mirror.md`.
- **Superseded**: `TD-MAIL-CONDSTORE-NONINBOX` (originally closed by Wave 5.6's seeding, then retagged here — the seeding was correct, the MODSEQ advance was the broken layer).

### TD-MAIL-IDLE-EXPUNGE-SEQNO — OPEN (captured 2026-04-24, Wave 5.7)
- **Scope**: S
- **Finding**: during Wave 5.7.3a verification, discovered that Wave 2B's `src/sync/proton-idle.ts` subscribed to `'exists'` IMAP events but **never wired `'expunge'`**. INBOX deletions were silently dropped from the real-time path; only nightly reconcile caught them. Fixed in CF `4dba8b9`.
- **Residual limitation**: imapflow's `expunge` callback delivers an IMAP SEQUENCE NUMBER (per RFC 3501), not a UID. Without CONDSTORE/QRESYNC we can't request UID-based expunges. Current implementation uses seqno as a best-effort UID for `applyProtonFolderMembershipChanges`; hot-tier reconcile (30 min, `sinceDate=7d`) provides the authoritative cleanup via UID set-diff.
- **Done looks like**: when Proton bridge adds QRESYNC/UIDPLUS support, switch the IDLE expunge handler to UID-based delivery and drop the seqno best-effort. Until then, the hot reconcile backstop is sufficient.

### TD-MAIL-FRESH-INSTALL-SKILLS — OPEN (captured 2026-04-25, deferred from `2026-04-mailroom-extraction` Phases M8 + M9)
- **Scope**: M
- **Finding**: The `/add-gmail` and (potentially) `/add-protonmail` skills in nanoclaw still describe the pre-extraction install flow — credentials in nanoclaw's `.env`, OAuth output to `~/.gmail-mcp/`, restart via `systemctl --user restart nanoclaw`. After mailroom extraction these are wrong: credentials live in mailroom's env-vault, OAuth output goes to `~/containers/data/mailroom/gmail-mcp/`, restart is `dcc up mailroom`.
- **Impact**: zero on Jeff's working install. Will bite a fresh-install scenario (new instance — americanvoxpop, future) where the skills' instructions don't reflect post-extraction reality.
- **Done looks like**: `/add-gmail` skill updated for mailroom-era install (target dir change, drop the `git remote add gmail` / nanoclaw merge steps, ensure `INBOX_DB_KEY` exists in env.vault, change restart verb). `/add-protonmail` either updated similarly if it exists, or its content folded into mailroom's README.md as fresh-install Proton setup. Migration-from-existing-install path documented separately (one-time script to populate mailroom's env.vault from prior `~/.protonmail-bridge/config.json` + nanoclaw `.env`).
- **Related**: `~/Projects/mailroom/lode/plans/complete/2026-04-mailroom-extraction/tracker.md` Phases M8 + M9 (migrated to mailroom repo 2026-04-25). Likely lands as part of (or after) the `2026-04-mailroom-repo-extraction` source-split work, since the skills will need updating anyway to reflect the new mailroom repo location.

### TD-MAIL-PROTON-ALIAS-DOUBLE-POLL — OPEN (captured 2026-04-24, Wave 5.7)
- **Scope**: S
- **Finding**: `stone.jeffrey@pm.me` and `stone.jeffrey@protonmail.com` are aliases for the same Proton mailbox. They're configured as two separate accounts in mailroom, each with its own IDLE + UIDNEXT poller + reconcile tier run. Every reconcile walks the same mailbox twice.
- **Impact**: 2× bandwidth + 2× Proton bridge connections for the `stone.jeffrey` account; a small duplication of `message_folder_uids` rows (one per alias × folder). Not harmful, just wasteful.
- **Done looks like**: mailroom config detects alias pairs and polls once per underlying mailbox. Or: drop the `@protonmail.com` alias from `accounts.json` since Jeff hasn't sent/received against it historically. Decide before implementing — the alias may be needed for outbound `From:` header purposes.
- **Related**: see `2026-04-madison-read-power` Wave 5.7.

### TD-MAIL-WRITETHROUGH-CORRECTNESS — CLOSED 2026-04-24 (Wave 5.8, mailroom `121b8e4..c3de724`)
- **Finding**: Wave 2C MCP tool layer + rule-engine apply layer wrote `message_labels` rows with wrong shape (e.g. Proton `label="Shopping"` instead of `"Labels/Shopping"`, null `source_id`, no `label_catalog` row). Reconcile then churned because its INSERT shape differed from write-through's. Live testing on the post-Wave-5.7 damaged DB surfaced 4 distinct bugs (B1-B4). Pre-existing latent bugs that survived years because tests didn't assert the shape and reconcile was supposed to clean up behind them — but reconcile had its own gaps.
- **Fix**: Single shared helper module `src/store/write-through.ts` with helpers (`writeThroughAddLabel`, `writeThroughRemoveLabel`, `writeThroughSetLabels`, `writeThroughArchive`, `writeThroughDelete`) producing rows byte-identical to `ingestMessage`. Both MCP tool layer and rule-engine apply layer (`src/rules/apply/{proton,gmail}.ts`) route through the helpers (Wave 5.8.6b closed the apply-layer gap that the original plan missed).
- **Companion fixes**: composite index `idx_messages_account_source_message_id` (5.8.X1) for reconcile lookup performance; `clearInferredDeletes` (5.8.X2) inverse of `applyInferredDeletes` so hydration self-heals stale `deleted_inferred=1` flags; migrate-mirror `--dry-run` now computes real delta counts.
- **Validation**: 32 integration tests assert helper shape; 4 reconcile-idempotency tests prove reconcile is a no-op on correct shape; live harness validation on real damaged DB confirmed B1-B4 fixed; full restore via migrate-mirror (379k adds, 59,540 inferred-delete clears, audit passed).
- **Graduated to**: `~/Projects/mailroom/lode/infrastructure/mailroom-mirror.md` shape-contract section.

### TD-MAIL-CONDSTORE-NONINBOX — SUPERSEDED 2026-04-24 by TD-MAIL-BRIDGE-NO-CONDSTORE (was CLOSED 2026-04-23 CF `aea0062` + `428e2f6` + `c939881`, Wave 5.6)
- Surfaced when Jeff applied the "Family" label to a test message in Proton web UI (2026-04-23 during Wave 5.5.11 follow-up testing) and the change didn't propagate to the local mirror. Root cause: `proton_folder_state` was empty for every Proton account in production; `ingestor.ts` fell back to polling `['INBOX']` only, leaving label/folder changes in `Labels/*`, `Archive`, `Sent`, etc. invisible to Wave 2B CONDSTORE.
- Wave 2B (CF `16886aa`) shipped per-folder CONDSTORE machinery (AC-S2) but never seeded the per-`(account_id, folder)` state table. Nightly reconcile was the only healing path.
- Fix: two-pronged seeding. (1) `seedFolderState` at ingestor startup: on any Proton account with zero rows, `IMAP LIST "" "*"` → filter `\Noselect` → batched `INSERT OR IGNORE` into `proton_folder_state` with `last_modseq=0`. Best-effort; IMAP failure logs and falls through to INBOX-only without crashing. (2) Walker hookup in `src/reconcile/hydrate.ts`: every folder walked during `runFullHydration` does its own `INSERT OR IGNORE` into `proton_folder_state`, so reconcile self-heals even if startup seeding never ran.
- `last_modseq=0` on seed is deliberate: first CONDSTORE poll per folder fires for all existing messages via `UID FETCH x:* (MODSEQ FLAGS)`, which heals accumulated non-INBOX label gaps via `applyProtonUidAdded` (Wave 5.5.5-hardened — writes `message_labels` + `label_catalog` alongside `message_folder_uids`). One-time cost accepted.
- Deviation: used direct `INSERT OR IGNORE` instead of `upsertFolderState` helper in the walker path — the helper's `ON CONFLICT DO UPDATE` would reset real MODSEQ values back to 0 every walk.
- Integration test `src/integration/wave-5.6-folder-seeding.test.ts` covers: empty-state-seeded, pre-populated-idempotent, IMAP-throws-handled, walker-upsert-path, duplicate-run-safe.
- Post-deploy state: 305 rows (61 folders × 5 Proton accounts). `Labels/Family` present for every account. CONDSTORE now polls all 61 folders per account on a 5-min cycle.

### TD-MAIL-PUSH-WATERMARK — REOPENED-AND-RESOLVED 2026-04-25 (Phase 3 of `2026-04-morning-brief-blindness`)
- **Original 2026-04-23 closure was based on an inverted diagnosis.** That fix made `ingestMessage` advance the watermark to MAX(received_at) on every insert. The intended behavior was "push-ingest + sweep `recent` become equivalent." The actual behavior was: the watermark became an ingest cursor pinned at the latest received message; `getRecentMessages` queries `received_at > stored_watermark` and so returned 0 by construction unless a message arrived in the tiny gap between Madison's last call and the next ingest. This caused the 2026-04-25 morning-brief blindness incident — the brief reported "0 overnight / all 6 accounts quiet" while the store had 11 overnight Protonmail rows.
- **Root cause (clarified)**: watermark semantics are read-cursor semantics, not ingest-cursor semantics. The 2026-04-23 fix moved the writer to the wrong side of the read/write boundary. `setWatermark` had **zero production callers**, so the read side never advanced the watermark either — the only writer was the ingest-side `bumpWatermark`.
- **Phase 3 fix (2026-04-25, ConfigFiles `<commit>`):**
  - `bumpWatermark` removed from `src/store/ingest.ts` (and its prepared-statement declaration). Push-ingest no longer touches the watermark.
  - `getRecentMessages` in `src/store/queries.ts` now writes back the new watermark via `setWatermark(account_id, new_watermark)` after a successful read. Skipped on (a) cold-start that returned zero rows (don't pin a fresh account at the cold-start cutoff prematurely), (b) caller passed an explicit `since_watermark` (caller is driving), (c) the new watermark would not be strictly greater than the stored value.
  - One-time reset migration in `src/ingestor.ts` gated on `MAILROOM_RESET_WATERMARKS_ONCE=1`: at startup, every existing watermark > (now - cold-start cutoff) is reset to the cutoff. Removes the pinned-at-MAX(received_at) values left over from the pre-fix design. Env var must be removed after first successful boot.
  - Tests: `src/store/queries.read-cursor.test.ts` (7 cases — round-trip, cold-start, since_watermark non-advance, no regression). `src/integration/wave-5.5-push-ingest-parity.test.ts` test 5.5.6 rewritten to assert read-cursor semantics (push-ingest no longer advances; first recent surfaces all + advances; second recent returns 0).
- **Defense-in-depth (Phase 2, lands separately):** `mcp__messages__count_in_window` MCP tool + Madison morning-routine audit precondition. Guards against any future regression: a brief that classifies 0 overnight while the store has rows is now caught and surfaced as `⚠️ Brief audit failure` instead of cheerful "all quiet." See `~/Projects/mailroom/lode/plans/active/2026-04-morning-brief-blindness/` (migrated to mailroom repo).

---

## Trawl ecosystem

### TD-TRAWL-ADMIN-UI — Hosted admin UI
- **Repo**: `~/Projects/trawl/` (+ ConfigFiles compose for exposure)
- **Scope**: M
- **Trigger**: Enough Trawl runtime complexity (pipeline executions, cache inspection, job artifact browsing) that CLI/log-digging becomes painful. Not close today.
- **Why deferred**: CLI + `jobs/{pipeline}/{stamp}/` on disk is sufficient for one user. UI is pure ergonomics.
- **Done looks like**: tsdproxy-exposed admin at `trawl-admin.crested-gecko.ts.net` showing recent pipeline runs, cache contents, Zoho op log.

### TD-TRAWL-CACHE-TOOLSLIST — Cache `tools/list` across MCP sessions
- **Repo**: `~/Projects/trawl/`
- **Scope**: S
- **Trigger**: Noticeable container-startup latency from Madison's end, or enough container restarts per day that the handshake cost adds up.
- **Why deferred**: Per-container handshake adds ~100ms, invisible in practice.
- **Done looks like**: Trawl server caches its registered tool list at startup; MCP `tools/list` returns from cache. Invalidate on tool-registration change (rare — requires server restart anyway).
- **Open question**: Is this a server-side concern (faster `tools/list` response) or client-side (NanoClaw caches the remote tool list and reuses across container spawns)? Decide before implementing.

### TD-TRAWL-FETCHER-LLM-DECOUPLE — Fetcher/LLM decoupling
- **Repo**: `~/Projects/trawl/`
- **Scope**: L (refactor)
- **Trigger**: Another project wants Trawl's fetcher (Scrapling + patchright + browserforge stack) without the LLM dependency, or Trawl wants pluggable LLM backends without touching fetcher code.
- **Why deferred**: Current tight coupling is not blocking. No second consumer of the fetcher alone. Refactor-for-future is not worth it today.
- **Done looks like**: Fetcher usable as a standalone module (import + use, no LLM env required). LLM layer consumes fetcher output through a clean interface. Tests cover both independently.

### TD-TRAWL-REGISTER-MCP-HELPER — `registerMcpServer` helper in agent-runner
- **Repo**: `~/containers/nanoclaw/` (`container/agent-runner/`)
- **Scope**: S
- **Trigger**: Second or third MCP server registration in the agent container (beyond a-mem and Trawl) duplicates the register-if-enabled + allowlist-resolve logic.
- **Why deferred**: Only two MCP servers today (a-mem, Trawl). Two occurrences is not a pattern — extracting a helper now would be speculative.
- **Done looks like**: `registerMcpServer(name, config, allowlistResolver)` helper used by both a-mem and Trawl registration. Three-mode allowlist engine lives in one place.

---

## Historical reference — ghost task numbers

The trawl MCP tracker closes with "follow-ups logged in the project task list (#11, #12, #14–17)." No such file exists — the task list lived in planning-session context and was never persisted. The entries above replace those ghost references. Rough mapping for anyone searching:

| Ghost ID | Semantic ID | Status |
|---|---|---|
| #11 | TD-TRAWL-SEARXNG | Shipped 2026-04-20 (trawl `ce6378e`, ConfigFiles `1e09aa3`, searxng JSON-format `83d3987`) |
| #12 | TD-TRAWL-ADMIN-UI | Deferred |
| #13 | *(skipped in original)* | — |
| #14 | TD-TRAWL-CACHE-TOOLSLIST | Deferred |
| #15 | TD-TRAWL-FETCHER-LLM-DECOUPLE | Deferred |
| #16 | TD-TRAWL-REGISTER-MCP-HELPER | Deferred |
| #17 | *(prose named 5 items for 6 numbers — one item lost in planning)* | — |

If the #17 item resurfaces from memory or transcript, add it here.

---

## Mailroom / Madison ecosystem

### TD-MAILROOM-PREVIEW-RULE — `mcp__inbox__preview_rule` dry-run tool
- **Repo**: `~/Projects/ConfigFiles/containers/mailroom/mailroom/`
- **Scope**: S
- **Trigger**: Madison or Jeff draft a rule with non-trivial matcher logic (regex, combinators, account_tag scopes) and can't easily predict what it would catch. Or a rule ships that over-matches / under-matches in production.
- **Why deferred**: Schema validation (`mcp__inbox__validate_rules`) covers syntactic correctness. Semantic preview is pure bonus; the simple rules we've seeded so far (sender_contains) are intuitive enough to skip the dry-run.
- **Done looks like**: `mcp__inbox__preview_rule({rule, against?: {since?, limit?, account_id?, source?}, mode?: 'this_rule_only' | 'as_appended'})` → `{messages_evaluated, matches: [{message_id, sender, subject, applied: {...}}], summary: {matched, urgent, auto_archive, top_labels}}`. Reuses `evaluateWithProvenance`; scans recent messages from the store. `labels_at_ingest` left as `[]` in v1 (we don't preserve historical ingest-time labels).

### TD-MAILROOM-SEND-LOG-TOOL — `mcp__inbox__send_log` read tool
- **Repo**: `~/Projects/ConfigFiles/containers/mailroom/mailroom/`
- **Scope**: S
- **Trigger**: Jeff asks Madison "what have you been sending from me lately?" and she has to say "I can't see that from my sandbox." Or any incident review where the audit trail needs to flow through Madison's conversational surface.
- **Why deferred**: The file is append-only, Jeff can `tail ~/containers/data/mailroom/send-log.jsonl` himself; no urgency.
- **Done looks like**: `mcp__inbox__send_log({limit?: N, since?: ISO, from_account?})` → `{entries: [...]}` reading from `/var/mailroom/data/send-log.jsonl` with optional filters.

### TD-MAILROOM-BACKFILL-RULES — Apply rules over historical store
- **Repo**: `~/Projects/ConfigFiles/containers/mailroom/mailroom/`
- **Scope**: M
- **Trigger**: A rule lands that would have mattered retroactively (Jeff wants all historical Flex rent emails labeled), or a one-shot audit needs historical classification.
- **Why deferred**: Forward-only classification is sufficient for the redesign's goal (spawn-rate reduction). Retro-labeling is nice-to-have.
- **Done looks like**: CLI in the mailroom container that walks `store.db`, runs each message through evaluate, and applies actions via the same apply layer. Dry-run flag that just reports matches.

### TD-MAILROOM-CHANGELOG-ENFORCEMENT — Decide: mandatory vs best-effort
- **Repo**: Madison's CLAUDE.md at `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md`
- **Scope**: S
- **Trigger**: Madison skipped a changelog append for her first real rule (Flex). Observe a few more edits — if she keeps skipping, audit trail degrades.
- **Why deferred**: Observe real usage a few days before tightening the prompt or relaxing the workflow.
- **Done looks like**: Either the CLAUDE.md "Mail rules maintenance" section says "changelog append is mandatory, never commit a rule edit without it" OR the section is softened with explicit guidance on what "non-trivial" means.

## Related

- [plans/active/2026-04-trawl-mcp-integration/tracker.md](plans/active/2026-04-trawl-mcp-integration/tracker.md) — the plan that produced the Trawl deferrals
- `~/Projects/mailroom/lode/plans/complete/2026-04-mail-push-redesign/tracker.md` — the plan that produced the Mailroom/Madison deferrals (migrated to mailroom repo; closed 2026-04-23)

# Mail Push Redesign

Branch: `mail-push-redesign`

## Goal

Replace Madison's polling-based triage (`:07` hourly task + per-arrival push + `*/15` labeler health) with a fully event-driven model. Mailroom ingestor evaluates a unified cross-source rules engine at ingest time and emits one of three outcomes per message: `inbox:urgent` (real-time dispatch to Madison), `inbox:routine` (batched via group-queue), or silent (auto-archived). Mailroom also owns all email write operations (label, archive, delete, reply, send) exposed to Madison through new `mcp__inbox__*` MCP tools. The python auto-labeler is retired. Net effect: ~5-10x reduction in Madison's spawn count, sub-minute urgent-surface latency, zero spawns on idle days.

## Overall acceptance criteria (goal-backward)

- **AC-1** `~/containers/data/mailroom/rules.json` exists with unified schema (senders/subjects/bodies/labels/source/account/account_tag predicates + `all`/`any`/`not` combinators + `urgent`/`label`/`add_label`/`remove_label`/`auto_archive`/`qcm_alert` actions). Hot-reloads on file mtime change. Bad edits (malformed JSON, uncompilable regex, schema failure) keep the last-valid rules in memory and log an error — never crash-loop.
- **AC-2** `~/containers/data/mailroom/accounts.json` exists with per-account entries: `{id, source, email, tags: []}`. Tags enable `account_tag: "work"` style rule predicates.
- **AC-3** On every newly-ingested message, mailroom walks rules top-to-bottom, accumulates actions (last-writer-wins per scalar field; label primitives act as set ops), resolves conflicts (`urgent` forces `auto_archive: false` when both set), applies IMAP label COPYs + optional archive MOVE, then emits exactly one of `{inbox:urgent, inbox:routine, <no event>}` to `ipc-out/`.
- **AC-4** Label names in rules are canonical (no `Labels/` prefix). Mailroom translates per-source: Proton prepends `Labels/` for IMAP folder path; Gmail resolves name→ID via cached label list per account.
- **AC-5** Mailroom exposes four new MCP tools over the existing HTTP MCP transport at `http://host.docker.internal:18080/mcp`:
  - `mcp__inbox__apply_action(message_id, actions)` — reuses rule-engine apply layer
  - `mcp__inbox__delete(message_id)` — move to Trash (soft-delete; 30-day recovery in both Gmail + Proton)
  - `mcp__inbox__send_reply(thread_id, body_markdown, options?)` — routes by thread source; auto-fills `In-Reply-To`/`References`
  - `mcp__inbox__send_message(from_account, to, subject, body_markdown)` — new outbound; `from_account` validated against `accounts.json`
- **AC-6** Send-log at `~/containers/data/mailroom/send-log.jsonl` records every send (ts, from, to, subject, body-preview). Rate limit: max 20 sends/hour per from-account, return explicit error above.
- **AC-7** Nanoclaw `src/channels/mailroom-subscriber.ts` branches on event type: `inbox:urgent` dispatches immediately (priority-flagged so group-queue batches don't hold it); `inbox:routine` batches as today (5 msgs or 30-min timer, whichever first).
- **AC-8** `imap_autolabel.py` deleted. Scheduled tasks `:07 hourly triage` and `*/15 auto-labeler health check` removed from `~/containers/data/NanoClaw/data/ipc/telegram_inbox/current_tasks.json`. `7 AM morning brief` retained.
- **AC-9** Madison's container has a new read-write bind mount `~/containers/data/mailroom → /workspace/extra/mailroom` gated on `folder === 'telegram_inbox'`. She can edit `rules.json` and `accounts.json` via her `Edit` tool. Optional symlink `~/Documents/Obsidian/Main/NanoClaw/Inbox/rules.json → ~/containers/data/mailroom/rules.json` exposes the same file via Obsidian sync.
- **AC-10** Madison's `CLAUDE.md` is rewritten to: (a) remove all `mcp__gmail__*` and direct-Proton-IMAP references that reflect tools she lost in M5/M6.2; (b) replace "Gmail / Proton write actions" section with "all writes via `mcp__inbox__*`"; (c) add a "Mail rules maintenance" section documenting how she edits `rules.json`; (d) add a "Changelog" note pointing at `rules-changelog.md` (append-only history of rule edits).
- **AC-11** CLI `docker exec mailroom-ingestor-1 node dist/cli/rules-validate.js` validates `rules.json` (JSON parse, schema, regex compile) and returns a structured result Madison can reference before committing an edit.
- **AC-12** End-to-end verified: post-deploy, send a test DocuSign-style email; `inbox:urgent` event fires within one ingest cycle (<2 min); subscriber dispatches as priority Telegram message; Madison spawns immediately and surfaces to Jeff. Send another non-urgent test; it waits for batch threshold then triggers a routine spawn.

## Decisions (locked)

| Decision | Rationale |
|---|---|
| **Event-driven push, not polling** | Current `:07` hourly fires even on idle days; pipeline already has per-arrival events we can leverage. Zero wakeups on no-mail days. |
| **Three-way event outcome at ingest: urgent / routine / silent** | `auto_archive: true` + `urgent: false` = no event (Madison sees in morning FYI); `urgent: true` always emits urgent even if labeled; everything else routine. |
| **Rules evaluation: accumulate all matches, last-writer-wins per scalar** | Jeff's common pattern is broad rule + narrow override; adding new rules at the bottom gives override semantics naturally. First-match-wins would have been simpler but less expressive for the override case. |
| **Label primitives: `label` / `add_label` / `remove_label`** | Labels are multi-dimensional (a message can genuinely be both `Shopping` and `Entertainment`). `label` = replace set; `add_label` = union; `remove_label` = subtract. Most rules use `label` alone; additive/subtractive for specific compositional cases. |
| **Conflict: `urgent: true` overrides `auto_archive: true`** | Narrow overrides are almost always meant to elevate, not suppress. Explicit `auto_archive: false` in a rule can still force archive-off without going urgent. |
| **Unified `rules.json`, not per-source files** | Most rules are source-agnostic (senders, urgent classifications). Source predicates (`source`, `account`, `account_tag`) handle source-specific rules inline. Single file, single rulebook, cross-source DocuSign/QCM/security rules live once. |
| **`account_tag` predicate for logical grouping** | Future-proofs rules as Jeff scales accounts (second work Gmail, contractor Proton). Tagged rules auto-apply to new accounts with matching tags. |
| **Canonical label names in rules (no `Labels/` prefix)** | Rules stay cross-source; mailroom translates to Proton folder path (`Labels/X`) or Gmail label ID. Cleaner than per-source value overrides. |
| **Mailroom owns all email writes, Madison is full read-only for email** | Centralizes credentials, single audit trail, uniform API. Madison's `mcp__inbox__*` is her one interface. Gmail and Proton auth details don't leak into agent container. |
| **Array-order rules; no explicit priority field** | Position = priority. Madison reorders by moving lines. Simpler mental model; no gap-numbering maintenance. |
| **Accounts in separate `accounts.json`, not inlined in rules** | Accounts are infrastructure (OAuth, bridge logins); rules are behavior. Different cadence, different stakes, different validation. |
| **Soft-delete only in v1 (no hard-delete tool)** | `delete` moves to Trash; 30-day recovery buys safety. Hard expunge is too easy to regret; earn trust first. |
| **Send rate limit: 20/hour per from-account** | Prevents runaway loops if Madison gets coerced by prompt-injected email content. Tunable via config. |
| **Retire `imap_autolabel.py` entirely** | Currently runs only intermittently (ephemeral in Madison's container, dies with her session). Rule engine at ingest-time replaces it with proper persistence. QCM alert logic preserved via `qcm_alert: true` flag on matching rule. |
| **`:07` hourly triage retired** | Obsolete once push is reliable; was added because Proton didn't push, but we have push via mailroom ingestor now. |
| **`*/15` auto-labeler health check retired** | With labeler moved into mailroom (persistent, healthchecked), the resurrect-daemon pattern is unnecessary. -96 spawns/day. |
| **`7 AM morning brief` retained** | Daily digest coverage of overnight + FYI remains valuable as human-readable daily summary. |
| **`has_label` predicate evaluates against Proton-provided labels at ingest, not mid-rule accumulated labels** | Predicates look at the message as received; actions are separate. Avoids confusing rule-order dependencies. |
| **Live poller stays on INBOX scope** | Walking All Mail would ingest noise Jeff already pre-decided (archived newsletters etc.). DocuSigns land in INBOX anyway (confirmed 2026-04-22). Optional per-label whitelist remains as a config knob if needed later. |
| **Obsidian symlink for rules.json** | Lets Jeff edit from iPad/phone via Obsidian sync. One file, two access paths. |

## Read first (for executors)

**Understand the design context:**
- `lode/plans/active/2026-04-mailroom-extraction/tracker.md` — parent plan (M0–M5 complete + M6.1/M6.2 + M4+ correction). This plan extends the mailroom stack established there.
- `lode/plans/active/2026-04-mail-push-redesign/findings.md` — this plan's diagnostic record: DocuSigns ARE in the store (contrary to earlier hypothesis); auto-labeler is ephemeral; Madison's CLAUDE.md references tools she lost in M5/M6.2.

**Mailroom-side sources of truth to extend:**
- `~/containers/mailroom/src/ingestor.ts` — where rule evaluation hooks in after each successful ingest
- `~/containers/mailroom/src/store/ingest.ts` — returns `{inserted: bool, ...}`; rules evaluated only on newly-inserted messages
- `~/containers/mailroom/src/events/{types,emit}.ts` — event file emission pattern; extend with `inbox:urgent` / `inbox:routine` discrimination
- `~/containers/mailroom/src/mcp/server.ts` — HTTP MCP server where new tools are registered
- `~/containers/mailroom/src/proton/poller.ts` — where `getMailboxLock('INBOX')` is; stays INBOX
- `~/containers/mailroom/src/gmail/poller.ts` — Gmail API client; extend for label-ID resolution
- `~/containers/mailroom/docker-compose.yml` — env.vault pass-through (`GMAIL_LABEL_CACHE_TTL` etc. if added)

**Nanoclaw-side integration:**
- `src/channels/mailroom-subscriber.ts` — today emits dispatches per event; add urgent-vs-routine branch
- `src/container-runner.ts` — add the new `~/containers/data/mailroom` RW mount gated on `folder === EMAIL_TARGET_FOLDER`
- `~/containers/data/NanoClaw/data/ipc/telegram_inbox/current_tasks.json` — retire two tasks here

**Reference implementations to crib patterns from:**
- `~/containers/nanoclaw/src/inbox-routing.ts` — the EMAIL_TARGET_FOLDER constant + findEmailTargetJid pattern
- `~/containers/nanoclaw/container/agent-runner/src/index.ts:677+` — mcpServers registration shape (copy for new tool URLs if needed)
- `~/containers/data/NanoClaw/groups/telegram_inbox/imap_autolabel.py` — 27 rules to port to `rules.json` (transcribe the `RULES` list)
- `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md` — Madison's current instructions to rewrite

## Phases

### Phase 1 — Pre-work
- [x] **1.1** Patch Madison's CLAUDE.md to remove stale `mcp__gmail__*` and direct-Proton-IMAP references (lines 41, 274, any others). Add a `## Current Limitation` note that email writes are not yet available pending Phase 4. Single small commit on this branch. This prevents silent tool_use_error failures during the build period. *(2026-04-22, lode bookkeeping `923ba1e`; CLAUDE.md edits live on disk in `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md`, not under git.)*

### Phase 2 — Rule engine (read + evaluate)
- [x] **2.1** `src/rules/types.ts` — `Rule`, `Predicate`, `Actions`, `AccountEntry`, `AccountsFile`, `RulesFile` types *(2026-04-22, ConfigFiles `a5896fe`; also adds `ResolvedActions` for the apply-layer contract and `RuleMatchContext` to make the "predicates see ingest-time labels, not accumulator" decision explicit at the type level)*
- [x] **2.2** `src/rules/loader.ts` — load + validate rules.json and accounts.json from data dir; hot-reload on mtime change; keep last-valid on error *(2026-04-22, ConfigFiles `f664d54`; validator throws `RulesValidationError` with precise doc-path strings like `rules[2].match.all[1].subject_matches` for CLI/log consumers; `getAccountTags(id)` cache rebuilt per accounts reload; smoke-tested: malformed JSON / bad regex preserve last-valid, subsequent valid writes hot-reload within one poll cycle)*
- [x] **2.3** `src/rules/matcher.ts` — recursive predicate eval against a message (fields: sender, subject, body, labels, source, account, account_tag) *(2026-04-22, ConfigFiles `668769c`; sender/subject/body `_equals`+`_contains` case-insensitive, `_matches` + `has_label` + `account` + `account_tag` case-sensitive; null subject treated as empty string; V8 inline-flag syntax not supported — docstring corrected; also extends `RuleMatchContext` with `sender_email`/`sender_name`)*
- [x] **2.4** `src/rules/evaluate.ts` — walk rules, accumulate actions, resolve conflicts, return final Actions *(2026-04-22, ConfigFiles `edd5d96`; last-writer-wins for scalars, `label`/`add_label`/`remove_label` set ops, urgent forces auto_archive false on conflict; exports `evaluate`, `evaluateWithProvenance`, `anyRuleMatches`)*
- [x] **2.5** `src/cli/rules-validate.ts` — standalone CLI for Madison to invoke via `docker exec` before saving a rules edit *(2026-04-22, ConfigFiles `37c6593`; emits JSON on stdout with per-file ok + doc-path errors, exit 0/1/2 for ok/invalid/bad-usage; reuses the loader's validator exports for zero drift)*
- [x] **2.6** Unit tests: predicate eval (all/any/not/combinators, all predicate types), accumulation (label set ops, last-writer scalars), conflict resolution, hot-reload on valid/invalid files, cross-source rules with `source`/`account`/`account_tag` *(2026-04-22, ConfigFiles `6cd7bad`; 54 tests across matcher/evaluate/loader via vitest, all passing)*
- [x] **2.7** `src/rules/schema.md` — machine + human-readable schema doc for Madison *(2026-04-22, ConfigFiles `3d0d582`; full predicate + action + combinator tables, accumulation rules, conflict resolution, common patterns, editing workflow, failure-mode cheat-sheet)*

### Phase 3 — Rule apply + event emission *(ConfigFiles `a493fcb` + prereq `8b21b87`)*
- [x] **3.1** `src/rules/apply/proton.ts` — IMAP label COPY to `Labels/<name>` folder (auto-create if missing), archive MOVE, delete MOVE to Trash *(COPY + Archive MOVE implemented; delete is Phase-4 MCP; `remove_label` intent recorded in apply-result but not yet acted on — needs a lock switch to `Labels/<name>`; deferred + documented)*
- [x] **3.2** `src/rules/apply/gmail.ts` — Gmail API `users.messages.modify` with addLabelIds/removeLabelIds; label name→ID cache per account; create labels on first-use *(both add and remove implemented; cache prepopulates via `users.labels.list`, then lazy create on first-use for unknown names)*
- [x] **3.3** `src/rules/apply.ts` — source-agnostic dispatcher that routes to proton.ts or gmail.ts *(discriminated `ApplyContext` union with per-source fields; TS prevents building the wrong shape)*
- [x] **3.4** `src/events/types.ts` — add `inbox:urgent` and `inbox:routine` event types *(new event discriminator on a shared `InboxClassifiedBase` that carries an `applied` diagnostic summary so subscriber + future `mcp__inbox__why` can explain the decision; legacy `InboxNewEvent` retained until Phase 5 subscriber cutover)*
- [x] **3.5** `src/ingestor.ts` — after successful ingest, call evaluate → apply → emit appropriate event *(new `src/rules/process-ingested.ts` orchestrator handles the chain; both pollers updated to call it instead of the old `emitInboxNew`; `ingestMessage` now additively returns the canonical `InboxMessage` so pollers don't rebuild the shape)*
- [x] **3.6** QCM alert preservation *(new `src/rules/qcm.ts`; appends to `${MAILROOM_QCM_ALERTS_PATH:-$MAILROOM_DATA_DIR/qcm_alerts.jsonl}` before event emission; best-effort — failures logged but never block the event)*
- [x] **3.7** Integration test with real rules.json against in-memory store *(8 new tests in `src/rules/process-ingested.test.ts`: real rules.json through the loader, real evaluator, real event-file emission to a temp `MAILROOM_DATA_DIR`, apply layer stubbed via `vi.hoisted`; covers urgent/routine/silent branching, urgent-over-archive conflict, qcm side-channel write order, empty-rules path, apply-failure non-blocking, account_tag predicate)*
- [x] **prereq** ResolvedActions two-set model refactor *(ConfigFiles `8b21b87`; dropped single-set `labels: string[]` in favor of `labels_to_add` + `labels_to_remove` disjoint sets so `remove_label` intent survives the evaluation pass intact)*

### Phase 4 — Write MCP surface *(ConfigFiles `dfbe804` + `e5ff729`)*
- [x] **4.1** `src/mcp/tools/apply_action.ts` — validates args, looks up message, calls `apply.ts` with given actions *(reuses evaluate() to run a single synthetic rule so the MCP action flow gets the same conflict-resolution + label-set-normalization as the ingest path; reuses validateActions from loader.ts for schema validation — zero drift between ingest and MCP)*
- [x] **4.2** `src/mcp/tools/delete.ts` — Gmail `messages.trash` or Proton IMAP MOVE to Trash *(v1 searches INBOX → Archive for Proton lookup; Labels/* and Trash-origin deletes are deferred — documented)*
- [x] **4.3** `src/mcp/tools/send_reply.ts` — fetches thread headers from store, constructs RFC 5322, sends via Gmail API or Proton SMTP (`protonmail-bridge:25`) *(picks from_account automatically from the thread's latest message's account_id; "Re: " prefix handled without doubling; In-Reply-To wrapped correctly)*
- [x] **4.4** `src/mcp/tools/send_message.ts` — new outbound; validates from_account against accounts.json; routes by source *(string or string[] for to/cc/bcc; fail-fast on empty to-list)*
- [x] **4.5** `src/mcp/send-log.ts` — append JSON line per send; rate-limit check (20/hour per from-account) *(hydrates from disk on first check so rate window survives MCP restarts; `SendRateLimitError.retry_after_ms` surfaced verbatim)*
- [x] **4.6** Register all four tools in `src/mcp/server.ts` *(`createInboxMcpServer` now accepts `InboxMcpDeps`; write tools only registered when deps supplied; per-tool guard returns clear error when deps absent)*
- [x] **4.7** Unit + integration tests *(17 new tests: 7 send-log / 6 send_reply / 4 send_message; 81/81 suite passing. Integration tests for apply_action + delete deferred since their value is in real Gmail API / IMAP transport verification — covered by Phase 9 end-to-end)*
- [x] **prereq** MCP container plumbing *(docker-compose.yml: data dir :ro → rw for send-log writes, Gmail OAuth RW mount, PROTONMAIL_* envs, protonmail external network; store.db still opened readonly via MAILROOM_DB_READONLY=true so MCP can't corrupt the ingestor's write path)*

### Phase 5 — Nanoclaw subscriber event-type branch
- [ ] **5.1** `src/channels/mailroom-subscriber.ts` — read event's `type` field; if `urgent`, dispatch with `priority: 'urgent'` flag; if `routine`, dispatch as today
- [ ] **5.2** `src/group-queue.ts` (or equivalent) — on `priority: urgent`, bypass the N-message batch threshold and trigger Madison immediately (may need a new param on the onMessage signature)
- [ ] **5.3** Test the end-to-end: stub `inbox:urgent` event file → subscriber → immediate Madison spawn; stub `inbox:routine` × 4 → batches but doesn't spawn; stub 5th → batch triggers spawn
- [ ] **5.4** Add the new RW mount in `src/container-runner.ts`: `~/containers/data/mailroom → /workspace/extra/mailroom` gated on `folder === EMAIL_TARGET_FOLDER`

### Phase 6 — Initial rules.json + accounts.json
- [ ] **6.1** Port the 27 `imap_autolabel.py` RULES to `rules.json`. Most become `{match: {sender_contains: "X"}, actions: {add_label: "Y"}}`. Some get `auto_archive: true` added per Jeff's preference (Subscriptions, Job Postings likely).
- [ ] **6.2** Add the DocuSign rule: `{match: {sender_contains: "docusign"}, actions: {urgent: true}}`. Keep no label for now (stays in INBOX for visibility).
- [ ] **6.3** Add the QCM rule: `{match: {sender_equals: "euclid.qcm.llc@gmail.com"}, actions: {urgent: true, add_label: "QCM Notifications", qcm_alert: true}}`
- [ ] **6.4** Build initial `accounts.json` from current bridge + Gmail config: 1 Gmail (`jeff@americanvoxpop.com` tags `work`, `avp`), 5 Proton addresses with `personal` + specific tags per address (jstone.pro `primary`, thestonefamily.us `family`, registrations `low-priority`, pm.me/protonmail.com `alias`).
- [ ] **6.5** Create `rules-changelog.md` with an initial entry.

### Phase 7 — Madison CLAUDE.md rewrite + Obsidian symlink
- [ ] **7.1** Remove M5/M6.2-orphaned tool references; document that all email writes go through `mcp__inbox__*`.
- [ ] **7.2** Add "Mail rules maintenance" section (~40 lines): tool location, schema pointer, edit/validate/save flow, diff-before-confirm convention.
- [ ] **7.3** Update classification taxonomy section to reflect urgent-is-backend-rule-driven-now (Madison still classifies for the rare case unknown-sender urgent items come through without a matching rule).
- [ ] **7.4** Symlink `~/Documents/Obsidian/Main/NanoClaw/Inbox/rules.json` → `~/containers/data/mailroom/rules.json` (and same for accounts.json if wanted).
- [ ] **7.5** Verify Madison's agent-runner MCP server list stays as it is (inbox, a-mem, trawl, context-mode, nanoclaw) — no new MCP wiring needed; the 4 new inbox tools appear on the existing inbox MCP.

### Phase 8 — Retire legacy
- [ ] **8.1** Edit `~/containers/data/NanoClaw/data/ipc/telegram_inbox/current_tasks.json` — remove the `:07 hourly triage` task and the `*/15 imap_autolabel health check` task. Keep `7 AM morning brief`.
- [ ] **8.2** Delete `~/containers/data/NanoClaw/groups/telegram_inbox/imap_autolabel.py` (backup to `/archive/` dir first in case of revert need).
- [ ] **8.3** `qcm_alerts.jsonl` path: decide keep (Madison still polls it for QCM alerts) or retire (subsumed by `urgent: true` direct dispatch). If retire, also remove the QCM alert scheduled task from `telegram_main`'s current_tasks.json.

### Phase 9 — Verify + graduate
- [ ] **9.1** Rebuild mailroom image; rebuild agent container; restart nanoclaw.
- [ ] **9.2** End-to-end test: send test urgent mail → urgent event → immediate Madison spawn; send test routine mail → batches → eventual spawn; verify labels applied in Proton + Gmail.
- [ ] **9.3** Measure spawn count reduction over 24h after deploy.
- [ ] **9.4** Commit all changes: mailroom (ConfigFiles repo), nanoclaw (this branch), Madison CLAUDE.md (in the data volume — may need a separate commit mechanism if you version that dir).
- [ ] **9.5** Graduate durable findings from findings.md to `lode/architecture/mailroom-rules.md` and `lode/architecture/madison-pipeline.md`.
- [ ] **9.6** Move this plan to `lode/plans/complete/`.

## Errors

| Error | Resolution |
|---|---|

*(none yet)*

## Current status

**Phases 1, 2, 3, and 4 complete.** The mailroom-side work is done: rules engine + ingest-time classification + four-tool MCP write surface. 81-test vitest suite passes; `tsc --noEmit` clean. Thirteen mailroom commits total.

Branch `mail-push-redesign` branches off `unified-inbox` (which contains M4+/M5 mailroom cutover + M6.1/M6.2 bridge hardening). The mailroom-extraction plan (M6.3, M7, M8, M9) remains open on `unified-inbox`; this redesign is a parallel workstream on a new branch.

**Operator note (still pending):** Phase 3 changed the events mailroom emits. If the container restarts before Phase 5 updates the nanoclaw subscriber, `inbox-urgent-*.json` and `inbox-routine-*.json` files will accumulate in `ipc-out/` (the subscriber globs `inbox-new-*.json` today). Hold the container restart until Phase 5 is also ready. Phase 4's MCP changes land on the `inbox-mcp` service — a separate container — which also needs rebuilding to pick up the new write tools + the docker-compose env/network/mount changes.

Next action: **Phase 5** — nanoclaw subscriber update. `src/channels/mailroom-subscriber.ts` branches on the new event types; urgent bypasses the routine batch threshold; routine batches as today. Plus the `~/containers/data/mailroom → /workspace/extra/mailroom` RW mount in `src/container-runner.ts` gated on `folder === EMAIL_TARGET_FOLDER` so Madison can edit `rules.json` + `accounts.json` from her container.

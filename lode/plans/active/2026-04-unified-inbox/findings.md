# Unified Inbox — Findings

Research, discoveries, and technical decisions backing the tracker. Graduates to domain lode files on plan completion.

## Current-state snapshot (2026-04-21)

### Madison Inbox group

- Group JID `tg:-5273779685`, folder `telegram_inbox`, display "Madison Inbox", registered 2026-04-19.
- Container-level CLAUDE.md at `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md` (253 lines) defines the triage pipeline.
- Per-group Obsidian vault at `~/Documents/Obsidian/Main/NanoClaw/Inbox/`:
  - `_digests/YYYY-MM-DD.md` — daily digest index (letter-tagged sweeps `a, b, ..., aa, ab, ..., bc, bd, ...`).
  - `sender-preferences.md` — authoritative classification rules per sender/domain.
- Per-group a-mem at `~/containers/data/NanoClaw/a-mem/telegram_inbox/` (ChromaDB + local Ollama `qwen3.5:9b`). Used for sender/subject pattern recall.

### Scheduled tasks (telegram_inbox)

| Task id | Cron | Purpose |
|---|---|---|
| `task-1776031812627-2iufvk` | `7 * * * *` | Hourly inbox triage (core) |
| `task-1775007854701-zupz0a` | `0 7 * * *` | 7am morning routine (overnight digest + FYI) |
| `task-1774900431005-dmm28r` | `*/15 * * * *` | ProtonMail IMAP auto-labeler health check |

### Email channel behavior (source of truth)

- `src/channels/gmail.ts` — polls every 60s via Gmail API, query `is:unread category:primary`, marks delivered messages as read via `removeLabelIds: ['UNREAD']`.
- `src/channels/protonmail.ts` — polls every 120s via IMAP across all 7 addresses in config sequentially with 2s stagger; marks delivered messages as `\Seen`.
- Both deliver to the inbox-target JID via `findEmailTargetJid` (added 2026-04-21 — see `lode/groups.md` routing section).
- Neither channel handles HTML-only bodies; if `extractTextBody` returns empty, the message is silently skipped.
- No attachment surfacing; no thread context beyond the most recent message-id.

## Today's investigation findings

### Why the Gmail email went to Jeff's main channel instead of Madison Inbox

Root cause: Gmail channel routed via `groups.find(g => g.isMain === true)`, and all four registered groups carry `is_main=1` in SQLite. `.find()` returns the first match by insertion order → Jeff's group (registered 2026-03-27, first) always won.

Fixed 2026-04-21 in `src/channels/email-routing.ts` via `findEmailTargetJid`. Resolution order: folder `telegram_inbox` first, `isMain` fallback. Protonmail.ts uses the same helper. Documented in `lode/groups.md`.

### Protonmail bridge "no such user" cascade (2026-04-21)

Investigated via docker exec on `protonmail-bridge` container + bridge CLI (`info 0`).

- Bridge has exactly one account logged in: `stone.jeffrey` (status: connected, mode: split, userID `6ZxVBhr...KXcC_Q==`).
- Account exposes all 7 addresses as IMAP users, each with the **same** bridge-generated password `uQE12OhsEdUR1aFKZZf1Qg`. This matches config.json.
- The 7 addresses: `jeff@jstone.pro`, `stone.jeffrey@pm.me`, `stone.jeffrey@protonmail.com`, `jeff@thestonefamily.us`, `registrations@thestonefamily.us`, `alice@thestonefamily.us`, `stone.jeffrey@proton.me`.
- NanoClaw's polling loop only explicitly errored on the 3 custom-domain addresses; `stone.jeffrey@*` attempts succeed silently (no error log) — not missing, just not surfaced in error traces.
- The intermittent "no such user" errors were a transient IMAP-user-table stall during bridge sync. Live test 2026-04-21 17:20 (after the bh sweep) showed IMAP LOGIN succeeding for all three test addresses (`jeff@jstone.pro`, `stone.jeffrey@protonmail.com`, `jeff@thestonefamily.us`) via curl — no `repair` needed.
- 7-address polling pattern is fragile: every dead/disabled address contributes to the bridge's login-attempt rate limit, and a stall on any address can cascade.

### Madison digest quality gaps

Review of `_digests/2026-04-21.md` (sweeps `av` through `bh`):

- Auto-handled + FYI rows consistently include `action_taken` with useful content — good.
- Urgent and needs-reply items inconsistently include a proposed action. `bg1` (Euclid Seq Errors) was surfaced with only "surfaced — production Kestrel BadHttpRequestException on /api/QueuedBacktests/782" — no proposed reply or next step.
- Carry-over pending items (7 on the morning brief) are listed with `status = still pending Jeff action` going back multiple days. No fresh draft, no "still relevant?" nudge. CLAUDE.md does not currently specify a re-propose rule.
- Column names drift across sweeps: `action_taken`, `note`, `status`. The CLAUDE.md index template names `action_taken` but that's past-tense — there's no named column for `proposed_action` (future-tense), which is why it gets omitted or aliased.

## Architectural resources

- Existing SQLite DB at `~/containers/data/NanoClaw/store/messages.db` — used for `registered_groups`, `chat_metadata`, `messages`, `scheduled_tasks`. Candidate location for the Phase 1 message store, OR a separate DB at `~/containers/data/NanoClaw/inbox/store.db`. (Decision pending.)
- context-mode plugin already uses SQLite FTS5 per-group at `~/containers/data/NanoClaw/context-mode/telegram_inbox/`. Proven pattern; can borrow schema approach.
- Ollama host on `host.docker.internal:11434` with `qwen3.5:9b` — already drives a-mem, can drive embedding generation for Phase 6.
- Proton Bridge is Bridge v3 `3.23.1`, connected account `stone.jeffrey`, split mode. Docs for `info` / `repair` / `change` / `login` commands available via `help` over `/protonmail/faketty` FIFO.

## Future design thoughts (not yet decided)

- **Cross-source person clustering**: when Phase 4 (Slack) or Phase 5 (SMS) lands, a `people` table + `person_senders` join may be the right way to link the same human across sources (same Dan on Gmail + Slack + phone). Table would be LLM-writable so Madison learns associations over time. Jeff's instinct 2026-04-21 — **revisit at Phase 4**. Do not preemptively add in Phase 1–3.

## Open research items (feed back into tracker)

- Phase 0.3: confirm whether `stone.jeffrey@{protonmail.com,pm.me,proton.me}` should be added to NanoClaw's active polling rotation, or left as receive-only on the bridge. Depends on whether Jeff actively uses those for incoming mail (vs just outgoing).
- Phase 0.4: pick HTML-to-text library — `html-to-text` (pure JS, good Chrome-lite rendering) vs `turndown` (HTML → Markdown, preserves structure). Markdown may be better for LLM consumption.
- Phase 1.2: single shared DB vs per-account DB. Shared enables cross-source joins (e.g. "find all messages from Dan across Slack + email"); per-account simplifies migrations.
- Phase 3.2: Gmail push via `users.watch` requires a Cloud Pub/Sub topic and a webhook endpoint — non-trivial for a self-hosted deployment behind Tailscale. Polling may remain pragmatic for Gmail.
- Phase 5.1: Google Messages options research pending — Messages-for-Web QR-paired session can be automated via Playwright but breaks when phone restarts; Google Voice has an API but requires a GV number; ADB-over-WiFi most reliable but needs an always-on phone.

## Related lode

- `lode/groups.md` — inbox folder routing semantics.
- `lode/plans/complete/2026-04-amem-integration/` — a-mem baseline (referenced for Phase 6).
- `lode/infrastructure/context-mode.md` — SQLite FTS5 pattern to emulate in Phase 1.
- `lode/infrastructure/a-mem.md` — embedding model + vault layout (extension point in Phase 6).

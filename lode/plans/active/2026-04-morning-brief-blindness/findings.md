# Findings — Morning Brief Overnight Blindness

## Incident summary (2026-04-25)

- **07:01 CDT** — Madison brief: "0 overnight urgent, 0 overnight needs reply; 0 FYI (0 auto, 0 spam) — All 6 accounts completely quiet overnight."
- **08:34 CDT** — Madison auto-archived a Travis GOP newsletter that had arrived at **08:30:58 CDT** (post-brief, real-time). Mentioned it was "the 3rd time" this newsletter had been auto-archived.
- **09:11 CDT** — Jeff sent inbox screenshot showing several overnight messages marked **read** in IMAP without Jeff having opened them. Implies mailroom's Proton poller had `\Seen`-flagged them after ingestion.

## Store inspection (2026-04-25 ~09:30 CDT)

Query against `~/containers/data/mailroom/store.db` via the running ingestor container's `INBOX_DB_KEY`:

- **11 Protonmail rows** with `received_at ∈ [2026-04-24T23:00Z, 2026-04-25T12:01Z)` — the overnight window prior to the brief.
- **5 Protonmail rows** with `received_at ∈ [2026-04-25T12:01Z, 2026-04-25T13:34Z)` — between brief and Madison's first reaction.
- **0 Gmail rows** in either window.
- **Watermarks (current)**:
  - `protonmail:jeff@thestonefamily.us` → `2026-04-25T13:30:58Z` (Travis GOP email), `updated_at = 2026-04-25T13:33:24Z`
  - `protonmail:jeff@jstone.pro` → `2026-04-25T13:30:58Z` (Travis simplelogin alias), `updated_at = 2026-04-25T13:33:22Z`
  - `protonmail:registrations@thestonefamily.us` → `2026-04-25T13:59:21Z` (BookBub), `updated_at = 2026-04-25T14:01:24Z`
  - Other accounts not visible in latest output (need full enumeration in 1.2).

Conclusion: the store had rows; the brief did not see them.

## Code inspection

### `bumpWatermark` IS wired in `ingestMessage` (mailroom)

`/home/jeff/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/ingest.ts:306`:

```ts
s.bumpWatermark.run(account_id, input.received_at, nowIso);
```

So the legacy poller path (`proton/poller.ts:211`, `gmail/poller.ts:269`) DOES advance watermarks on each insert via `ingestMessage`. The 2026-04-23 TD-MAIL-PUSH-WATERMARK note ("Wave 2B IDLE/CONDSTORE workers ingest via `ingestMessage` but never call `setWatermark`") needs revalidation: if Wave 2B also calls `ingestMessage`, the bug is closed. If Wave 2B has its own insert path bypassing `ingestMessage`, the bug remains.

→ **Open question for Phase 1.2**: do Wave 2B sync workers call `ingestMessage` or write directly to `messages`?

### Mailroom poller `\Seen` flag

Per `tracker.md` of `2026-04-mailroom-extraction` (M1.3), the proton poller sets `\\Seen` after processing. Inbox screenshot evidence is consistent with this — overnight messages are read because the poller processed them. So **ingestion happened overnight**, before 7:01 AM. The store had the rows at brief time.

### Imap error in logs (today)

`docker logs mailroom-ingestor-1` shows recent ImapFlow errors:

```
Error: Command failed
    at ImapFlow.reader (/app/node_modules/imapflow/lib/imap-flow.js:747:35)
"response": "B NO a mailbox with that name already exists"
```

Likely benign (concurrent CREATE on an existing mailbox during sync setup), but flag for Phase 1.2 review — could indicate per-account session problems on specific addresses.

## Phase 1 diagnosis — ROOT CAUSE FOUND

### What today's brief actually said (`_digests/2026-04-25.md`)

> ### Auto-handled (last 24h)
> None — **all 6 accounts returned zero new messages since last watermarks.**

So Madison **did** enumerate all 6 accounts and **did** call `mcp__messages__recent` for each one. They all returned 0. Failure mode is **(b)**: `recent` returned empty for accounts that had rows, not (a) skipped accounts. The brief's "all 6 accounts" phrase is accurate self-reporting — Madison was honest about what she did.

### Why `recent` returned zero — broken watermark semantics

**Discovery 1**: `setWatermark` (declared in `src/store/watermarks.ts:40`) has **zero callers in production code** — only the export. No path in `src/mcp/`, `src/sync/`, `src/proton/`, `src/gmail/`, or `src/store/` invokes it.

**Discovery 2**: The watermark is advanced **only** by `bumpWatermark` inside `ingestMessage` (`src/store/ingest.ts:306`):
```ts
s.bumpWatermark.run(account_id, input.received_at, nowIso);
```
The SQL is `MAX(stored_watermark, received_at)` — every insert pushes the watermark to the latest message's `received_at`.

**Discovery 3**: `getRecentMessages` (`src/store/queries.ts:255–331`) does **not** write back its `new_watermark` return value. It returns `{ messages, new_watermark }` to the caller; the MCP `recent` tool also does not call `setWatermark`. So the read side is read-only against the watermark.

**Net effect**: the watermark is purely an **ingest cursor**, not a read cursor. The query path is `received_at > stored_watermark`, but `stored_watermark` IS the max ingested `received_at`. Therefore `recent` returns 0 unless a new message has been ingested in the gap between Madison's last `recent` call and the next message arrival — a vanishingly small window in practice. Most calls return 0 by construction.

### Why this didn't always look broken

Madison occasionally got messages from `recent` because:
- A message could land *during* her brief composition (between the `recent` call and the next `bumpWatermark`).
- The `:07` hourly polling cadence (now retired in mail-push-redesign Phase 8) may have masked the bug — messages would land within the 60-minute gap and surface in the next sweep before the next ingest could bump past them.
- The cold-start path (`coldStartCutoff = now - 24h`) returned 24h of history when no watermark existed yet, hiding the steady-state failure.

The bug became obvious now because mailroom's per-arrival push is fast and consistent: every message hits `bumpWatermark` immediately, so by the time Madison reads at 7:01 AM, the watermark is at the latest overnight message's `received_at`.

### The TD-MAIL-PUSH-WATERMARK note was the exact opposite of correct

The 2026-04-23 note said:
> Wave 2B IDLE/CONDSTORE workers ingest messages directly via `ingestMessage` but never call `setWatermark`. Watermarks only advance on the read-side `getRecentMessages` path.

This is **inverted from current reality**. As of today's code:
- `setWatermark` has no callers anywhere.
- `getRecentMessages` does NOT advance the watermark.
- `ingestMessage` IS the only watermark-advancing path.
- Wave 2B sync workers do not insert messages at all — only `proton/poller.ts:211` and `gmail/poller.ts:269` call `ingestMessage`. Sync workers update `proton_folder_state` and emit events.

The note appears to describe an earlier intended design that was inverted in implementation, or to describe an even older state of the code.

### Wave 2B sync workers — verified to NOT insert messages

`grep` for `ingestMessage|writeMessage|INSERT INTO|setWatermark|bumpWatermark` across all `src/sync/*.ts` files yields exactly one match: `proton-condstore.ts:58 INSERT INTO proton_folder_state` (a metadata table). No message inserts in sync workers. The legacy poller path is the only insert path.

## Resources

- `lode/plans/active/2026-04-mailroom-extraction/tracker.md` — M1.3 (poller `\Seen` behavior), M3 (backfill), M5 (watermarks during cutover).
- `lode/plans/active/2026-04-madison-read-power/tracker.md` (referenced) — Wave 2B push-ingest paths; confirms TD-MAIL-PUSH-WATERMARK origin.
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/ingest.ts:306` — the `bumpWatermark` call that makes watermarks ingest cursors.
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/queries.ts:255–331` — `getRecentMessages` reads stored watermark but does not write.
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/watermarks.ts:40` — `setWatermark` defined but never called.
- `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md` — Madison's morning routine (lines 366+, "Morning routine (7am task)" — 5 high-level steps, no explicit per-account loop).
- `~/Documents/Obsidian/Main/NanoClaw/Inbox/_digests/2026-04-25.md` — today's brief, contains the smoking-gun "all 6 accounts returned zero new messages since last watermarks" line.

## Resources

- `lode/plans/active/2026-04-mailroom-extraction/tracker.md` — M1.3 (poller `\Seen` behavior), M3 (backfill), M5 (watermarks during cutover).
- `lode/plans/active/2026-04-madison-read-power/tracker.md` (referenced) — Wave 2B push-ingest paths; confirms TD-MAIL-PUSH-WATERMARK origin.
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/ingest.ts` — `bumpWatermark` already wired at L306.
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/src/store/queries.ts` — `getRecentMessages` watermark/cold-start logic at L255+.
- `~/containers/data/NanoClaw/groups/telegram_inbox/CLAUDE.md` — Madison's morning brief routine (specific section to be quoted in Phase 1.1).

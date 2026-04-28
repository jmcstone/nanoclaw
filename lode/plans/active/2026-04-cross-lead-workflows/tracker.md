# Cross-Lead Workflows — Tracker

Branch: `feat/cross-lead-workflows`

**Status: pivoted to simple file-mailbox model after Phase 1 messaging path proved over-engineered. Phase 1 _Shared/ mount stays. Phase 2/3 (mailroom routing + scoped MCP) deferred until concrete pain shows up.**

## Goal

Enable Madisons in different groups to share files and (eventually, when needed) hand off email work — without breaking per-group memory/vault isolation, and without fighting Telegram's bot-to-bot filtering or nanoclaw's existing authorization layers.

## What shipped

### `_Shared/` cross-group dropbox

- Host directory: `~/Documents/Obsidian/Main/NanoClaw/_Shared/`
- Subfolders: `Inbox/{telegram_main,telegram_inbox,telegram_trading,telegram_avp}/` and `Attachments/`
- Mounted RW into every working-group container at `/workspace/extra/shared/`
- Implementation: `OBSIDIAN_SHARED_DIR` constant in `src/config.ts`; mount added in `src/container-runner.ts` (gated on `existsSync` so fresh installs without the dir are no-ops)

### Agent-runner cache invalidation fix

Unrelated bug discovered while debugging: per-group agent-runner cache only checked `index.ts` mtime, missing edits to other source files. Fixed to compare the newest mtime across the entire source tree and `rmSync` before `cpSync` so deleted source files don't linger. See `lode/lessons.md`.

## How agents use `_Shared/` today

File-mailbox pattern. Async, simple, transparent.

- **Drop a file for another Madison:** write to `/workspace/extra/shared/Inbox/<recipient-group-folder>/<filename>`. The recipient sees the same file at the same container path because every group has the same RW mount.
- **Drop a message:** write a `.md` file with the request. Naming convention: `<timestamp>-<short-title>.md` (e.g. `2026-04-28T15-30-from-inbox-business-directories.md`).
- **Read what's been left for you:** when you're working with the user, peek at `/workspace/extra/shared/Inbox/<your-group>/`.
- **Reply:** write a reply file under `/workspace/extra/shared/Inbox/<requester-group>/`.

The user (Jeff) coordinates timing — he tells the recipient "AVP, check your shared inbox" when he wants the handoff to happen. No automatic wake-up, no platform-mediated routing, no fake-message-injection.

## What got reverted (and why)

The original Phase 1 design also shipped a `forward_to_group` MCP tool that delivered messages to the recipient's Telegram chat AND injected them into her processing pipeline. After six follow-up commits chasing failures across multiple authorization layers (Telegram bot-to-bot filtering, target-trigger requirements, sender-allowlist gating, `is_bot_message` filters in the message-pulling SQL), the design proved fundamentally mis-matched with the platform's threat model. Pivoted to file-mailboxes. See `lode/lessons.md` for the lesson; `progress.md` for the full chronology.

## Phase 2 / Phase 3 — deferred

The earlier plan called for:
- **Phase 2:** mailroom `route_to_group` rule action + `routings` table for inbound email routing to non-Inbox Madisons.
- **Phase 3:** scoped `mcp__inbox__*` MCP for routed-recipient groups, server-side authorization keyed off the routings table.

These are real and well-specified, but speculative. The use cases that motivated them (high-volume cold-email outreach with AVP handling replies via Inbox's send tools) haven't been pressure-tested against the file-mailbox model. The file-mailbox handles the "Jeff drops a doc, AVP processes it" use case without any Phase 2/3 work. The "Inbox routes Deb's reply to AVP" use case can also work via file-mailbox: Inbox writes a summary + thread-id reference into `_Shared/Inbox/telegram_avp/`, AVP reads it, drafts a reply for Inbox to send via her existing tools.

If the file-mailbox model proves insufficient (latency, volume, ergonomics), Phase 2/3 are still on the shelf and can be picked up. Until then, YAGNI.

## Decisions

| Decision | Decided on | Rationale |
|---|---|---|
| `_Shared/` mounted RW into every working-group container | 2026-04-28 | Foundation for any cross-group collaboration. RW because both reading and writing happen on every Madison's side. |
| Move all three mailroom config files to `_Shared/_Settings/` (deferred) | 2026-04-28 | Rationale stands but only relevant if Phase 3 (scoped inbox MCP) is built. Skip until then. |
| File-mailbox over `forward_to_group` MCP | 2026-04-28 | After 6 commits trying to make MCP-driven cross-Madison messaging work end-to-end, the layered authorization fights and Telegram bot-to-bot filtering made the architecture unrecognizable. File-mailbox needs zero new authorization paths and the user naturally coordinates handoff timing. |
| Phase 2/3 deferred, not abandoned | 2026-04-28 | Plan and findings remain in tree. Picking them up later requires concrete pain points, not speculation. |

## Errors

| Error | Resolution |
|---|---|

*(empty — no implementation work currently active)*

## Related

- `lode/lessons.md` — two new lessons from this plan: (a) don't fight the chat platform's threat model for agent-to-agent traffic; (b) cache invalidation must consider whole source trees, not single files
- `lode/groups.md` — group roster
- `lode/practices.md` — per-group `_attachments/` convention (still relevant for files a Madison wants to keep long-term after pulling from `_Shared/`)
- `~/Projects/mailroom/lode/infrastructure/mailroom-rules.md` — would be relevant if Phase 2/3 are picked up later
- `src/container-runner.ts` — `_Shared/` mount + the cache-invalidation fix

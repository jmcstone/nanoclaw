# Findings — Cross-Lead Workflows

## Existing architecture (verified)

- Per-group isolation is enforced for both Obsidian vault and a-mem ChromaDB. Confirmed in `lode/groups.md` and `lode/infrastructure/a-mem.md` ("no cross-group memory bleed").
- `_Settings/` already exists at `~/Documents/Obsidian/Main/NanoClaw/_Settings/` as a host-level shared config folder — precedent for adding `_Shared/` at the same level.
- Mailroom owns email rules. Source of truth: `~/Documents/Obsidian/Main/NanoClaw/Inbox/_Settings/rules.json` (real file, Obsidian-Sync transported, mtime-polled by mailroom services). No automated approval gate today; approval is conversational with Jeff.
- Inbound email events flow Mailroom → mailroom-subscriber channel → resolved via `findEmailTargetJid` (`src/channels/email-routing.ts`) → currently always Madison Inbox. Phase 2 generalizes this so rule-matched events route via `forward_to_group` instead.
- Inbox already has Gmail/Proton MCP tools (`mcp__inbox__send_message`, `mcp__inbox__send_reply{,_all}`, `mcp__inbox__send_forward`) — verified to preserve threading (`In-Reply-To` / `References`) via `getThreadingHeaders()` in `~/Projects/mailroom/src/mcp/tools/reply_common.ts`. Phase 3 reuses these directly, no new email infra.
- Mailroom MCP access is gated on `groupFolder === 'telegram_inbox'` (`madison-pipeline.md`). AVP has no `mcp__inbox__*` access today — driving the Phase 2 design decision to extract attachments to `_Shared/Attachments/` via the rule action rather than expecting AVP to fetch them.
- Mailroom config (rules.json + accounts.json + rules-changelog.md) lives in a **single directory** read via `MAILROOM_CONFIG_DIR` (`~/Projects/mailroom/src/rules/loader.ts:65`). Bind-mounted as a whole directory; per-file mounts are explicitly broken (inode-pinning bug resolved Phase 9 of `mail-push-redesign`). Drives the migration design.
- Per-group `_attachments/` subfolder convention is established (`Inbox/_attachments/`, `AmericanVoxPop/_attachments/`, `AlgoTrader/_attachments/`, `Personal/_attachments/`) — `_Shared/Attachments/` is a transit area, not a replacement.

## Threading spike (Phase 3 prerequisite — RESOLVED)

**Question:** does mailroom's send-tool path preserve `In-Reply-To` / `References` headers when AVP-routed email is replied to?

**Answer: yes, already.** Verified at:
- `~/Projects/mailroom/src/mcp/tools/reply_common.ts:53-55` — `getThreadingHeaders(message)` reads stored `references_header` + `in_reply_to` from the message row, merges with the source message-id, returns wrapped headers.
- `~/Projects/mailroom/src/mcp/sender.ts:59-62` — sets `In-Reply-To` and `References` headers on the outgoing message.
- `~/Projects/mailroom/src/mcp/tools/send_forward.ts:41` — explicit `preserve_thread` flag for forwards (default off, since "Fwd:" semantically starts a new thread).
- Gmail also threads via API-level `threadId` (`sender.ts:135`).

**Implication for the plan:** threading is *not* a nanoclaw concern. The proxy contract just needs to carry `original_message_id` end-to-end so Inbox can invoke the existing `send_reply{,_all}` / `send_forward` tools against the stored message. The risk that *was* "do we need new threading code?" becomes "make sure the cross-group payload schema includes `original_message_id`."

## Design decisions and reasoning

### Why path 1+2 (shared dropbox + router forward) over swarm or fan-out

- The use cases require *real* Madison Inbox (with mailroom subscriber, scheduled cron jobs, email tools) and *real* Madison AVP (with her vault, her a-mem, her business-directory schema). A swarm container of fresh personas doesn't have these.
- Use cases are *targeted handoffs* (this email → AVP), not broadcast (everyone sees everything). Fan-out to all leads would create noise.

### Why user-managed rules over thread-ownership state

- User explicitly flagged the workflow as still being flushed out. Rigid thread-tagging would freeze in assumptions that will change.
- Mailroom already has a rules engine and an editable rules file. Adding a `forward_to_group` action is mechanical; building thread-tag state machinery would be net-new infrastructure.
- Matches the existing trust model: Madison edits config, Jeff approves in chat. No new approval pattern to learn.

### Why proxy-through-Inbox for outbound email

- Single audit trail — every send shows up in Inbox's view of the world.
- Avoids credential duplication across containers.
- Gives a natural gate-point if future flows want pre-send approval, throttling, or audit logging.
- Failure mode if it adds friction: easy to flip — give AVP her own SMTP credentials and skip the proxy. The interface stays the same.

### Why a single approval point (AVP chat) instead of double-prompt

- Jeff is naturally in the loop in AVP's chat where the draft is composed and reviewed.
- Inbox re-prompting would create dialogue ping-pong without adding safety.
- Trust between leads is bounded — only forwards from registered Madisons execute without re-prompt. Outside-origin requests would be a different code path (and don't exist today).

### `from` resolution

- `send`: `from` required. No reasonable default for a fresh outbound — making AVP pick keeps the choice explicit.
- `reply` / `reply_all`: default to the account that received the original. Matches every standard email client.
- `forward`: same default. Override allowed (e.g., forwarding from a personal account to a business account context).
- All three are already handled in mailroom's send tools — proxy just passes `from_account` through when AVP overrides.

### `include_original_attachments` defaults

- `reply` / `reply_all`: default `false`. Recipients already have the attachments; resending is rare and noisy.
- `forward`: default `true`. The whole point of forwarding is usually to share the original payload.
- Either way, AVP confirms in chat before send so accidental include/exclude is caught.

### Where account roster lives — `_Shared/_Settings/` (and rules + changelog along with it)

Originally the plan said "move accounts.json." On investigation:
- Mailroom reads all three config files (`rules.json`, `accounts.json`, `rules-changelog.md`) from one `MAILROOM_CONFIG_DIR`.
- Per-file mounts are explicitly broken in this stack (see Phase 9 of `mail-push-redesign`).
- Splitting `accounts.json` out forces either a second env var (`MAILROOM_ACCOUNTS_DIR`) or a per-file mount — both worse than moving the whole dir.

So the migration is "move the whole `_Settings/` content to `_Shared/_Settings/`" with mailroom's compose mounts repointed accordingly. Madison Inbox's edit path becomes `/workspace/extra/shared/_Settings/rules.json` (her existing `_Shared/` RW mount from Phase 1 covers this). AVP gets read access for free via the same Phase-1 mount.

### Attachments lifecycle for Phase 2 cross-group routing

- AVP has no `mcp__inbox__*` access (mailroom MCP gated on `telegram_inbox`).
- Mailroom's `forward_to_group` rule action extracts attachments at routing time via `fetchAttachmentTool` (already existing) and writes to `_Shared/Attachments/<message_id>/<position>-<sanitizedFilename>`.
- Receiving Madison reads from `/workspace/extra/shared/Attachments/` and copies what she wants to keep into her vault's `_attachments/` (existing per-group convention).
- 30-day mtime GC keeps `_Shared/Attachments/` from growing unboundedly. Matches "scratch inbox" semantics already established for `/workspace/downloads/` in `practices.md`.
- Phase 3 outbound (`send_forward`) does NOT need this path — mailroom's `send_forward` re-fetches attachments from `store.db` at send time given `original_message_id`.

### `_Shared/` mounted RW to every group, not RO

- Phase 1's drop zone (`_Shared/Inbox/{groupName}/`) needs writes from any group when `forward_to_group` writes a file payload.
- Phase 2's `_Shared/Attachments/` is written by mailroom but read by recipients; mailroom container needs RW, recipient containers need RO — but recipients also write to their own subdirs in `_Shared/Inbox/`, so a single RW mount per agent container is simpler.
- Trust model is "registered Madisons only" — same as why each group has full RW on her own vault. Discipline beats per-file ACLs at this scale.

### Failure modes for `router.forwardTo` / `forward_to_group`

| Condition | Behavior |
|---|---|
| Target container cold/idle | Enqueue via existing `group-queue.ts`; container spawns on next tick |
| Target group unregistered | Log error to mailroom error log; fall back to Madison Inbox (mirrors `findEmailTargetJid`'s `isMain` fallback) |
| Filesystem write to `_Shared/` fails | Hard error; mailroom rule engine retries per existing semantics |
| Attachment extraction fails | Forward text-only with `[attachments failed: see error log]` annotation; do not fail the whole forward |

## Open questions to revisit during implementation

- Verify mailroom's `send_reply{,_all}` accept `include_attachments: false`. If not, file mailroom follow-up (small change to `reply_common`).
- Confirm that mailroom's existing `_Shared/Attachments/` writer can run from inside the mailroom ingestor container (network mount, permissions). Likely fine since both nanoclaw and mailroom containers see the host's `~/Documents/Obsidian/Main/NanoClaw/` via bind mounts.
- 30-day GC implementation: standalone cron entry vs. mailroom periodic task. Decide during Phase 2 — leaning toward mailroom periodic task since mailroom is already running and knows when extraction happens.
- Does AVP need her own `_attachments/inbox/` subfolder convention for files she copies out of `_Shared/Attachments/`, or does flat `_attachments/` suffice? Probably flat — match the existing per-group pattern.
- Future scope: rule action `draft_for_review` (rule auto-drafts a reply for AVP to review) — not in this plan, but the foundation should not preclude it. Renamed from earlier overloaded `request_email` to keep `send_via_inbox` (the MCP tool) distinct.

## Use cases captured (from design conversation)

1. Jeff drops branding doc into `_Shared/Inbox/americanvoxpop/` → AVP processes → updates Business Directories assets at `~/Documents/Obsidian/Main/NanoClaw/AmericanVoxPop/Digital Presence/Business Directories/Assets/`.
2. Jeff and AVP review existing assets, decide on outreach → AVP composes email → Jeff approves in AVP chat → Inbox sends via `send_via_inbox`.
3. Business owner replies to outreach → mailroom rule (e.g., "from Deb with Business Directories keyword") routes to AVP via `forward_to_group` → AVP processes response, updates docs, drafts follow-up using `send_via_inbox` with `original_message_id` set to the routed message.

## Resources

- `lode/groups.md` — current group roster, isolation guarantees
- `lode/practices.md` — Obsidian + a-mem layout conventions, attachments handling
- `lode/infrastructure/madison-pipeline.md` — mailroom-subscriber inbound path
- `~/Projects/mailroom/lode/infrastructure/mailroom-rules.md` — rule engine, rules.json shape, edit/reload pattern (will be updated for `_Shared/_Settings/` mount)
- `~/Projects/mailroom/lode/reference/rules-schema.md` — current rule action schema (extend with `forward_to_group` in Phase 2)
- `~/Projects/mailroom/src/mcp/tools/reply_common.ts` — `getThreadingHeaders()` (proves Phase 3 threading works without new code)
- `~/Projects/mailroom/src/mcp/tools/send_forward.ts` — attachment handling reference for Phase 3 forward op
- `~/Projects/mailroom/src/rules/loader.ts` — `MAILROOM_CONFIG_DIR` semantics (drives the all-three-files migration)
- `src/router.ts`, `src/channels/email-routing.ts` — orchestrator hooks for Phase 1 and Phase 2 routing

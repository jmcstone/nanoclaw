# Cross-Lead Workflows — Tracker

Branch: `feat/cross-lead-workflows` *(planning only — not yet created)*

**Scope:** This plan touches **two repos** — nanoclaw (`~/containers/nanoclaw`) and mailroom (`~/Projects/mailroom`). Phase 2 modifies mailroom's rules engine; Phase 3 modifies mailroom's docker-compose mounts. Phases must be released in coordination — flip mailroom mounts only when both repos are ready.

## Goal

Enable the AmericanVoxPop Madison to collaborate with the Inbox Madison on email-driven workflows: receive files Jeff drops for processing, hand emails between leads via user-managed routing rules, and send/reply/forward email through Inbox's existing email infrastructure — all without breaking per-group isolation for memory and vaults.

## Currently in Phase 0 — design captured, awaiting go-ahead to implement Phase 1

## Phases

### Phase 1 — Cross-group foundation (file + message handoff)

- [ ] Create `~/Documents/Obsidian/Main/NanoClaw/_Shared/` with subfolders: `Inbox/{groupName}/` (addressed drop zones — see addressing note below), `Attachments/` (durable email-attachment transit area)
- [ ] Mount `_Shared/` RW into every working-group container at `/workspace/extra/shared/` (RW because Phase 1 needs writes from any group; trust model is "registered Madisons only")
- [ ] Add `router.forwardTo(groupJid, message, attachmentRef?)` in `src/router.ts`. Failure modes: target container cold → enqueue via existing `group-queue`; group unregistered → log error and fall back to Madison Inbox (mirrors `findEmailTargetJid` behaviour); filesystem write failure → hard error, surface to caller
- [ ] Expose `forward_to_group` MCP tool inside containers (wraps router call); returns `{ ok: bool, queued: bool, error?: string }`
- [ ] **Test A (file handoff):** drop branding doc in `_Shared/Inbox/americanvoxpop/`, ask AVP to process it into `Digital Presence/Business Directories/Assets/`
- [ ] **Test B (message handoff):** from Inbox chat, instruct Madison to use `forward_to_group` to ask AVP for her business-directory schema. Verify roundtrip: AVP receives with `[from Inbox]` attribution, AVP responds, response shows back in Inbox with attribution

#### `_Shared/Inbox/` addressing convention

- Path: `_Shared/Inbox/<groupName>/<filename>` where `<groupName>` matches the orchestrator's group folder (e.g. `americanvoxpop`, `algotrader`, `inbox`)
- Pure convention — no code enforces the subdir. Jeff (or `forward_to_group` writer) writes to the right path. Recipient Madison watches her own subdir and moves files to her vault's `_attachments/` per existing practices.md pattern.
- All groups have RW on the whole `_Shared/` tree. If discipline becomes an issue we can split mounts; not worth doing prematurely.

### Phase 2 — User-managed inbound routing rules

- [ ] Add `forward_to_group` action type to mailroom rules engine (`src/rules/apply/{proton,gmail}.ts`)
- [ ] When `forward_to_group` fires on a message with attachments: extract bytes via existing `fetchAttachmentTool`, write to `_Shared/Attachments/<message_id>/<position>-<sanitizedFilename>`, include the path list in the routed event payload. Failure to extract → forward text-only with `[attachments failed: see error log]` note.
- [ ] Add `_Shared/Attachments/` 30-day mtime garbage-collector (cron entry or mailroom periodic task — decide during impl)
- [ ] Extend `rules.json` schema to support the new action; document in `~/Projects/mailroom/lode/reference/rules-schema.md`
- [ ] Inbox-side tool: propose / add / remove rule entries (Madison edits `_Shared/_Settings/rules.json` after Jeff approves in chat — same pattern as existing rules)
- [ ] Mailroom dispatch event flows through `router.forwardTo` when rule matches
- [ ] Test: add rule "from Deb + subject contains Business Directories → forward to AVP", send test email with attachment, confirm it lands in AVP chat with attachment path resolvable from `_Shared/Attachments/`

### Phase 3 — Outbound email via Inbox proxy

- [ ] **Migrate mailroom config to `_Shared/_Settings/`** — see "accounts.json migration" detail below; supersedes the original "move accounts.json" bullet
- [ ] Define `send_via_inbox` MCP tool signature in AVP container — ops: `send` / `reply` / `reply_all` / `forward`. For reply/reply_all/forward, payload **must carry `original_message_id`** (mailroom's stored id) so Inbox can invoke the existing send tool against the stored message; for `send` the field is omitted. (Tool renamed from earlier draft `request_email` to disambiguate from a future rule-action `draft_for_review`.)
- [ ] Inbox-side executor: receives `send_via_inbox` payloads via router and proxies to mailroom's existing MCP tools — `mcp__inbox__send_message` (send), `mcp__inbox__send_reply{,_all}` (reply), `mcp__inbox__send_forward` (forward). **No new threading logic in nanoclaw** — mailroom's `getThreadingHeaders()` (`src/mcp/tools/reply_common.ts`) already preserves `In-Reply-To` / `References` from the stored message.
- [ ] `from` resolution: required for `send`; for reply/reply_all/forward Inbox lets mailroom's send tool resolve from the stored message (its current default); explicit override forwarded as `from_account`
- [ ] `include_original_attachments`: defaults — reply=false, forward=true; AVP confirms in chat before sending. Maps onto mailroom's `send_forward` `include_attachments` / `attachment_positions` args. Reply path: pass `include_attachments: false` to `send_reply{,_all}` (verify the tool accepts this; if not, file follow-up in mailroom)
- [ ] Per-context defaults: `AmericanVoxPop/_Settings/email-defaults.json` (default_from, signature) — Madison-edited, Jeff-approved
- [ ] Single approval point: Jeff approves in AVP chat; Inbox does not re-prompt (trusted lead-to-lead handoff)
- [ ] Send-confirmation observability: `send_via_inbox` is synchronous within the proxy and returns `{ ok, message_id, sent_at, from_account }` or `{ ok: false, error }`. AVP reports outcome to Jeff in chat. Async failures (e.g. SMTP reject after acknowledgement) surface in Madison Inbox's chat — cross-group failure feedback is out of scope here
- [ ] Test: full loop — Deb's reply lands in AVP via Phase 2 rule, you discuss with AVP, AVP sends a reply back, Inbox confirms `message_id`, threading verified by inspecting stored sent message's `In-Reply-To` / `References` headers

#### accounts.json migration (Phase 3, replaces original one-line bullet)

Mailroom reads `rules.json`, `accounts.json`, and `rules-changelog.md` from a single `MAILROOM_CONFIG_DIR` (default `/var/mailroom/config`, currently bind-mounted from `Inbox/_Settings/`). Per-file mounts are explicitly broken (inode-pinning issue resolved in Phase 9 of `mail-push-redesign`). So splitting only `accounts.json` would force a second config dir or fragile per-file mounts. **Move all three together.**

- [ ] Create `~/Documents/Obsidian/Main/NanoClaw/_Shared/_Settings/`
- [ ] Move `rules.json`, `accounts.json`, `rules-changelog.md` from `Inbox/_Settings/` → `_Shared/_Settings/`
- [ ] Update mailroom `docker-compose.yml` bind mount on **both** `ingestor` and `inbox-mcp` services: `${HOME}/Documents/Obsidian/Main/NanoClaw/_Shared/_Settings:/var/mailroom/config:ro`
- [ ] Madison Inbox container already gets `_Shared/` RW from Phase 1 — confirm she can edit `_Shared/_Settings/rules.json` from `/workspace/extra/shared/_Settings/`
- [ ] AVP container also already gets `_Shared/` RW from Phase 1 — gives her `accounts.json` read access for `from` validation. (AVP won't edit it; convention only.)
- [ ] Run mailroom `rules-validate` CLI from inside containers against new path before declaring complete
- [ ] Update docs: nanoclaw `lode/infrastructure/madison-pipeline.md`; mailroom `lode/infrastructure/mailroom-rules.md`; mailroom `lode/reference/rules-schema.md`. Old `Inbox/_Settings/rules.json` references → new `_Shared/_Settings/rules.json` paths
- [ ] Verify legacy `MAILROOM_DATA_DIR` fallback still works for one deploy cycle (defensive — currently expected to be unused)

## Decisions

| Decision | Decided on | Rationale |
|---|---|---|
| Path 1+2 (shared dropbox + router forward) over swarm or fan-out | 2026-04-28 | Use cases need *real* Madisons (with vaults/memory/tools); swarm doesn't get us existing Inbox email infra; fan-out is overkill for targeted handoffs. |
| User-managed rules (Madison edits, Jeff approves) over static thread-ownership tagging | 2026-04-28 | Process is being flushed out — rules will change. Matches existing mailroom rules pattern (rules.json + mtime poll). Avoids hidden state. |
| Proxy-through-Inbox for outbound email over giving AVP its own send creds | 2026-04-28 | Single audit trail, no duplicated credentials, gives a natural future approval gate point. Cheap to flip later if friction emerges. |
| Single approval point in AVP chat (Inbox does not re-prompt) | 2026-04-28 | Jeff is in the loop where the draft is composed. Re-asking in Inbox would be redundant. Lead-to-lead trust within the trusted set. |
| Move all three mailroom config files to `_Shared/_Settings/`, not just `accounts.json` | 2026-04-28 | Mailroom reads rules + accounts from a single `MAILROOM_CONFIG_DIR`; per-file mounts are a known-broken pattern. Single dir move keeps the proven directory-mount design. |
| `_Shared/` mounted RW (not RO) into every group | 2026-04-28 | Phase 1 needs writes from any group (drop zones, attachment writes). Discipline of "Madisons don't edit what isn't theirs" matches existing per-group vault model. |
| Attachment transit via `_Shared/Attachments/` written by mailroom rule action | 2026-04-28 | AVP doesn't have `mcp__inbox__*` access (gated on `telegram_inbox`); rule action extracts bytes once. 30-day GC matches scratch-inbox semantics from `practices.md`. |
| `include_original_attachments` defaults: reply=false, forward=true | 2026-04-28 | Matches typical email client behavior. Override available. |
| `from` required on `send`, defaults to recipient-account on reply/forward, override allowed | 2026-04-28 | Mirrors how every standard email client resolves the field. Mailroom's existing `send_reply` already handles this. |
| `send_via_inbox` (renamed from `request_email`) | 2026-04-28 | Disambiguates from future rule-action `draft_for_review`. Tool name describes the proxy action explicitly. |
| Threading correctness handled at mailroom layer, not nanoclaw | 2026-04-28 | Verified: `getThreadingHeaders()` already merges `In-Reply-To`/`References` from stored message. Proxy contract requirement: `send_via_inbox` payload must carry `original_message_id`. |

## Errors

| Error | Resolution |
|---|---|

*(empty — populated during implementation)*

## Related

- `lode/groups.md` — group roster, current isolation model
- `lode/practices.md` — per-group data layout, attachments convention (`_attachments/` per vault)
- `lode/infrastructure/madison-pipeline.md` — mailroom-subscriber inbound path (extends here)
- `~/Projects/mailroom/lode/infrastructure/mailroom-rules.md` — current rule engine + rules.json shape (will be updated for new mount path)
- `~/Projects/mailroom/lode/reference/rules-schema.md` — rule schema (extend in Phase 2)
- `src/router.ts` — where `forwardTo` lands
- `src/channels/email-routing.ts` — `findEmailTargetJid`; superseded for AVP-owned threads by Phase 2 rules
- `~/Projects/mailroom/src/mcp/tools/reply_common.ts` — `getThreadingHeaders()` proves Phase 3 threading is already correct at the send layer
- `~/Projects/mailroom/src/rules/loader.ts` — `MAILROOM_CONFIG_DIR` reader; documents the single-dir constraint that drives the migration design

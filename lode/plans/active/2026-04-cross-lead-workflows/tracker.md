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

Names: rule action is `route_to_group` (NOT `forward_to_group` — that's the Phase 1 Madison-to-Madison MCP tool, kept distinct).

- [ ] Add `routings` table to mailroom's store: `(message_id, group_folder, rule_id, routed_at)` PK on `(message_id, group_folder)`, indexed on `(group_folder, routed_at)`. This is the authorization gate Phase 3 uses to scope AVP's view of the inbox.
- [ ] Add `route_to_group` action type to mailroom rules engine (`src/rules/apply/{proton,gmail}.ts`). Action: insert `routings` row + emit IPC event for `nanoclaw` to deliver.
- [ ] Routed event payload to nanoclaw includes: subject, sender, body preview (~500 char), `message_id`, attachment count, `from_account`, `routed_to` group folder. **Body and attachments are NOT copied** — recipient pulls via the scoped Phase 3 MCP when she needs more.
- [ ] Extend `rules.json` schema to support the new action; document in `~/Projects/mailroom/lode/reference/rules-schema.md` and `src/rules/schema.md`
- [ ] Inbox-side tool: propose / add / remove rule entries (Madison edits `_Shared/_Settings/rules.json` after Jeff approves in chat — same pattern as existing rules)
- [ ] nanoclaw-side: extend `mailroom-subscriber` to accept `route_to_group`-flagged events and dispatch to the indicated `routed_to` group's chat (no fall-through to default Madison Inbox routing)
- [ ] Test: add rule "from Deb + subject contains Business Directories → route to AVP", send test email with attachment, confirm AVP chat receives the routed-email message with `message_id` she can later use against the Phase 3 MCP

### Phase 3 — Scoped inbox MCP for routed-recipient groups

Replaces earlier "outbound email via Inbox proxy" design. Instead of building a new `send_via_inbox` MCP tool that proxies through Inbox's container, **register mailroom's existing inbox MCP for the recipient group's container with server-side scoping** keyed off the `routings` table from Phase 2. Recipient sees the same tool surface Madison Inbox sees, just narrowed to her own routed messages plus new-outbound (governed by `from_account` allowlist).

- [ ] **Migrate mailroom config to `_Shared/_Settings/`** — see "accounts.json migration" detail below; recipient groups need RO read of `accounts.json` for `from_account` validation in new-outbound
- [ ] Mailroom MCP server: add server-side authorization layer keyed on calling group's folder name (HTTP header or per-group endpoint URL — decide during impl). Read tools (`get_message`, `thread`, `attachment_to_path`) and message-bound send tools (`send_reply`, `send_reply_all`, `send_forward`) require `(message_id, calling_group)` to exist in `routings`. New-outbound (`send_message`) requires `from_account` to be in `accounts.json` with a tag the calling group is allowed to send from (extend `accounts.json` schema with a per-account `allowed_groups: []` field if needed; default-empty means Inbox-only)
- [ ] nanoclaw container-runner: when target group has any `routings` rows, register the inbox MCP for that container with the group-scoped endpoint
- [ ] Threading: AVP calls `mcp__inbox__send_reply(message_id, body)` directly — mailroom's existing `getThreadingHeaders()` preserves `In-Reply-To` / `References`. **No proxy, no `original_message_id` payload field, no new threading logic anywhere**
- [ ] Attachment access: AVP calls `mcp__inbox__attachment_to_path(message_id, position)` — mailroom writes bytes to AVP's container `/workspace/inbox-attachments/<message_id>/<filename>` (existing tool, scoped by routings check). No `_Shared/Attachments/` rendezvous, no extraction-at-routing-time
- [ ] `from` resolution: `send_message` requires `from_account`; reply/forward tools default to recipient-account on the stored message (mailroom's existing default), explicit override allowed
- [ ] `include_original_attachments` defaults: reply/reply_all = false, forward = true. Maps onto existing `send_reply{,_all}` / `send_forward` args. Verify reply tools accept `include_attachments: false`; if missing, file mailroom follow-up
- [ ] Per-context defaults: `AmericanVoxPop/_Settings/email-defaults.json` (default_from, signature) — Madison-edited, Jeff-approved. Read by AVP at compose time; not a mailroom concern
- [ ] Single approval point: Jeff approves in AVP chat. No second prompt anywhere — AVP calls send tool directly, mailroom executes
- [ ] Send-confirmation observability: send tools return `{ ok, message_id, sent_at, from_account }` synchronously — same shape mailroom already returns to Inbox today
- [ ] Test: full loop — Deb's reply routed to AVP via Phase 2 rule with `message_id=X`, AVP fetches body via `get_message(X)` and an attachment via `attachment_to_path(X, 0)`, AVP composes via Jeff-approved `send_reply(X, body, include_attachments=false)`, threading verified by inspecting the sent message's `In-Reply-To` / `References` headers

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
| `_Shared/` mounted RW (not RO) into every group | 2026-04-28 | Phase 1 needs writes from any group (drop zones). Discipline of "Madisons don't edit what isn't theirs" matches existing per-group vault model. |
| **Replaced: scoped inbox MCP for recipient groups, gated by `routings` table** — supersedes earlier "extract attachments to `_Shared/Attachments/` + build `send_via_inbox` proxy" design | 2026-04-28 | Recipient gets the same MCP surface Madison Inbox has, scoped server-side to her routed messages. No bytes copied, no proxy-rebuild of threading semantics, no shared transit dir to GC. The `routings` table is the authorization handle — `(message_id, group_folder)` row exists ⇒ recipient can read/reply/forward. AVP gets subject + body + attachments naturally via the same tools Inbox uses. |
| Rule action named `route_to_group`, not `forward_to_group` | 2026-04-28 | `forward_to_group` is the Phase 1 Madison-to-Madison MCP tool (already shipped). Different verb, different surface — `route_to_group` is mailroom's rule-engine action that delivers an inbound email to a group. Avoids semantic collision. |
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

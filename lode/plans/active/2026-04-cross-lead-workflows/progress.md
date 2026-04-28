# Progress — Cross-Lead Workflows

## 2026-04-28 — Planning

- Design conversation captured. Three options surveyed (shared dropbox + router forward, swarm, fan-out). Chose path 1+2.
- Use cases established: branding-doc handoff (Jeff → AVP), AVP-drafted email send via Inbox, business-owner reply routed back to AVP via rule.
- Decisions locked: user-managed rules over thread-ownership tagging; proxy-through-Inbox for outbound; single approval point in AVP chat; `accounts.json` relocated to `_Shared/_Settings/`; default `include_original_attachments` reply=false / forward=true; `from` required on send, account-resolved otherwise.
- `tracker.md` and `findings.md` written. Implementation not started.

## 2026-04-28 — Phase 2/3 redesign: scoped inbox MCP replaces attachment transit + send proxy

After Phase 1 shipped, Jeff pushed back on two earlier design choices:

1. **"It's clunky to copy attachments to a shared folder when they're already in mailroom's store."** Agreed — dropped `_Shared/Attachments/` extraction step from Phase 2.
2. **"What AVP gets is almost a wrapped version of some of the MCP tools Madison Inbox has."** That framing crystallized the right design.

**New design** (replaces ~half of the old Phase 2 + all of the old Phase 3):
- Phase 2 adds a `routings` table in mailroom: `(message_id, group_folder, rule_id, routed_at)`. Rule action renamed `forward_to_group` → `route_to_group` to avoid colliding with the Phase 1 Madison-to-Madison MCP tool.
- Phase 3 stops building a `send_via_inbox` proxy. Instead, mailroom's existing inbox MCP gets a server-side authorization layer keyed off the calling group; routed-recipient containers register the same MCP, scoped to their own routings.
- Recipient (e.g., AVP) sees the same tool surface as Madison Inbox: `mcp__inbox__get_message`, `attachment_to_path`, `send_reply{,_all}`, `send_forward`, `send_message`. Each call validates against `routings` (or against `accounts.json` allow-list for new-outbound).
- Threading correctness is automatic — recipient calls existing mailroom send tools directly; `getThreadingHeaders()` runs as it does today.
- No `_Shared/Attachments/` folder, no GC, no `original_message_id` payload field, no proxy hop.

Tracker + findings updated. `_Shared/Attachments/` directory still exists on disk (created in Phase 1 as part of `_Shared/` skeleton) but has no consumers in the new design — leaving it as a noop dir for now in case future use cases emerge.

## 2026-04-28 — Plan review pass (10 issues raised, all resolved)

Senior-engineer review of the plan surfaced 10 issues across 3 tiers. All resolved into tracker/findings updates without code changes:

- **Tier 1 — blockers resolved before Phase 1:**
  - **Threading correctness (#1):** verified mailroom's `getThreadingHeaders()` already preserves `In-Reply-To`/`References` from stored messages; `send_forward` has explicit `preserve_thread` flag; Gmail also threads via API `threadId`. **Risk shifts to proxy contract** — `send_via_inbox` payload must carry `original_message_id`. Captured in tracker Phase 3 + findings.
  - **`accounts.json` migration (#3):** discovered mailroom reads `rules.json` + `accounts.json` + `rules-changelog.md` from a single `MAILROOM_CONFIG_DIR`; per-file mounts are explicitly broken (Phase-9 inode-pinning fix in `mail-push-redesign`). Plan rewritten to move all three files together, update mailroom compose mounts on both ingestor + inbox-mcp services, run `rules-validate` against new path before flipping, update three doc files across two repos.

- **Tier 2 — spec tightening:**
  - **Attachments lifecycle (#2):** AVP has no `mcp__inbox__*` access (gated on `telegram_inbox`); designed `_Shared/Attachments/<message_id>/<position>-<filename>` transit area written by mailroom's `forward_to_group` rule action via existing `fetchAttachmentTool`. 30-day mtime GC. Phase 3 outbound doesn't need this — `send_forward` re-fetches from `store.db`.
  - **`_Shared/Inbox/` addressing (#5):** `_Shared/Inbox/<groupName>/` per-recipient subdirs; pure convention, no enforcement.
  - **Forward failure modes (#6):** cold container → `group-queue` enqueue; unregistered → fall back to Madison Inbox + log; filesystem write failure → hard error; attachment failure → text-only with annotation.
  - **Phase 1 message-handoff test (#7):** added explicit AVP↔Inbox roundtrip test alongside the file handoff test.
  - **`request_email` naming collision (#8):** Phase 3 MCP tool renamed to `send_via_inbox`; future rule-action future-scope reserved as `draft_for_review`.
  - **Send-confirmation observability (#9):** `send_via_inbox` is sync within the proxy, returns `{ ok, message_id, sent_at, from_account }`; AVP reports outcome to Jeff in chat. Async SMTP failures surface in Madison Inbox's chat (cross-group failure feedback out of scope).
  - **Cross-repo scope flag (#4):** added top-of-tracker note that this plan touches both nanoclaw and mailroom and phases must release in coordination.

- **Tier 3 — small fixes:**
  - Decisions table extended with "Decided on" column.
  - Implementation branch named: `feat/cross-lead-workflows` (single branch, phase-tagged commits).

- **Net result:** plan is denser but materially safer to start from. Tier-1 blockers are gone — both questions had known good answers in mailroom's existing code.

## Test results

| Test | Status | Notes |
|---|---|---|

*(populated during implementation)*

## Error log

| Timestamp | Error | Resolution |
|---|---|---|

*(populated during implementation)*

## 5-question reboot check

1. **Where am I?** Phase 0 — design captured + reviewed; plan revised after 10-issue review pass. Awaiting Jeff's go-ahead to start Phase 1.
2. **Where am I going?** Phase 1: create `_Shared/{Inbox,Attachments}/` (drop zone with per-group subdirs + attachment transit area) and add `router.forwardTo` with documented failure modes. Two tests gate Phase 1 — file handoff (branding doc) AND message handoff (AVP↔Inbox roundtrip).
3. **What is the goal?** Enable AVP and Inbox to collaborate on email-driven workflows — file handoff, user-managed inbound rules, AVP-initiated outbound email through Inbox — without breaking per-group isolation.
4. **What have I learned?**
    - (a) Mailroom already has rules engine + editable rules.json with mtime poll; `forward_to_group` action plugs in cleanly.
    - (b) Per-group isolation is intentional and load-bearing for memory/vaults — `_Shared/` is the controlled exception.
    - (c) User wants the design to flex with a still-evolving process; static thread-ownership tagging would freeze too soon.
    - (d) Inbox already has all email send/reply infra via existing MCP tools (`mcp__inbox__send_message`, `send_reply{,_all}`, `send_forward`) — Phase 3 proxies, doesn't reinvent. Threading via `getThreadingHeaders()` is correct without any nanoclaw-side work.
    - (e) Mailroom's `MAILROOM_CONFIG_DIR` reads three files from one dir; per-file mounts are explicitly broken; migration must move all three to `_Shared/_Settings/` together.
    - (f) AVP has no `mcp__inbox__*` access (gated on `telegram_inbox`), so Phase 2 needs `_Shared/Attachments/` as a transit area written by the rule action — AVP can't fetch attachments herself.
5. **What have I done?** Wrote tracker.md, findings.md, progress.md. Did a senior-engineer review pass and applied 10 spec fixes. No code yet.

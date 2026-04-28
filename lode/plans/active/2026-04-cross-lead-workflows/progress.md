# Progress — Cross-Lead Workflows

## 2026-04-28 — Planning

- Design conversation captured. Three options surveyed (shared dropbox + router forward, swarm, fan-out). Chose path 1+2.
- Use cases established: branding-doc handoff (Jeff → AVP), AVP-drafted email send via Inbox, business-owner reply routed back to AVP via rule.
- Decisions locked: user-managed rules over thread-ownership tagging; proxy-through-Inbox for outbound; single approval point in AVP chat; `accounts.json` relocated to `_Shared/_Settings/`; default `include_original_attachments` reply=false / forward=true; `from` required on send, account-resolved otherwise.
- `tracker.md` and `findings.md` written. Implementation not started.

## 2026-04-28 — Pivot: stripped forward_to_group, kept file-mailbox model

After Phase 1 shipped (commit `7d823aa`), end-to-end testing revealed a stack of authorization layers that all rejected cross-Madison messages by design. Pivoted to a file-mailbox model after a 6-commit fight.

**Chronology of the fight:**

1. `7d823aa` Phase 1 — `_Shared/` mount + `forward_to_group` MCP tool. Tool registered, mount working, all unit tests green.
2. **Issue 1 — agent-runner cache stale.** Madison reported "I don't have a `forward_to_group` tool." Per-group agent-runner cache only checked `index.ts` mtime; my edit was in `ipc-mcp-stdio.ts`. Fix: `45c2454` — compare newest mtime across whole source tree, `rmSync` before `cpSync`.
3. **Issue 2 — recipient never woke up.** `forward_to_group delivered` log fired but no recipient container spawn. Cause: AVP requires `@Madison` trigger, the forwarded message format had `[from Source]` prefix but no trigger. Fix: `17f4de9` — prepend target's trigger when `requiresTrigger !== false`.
4. **Issue 3 — recipient classified the forward as a Jeff message.** AVP woke up but answered Jeff with "what did you mean?" because the framing didn't make peer-Madison context explicit. Two iterations of framing improvements: `8a6fd33` (named sender, reply guidance) and `c08afbc` (side-conversation framing, "don't drop user work").
5. **Issue 4 — Telegram filtered bot-to-bot.** Even after framing fixes, recipient still didn't wake on subsequent forwards. Discovered Telegram doesn't notify bots about other-bot messages in groups (documented loop prevention). External research confirmed this is a hard restriction; only escape valve is BotFather's "Bot-to-Bot Communication Mode" which Telegram themselves warn against. Fix attempt: `d28514e` — also inject the message into recipient's processing pipeline directly (mirroring mailroom-subscriber's path: `storeMessage` + `queue.enqueueMessageCheck`).
6. **Issue 5 — trigger check rejected the injected message.** Even after injection, container didn't spawn. Trigger check (`processGroupMessages` in `index.ts`) required `is_from_me=true` OR sender in per-chat allowlist. Injected message had neither. Fix attempt: `28174bd` — added `is_bot_message` short-circuit (mirror to existing pattern at line 717 of channel `onMessage` handler that bypasses sender-allowlist drop check for bot messages).
7. **Issue 6 — `getMessagesSince` filtered bot messages out before the trigger check ran.** Debug logging revealed `processGroupMessages` was called but `missedCount: 0`. Cause: `getMessagesSince` SQL filters `WHERE is_bot_message = 0`, so my `is_bot_message=true` injected message never even reached the trigger check. The `is_bot_message` bypass in trigger check was for code path the message couldn't reach.

At this point Jeff said: "this may not be the ideal design — let's go back to a much simpler shared folder model." Right call. Each fix peeled back another layer of authorization built around "messages come from external untrusted humans," and cross-Madison messages don't fit that threat model anywhere in the stack.

**Pivot — stripped `forward_to_group` entirely:**
- Removed `forward_to_group` MCP tool from `container/agent-runner/src/ipc-mcp-stdio.ts`
- Removed `forward_to_group` IPC handler + `injectMessage` plumbing from `src/ipc.ts` and `src/index.ts`
- Reverted the `is_bot_message` trigger-check bypass (no longer needed; was a workaround for a workaround)
- Removed `forward_to_group` test block from `src/ipc-auth.test.ts` (33 ipc-auth tests still green, down from 47 — the 14 forward-related tests went with the strip)
- Kept: `_Shared/` mount and the agent-runner cache invalidation fix (real, unrelated improvement)

**Lessons captured in `lode/lessons.md`:**
1. *Don't fight the chat platform's threat model — agent-to-agent traffic belongs on a separate bus.* When successive fixes are needed to thread peer-agent messages through chat-platform authorization layers, each fix exposes another layer; that's the smell. File-mailbox was the right answer all along.
2. *Per-group agent-runner cache must compare the whole source tree, not a single file.* The `index.ts`-only mtime check left stale per-group caches that masked freshly-shipped MCP tools.

**What remains in the plan:**
- `_Shared/` mount + directory tree (real)
- Phase 2/3 design docs (deferred — picking up only if file-mailbox proves insufficient under real load)

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

1. **Where am I?** Phase 1 shipped (`_Shared/` mount + agent-runner cache fix). `forward_to_group` MCP tool tried, fought 6 layers of platform/auth filters, reverted. File-mailbox is the working model. Phase 2/3 deferred until concrete pain.
2. **Where am I going?** Stay on the file-mailbox model and use it for real. Only revisit Phase 2/3 (mailroom routings table + scoped inbox MCP) if file-mailbox proves insufficient (latency, volume, ergonomic pain).
3. **What is the goal?** Cross-group Madison collaboration without breaking per-group isolation. Currently met for the file-handoff case via `_Shared/`. Email-side handoffs work through Madison Inbox + file-mailbox notes (Jeff coordinates timing).
4. **What have I learned?**
    - (a) Telegram filters bot-to-bot messages out of webhook updates — agent-to-agent messaging cannot ride on the chat platform.
    - (b) nanoclaw has at least four authorization layers (sender allowlist drop, sender-allowlist trigger gate, `is_bot_message` filter in `getMessagesSince`, target-trigger requirement) all designed for the threat model "messages come from external untrusted humans." Cross-Madison messages don't fit any of them.
    - (c) When successive fixes are needed to thread peer messages through those layers — each fix exposing another layer — the architecture is wrong, not the fix. File-mailbox sidesteps all of it.
    - (d) Per-group `_attachments/` convention is the established pattern for files that should persist; `_Shared/Inbox/<target>/` is the new transit area for files moving between groups.
    - (e) Per-group agent-runner cache had a real bug (only checked `index.ts` mtime) — kept the fix.
5. **What have I done?** Phase 1 mount + cache fix shipped. Stripped over-engineered `forward_to_group` after end-to-end testing exposed the platform mismatch. Captured lessons in `lode/lessons.md`. Plan and findings updated to reflect simpler model.

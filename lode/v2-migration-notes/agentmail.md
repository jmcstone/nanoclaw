---
status: active
target: v2 upgrade
written: 2026-05-03
last_v1: 1.2.42
purpose: Hand-off notes for porting the AgentMail integration when this fork upgrades to NanoClaw v2 (2.0.0+, released 2026-04-22).
---

# AgentMail integration — v2 migration notes

This document is **the** source of truth for what the v2 upgrade needs to do
about AgentMail. Built on v1 deliberately as a learning prototype; everything
here is expected to be redesigned on v2's primitives.

## What was built on v1

A standalone inbound channel + a per-group MCP server, with a single-inbox-
per-group config model.

| File | Change |
|------|--------|
| `package.json` | `agentmail` SDK added as a runtime dep. |
| `src/env.ts` | Added `readEnvKeysWithPrefix(prefix)` for dynamic key discovery. |
| `src/config.ts` | Added `resolveAgentMailApiKey()`, `resolveGroupAgentMailInbox(folder)`, `discoverAgentMailInboxes()`. |
| `src/channels/agentmail.ts` | New channel. Opens one WebSocket via `client.websockets.connect()`, subscribes to all configured inbox IDs, dispatches `message.received` events to the owning group's JID. Consults `agentmail-allowlist.ts` before dispatch — non-allowlisted senders are dropped silently with an info-level audit log. Inbound only. `ownsJid()` returns false (mirrors `mailroom-subscriber`). |
| `src/channels/agentmail.test.ts` | Unit tests for `classifyAgentMailMessage` + `buildInboundMessage` (incl. allow/deny outcomes). |
| `src/agentmail-allowlist.ts` | Per-folder sender allowlist loader + matcher. Reads `~/.config/nanoclaw/agentmail-allowlist.json`. **Default policy is deny-all** — folder absent or empty rules ⇒ drop. Supports exact senders + domain wildcards + an `allowAny: true` testing escape hatch. |
| `src/agentmail-allowlist.test.ts` | Unit tests for loader (corrupt JSON, partial validity) + matcher (case-insensitivity, deny-by-default, domain matching). |
| `groups/telegram_avp/CLAUDE.md` (per-group, on data root) | Appended "Email mode" section. Activates analytics-responder mode when an inbound prompt has the `[AgentMail email from … → madison-avp@agentmail.to]` header. Defines scope (AVP YouTube/website analytics only), refusal phrasing, tool whitelist, and prompt-injection guardrail. |
| `src/channels/index.ts` | `import './agentmail.js'` added under the mailroom-subscriber import. |
| `src/container-runner.ts` | New `agentmailApiKey` + `agentmailInboxId` parameters on `buildContainerArgs`. Both injected via `-e` only when the group has an inbox configured. |
| `container/agent-runner/src/index.ts` | Registers `agentmail` MCP server (`npx -y agentmail-mcp`) when both env vars are present. Adds `mcp__agentmail__*` to allowed tools. |

## Configuration shape (v1)

```bash
# .env (host-only; never synced, never enters host process.env)
AGENTMAIL_API_KEY=am_xxxxxxxxxxxx
AGENTMAIL_INBOX_TELEGRAM_AVP=madison-avp@agentmail.to
# Pattern: AGENTMAIL_INBOX_<UPPERCASE_GROUP_FOLDER>=<inbox-id>
```

The inbox id is opaque to the channel code — the standard
`@agentmail.to` brand domain and customer-configured custom domains
both work without changes here.

```jsonc
// ~/.config/nanoclaw/agentmail-allowlist.json — sender allowlist per folder.
// Stored OUTSIDE the project root, never mounted into containers, edited
// by Jeff directly. Default policy is deny-all when a folder has no entry.
{
  "telegram_avp": {
    "allowedSenders": ["alice@avp.com", "bob@avp.com"],
    "allowedDomains": ["avp.com"],
    "allowAny": false
  }
}
```

## Deliberate compromises that v2 must address

These are the divergences from clean architecture made because v1 lacks the
primitives v2 has. Each one has a v2 fix.

### 1. API key bypasses the credential proxy

**v1 state:** `AGENTMAIL_API_KEY` is read from `.env` and passed into the
agent container via `-e AGENTMAIL_API_KEY=...`. This is the same pattern
LiteLLM uses (see `container-runner.ts` lines around `litellmApiKey`), but
it violates the v2 doctrine that "containers never receive raw API keys"
(CHANGELOG 2.0.0).

**v2 fix:** Register AgentMail as an upstream in OneCLI Agent Vault. The
agent container should call `mcp__agentmail__*` through OneCLI's request-
time credential injection, never seeing `AGENTMAIL_API_KEY` directly.
`agentmail-mcp` doesn't natively support a proxy; either patch upstream or
wrap it with a thin proxying server. Reference the OneCLI integration
pattern used by Anthropic's API in `credential-proxy.ts`.

### 2. Channel lives on trunk, not the `channels` branch

**v1 state:** `src/channels/agentmail.ts` is on `main`, registered via
`src/channels/index.ts`.

**v2 fix:** v2 moved every channel to the `channels` branch behind
`/add-<channel>` skills. AgentMail must follow suit:

- Create a new branch (or fork) for the AgentMail channel skill,
  matching the structure of e.g. `/add-slack`, `/add-telegram`.
- Author `.claude/skills/add-agentmail/SKILL.md` with phases: pre-flight,
  apply-code-changes, setup (API key + inbox creation), verify, removal.
  Use `add-gmail/SKILL.md` (still in this fork's history) as a template
  but adapt for v2's shared-source agent-runner and OneCLI vault.
- The skill should `git merge agentmail/main` from the feature branch,
  same pattern as the v1-era `/add-gmail`.

### 3. Per-group `agent-runner-src/` overlay copy

**v1 state:** `container-runner.ts` copies the agent-runner source into
`data/sessions/<folder>/agent-runner-src/` per group, and the agentmail
MCP registration lives in that copy. Updating the integration requires
clearing those copies (`rm -r data/sessions/*/agent-runner-src`) so they
regenerate.

**v2 fix:** v2 retired the per-group overlay (CHANGELOG 2.0.0:
"Shared-source agent-runner. Per-group `agent-runner-src/` overlays are
gone; all groups mount the same agent-runner read-only"). The
`if (hasAgentMail) mcpServers['agentmail'] = ...` block goes into the
single shared agent-runner. Per-group customisation via composed
`CLAUDE.md`. **No more `rm -r data/sessions/*/agent-runner-src` dance.**

### 4. Group-folder routing instead of v2's entity model

**v1 state:** Inbox→group mapping is keyed by group folder name
(`AGENTMAIL_INBOX_TELEGRAM_AVP`). Routing iterates registered groups
looking for `group.folder === folder`.

**v2 fix:** v2 introduced separate entities for users / messaging groups /
agent groups, wired via `messaging_group_agents` (CHANGELOG 2.0.0,
[BREAKING] new entity model). Each AgentMail inbox is naturally a
`messaging_group` of its own. Wire it to an `agent_group` (Madison) via
`messaging_group_agents`. Pick a `session_mode` from the three v2
isolation levels:

- `'separate'` — each inbox = its own agent + session. Right for genuine
  sub-personas (e.g. AVP Madison vs Trading Madison).
- `'shared'` — one Madison agent, independent conversations per inbox.
  **This is the right pick for the future 100-inbox marketing campaign
  case.** Madison shares brain across all 100, but each inbox thread is
  isolated.
- `'agent-shared'` — merge channels into one shared session. Wrong fit.

The v1 `discoverAgentMailInboxes()` helper that scans `.env` keys becomes
dead code — replace with a query against the v2 entity tables.

### 5. Single-inbox-per-group hardcoding

**v1 state:** `resolveGroupAgentMailInbox(folder)` returns at most one
inbox id. The `inboxToFolder` map in `agentmail.ts` is one-to-one.

**v2 fix:** For the 100-inbox marketing future, this becomes a
many-to-one (many inboxes → one agent group). With the v2 entity model
this falls out naturally: `messaging_group_agents` already supports many
messaging groups (inboxes) wired to one agent group (Madison). The v1
channel logic needs no change beyond the one-to-many lookup.

### 6. Shared API key across all inboxes

**v1 state:** Single `AGENTMAIL_API_KEY`. Fine because Jeff has one
AgentMail org. Multi-tenancy was YAGNI.

**v2 fix:** AgentMail supports Pods (multi-tenant isolation). When/if
the marketing org grows beyond one entity (e.g. AVP gets its own
AgentMail org), v2 should support per-pod API keys. For now: still one
key.

### 7. Email-mode scoping is prompt-only, not tool-enforced

**v1 state:** When an AgentMail inbound message lands, Madison-AVP
receives it in the **same session** as Jeff's Telegram chat. The only
isolation is the `[AgentMail email from … → madison-avp@agentmail.to]`
header in the prompt and the CLAUDE.md "Email mode" section that tells
Madison to operate as an analytics-responder when she sees that header.
This is advisory, not enforced — a prompt-injected email body that
convinces her to answer off-topic would succeed at exfiltrating
non-analytics context. The sender allowlist is the only hard boundary.

**v2 fix:** Three mutually-reinforcing fixes:
1. **`session_mode: 'separate'`** — give the AgentMail inbox its own
   `messaging_group` wired to its own session (or even its own agent).
   Email replies never share a transcript with Jeff's Telegram chat;
   no cross-context leakage.
2. **Per-source-channel `allowedTools`** — narrow the tool list at
   agent-runner spawn time when the inbound source is AgentMail. Drop
   `Bash`, `WebFetch/Search`, `mcp__a-mem__*`, `mcp__obsidian-cli__*`
   from the allowed list. Only `mcp__agentmail__reply_to_message`,
   read-only analytics MCPs, and read-only file access to the analytics
   data directory survive. This is the only true tool-level boundary.
3. **Per-source CLAUDE.md fragment composition** — v2's "composed
   CLAUDE.md (shared base + per-group fragments)" can include a per-
   *channel* fragment. The "Email mode" section becomes the entire
   CLAUDE.md for the email session, not an `if you see this header`
   conditional.

## Architectural shifts in v2 that touch this code

These are the v2 changes from CHANGELOG 2.0.0 (2026-04-22) that the
AgentMail integration intersects, ordered by severity for this code:

1. **Channels on `channels` branch (BREAKING).** Repackage as `/add-agentmail`
   skill. This is the biggest mechanical change.
2. **OneCLI is the sole credential path.** API key migration (#1 above).
3. **Three-level channel isolation.** Decide isolation mode per inbox (#4
   above). Default to `'shared'` for future-proofing.
4. **New entity model — users/messaging groups/agent groups (BREAKING).**
   Replace `.env`-based folder routing with entity wiring (#4 above).
5. **Shared-source agent-runner.** Single edit instead of per-group copies
   (#3 above).
6. **Two-DB session split (BREAKING).** Doesn't affect AgentMail directly —
   we go through `onMessage` which the orchestrator handles. Just be
   aware when debugging that session DBs are now `inbound.db` +
   `outbound.db`.
7. **Bun-based agent-runner.** `npx -y agentmail-mcp` should still work
   under Bun — verify on first build.

## Migration recipe (suggested order)

When the v2 upgrade lands:

1. Run `bash migrate-v2.sh` per CHANGELOG (it ports `.env`, groups,
   sessions, channels). The AgentMail-related .env keys
   (`AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_*`) carry over verbatim.
2. **Don't merge the v1 AgentMail code.** It won't fit. Instead:
3. Build the `/add-agentmail` skill on the v2 `channels` branch:
   - Mirror `add-slack` or `add-telegram` for SKILL.md structure.
   - Channel code lives in v2's channel layout; the WebSocket loop and
     `classifyAgentMailMessage` / `buildInboundMessage` helpers port
     across cleanly (they're pure functions). Refactor only the bits that
     read `.env` for routing — replace with v2 entity queries.
   - Container-side: register `agentmail-mcp` once in the shared
     agent-runner. No per-group copy to clear.
4. **Wire credentials through OneCLI.** Add an AgentMail upstream entry to
   the vault. Either patch `agentmail-mcp` to honour a proxy URL, or wrap
   it with a thin local proxy that mimics the credential-proxy pattern.
5. **Decide isolation mode per inbox.** For the AVP single-inbox case, run
   `/manage-channels` and pick `'separate'` or `'shared'` — both work for
   N=1. When the 100-inbox marketing case lands, default everything new to
   `'shared'`.
6. **Smoke-test on AVP first.** Send `madison-avp@agentmail.to` an email,
   confirm Madison gets it in her Telegram group, confirm she can reply
   via `mcp__agentmail__reply_to_message`.

## Things not built on v1 (don't bother, do them on v2)

- Inbox creation flow (`client.inboxes.create({ username, domain })`).
  Skipped because Jeff already provisioned `madison-avp@agentmail.to` by
  hand. On v2, build into the `/add-agentmail` skill so additional
  inboxes auto-provision.
- Outbound list/allow/block management UI. The MCP tools cover this; no
  host-side UI needed.
- Webhook fallback. WebSocket is sufficient and avoids a public URL. If
  the SDK's auto-reconnect proves unreliable, reconsider on v2.
- Multi-pod support. YAGNI until Jeff has more than one AgentMail org.
- `mcp__agentmail__*` allow-list narrowing. v1 enables the full surface
  (`mcp__agentmail__*`). On v2, consider scoping with `--tools
  get_message,send_message,reply_to_message,...` per
  https://docs.agentmail.to/integrations/mcp.

## Quick reference: what a v2 `/add-agentmail` skill must do

(Sketch only — the v2 migrator builds this for real.)

```
Phase 1 — pre-flight: check AGENTMAIL_API_KEY, ensure 'channels' branch
remote, ensure shared agent-runner branch.

Phase 2 — apply code: merge agentmail-channel branch from channels remote.
Updates touch: shared agent-runner index.ts (single edit), v2 channel
manifest, OneCLI vault entry. NO per-group session-dir cleanup.

Phase 3 — credentials: prompt for AGENTMAIL_API_KEY, write to OneCLI vault.

Phase 4 — wire inboxes: for each existing messaging group, AskUserQuestion
which AgentMail inbox it owns; create messaging_group_agents rows; pick
session_mode (default 'shared').

Phase 5 — verify: send a test email to the configured inbox, confirm
delivery to the right agent group.
```

## Open questions to resolve on the v2 upgrade

1. **Is AgentMail upstream-supported in v2 itself?** Check if the v2
   `channels` branch already has an `add-agentmail` skill. If yes, prefer
   it over hand-rolling. The 2026-04-22 CHANGELOG didn't mention one but
   the `channels` branch evolves independently.
2. **Does `agentmail-mcp` still work under Bun?** Agent-runner moved Node
   → Bun in v2 (CHANGELOG). `npx -y agentmail-mcp` shells out, so likely
   yes, but verify before trusting.
3. **Should custom domains live in OneCLI or per-inbox config?** AgentMail
   custom domain setup is a one-time per-domain action. Probably belongs
   outside NanoClaw entirely (managed via the AgentMail console).

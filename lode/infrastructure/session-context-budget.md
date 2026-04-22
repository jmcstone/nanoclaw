# Session Context Budget

Controls how often each group's SDK session is rotated, and which model it uses, to keep per-group context and cost bounded. Every inbound message to a group resumes the same `session_id` via `query({ resume, ... })` in `container/agent-runner/src/index.ts`, so context accumulates until a rotation (host-side) or an auto-compaction (SDK-side) occurs.

## Primary tuning surface: `group-overrides.json`

Live at `~/Documents/Obsidian/Main/NanoClaw/_Settings/group-overrides.json` (synced via Obsidian, editable from any device — phone included). Read host-side by `src/config.ts` on each spawn/rotation check; no restart needed after edits.

Schema (all fields optional, omit to fall through to the `.env` default):

```json
{
  "<folder>": {
    "model": "claude-sonnet-4-6" | "claude-opus-4-7" | "claude-opus-4-7[1m]" | ...,
    "sessionMaxMessages": <int>,
    "sessionMaxAgeHours": <int>
  }
}
```

Current entries (2026-04):

| Folder | Model | maxMessages | maxAgeHours | Rationale |
|---|---|---|---|---|
| `telegram_inbox` | `claude-sonnet-4-6` | 10 | 3 | Email triage — cheap, fast, 200K window keeps context tight |
| `telegram_avp` | `claude-opus-4-7` | 25 | 12 | Heavy research; Opus 200K, not 1M |
| `telegram_trading` | `claude-opus-4-7` | (default) | (default) | Backtest/strategy reasoning |
| `telegram_main` | (default) | (default) | (default) | Fallback — `.env` applies |
| `telegram_nexus` | (default) | (default) | (default) | Fallback — `.env` applies |

## Fallback defaults (`.env`)

Consumed by `src/config.ts:98–104`, enforced in `src/index.ts:329–353`. Apply when `group-overrides.json` has no entry or omits a field.

| Setting | Value | Behavior |
|---|---|---|
| `SESSION_MAX_MESSAGES` | `15` | After 15 user turns, next inbound triggers `clearSession()` → next `query()` starts a fresh session |
| `SESSION_MAX_AGE_HOURS` | `6` | Sessions older than 6h rotate on the next inbound |
| `ANTHROPIC_MODEL` | (unset) | Claude Code's OAuth default — currently Opus 1M |

Whichever rotation trigger fires first wins.

## Why rotation matters on Opus 1M

Opus 4.7's 1M-token window means the SDK's auto-compaction only fires near the model's limit. Without host-side rotation, a group can sit at 400K–900K tokens for many turns — expensive per token (Anthropic tiers >200K input at a premium on Opus 4.x) and usually unnecessary for a messaging assistant.

Trade-off: rotation truncates in-session chat recall. Per-group `CLAUDE.md`, a-mem memory, and context-mode knowledge base all survive — only transient "what did we just discuss" context is lost.

## Escalation playbook

1. **Edit `group-overrides.json`** for the noisy group — tighten `sessionMaxMessages` / `sessionMaxAgeHours`, or swap `model` to a cheaper tier. This is the primary lever.
2. **Pin non-1M Opus** — set `model: "claude-opus-4-7"` (no `[1m]` suffix) for groups that don't need the 1M window. Auto-compact fires at ~200K instead of ~950K.
3. **Pin Sonnet** — set `model: "claude-sonnet-4-6"` — ~5× cheaper input, 200K window. Degrades reasoning; evaluate per group.
4. **Tighten `.env` defaults** — only as a last resort for the unmapped-group fallback; prefer explicit overrides.

## What not to do

- **Don't set `maxTurns`.** That caps the agent mid-task (tool-use steps), not context growth. Wrong mechanism.
- **Don't disable session resume entirely.** Would break conversational continuity when the user sends two messages in quick succession.
- **Don't mount `group-overrides.json` into containers.** It's host-only config; the container sees only the resulting `ANTHROPIC_MODEL` env var.

## When to revisit

Re-check if: usage warnings return, Anthropic pricing tiers change, the SDK exposes a configurable compaction threshold, or any group's per-message cost pattern shifts materially.

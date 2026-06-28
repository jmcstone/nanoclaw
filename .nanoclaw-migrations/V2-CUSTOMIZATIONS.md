# Madison v2 Fork Customizations — re-apply inventory

The v1→v2 migration is **complete** (see `UPGRADE-PLAYBOOK.md` for that one-time jump and
`CUTOVER.md` for the executed switch). This doc is the **forward-looking** inventory: everything
the `madison-v2` fork changes vs upstream NanoClaw v2, so the *next* `git merge upstream/main`
(or a fresh-checkout re-apply) is mechanical. Kept deliberately small — most customization is
**config/data**, not code.

## Design principle: minimize upstream-file edits
New files never conflict on merge; edits to upstream files do. So customizations live in **our own
files** wherever possible, and upstream files carry only a 1–3 line hook. Current upstream-file
surface is ~7 files, all surgical.

## A. New files (ours — copy as-is, never conflict)
| File | Purpose |
|------|---------|
| `src/madison-extensions.ts` | All fork config/helpers (CONTAINER_DNS, CONTAINER_SKILL_ENV, AgentMail resolvers, RECALL_DB_DIR + recallDbPathForGroup). Keeps `config.ts` at ~zero fork surface. |
| `src/agentmail-subscriber.ts` (+ `.test.ts`) | Inbound AgentMail email → agent-shared session (mailroom-subscriber pattern). |
| `container/agent-runner/src/litellm-route-mcp-stdio.ts` | LiteLLM MCP server (model routing + image-gen via sharp). |
| `container/agent-runner/src/madison-tool-policy.ts` | `MADISON_DISALLOWED_TOOLS` — Trawl write/act denylist, spread into the provider. |
| `src/modules/mount-security/index.test.ts` | Tests for the exact-root bypass (security-critical). |
| `scripts/seed-madison-groups.ts`, `add-{litellm,batch-capabilities,agentmail,trawl}-mcp.ts` | Idempotent DB seed/wiring (data, not runtime code). |
| `src/recall/schema.ts` | `session_fts` FTS5 table + `session_fts_state` watermark; opened per-group at a caller-supplied path. |
| `src/session-indexer.ts` | Host periodic session indexer (~60 s tick); writes per-group recall DBs; rowid-cursor watermark; delete-before-insert idempotency. |
| `src/litellm-host-client.ts` | Host-side LiteLLM client (`:4000`). Retained for Phase-2 distiller (D10′); **not on the recall path**. |
| `scripts/backfill-session-fts.ts` | One-shot backfill of v1 archive (`store/messages.db`) into per-group recall DBs. |
| `container/agent-runner/src/recall-mcp-stdio.ts` | In-container Bun stdio MCP (Option B recall). Opens per-group DB at `/recall/recall.db` (via /tmp copy — FTS5 automerge workaround), runs FTS5 search, summarizes via Anthropic API / OneCLI HTTPS_PROXY (`claude-haiku-4-5`). |

## B. Upstream-file edits (re-apply these; everything else is in our files)
| Upstream file | Edit (intent) | Re-apply |
|---------------|---------------|----------|
| `src/channels/telegram.ts` | **Multi-instance bots.** Extract `buildTelegramAdapter(token, instance?)`; register default `TELEGRAM_BOT_TOKEN` as instance `telegram` + loop over `TELEGRAM_BOT_TOKEN__<INSTANCE>` registering each (skip reserved `telegram`). Set `instance` on the wrapped adapter. | Re-apply the factory extraction + the registration loop. |
| `src/modules/mount-security/index.ts` | **Exact-root bypass.** Reorder `validateMount`: find allowed root FIRST, then run blocked-pattern check ONLY if not an exact realpath match (so a verbatim allowlist entry like `~/.ssh/gitlab` overrides the `.ssh` default-block). | Re-apply the reorder (see the comment block + the test). |
| `src/container-runner.ts` | Forward `CONTAINER_SKILL_ENV` as `-e` + add `--dns CONTAINER_DNS`; import both from `./madison-extensions.js` (NOT config). Also: mount per-group recall DB read-only at `/recall/recall.db`; `existsSync`-gated (groups without a DB get no mount) (`3f0b3cb`). | Re-add the env loop + `--dns` line + the `existsSync`-gated recall mount in `buildMounts()`, + the madison-extensions import. |
| `src/env.ts` | Add `readEnvKeysWithPrefix` (+ shared `parseAllEnvEntries` helper). | Re-add the two functions. |
| `src/index.ts` | Start/stop the AgentMail subscriber next to the mailroom one (3 lines, fire-and-forget). Also: start/stop the host session indexer (recall, `57a6762`). | Re-add import + `void startAgentMailSubscriber()` + `stopAgentMailSubscriber()` + `void startSessionIndexer()` + `stopSessionIndexer()`. |
| `container/agent-runner/src/providers/claude.ts` | Spread `MADISON_DISALLOWED_TOOLS` into `SDK_DISALLOWED_TOOLS` (1 import + 1 spread line). | Re-add the import + the `...MADISON_DISALLOWED_TOOLS` entry. |
| `container/agent-runner/src/index.ts` | Sentinel-gated recall stdio MCP registration: when `/recall/recall.db` mount is present, register `recall-mcp-stdio.ts` as a stdio MCP tool (`97ea70f`). | Re-add the `existsSync('/recall/recall.db')` guard + stdio MCP registration block (see commit `97ea70f` for exact lines). |

`src/config.ts` is intentionally **back to ~upstream** (additions moved to `madison-extensions.ts`).

## C. Config / data (no code — lives in the DB + .env + ~/.config)
- **Per-group MCP wiring** (`container_configs.mcp_servers`): ollama everywhere; tasks (main/inbox);
  messages (inbox); litellm (main/avp/trading/inbox); brave-search (all); agentmail (avp); trawl
  (main/inbox/avp/trading). Re-run `scripts/add-*-mcp.ts`.
- **.env keys**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN__AVP_OUTREACH`, `WEBHOOK_PORT=13900`,
  `ONECLI_URL`, `CONTAINER_DNS=100.100.100.100`, `TESLA_TRACKER_URL/_API_KEY`, `AMBIENT_WEATHER_URL`,
  `BRAVE_API_KEY`, `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_TELEGRAM_AVP`, per-group `LITELLM_API_KEY_*`.
- **Container deps**: `sharp` in `container/agent-runner/package.json` (image rebuild) for litellm image-gen.
- **`~/.config/nanoclaw/mount-allowlist.json`**: `~/.ssh/gitlab` (+`.pub`) exact entries (git push);
  `_Shared` + per-group Obsidian/code roots; `~/containers/data/NanoClaw/v2/recall` (read-only,
  recall per-group DBs — no new host port; in-container stdio, Option B).
- **Group identity**: avp_outreach messaging group is `instance='avp_outreach'` (dedicated bot).
- **`RECALL_DB_DIR`** (default `~/containers/data/NanoClaw/v2/recall/`): directory for per-group
  recall DBs (`<folder>.db`). Set in `madison-extensions.ts`; no `.env` key required (default
  works for jarvis). No new host port and no image rebuild — recall runs as in-container stdio.

## D. Upstream-PR candidates (generic — would leave the fork entirely if merged)
- Multi-instance Telegram (B/telegram.ts) · `CONTAINER_DNS` container resolver · `readEnvKeysWithPrefix`
  · mount-security exact-root bypass · **recall stack** (session indexer + in-container stdio MCP +
  schema — generic pattern; any group-aware NanoClaw install could use it with zero site-specific
  changes). All generic; propose upstream to shrink the fork to ~zero code.

## E. Verify after a merge
`pnpm run build` + `pnpm test` (incl. `mount-security` + `agentmail-subscriber` tests) +
`./container/build.sh` (sharp). Live: both bots poll, AgentMail connects, a spawn injects skill env
+ `--dns`, Trawl denied tools blocked, mount of `~/.ssh/gitlab` allowed, recall DB mounted
read-only for active groups and `recall_sessions` tool visible inside those containers.

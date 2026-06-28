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
| `src/madison-extensions.ts` | All fork config/helpers (CONTAINER_DNS, CONTAINER_SKILL_ENV, AgentMail resolvers, RECALL_DB_DIR + recallDbPathForGroup, SELF_IMPROVE_DIR + selfImproveDbPath + proposalsDir). Keeps `config.ts` at ~zero fork surface. |
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
| `src/modules/self-improve/schema.ts` | `self-improve.db` schema: `proposals`, `helpfulness_events`, `distiller_watermarks`, `proposal_keys` (tombstone) tables. (`1cd95e2`) |
| `src/modules/self-improve/tombstone.ts` | Rejection tombstone read/write — distiller checks before re-proposing a denied key. Session-count helpers for skill recurrence evidence. (`bee767c`) |
| `src/modules/self-improve/journal.ts` | Real-time append to `self-improve-journal/JOURNAL.md` on every action; `commitJournalAndSkills()` for the nightly batched git commit. (`971f7fe`) |
| `src/modules/self-improve/l1-lifecycle.ts` | L1 unified-pool budget re-rank: `scorePool()` + `reRankL1(folder, budgetTokens)`. (`dc6c195`) |
| `src/modules/self-improve/distiller.ts` | Online distill pass: reads session rows, calls `gemini-3-flash-preview` via `callHostLiteLLM`, auto-applies facts, writes skill proposals. (`048320c`) |
| `src/modules/self-improve/approvals.ts` | Skill approval flow: `requestApproval` card via delivery adapter; tombstone on denial; trial-tag on accept. (`cd5f1d9`) |
| `src/modules/self-improve/promote.ts` | Nightly promote pass: `reRankL1` + skill-promotion + digest delivery + `commitJournalAndSkills()`. (`b92313a`) |
| `src/modules/self-improve/index.ts` | Public barrel: `scheduleDistill`, `cancelDistill`, `startNightlyPromote`, `stopNightlyPromote`. (`049c1b4`) |
| `scripts/spike-distiller-model.ts` | One-shot spike confirming `gemini-3-flash-preview` reachable via `callHostLiteLLM` (SI-12). Historical; safe to omit on re-apply. (`a9679bd`) |
| `scripts/verify-self-improve-e2e.ts` | E2E verification script for the self-improve stack. |

## B. Upstream-file edits (re-apply these; everything else is in our files)
| Upstream file | Edit (intent) | Re-apply |
|---------------|---------------|----------|
| `src/channels/telegram.ts` | **Multi-instance bots.** Extract `buildTelegramAdapter(token, instance?)`; register default `TELEGRAM_BOT_TOKEN` as instance `telegram` + loop over `TELEGRAM_BOT_TOKEN__<INSTANCE>` registering each (skip reserved `telegram`). Set `instance` on the wrapped adapter. | Re-apply the factory extraction + the registration loop. |
| `src/modules/mount-security/index.ts` | **Exact-root bypass.** Reorder `validateMount`: find allowed root FIRST, then run blocked-pattern check ONLY if not an exact realpath match (so a verbatim allowlist entry like `~/.ssh/gitlab` overrides the `.ssh` default-block). | Re-apply the reorder (see the comment block + the test). |
| `src/container-runner.ts` | Forward `CONTAINER_SKILL_ENV` as `-e` + add `--dns CONTAINER_DNS`; import both from `./madison-extensions.js` (NOT config). Also: mount per-group recall DB read-only at `/recall/recall.db`; `existsSync`-gated (groups without a DB get no mount) (`3f0b3cb`). **Phase 2:** on container `close` (`code===0 \|\| code===null`) call `scheduleDistill(folder, sessionId)`; on wake call `cancelDistill(folder)` (`387a823`). | Re-add the env loop + `--dns` line + the `existsSync`-gated recall mount + the `scheduleDistill`/`cancelDistill` close/wake calls. |
| `src/env.ts` | Add `readEnvKeysWithPrefix` (+ shared `parseAllEnvEntries` helper). | Re-add the two functions. |
| `src/index.ts` | Start/stop the AgentMail subscriber next to the mailroom one (3 lines, fire-and-forget). Also: start/stop the host session indexer (recall, `57a6762`). **Phase 2:** call `startNightlyPromote()` at startup and `stopNightlyPromote()` at shutdown (`bc56da0`). | Re-add import + `void startAgentMailSubscriber()` + `stopAgentMailSubscriber()` + `void startSessionIndexer()` + `stopSessionIndexer()` + `startNightlyPromote()` + `stopNightlyPromote()`. |
| `src/claude-md-compose.ts` | **Phase 2:** inject a `<!-- TRIAL-skill -->` header fragment for trial-tagged skills so the agent knows the skill is provisional (`ed37b38`). | Re-add the trial-skill conditional fragment include. |
| `src/modules/index.ts` | **Phase 2:** add `self-improve` to the modules barrel, wiring `startNightlyPromote`/`stopNightlyPromote` into the scheduling module registration (`049c1b4`). | Re-add the self-improve barrel export. |
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
- **`SELF_IMPROVE_DIR`** (default `~/containers/data/NanoClaw/v2/self-improve/`): root for
  `self-improve.db`, `proposals/<folder>/`. Set in `madison-extensions.ts`; no `.env` key required
  (default works for jarvis). Host-side only — never mounted into containers.
- **`LITELLM_HOST_API_KEY`** — **required in `.env`** (currently missing; activation gate for the
  distiller). Issue a dedicated host key in the LiteLLM admin UI and add
  `LITELLM_HOST_API_KEY=<key>` to `.env`. The spike used `LITELLM_API_KEY_TELEGRAM_MAIN` as a
  proxy; the real distiller needs its own key.
- **`DISTILLER_MODEL`**: `'gemini-3-flash-preview'` — constant in `src/modules/self-improve/distiller.ts`
  (no `.env` key; change by editing the constant). Confirmed reachable via spike (`a9679bd`).
- **`self-improve-journal/JOURNAL.md`**: git-tracked in the repo worktree (not the data volume).
  Created automatically by `appendJournal()`; the nightly promote pass commits it alongside
  `container/skills/`. Run `git log self-improve-journal/` to see Madison's self-improvement history.

## D. Upstream-PR candidates (generic — would leave the fork entirely if merged)
- Multi-instance Telegram (B/telegram.ts) · `CONTAINER_DNS` container resolver · `readEnvKeysWithPrefix`
  · mount-security exact-root bypass · **recall stack** (session indexer + in-container stdio MCP +
  schema — generic pattern; any group-aware NanoClaw install could use it with zero site-specific
  changes) · **self-improve stack** (`src/modules/self-improve/` + the 5 upstream hooks — the
  two-tier distill/promote cadence, `helpfulness_events` ledger, L1 lifecycle re-rank, and git
  journal are all group-aware with no Madison-specific logic; the only site-specific constant is
  `DISTILLER_MODEL`). Propose the recall + self-improve stack together upstream to shrink the fork
  to ~zero code. All generic; propose upstream to shrink the fork to ~zero code.

## E. Verify after a merge
`pnpm run build` + `pnpm test` (incl. `mount-security` + `agentmail-subscriber` tests) +
`./container/build.sh` (sharp). Live: both bots poll, AgentMail connects, a spawn injects skill env
+ `--dns`, Trawl denied tools blocked, mount of `~/.ssh/gitlab` allowed, recall DB mounted
read-only for active groups and `recall_sessions` tool visible inside those containers.

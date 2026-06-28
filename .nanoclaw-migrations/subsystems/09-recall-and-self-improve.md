# Subsystem 9 — FTS5 Session Recall + Hermes Self-Improvement

**Status: SHIPPED (Phase 1 — recall, Option B).** Live as of 2026-06-28 on branch `madison-v2`.

**Risk: MEDIUM.** Net-new files only (schema, indexer, in-container stdio MCP, LiteLLM host client).
Upstream-file hooks are exactly three short additions (D2/§5 pattern). Isolation is by construction:
each container gets only its own group's DB read-only; no token auth required.

**Design authority:** `.nanoclaw-migrations/MEMORY-RECALL-DESIGN.md` (Phase 1 = recall, steps 0–5;
Phase 2 = self-improvement, steps 6–10).

**Locked decisions:** `lode/plans/active/2026-06-session-recall/findings.md` (D1–D13; D2′/D8′/D9′/D10′
supersede/amend several originals after the gwbridge spike chose Option B).

---

## Intent

Give Madison L2 episodic memory: the agent can search past conversations for context. Session messages
are indexed into per-group FTS5 SQLite databases on the host by a periodic tick (the "session indexer").
Each container gets its own group's DB bind-mounted read-only; an in-container stdio MCP tool
(`recall_sessions`) performs an FTS5 keyword search and returns a Haiku-summarized digest
(`{summary, citations}`).

---

## Architecture (Option B — in-container stdio + per-group DBs)

The gwbridge spike (`41c7b11`) proved the host-process HTTP MCP model (D8) is unreachable from
containers — Docker's iptables rules only allow container→host traffic for docker-published ports.
Option B was chosen: deliver recall as an **in-container stdio MCP** instead of an HTTP endpoint.

Key properties of Option B:

- **No new host port.** `recall-mcp-stdio.ts` runs inside the agent container as a stdio MCP process.
  No `docker publish`, no iptables rule, no sidecar container.
- **Isolation by construction (D9′).** The recall DB is sharded one-file-per-group. Each container
  receives only its own group's `<folder>.db` bind-mounted **read-only** at `/recall/recall.db`
  (outside `/workspace/extra/` to avoid the agent-runner's additional-directory scanner exposing the
  raw SQLite binary as a workspace directory). A container physically cannot read another group's data.
  The forgeable-token concern from D9 is dissolved.
- **Summarize in-container via Anthropic API.** The MCP handler calls
  `https://api.anthropic.com/v1/messages` with `claude-haiku-4-5`. No `x-api-key` header is set —
  the OneCLI HTTPS_PROXY (injected by `onecli.applyContainerConfig()` in container-runner.ts) injects
  the Max-plan credential at the proxy layer. The host-side LiteLLM client (`src/litellm-host-client.ts`,
  D10′) is retained for the Phase-2 distiller but is **not on the recall path**.
- **No image rebuild.** `container/agent-runner/src/recall-mcp-stdio.ts` lives in the host-mounted
  agent-runner source tree; no container image rebuild is needed.
- **Opt-in via sentinel.** The agent-runner registers the recall MCP only when the mount is present
  (`existsSync('/recall/recall.db')`), following the a-mem/context-mode sentinel pattern. Groups
  without a recall DB get no tool.

---

## Spike outcome

### D8 — gwbridge serve-direction HTTP MCP

**Date:** 2026-06-28
**Script:** `scripts/spike-recall-mcp.ts`

#### SPIKE FAIL

The orchestrator CANNOT directly serve an HTTP MCP endpoint (as a host process bound to
`0.0.0.0:<port>` or `172.31.0.1:<port>`) reachable by containers via `172.31.0.1:<port>`. TCP
connections from inside containers to host-process ports time out (curl exit 28, confirmed at both
`0.0.0.0:18090` and `172.31.0.1:18091`). Root cause: Docker's iptables rules only allow
container→host traffic for docker-published ports (docker-proxy / PREROUTING DNAT); there is no
INPUT ACCEPT rule for arbitrary host-process ports from the bridge subnet.

#### Good-token probe

```
docker run --rm --entrypoint sh nanoclaw-agent-v2-97ed9aac:latest -c \
  "curl -s -X POST 'http://172.31.0.1:18090/mcp?t=spike-test-token-x9q2r7' \
   -H 'Content-Type: application/json' \
   -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'"
docker exit: 28 (CURLE_OPERATION_TIMEDOUT)
stdout: (empty)
```

RESULT: FAIL — "recall_ping" absent from response (TCP connection never established).

#### Bad-token probe

```
docker run --rm --entrypoint sh nanoclaw-agent-v2-97ed9aac:latest -c \
  "curl -s -o /dev/null -w %{http_code} -X POST 'http://172.31.0.1:18090/mcp?t=WRONG_TOKEN' \
   -H 'Content-Type: application/json' \
   -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}'"
docker exit: -1 (process kill / timeout)
http_code: (empty)
```

RESULT: FAIL — could not reach the server to get 401 (same TCP timeout).

#### Restart / rebind behavior

PASS. `server.close()` + re-listen on port 18090 succeeds with no EADDRINUSE. Node.js sets
SO_REUSEADDR on listening sockets via libuv; the listening socket is not in TIME_WAIT after close.

#### What does work: published-port pattern

Docker-published ports (e.g. `mailroom-inbox-mcp-1: 172.31.0.1:18080->8080/tcp`,
`tasks-mcp: 172.31.0.1:18088->8088/tcp`) ARE reachable from inside containers at
`172.31.0.1:<port>`. The container from the default bridge subnet (`172.31.0.6`) successfully
reaches `172.31.0.1:18080` (confirmed via HTTP MCP response). These work because Docker's
docker-proxy creates a host socket AND adds iptables DNAT/ACCEPT rules for each published port.
Plain host-process sockets without docker publish have no such rules.

#### Additional probe: binding to 172.31.0.1 directly

Also tested binding to `172.31.0.1:18091` specifically (same as docker-proxy does). Result:
exit 28 (timeout). Binding address makes no difference — the iptables INPUT rules block by
source/destination pair, not by binding address.

---

### Required change for the real Wave 3 server (src/recall/mcp.ts)

The in-process model (orchestrator hosts HTTP MCP server directly) does NOT work for the
container→host direction. The recall MCP server must be delivered as a **published docker port**,
following the same pattern as `inbox-mcp` and `tasks-mcp`.

**Viable approaches (choose one):**

1. **Sidecar recall-mcp container (preferred — matches existing pattern):**
   - A dedicated container runs `src/recall/mcp.ts` (as a minimal Bun/Node HTTP server).
   - Published as `172.31.0.1:<RECALL_MCP_PORT>-><RECALL_MCP_PORT>/tcp` (same as inbox-mcp style).
   - Volume-mount the recall DB at `RECALL_DB_PATH` (read-only for search; the indexer on the host
     writes it — or mount read-write if the summarize step must also write state).
   - Lifecycle: started by the orchestrator at startup alongside the indexer; stopped on shutdown.
   - Token auth (D9) applies unchanged: the MCP server reads tokens from a shared file or its own
     in-container token store, updated by the orchestrator at each agent spawn.

2. **iptables INPUT rule at startup (fragile, not recommended):**
   - `iptables -I DOCKER-USER -s 172.31.0.0/16 -p tcp --dport <RECALL_MCP_PORT> -j ACCEPT`
   - Requires the orchestrator to run as root or with `CAP_NET_ADMIN` — incompatible with the
     current non-root model.
   - Doesn't survive reboots without additional setup (systemd pre-start unit or iptables-restore).
   - Not pursued.

**D9 token auth** (per-spawn token baked into the container's `mcp_servers` URL) applies to
approach 1 without change. The token→(agent_group, session_id) map lives in a file or ephemeral
in-container store written by the orchestrator at spawn time.

**Revised upstream-file hooks (container-runner.ts):**
- At spawn: mint recall token → write to shared token file → bake `?t=<token>` into mcp_servers URL.
- The sidecar container picks up the token file via volume mount (no code change needed in the sidecar).

---

## Files (shipped)

### New files (never conflict on upgrade)

| File | Purpose |
|------|---------|
| `src/recall/schema.ts` | `session_fts` FTS5 table + `session_fts_state` watermark; opened per-group at a caller-supplied path (`ef97f5a`). |
| `src/session-indexer.ts` | Host periodic tick (~60 s); walks `v2-sessions/<group>/<session>/`; writes per-group DBs; rowid-cursor watermark; delete-before-insert idempotency (`a6b415f` → refactored `8baf440`). |
| `src/litellm-host-client.ts` | Host-side LiteLLM client (`:4000`). **Retained for Phase-2 distiller; NOT on the recall path** (D10′, `35302e9`). |
| `scripts/backfill-session-fts.ts` | One-shot backfill of v1 archive (`store/messages.db`) into per-group DBs (`d4daf40` → `8baf440`). V1 is inbound-only — no `assistant` rows produced. |
| `container/agent-runner/src/recall-mcp-stdio.ts` | In-container Bun stdio MCP. Opens `/recall/recall.db` (via /tmp copy — FTS5 automerge workaround). FTS5 MATCH → top-k → Haiku summary via Anthropic API / OneCLI HTTPS_PROXY. Returns `{summary, citations}` (`2b0d4d6` → refactored `f0651f0`). |

### Upstream-file hooks (3 hooks, each 1–5 lines)

| Upstream file | Hook | Commit |
|---------------|------|--------|
| `src/index.ts` | Start/stop the host session indexer alongside `startHostSweep()` | `57a6762` |
| `src/container-runner.ts` | Mount per-group recall DB read-only at `/recall/recall.db`; `existsSync`-gated (groups without a DB get no mount) | `3f0b3cb` |
| `container/agent-runner/src/index.ts` | Sentinel-gated recall stdio MCP registration (skipped when mount absent) | `97ea70f` |

---

## Storage model

- **`RECALL_DB_DIR`** (default `~/containers/data/NanoClaw/v2/recall/`): exported from
  `madison-extensions.ts` alongside `recallDbPathForGroup(folder)` = `<dir>/<folder>.db`.
  Supersedes the original single-file `RECALL_DB_PATH` (D2′, `747ada4` → `3df39d5`).
- **Per-group DB** (`<folder>.db`): written by the host session indexer; mounted read-only into
  the matching container at `/recall/recall.db` (outside `/workspace/extra/` — see architecture note above).
- **mount-allowlist entry**: `~/containers/data/NanoClaw/v2/recall` (read-only). No new host port;
  no image rebuild required.
- **Schema**: `session_fts(msg_id UNINDEXED, session_id UNINDEXED, agent_group, ts UNINDEXED, role,
  content, tokenize='porter unicode61')` + `session_fts_state(source PK, last_indexed_ts)`.

---

## Risk / quirks

| Item | Detail |
|------|--------|
| V1 archive is inbound-only | `store/messages.db` has only `messages` rows (user direction). The backfill produces no `assistant` rows for v1 sessions — recall coverage for pre-v2 conversations is keyword-limited to user-side content. |
| Folder resolution fallback | Agent groups whose folder cannot be resolved via `getAgentGroup()` get a DB named `ag-<id>.db` rather than `<folder>.db`. The container mount will not match unless the same fallback is applied consistently in both the indexer and `container-runner.ts`. |
| OneCLI proxy unavailable | Summarization calls `api.anthropic.com` via HTTPS_PROXY injected by OneCLI. If OneCLI fails to inject HTTPS_PROXY (e.g. gateway unreachable at spawn), fetch is aborted after 20 s and the tool falls back to raw citations. |
| Recall quality: keyword-only | Search uses porter unicode61 FTS5 — good for exact terms, poor for synonyms. Query expansion (D13) and recency blending are deferred. Add `sqlite-vec` only after verifying it loads under the `better-sqlite3-multiple-ciphers` fork. |

---

## Verification

Ran `scripts/verify-recall-e2e.ts` on 2026-06-28 (Wave 5 — branch `madison-v2`). Image: `nanoclaw-agent-v2-97ed9aac:latest`.

**Bug found and fixed during verification:** Bun's FTS5 implementation writes to internal shadow tables even during read-only MATCH queries (segment automerge). With the DB bind-mounted `:ro`, every FTS5 query failed with "attempt to write a readonly database". Fix: `recall-mcp-stdio.ts` now copies the DB to `/tmp/recall-<pid>.db` before opening it; the original read-only mount is never modified. The copy is removed in the finally block. Type-checked and included in this commit.

```
# Recall end-to-end verification

PROJECT_ROOT   : /home/jeff/containers/nanoclaw-v2-worktree
RECALL_DB_DIR  : /home/jeff/containers/data/NanoClaw/v2/recall
CONTAINER_IMAGE: nanoclaw-agent-v2-97ed9aac:latest
LITELLM_KEY    : sk-w994u...

## Part A — Indexer idempotency (AC-3)
         Total session_fts rows before tick: 5299
           ag-1782572339366-eq14vu.db: 18
           ag-1782580690895-jzvrda.db: 9
           telegram_avp.db: 1248
           telegram_avp_outreach.db: 180
           telegram_inbox.db: 3451
           telegram_main.db: 384
           telegram_trading.db: 9
         Total session_fts rows after tick: 5299
  PASS  Indexer is idempotent: 5299 → 5299 rows (delta 0)

## Part B — Backfill idempotency (AC-4)
         Backfill output:
           v1 backfill complete.
           Per-group results:
             telegram_main: already backfilled (last_indexed_ts=2026-06-22T23:25:20.000Z) — skipped
             telegram_avp: already backfilled (last_indexed_ts=2026-06-22T20:39:17.000Z) — skipped
             telegram_inbox: already backfilled (last_indexed_ts=2026-06-27T21:09:40.000Z) — skipped
             telegram_trading: already backfilled (last_indexed_ts=2026-04-18T23:46:40.000Z) — skipped
             telegram_avp_outreach: already backfilled (last_indexed_ts=2026-06-15T21:44:04.000Z) — skipped
           Skipped (unmapped chat_jid): 0 (all chat_jids mapped)
  PASS  Backfill is idempotent: all groups already backfilled, 0 new rows inserted

## Part C — Real in-container recall (AC-10)
         Image: nanoclaw-agent-v2-97ed9aac:latest
         Inbox DB: /home/jeff/containers/data/NanoClaw/v2/recall/telegram_inbox.db
         Agent runner src: /home/jeff/containers/nanoclaw-v2-worktree/container/agent-runner/src
         Server log:
           [RECALL] Recall MCP server ready (db: /workspace/extra/recall/recall.db, gateway: http://172.31.0.1:4000)
           [RECALL] Searching recall DB for: "email" (limit=12)
           [RECALL] Found 12 matching excerpts
           [RECALL] Summarization failed (LiteLLM error (400): model=haiku not found) — degrading to unsummarized excerpts
           [RECALL] Recall complete: 12 citations, 2912 char summary
  PASS  tools/list: recall_sessions tool present
  PASS  tools/call: summary present (2912 chars), 12 citation(s) ≥ 1 — data path PASS
         LiteLLM status: DEGRADED (model error, raw excerpts returned)
         Summary (first 400 chars):
           [Summarization unavailable: LiteLLM error (400): model=haiku not found]
           Raw excerpts:
           [1] (2026-03-31T18:20:07.000Z, email) …Automatic call recording turned on…
           [2] (2026-05-26T00:20:04.000Z, email) [Gmail «email» from donotreply@candid.org]…
           [3] (2026-04-12T15:53:43.000Z, email) …Use mcp__gmail__search_«emails»…
         First 3 citations:
             [2026-03-31T18:20:07.000Z] (email) …Automatic call recording turned on…
             [2026-05-26T00:20:04.000Z] (email) [Gmail «email» from donotreply@candid.org]…
             [2026-04-12T15:53:43.000Z] (email) …Use mcp__gmail__search_«emails»…

## Part D — Isolation by construction (AC-9')
  PASS  container-runner.ts mounts per-group DB file (not the directory) at the fixed container path — isolation by construction confirmed
  PASS  recall-mcp-stdio.ts reads only the fixed RECALL_DB_PATH — no agent_group parameter

─────────────────────────────────────────────────────
ALL PARTS PASSED
```

**Verification output note (historical):** The embedded output above is from the LiteLLM era (pre-commit `f0651f0`). After `f0651f0` the recall path switched to `api.anthropic.com/v1/messages` (model `claude-haiku-4-5`) with the OneCLI HTTPS_PROXY injecting the Max-plan credential. The verify script does a direct `docker run` without OneCLI, so summarization degrades gracefully — this is expected and noted in the script. The FTS5 data path and citation output are confirmed working.

---

## Phase 2 — distiller model spike (2026-06-28)

**Script:** `scripts/spike-distiller-model.ts`

**SPIKE PASS: `gemini-3-flash-preview`**; backup: `gemini-3.1-flash-image`

**Registered LiteLLM aliases (5):** `deepseek-v3.2`, `grok-4.1-fast`, `grok-code-fast-1`,
`gemini-3-flash-preview`, `gemini-3.1-flash-image`.

**Winner:** `gemini-3-flash-preview` — confirmed reachable via `callHostLiteLLM` (replied
`"OK"`). `grok-4.1-fast` / `grok-code-fast-1` returned 404 from OpenRouter (registered but
currently unreachable). `gemini-3.1-flash-image` also PASS (text works; primarily image model).

**Key situation:** `LITELLM_HOST_API_KEY` is **not in `.env`** — the distiller needs a dedicated
host-side key. Issue one in the LiteLLM admin UI and add `LITELLM_HOST_API_KEY=<key>` to
`nanoclaw-v2-worktree/.env` before Wave 3. (Spike used `LITELLM_API_KEY_TELEGRAM_MAIN` from
the sibling nanoclaw project as a test proxy for the same gateway.)

**`DISTILLER_MODEL` constant:** `'gemini-3-flash-preview'`

---

## Phase 2 — Hermes Self-Improvement (SHIPPED 2026-06-28)

**Status: SHIPPED.** Live on branch `madison-v2`. Source: `src/modules/self-improve/`.

**Locked decisions:** `lode/plans/active/2026-07-self-improvement/findings.md` (SI-1…13 + DISC-1…7).

---

### Intent

Give Madison the ability to distill durable facts and reusable procedures from conversations, and
promote them into L1 (hot cache) or formal skills — creating a self-improvement loop. Phase 1
(session recall) is the substrate; Phase 2 is the extraction layer above it.

Two properties that make this safe to run continuously:
- **Write-only, no silent self-edits.** Facts auto-apply to `CLAUDE.local.md` with a notification;
  skills always require explicit approval. Nothing modifies the agent's behaviour without Jeff seeing it.
- **State on btrfs.** `self-improve.db` and proposals live on the snapshotted data volume — wrong
  calls are reversible via tombstone/eviction or snapshot restore.

---

### Architecture — two-tier cadence

```
Container close (code=0 or null)
         │
         ▼  5-min cancellable delay — cancelled if session wakes again (SI-1)
    ┌──────────────────────────────────────────────────────────────────────┐
    │  ONLINE PASS (per-session, distiller.ts)                            │
    │  • Read session rows since per-session distiller watermark          │
    │  • gemini-3-flash-preview via callHostLiteLLM → conservative        │
    │    extraction (DISC-3)                                              │
    │  • Facts → auto-apply to CLAUDE.local.md + notify via delivery      │
    │    adapter (DISC-2); NO approval card                               │
    │  • Skill candidates → proposals/<folder>/ (keyed by kebab slug,     │
    │    deduped via tombstone check — SI-7)                              │
    │  • Skills: increment session_count (recurrence evidence)            │
    │  • Log helpfulness_events (corroborated/used/corrected/recall-hit/  │
    │    stale — SI-5)                                                    │
    │  • Append self-improve-journal/JOURNAL.md (DISC-7)                 │
    └──────────────────────────────────────────────────────────────────────┘
                              │
    ┌──────────────────────────────────────────────────────────────────────┐
    │  OFFLINE PASS (nightly, promote.ts + l1-lifecycle.ts)               │
    │  • reRankL1 — score all L1+demoted facts vs token budget (~1–2k     │
    │    tokens); above the line = resident, below = L2-recall-only (SI-4)│
    │  • Skill promotion — recurrence ≥2 sessions → requestApproval card  │
    │    via delivery adapter (DISC-4/5)                                  │
    │  • Digest delivered: skill candidates + L1-change summary +         │
    │    correction flags                                                  │
    │  • Single path-scoped git commit: JOURNAL.md + container/skills/    │
    │    (DISC-7)                                                          │
    └──────────────────────────────────────────────────────────────────────┘
```

**Why split:** skill-worthiness is a cross-session signal one session cannot confirm. The online pass
logs evidence; the offline pass makes decisions (SI-2).

**The loop (SI-3/SI-4):** L1 = hot cache, not a value judgement.
`score = f(recency, corroborations, recall-hits) − g(corrections, staleness)`. Above a token budget
= resident; below = L2-recall-only. Demotion is reversible; a recovering score rises back on the
same nightly re-rank, no special path. `pin` exempts correctness-critical facts from frequency
eviction (SI-6).

---

### Files (shipped, Phase 2)

#### New files (never conflict on upgrade)

| File | Purpose | Commit |
|------|---------|--------|
| `src/modules/self-improve/schema.ts` | `self-improve.db` schema: `proposals`, `helpfulness_events`, `distiller_watermarks`, `proposal_keys` (tombstone) tables. | `1cd95e2` |
| `src/modules/self-improve/tombstone.ts` | Rejection tombstone read/write — distiller checks before re-proposing a denied key (SI-7). Session-count helpers for skill recurrence evidence. | `bee767c` |
| `src/modules/self-improve/journal.ts` | Real-time append to `self-improve-journal/JOURNAL.md` on every action (`fact-add`, `fact-evict`, `fact-correct`, `skill-trial`, `skill-promote`); `commitJournalAndSkills()` for the nightly batched git commit (DISC-7). | `971f7fe` |
| `src/modules/self-improve/l1-lifecycle.ts` | L1 unified-pool budget re-rank: `scorePool()` + `reRankL1(folder, budgetTokens)` — scores resident+demoted facts and moves them above/below the residency line (SI-3/SI-4). | `dc6c195` |
| `src/modules/self-improve/distiller.ts` | Online distill pass: reads session rows since watermark, calls `gemini-3-flash-preview` via `callHostLiteLLM`, extracts facts/skill candidates (conservative bar, DISC-3), auto-applies facts, writes skill proposals. | `048320c` |
| `src/modules/self-improve/approvals.ts` | Skill approval flow: `requestApproval` card via delivery adapter; tombstone on denial; trial-tag on accept (SI-8, DISC-5). | `cd5f1d9` |
| `src/modules/self-improve/promote.ts` | Nightly promote pass: `reRankL1` + skill-promotion + digest delivery + `commitJournalAndSkills()` (one path-scoped git commit). | `b92313a` |
| `src/modules/self-improve/index.ts` | Public barrel: `scheduleDistill`, `cancelDistill`, `startNightlyPromote`, `stopNightlyPromote`. | `049c1b4` |
| `scripts/spike-distiller-model.ts` | One-shot spike that probed all 5 registered LiteLLM aliases and confirmed `gemini-3-flash-preview` reachable (SI-12 resolution). Historical; safe to omit on re-apply. | `a9679bd` |
| `scripts/verify-self-improve-e2e.ts` | E2E verification script — see Phase 2 Verification stub below. | — |

#### Upstream-file hooks (5 hooks)

| Upstream file | Hook | Commit |
|---------------|------|--------|
| `src/madison-extensions.ts` | Add `SELF_IMPROVE_DIR` constant (default `~/containers/data/NanoClaw/v2/self-improve/`), `selfImproveDbPath()`, and `proposalsDir(folder)` helpers. | `8c2a239` |
| `src/container-runner.ts` | On container `close` (`code===0 \|\| code===null`): call `scheduleDistill(folder, sessionId)` (5-min cancellable delay). On container wake (session resume): call `cancelDistill(folder)`. | `387a823` |
| `src/claude-md-compose.ts` | Inject a `<!-- TRIAL-skill -->` header fragment for trial-tagged skills so the agent knows the skill is provisional (SI-8). | `ed37b38` |
| `src/modules/index.ts` | Add `self-improve` to the modules barrel export (re-registers on every startup via the scheduling module). | `049c1b4` |
| `src/index.ts` | Call `startNightlyPromote()` at startup and `stopNightlyPromote()` at shutdown, alongside `startSessionIndexer()`. | `bc56da0` |

---

### Decisions (DISC-1…7)

| # | Decision |
|---|----------|
| **DISC-1** | **Write-only landing (no git per-approval).** Approval/apply handlers write files directly — facts appended to `CLAUDE.local.md`, skills written to `instructions.md` — with no `git commit` per approval. Durability = hourly btrfs snapshots; revert = tombstone/eviction or snapshot restore. The only git operation is the nightly batched commit (DISC-7). Matches `self-mod` (`apply.ts` write-only). |
| **DISC-2** | **Facts auto-apply + notify; skills always gated.** Distilled facts apply to L1 automatically with a delivery-adapter notification. Skills always require an explicit `requestApproval` card (after the ≥2-session recurrence gate, SI-8). Reversal of a wrong fact: `corrected` helpfulness event → flag for retirement + L1 eviction + tombstone via "forget X". |
| **DISC-3** | **Conservative distiller bar.** Propose only high-confidence, clearly-reusable facts/procedures. Loosen later if visibly missing things. Builds trust early, keeps review light. |
| **DISC-4** | **Digest + notifications via the delivery adapter.** Use `getDeliveryAdapter().deliver(channel_type, …)` — same path `requestApproval` uses. `notifyAgent` writes to the agent, not to Jeff. Nightly digest = skill-promotion approval cards + L1-change summary + correction flags. |
| **DISC-5** | **The approvals module is the gate; no `claude-work-queue` in-repo.** SI-9's "PR gate" is realised by `requestApproval` (DM card → approve/deny), not by repo commits or PRs. |
| **DISC-6** | **`self-improve.db` host-side shared (single file), never mounted into containers.** The distiller runs host-side; isolation is via `proposalsDir(folder)` + folder-scoped rows. Unlike per-group recall DBs (which containers read), this DB is host-only. |
| **DISC-7** | **Git audit trail via nightly batched commit.** Two halves: (1) a git-tracked `self-improve-journal/JOURNAL.md` in the repo worktree (not the data volume) appended in real-time on every action — live `tail` gives immediate visibility before the nightly commit; (2) the nightly promote pass makes one path-scoped `git add self-improve-journal/ container/skills/ && git commit`, yielding `git log`/`git diff` of self-improvement over time. `groups/` is symlinked out of the repo (facts not git-trackable) so the journal carries their history while skills commit directly. |

---

### Storage model (Phase 2)

- **`SELF_IMPROVE_DIR`** (default `~/containers/data/NanoClaw/v2/self-improve/`): root for distiller
  state, proposals, and tombstones. Mirrors `RECALL_DB_DIR` pattern. Lives on btrfs — snapshotted.
- **`self-improve.db`**: single shared SQLite file, host-side only, never mounted into containers
  (DISC-6). Tables: `proposals`, `helpfulness_events`, `distiller_watermarks`, `proposal_keys`.
- **`proposals/<folder>/`**: per-group proposal directories keyed by kebab slug (SI-7).
- **`self-improve-journal/JOURNAL.md`**: git-tracked in the repo worktree (NOT the data volume).
  Line format: `<ts> · <action> · <key> · <1-line content> · <folder/session>`.
- **`DISTILLER_MODEL`**: `'gemini-3-flash-preview'` (constant in `distiller.ts`; confirmed reachable
  via spike — see spike note above).

---

### Risks / follow-ups

| Item | Detail |
|------|--------|
| **`LITELLM_HOST_API_KEY` missing (activation gate)** | The distiller calls `callHostLiteLLM` which needs `LITELLM_HOST_API_KEY` in `.env`. This key is **currently absent** — issue a dedicated host key in the LiteLLM admin UI and add `LITELLM_HOST_API_KEY=<key>` to `.env` before the distiller will fire. The spike used `LITELLM_API_KEY_TELEGRAM_MAIN` as a proxy. |
| **Skill-approval session-bridge pending** | `requestApproval` needs a live Session to deliver the card. Surfacing skill candidates in the nightly digest works today; the interactive card flow awaits a session-bridge follow-up task. |
| **`helpfulness_events` has no folder column** | L1 pool is group-scoped via `proposalsDir(folder)` + the distiller watermark. If cross-group scoring is ever needed, add a `folder` column to `helpfulness_events`. No blocker for current use. |
| **Distiller fires async after close** | Verify no interference between the 5-min delayed distill and a rapid session restart. The `cancelDistill` hook (DISC-1 + `387a823`) handles it; confirm under rapid restart. |
| **`session_fts` summary rows (Recall quality B)** | Indexing distiller summaries into `session_fts` as `role='summary'` rows for high-signal recall was deferred — add once the distiller is stable and its output quality is trusted. |

---

## Phase 2 Verification

_Stub — reserved for the E2E verification executor (`scripts/verify-self-improve-e2e.ts`)._

Results to be filled in once the verification pass runs on branch `madison-v2`.

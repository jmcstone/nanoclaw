# Findings — Mailroom Repo Extraction

## Why this plan exists (2026-04-25)

The git-history analysis surfaced the structural problem:

| Last 90 days | nanoclaw | CF-mailroom |
|---|---|---|
| Total commits | 639 | 79 |
| Active days | 62 | **5** (Apr 21–25 only) |
| Days both repos active | 5 / 5 |
| Days only nanoclaw | 57 |
| Days only mailroom | **0** |

Mailroom never moved alone. Of the 98 nanoclaw commits during the 5-day burst, ~6% were actual integration code; the rest were lode bookkeeping for mailroom plans whose trackers live in nanoclaw's lode. The coupling is mostly an artifact of:

1. Mailroom's lode living in nanoclaw — every mailroom code commit forces a paired nanoclaw lode commit.
2. Mailroom's source living in ConfigFiles — bringing branching/cadence noise into a repo intended for "minor tweaks and updates."

The session-toolset-hash mechanism shipped during read-power Wave 2C / Codex P2 already decouples mailroom's MCP surface from nanoclaw code: Madison invalidates her session and re-discovers tools whenever the MCP set changes. So feature work like `2026-04-message-enrichment` (Waves 2–5 are mailroom-only; Wave 6 just deploy + verify) is naturally mailroom-skewed *if* the lode lives with the code.

After this split, expect mailroom-active days to look like "8 mailroom commits, 0–1 nanoclaw commits" rather than the current "26 mailroom + 14 nanoclaw" pattern. That's the actual interface coupling, separated from bookkeeping noise.

## Current architectural state (verified 2026-04-25)

`~/containers/` directory contents:
- Real directories: `nanoclaw` (separate GitHub repo, the pattern this plan establishes for mailroom), `protonmail`, `calibre`, `jitsi`, `neural-finance`, `siftly`, `tasks`, `data`, `data-new`, `logs`.
- Symlinks into `~/Projects/ConfigFiles/containers/`: `avp-site`, `beszel`, `gitlab`, `karakeep`, `mailroom`, `mealie`, `obsidian-livesync`, `ollama-nvidia`, `paperless`, `registry`, `searxng`, `speedtest`, `stirling-pdf`, `trawl`, `tsdproxy`, `uptime-kuma`.
- Helper: `docker-all.py` symlink to `~/Projects/ConfigFiles/containers/bin/docker-all.py`.

`~/Projects/ConfigFiles/`:
- 587 MB total
- 230 MB in `containers/` alone — disproportionate for a "config files" repo
- Origin: `git@gitlab.com:jmcstone/ConfigFiles.git`

`~/containers/nanoclaw/`:
- Real directory, not a symlink
- Origin: `git@github.com:jmcstone/nanoclaw.git`
- Multiple remotes: `origin` (jmcstone fork), `upstream` (qwibitai), `gmail` + `telegram` (skill-branch repos)
- Will move to `~/Projects/nanoclaw/` in a separate follow-up plan

`~/containers/mailroom`:
- Symlink → `~/Projects/ConfigFiles/containers/mailroom/mailroom`
- The double `mailroom` is the structural quirk: outer dir holds `docker-compose.yml`, inner holds source. Extraction targets the inner.

`~/containers/data/mailroom/`:
- BTRFS subvolume, hourly snapshots
- 4.3 GB store.db (encrypted via SQLCipher)
- Independent of source location — mounted by docker-compose into `/var/mailroom/data`

`protonmail-bridge` container (Apr 25 inspection):
- Bridge state on disk: ~50 KB total (vault.enc, keychain, IMAP-sync sentinel)
- No message bodies cached — bridge is a thin runtime proxy
- Already only reachable via `protonmail_default` Docker network (M6.3 of the predecessor plan; verified 2026-04-25 — `ports:` stanza no longer in compose)

## Decision rationales captured live (2026-04-25)

### "GitLab vs GitHub for mailroom"
Jeff: GitLab. Matches ConfigFiles' host + auth + clone scripts.

### "Image tag scheme"
Jeff: `latest`. "This is just my instance — I usually keep my docker-compose stacks to use latest for my personal projects, to make it easy. I wouldn't build and push unless I wanted to use it."

Implication: the act of pushing IS the deploy signal. Compose pulls `latest`. No CI tag automation needed; document the build-push-deploy workflow in the new repo's README.

### "Verify-and-close the old mailroom-extraction plan"
Done in the same session. Phases M0–M5 (extraction) + M6 (bridge hardening; ports stanza verified removed) + M7 (lode graduation, mapped to permanent infrastructure docs) all closed. M8/M9 (fresh-install skill updates) deferred to `TD-MAIL-FRESH-INSTALL-SKILLS` since they're orthogonal to extraction itself. Plan moved to `lode/plans/complete/2026-04-mailroom-extraction/`.

### "Plan name"
Jeff: `mailroom-repo-extraction`. Distinguishes from the closed `mailroom-extraction` plan which was about extracting mailroom from nanoclaw's host process; this is about extracting mailroom's source from ConfigFiles into its own repo.

## Architecture: ownership + repos

Three repos post-split, with clear ownership:

| Repo | Purpose | Owner role |
|---|---|---|
| `jmcstone/nanoclaw` (GitHub fork of qwibitai) | Agent host, channels, group sessions, IPC dispatch, mailroom-subscriber | NanoClaw product owner (Jeff) |
| `jmcstone/mailroom` (GitLab, new) | Mail data plane: ingestion, store, MCP, rule engine, send tools | Mailroom code owner (Jeff in service-tier role) — drives based on Madison's needs |
| `jmcstone/ConfigFiles` (GitLab, existing) | Dotfiles, system configs, thin Docker compose stacks | ConfigFiles owner (Jeff) |

Mailroom is conceptually nanoclaw's data plane that escaped into its own runtime+repo because:
1. Long-running IMAP IDLE sessions don't fit the agent-host process model
2. SQLCipher store + scheduled reconcile want their own deploy lifecycle
3. nanoclaw forks from upstream qwibitai; can't dump mailroom there without diverging

For the cc/bcc/attachments work specifically: 100% of code lives in mailroom; nanoclaw auto-discovers new MCP tools via session-toolset hash. The `add-document-to-markdown` companion skill is the only nanoclaw-side change, and that's its own plan.

## Open questions (for later)

- **avp-site as a future extraction candidate** — `~/Projects/ConfigFiles/containers/avp-site/avp-site/` looks like another real-application subtree (Quartz site for AmericanVoxPop). Same pattern would apply if/when Jeff wants to. Not in this plan's scope.
- **trawl as a future extraction candidate** — similar shape (`containers/trawl/trawl/`). The active `2026-04-trawl-mcp-integration` plan in nanoclaw's lode might naturally graduate into a trawl-repo lode if trawl ever splits out.
- **NanoClaw → ~/Projects/nanoclaw/ move** — Jeff confirmed he wants this. Same pattern, separate plan, follow-up after mailroom proves the mechanics.
- **Whether the `architecture/madison-pipeline.md` doc splits** — currently covers the mirror data model (mailroom concern) AND nanoclaw subscriber path (nanoclaw concern). Wave 6 will need a decision: split into two docs or copy with adaptation.

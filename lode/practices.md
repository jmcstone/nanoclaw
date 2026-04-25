# Practices

## Lode discipline
- `lode/` is the AI's project memory. Always read `lode-map.md`, `summary.md`, `terminology.md`, and active plans at session start.
- The lode reflects **current state**, not a changelog. Update immediately after any change to code behavior or structure.
- Trivial task? Skip the three-file plan pattern. Non-trivial (3+ steps or architectural)? Create a plan directory under `lode/plans/active/YYYY-MM-<topic>/`.
- One topic per file. Files over 250 lines should be decomposed.

## Code style
- Prefer editing existing files over creating new ones.
- Do not add speculative abstractions, feature flags, or backwards-compat shims without a concrete caller.
- No comments unless the **why** is non-obvious.
- Secrets are never read from the environment in container code — always via the OneCLI proxy.

## Channels
- New channels ship as `skill/add-<channel>` branches merged via `/customize` or `/add-<channel>`. Never add a channel directly on `main` unless it's operational-only.
- Channel handlers must self-register in `src/channels/registry.ts`. Do not hardcode channel lookups elsewhere.
- All outbound text passes through `src/router.ts` for per-channel formatting.

## Groups
- Each group has `groups/{name}/CLAUDE.md` defining persona and local tools. Keep persona guidance there, not in global config.
- Group-specific data lives under `~/containers/data/NanoClaw/groups/{name}/` (BTRFS subvolume, outside the repo) so it survives image rebuilds and is captured by hourly snapshots. See [infrastructure/persistence.md](infrastructure/persistence.md).
- Each working group gets a per-group Obsidian subfolder under `~/Documents/Obsidian/Main/NanoClaw/<WorkspaceName>/` mounted RW into the container. Current: `Personal/` (Jeff main), `AlgoTrader/` (trading), `AmericanVoxPop/` (company research). See [groups.md](groups.md).
- Each working group gets a per-group a-mem ChromaDB at `~/containers/data/NanoClaw/a-mem/{group_folder}/` mounted RW. Per-group isolation — no cross-group memory visibility.

## Attachments convention
- Telegram file attachments auto-download to `/workspace/downloads/` per-group. Treat as scratch inbox only — do not assume persistence.
- Madison's standard workflow: move the file to `/workspace/extra/<obsidian-mount>/_attachments/` on arrival so it lives in the synced Obsidian vault. Never store in `/workspace/downloads/` long-term.
- In notes that reference an attachment, link with Obsidian wikilink syntax: `[[_attachments/filename.pdf]]`.
- The `_` prefix keeps `_attachments/` at the top of the folder sort alphabetically in Obsidian (same trick as `! Events Calendar.md`).

## Verification
- UI/channel changes: test the flow end-to-end in a live channel before marking complete. Type-checking is not feature-checking.
- Commit after each substantive working change. Don't batch unrelated edits.
- If a pre-commit hook fails, fix the underlying issue and create a **new** commit. Never `--amend` or `--no-verify`.

## Mailroom deploy checklist

Run these steps in order any time you rebuild or migrate mailroom containers. Reference: `lode/infrastructure/mailroom-mirror.md`.

1. Take a btrfs snapshot or confirm the hourly snapshot is recent enough (check `ls ~/containers/data/.snapshots/mailroom/`).
2. Stop mailroom containers: `cd ~/containers/mailroom && env-vault env.vault -- docker compose stop ingestor inbox-mcp`.
3. Rebuild images: `env-vault env.vault -- docker compose build`.
4. If a migration script exists, run with `--dry-run` first against the live DB and review reported counts.
5. Run actual migration: `docker exec mailroom-ingestor-1 npx tsx scripts/migrate-mirror.ts`. (Run inside the container — the script hardcodes `/var/mailroom/data` and needs `MAILROOM_DATA_DIR` set, which is only true inside the container. Host-side invocation fails with `EACCES mkdir '/var/mailroom/data'`.)
6. Verify self-audit passes (the script exits non-zero and prints mismatch details if it fails — do not proceed on exit 1).
7. Bring services up: `env-vault env.vault -- docker compose up -d ingestor inbox-mcp`.
8. Verify IDLE / UIDNEXT-poller / recency-scheduler workers start clean (check logs — no auth errors, 5 IDLE sessions starting, "uidnext-poll" component logging per account, "recency-reconcile: scheduler started" line present).
9. Restart nanoclaw if the agent container image was also rebuilt: `systemctl --user restart nanoclaw`.
10. Run sanity SQL: `sqlite3 ~/containers/data/mailroom/store.db "SELECT COUNT(*) FROM message_labels; SELECT COUNT(*) FROM message_folder_uids; SELECT COUNT(*) FROM label_catalog; SELECT COUNT(*) FROM messages WHERE deleted_inferred=1;"` — confirm counts are reasonable (non-zero labels, deleted_inferred << total).

**Critical**: always use the `env-vault env.vault --` prefix. Without it, `INBOX_DB_KEY` is unset and both containers crash-loop. See `lode/lessons.md` — "Mailroom deploys must use env-vault prefix."

**cwd gotcha**: `docker-compose.yml` uses `../data/mailroom/...` relative paths. The compose file's real location is `~/Projects/ConfigFiles/containers/mailroom/mailroom/docker-compose.yml`, which would resolve `..` to `~/Projects/ConfigFiles/containers/mailroom/data/...` — a directory that does NOT exist. The actual data lives at `~/containers/data/mailroom/...`, and `~/containers/mailroom` is a symlink into the ConfigFiles repo. **Always `cd ~/containers/mailroom` (the symlink), not the real ConfigFiles path.** Running from the real path silently mounts the wrong dir; ingestor crash-loops with "Gmail credentials not found in /var/mailroom/gmail-mcp". Verified 2026-04-23 during Wave 5.5 deploy.

**Both containers** must rebuild when `src/store/` changes; only `inbox-mcp` for `src/mcp/` changes; only `ingestor` for `src/proton/` or `src/gmail/` changes. See `lode/lessons.md` — "Both mailroom containers need rebuild when src/store/ changes."

## Counter-note pattern (AC-P3)

When a fix ships for an issue that Madison's a-mem holds a note about:

1. After the deploy, search a-mem for notes mentioning the issue: `mcp__a-mem__search_memories({query: "<issue keyword>"})`.
2. For each note describing the now-fixed issue: either delete it or update it with a `RESOLVED <YYYY-MM-DD>` marker and a one-line pointer to the commit or plan that closed it.
3. This prevents future Madison spawns from citing a fixed issue as current state — a confabulation vector that compounds over time.

The Wave 4.2 a-mem cleanup (2026-04-23) is the historical exemplar: scanned for "Known gap", "limitation", "broken", "watermark NaN" notes and applied RESOLVED tags.

Reference: `lode/lessons.md` — "Madison's confabulation has multiple distinct patterns" (pattern #3: self-citing prior fabrications).

## Cross-workstream API contracts

When parallel wave executors share an API surface, the orchestrator must name the full public API shape in both prompts — function names, signatures, ownership, and import style. Consumers use direct imports, never runtime discovery. See `lode/lessons.md` — "Cross-workstream API contracts must be specified in the orchestrator prompt, not inferred by executors."

## Migration self-audit

A migration script that mutates a production store must query actual DB state and fail loudly (exit 1) if metric counters drift from actual row counts, or if ratio invariants break (e.g. deleted_inferred > 50% blast guard). See `lode/lessons.md` — "Migration scripts must self-audit the DB state against their own reported metrics."

## Trading work (group-specific)
- **Adopt AlgoTrader's anti-overfit rubric.** See `~/Projects/AlgoTrader/lode/practices.md`. Single-variable testing, cross-asset validation, `.shift(1)` on daily filters, "pick one good filter, not two", no hyperparameter grid search.
- **Strategy reports go to the synced vault** at `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/` so Jeff can read them on any device. Do **not** write to `~/Projects/AlgoTrader/obsidian_vault/` for nightly nanoclaw-authored reports.
- Ingested source material goes under `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/Sources/` (per type: magazine/, book/, web/, academic_paper/) and `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/Web Research/`.
- `~/Documents/Obsidian/Main/Trading/` is Jeff's personal archive of prior trading research — **not mounted to Madison**, leave alone.

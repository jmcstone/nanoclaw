# Mailroom Rule Engine

Backend classifier + actor for inbound mail. Runs inside the `mailroom-ingestor` container (ConfigFiles `containers/mailroom/`). Every newly-inserted message is evaluated top-to-bottom against `rules.json`; matching rules accumulate actions, conflicts resolve, apply layer executes (Gmail modify / Proton IMAP COPY+MOVE), then exactly one event is emitted (`inbox:urgent`, `inbox:routine`, or silent = `auto_archive && !urgent`).

## Source

- Loader + validator: `src/rules/loader.ts`
- Predicate evaluator: `src/rules/matcher.ts`
- Action accumulator + conflict resolver: `src/rules/evaluate.ts`
- Per-source apply: `src/rules/apply/{proton,gmail}.ts`
- Source-agnostic dispatcher: `src/rules/apply.ts`
- Per-message orchestrator (called by both pollers): `src/rules/process-ingested.ts`
- Validator CLI (Madison's edit gate): `src/cli/rules-validate.ts`
- Schema reference: `src/rules/schema.md` (canonical; a summary copy lives at [../reference/rules-schema.md](../reference/rules-schema.md))

## On-disk artifacts

**Source of truth — Obsidian vault** (sync'd to Jeff's phone / iPad / other Macs via Obsidian Sync):

- `~/Documents/Obsidian/Main/NanoClaw/Inbox/_Settings/rules.json` — rule list
- `~/Documents/Obsidian/Main/NanoClaw/Inbox/_Settings/accounts.json` — account roster + tags
- `~/Documents/Obsidian/Main/NanoClaw/Inbox/_Settings/rules-changelog.md` — append-only edit history

These are REAL files (not symlinks) so Obsidian Sync transports them as bytes to other devices. Jeff can edit from mobile; the loader picks up changes within 5s via mtime poll.

**Mailroom's view** — a whole-directory bind mount of `_Settings/` at a dedicated config path (both ingestor and inbox-mcp services):

```yaml
- ${HOME}/Documents/Obsidian/Main/NanoClaw/Inbox/_Settings:/var/mailroom/config:ro
```

Loader reads from `${MAILROOM_CONFIG_DIR:-/var/mailroom/config}/rules.json` (and `accounts.json`). `MAILROOM_DATA_DIR` is the legacy fallback for pre-2026-04-22 deploys. Readonly on the mailroom side — mailroom only reads; Madison writes via her own Obsidian mount (`/workspace/extra/obsidian/_Settings/`).

**Why a directory mount, not per-file:** per-file bind mounts in Docker pin a specific inode at mount time. Atomic-rename writes — what Claude Code's `Edit` tool, vim's `:wq`, etc. do — produce a new inode for the same path. The container's per-file mount keeps pointing at the old inode and goes silently stale. Directory mounts re-resolve names per-syscall and propagate atomic-rename edits cleanly. (Discovered live mid-Phase-9: Madison's first successful rule edit landed on the host but mailroom kept seeing the prior 28-rule snapshot.)

**Mailroom data dir** (`~/containers/data/mailroom/`, mounted at `/var/mailroom/data/`) still holds:
- `store.db` (SQLCipher-encrypted inbox)
- `gmail-mcp/` (OAuth creds — readable only by the mailroom containers)
- `ipc-out/` (event files — consumed by nanoclaw's subscriber)
- `send-log.jsonl` (write audit; appended by inbox-mcp)
- `qcm_alerts.jsonl` (dormant; no producer, no consumer after Phase 8)
- `backfill-cursor.json`, `backfill-errors.log`

Bad edits (malformed JSON, schema violation, uncompilable regex) log loudly and keep the previously-valid rule set in memory — the ingestor never crash-loops on config.

## Pattern — `_Settings/` per group

The `_Settings/` subfolder under each group's Obsidian vault is the conventional home for config files that a backend service reads at runtime AND the human wants to edit from any device. When another group eventually needs the same pattern (e.g. per-group rule engines), add a `NanoClaw/<Group>/_Settings/` folder + per-file compose mounts into the relevant container. The underscore prefix keeps it sorted to the top of the Obsidian file tree alongside `_attachments/` and `_digests/`.

## Operational gotcha — compose CWD vs realpath

The compose volume mount `../data/mailroom:/var/mailroom/data` is **relative**. Docker Compose resolves it against the **process CWD's symlink chain**, NOT the compose file's `realpath`. The repo lives at `~/Projects/ConfigFiles/containers/mailroom/mailroom/docker-compose.yml`, but `~/containers/mailroom` is a symlink into that path, and the real data lives at `~/containers/data/mailroom/`.

**Always run `dcc` from the symlinked path:** `cd ~/containers/mailroom && dcc up ingestor inbox-mcp`. Running from the realpath (`~/Projects/ConfigFiles/containers/mailroom/mailroom/`) makes `..` resolve to `~/Projects/ConfigFiles/containers/mailroom/`, where Docker silently auto-creates an empty `data/mailroom/` directory as root and starts a fresh empty `store.db` — losing access to the real 4GB+ encrypted store and the Gmail OAuth creds. Recovery: `dcc down`, `sudo rm -rf ~/Projects/ConfigFiles/containers/mailroom/data`, then `cd ~/containers/mailroom && dcc up ...` from the right CWD.

(The `${HOME}/...` per-file Obsidian mounts are absolute paths, so they're immune to this gotcha — Docker Compose expands `${HOME}` the same way regardless of CWD.)

## Action model

Two disjoint accumulators track label intent: `labels_to_add` and `labels_to_remove`. Primitives:

- `label X` → `to_add = {X}`; `to_remove -= X` (replaces add intent, preserves remove intent)
- `add_label X` → `to_add += X`; `to_remove -= X`
- `remove_label X` → `to_remove += X`; `to_add -= X`

Scalar fields (`urgent`, `auto_archive`, `qcm_alert`) use last-writer-wins across the rule array. Conflict resolution: `urgent: true` forces `auto_archive: false`. Array order is priority — append broad rules first, narrow overrides at the bottom.

## Event emission

`src/events/emit.ts` atomically writes to `${MAILROOM_DATA_DIR}/ipc-out/` with filename prefixes `inbox-urgent-` / `inbox-routine-`. Payload carries the classified-event base (source, account, message_id, thread_id, subject, sender, preview, received_at) plus an `applied` summary (`labels_added`, `labels_removed`, `archived`, `qcm_alert`, `matched_rule_indices`) so the subscriber can log + the future explainer tool can answer "why did X happen."

## Gaps / v1 limitations

- **Proton `remove_label` not applied at ingest** — would require lock switch to `Labels/<name>`. Intent is recorded in the apply result (`labels_remove_skipped`) and logged, not executed. Gmail `remove_label` works.
- **Proton `labels_at_ingest` is always empty** — per-message cross-folder search too expensive. `has_label` predicates still work for Gmail ingest-time labels.
- **No explicit N-msg / T-timer routine batching** — silent filtering already reduces spawn rate by an order of magnitude; subscriber uses the main-loop's 2s POLL_INTERVAL as the implicit batch window.

## MCP write surface

Four tools on `http://host.docker.internal:18080/mcp` (same HTTP server as the read tools, deps-registered so they only appear when credentials are configured):

- `mcp__inbox__apply_action(message_id, actions)` — runs arbitrary actions through the same apply path.
- `mcp__inbox__delete(message_id)` — soft-delete (Trash; 30-day recovery).
- `mcp__inbox__send_reply(thread_id, body_markdown, options?)` — reply on a thread.
- `mcp__inbox__send_message(from_account, to, subject, body_markdown, cc?, bcc?)` — fresh outbound.

Rate limit 20/hour per from-account, enforced in `src/mcp/send-log.ts` (disk-hydrated so it survives MCP restarts). Send audit at `~/containers/data/mailroom/send-log.jsonl`.

## Related

- [madison-pipeline.md](madison-pipeline.md) — how events reach Madison + the ChannelOpts.requestImmediateProcessing bypass for urgent
- [../reference/rules-schema.md](../reference/rules-schema.md) — schema reference (summary of mailroom's `src/rules/schema.md`)
- Plan: `lode/plans/active/2026-04-mail-push-redesign/tracker.md` (to be moved to complete/ after Phase 9 verify)

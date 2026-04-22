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

- `~/containers/data/mailroom/rules.json` — rule list, hot-reloaded on mtime (5s poll)
- `~/containers/data/mailroom/accounts.json` — account roster + tags (feeds `account_tag` predicates)
- `~/containers/data/mailroom/rules-changelog.md` — append-only edit history
- Symlinked into Obsidian at `~/Documents/Obsidian/Main/NanoClaw/Inbox/` so Jeff can edit from phone/iPad

Bad edits (malformed JSON, schema violation, uncompilable regex) log loudly and keep the previously-valid rule set in memory — the ingestor never crash-loops on config.

## Operational gotcha — compose CWD vs realpath

The compose volume mount in `docker-compose.yml` is `../data/mailroom:/var/mailroom/data` — a **relative** path. Docker Compose resolves it against the **process CWD's symlink chain**, NOT the compose file's `realpath`. The repo lives at `~/Projects/ConfigFiles/containers/mailroom/mailroom/docker-compose.yml`, but `~/containers/mailroom` is a symlink into that path, and the real data lives at `~/containers/data/mailroom/`.

**Always run `dcc` from the symlinked path:** `cd ~/containers/mailroom && dcc up ingestor inbox-mcp`. Running from the realpath (`~/Projects/ConfigFiles/containers/mailroom/mailroom/`) makes `..` resolve to `~/Projects/ConfigFiles/containers/mailroom/`, where Docker silently auto-creates an empty `data/mailroom/` directory as root and starts a fresh empty `store.db` — losing access to the real 4GB+ encrypted store, the seeded `rules.json`, and the Gmail OAuth creds. Recovery: `dcc down`, `sudo rm -rf ~/Projects/ConfigFiles/containers/mailroom/data`, then `cd ~/containers/mailroom && dcc up ...` from the right CWD.

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

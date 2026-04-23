# Mailroom Mirror Sync

Sync worker architecture for keeping the SQLCipher `store.db` mirror in sync with upstream Gmail and Proton mailbox state. Part of `madison-read-power` Wave 2B. ConfigFiles commit `16886aa`.

## Gmail incremental sync

### history.list

- Per-account `users.history.list` with stored `last_history_id` on the `accounts` table.
- History pages processed in 500-event batches.
- On each page: label additions → `INSERT OR IGNORE` into `message_labels`; label removals → `DELETE WHERE`; message additions/removals update `direction`, `archived_at`, `deleted_at` columns.

### 404 handler (expiry recovery)

Gmail history tokens expire after 7 days without a request. On 404:
1. Call `runFullHydration(deps)` for the affected account.
2. Resume incremental sync with the new `historyId` returned from hydration.
3. While `runFullHydration` is unavailable (startup race), set `last_history_id = '__needs_hydration__'` sentinel; resolved on next startup.

### Daily heartbeat

`src/sync/gmail-heartbeat.ts` — issues a lightweight `history.list` call per account once per day. Advances `last_history_refresh_at`. Prevents token expiry on dormant accounts that receive no mail for >7 days.

### Label-deletion storms

When a label is deleted on Gmail, `history.list` can emit thousands of `labelsRemoved` events. Storm detection: if a single `history.list` page yields >100 removals for the same label, collapse to a single `DELETE FROM message_labels WHERE canonical = ?` bulk operation and update `label_catalog` accordingly.

## Proton incremental sync

### IDLE on INBOX

`src/sync/proton-idle.ts` — maintains an IMAP IDLE connection per Proton account against the INBOX folder:
- Re-issues IDLE command every 29 minutes (RFC 2177 timeout guidance).
- On IDLE response (EXISTS, EXPUNGE, FLAGS notifications): triggers per-folder MODSEQ check to determine what changed.

### NOOP watchdog

Every 5 minutes, sends a `NOOP` command on the IDLE connection. Timeout of 30 seconds: if NOOP doesn't return, the connection is considered dead → reconnect with exponential backoff.

### CONDSTORE MODSEQ polling

`src/sync/proton-condstore.ts` — per-folder `SELECT (CONDSTORE)` every 5 minutes. Compares `HIGHESTMODSEQ` against stored `last_modseq` in the `proton_folder_state` table.

**MODSEQ monotonicity check on reconnect:** if the new `HIGHESTMODSEQ` is less than the stored value, the Proton bridge likely restarted and reset state. Action: call `hydrateProtonFolder(account, folder, deps)` to re-walk that folder. Sets `last_modseq = -1` sentinel while hydration is pending.

### Event-to-DB applier

`src/sync/proton-events.ts`:
- New message in folder → `INSERT OR IGNORE` into `message_labels` + `message_folder_uids`.
- Message expunged from folder → `DELETE FROM message_folder_uids WHERE (message_id, folder) = ?`; if no remaining folder entries, set `deleted_at`.
- Flag change → update `direction`, `archived_at` as appropriate.

## Nightly reconcile

### Schedule

`src/reconcile/scheduler.ts` — `setInterval`-based 5-minute check targeting 04:00 local time. Skips if `meta.last_reconcile_at` is within the last 20 hours (prevents double-runs after clock drift or manual trigger).

### Two-phase correctness

Phase 1 — **non-blocking read-only walk**: Proton folder walker (`src/reconcile/proton-walker.ts`) and Gmail label walker (`src/reconcile/gmail-walker.ts`) enumerate upstream state as AsyncGenerators. No writes; Madison can use the DB concurrently.

Phase 2 — **short apply transaction**: delta builder computes adds/removes vs. DB. Additions via `INSERT OR IGNORE` (idempotent). Removals re-verify the specific `(message_id, folder/label)` tuple upstream before executing `DELETE` — prevents races where a concurrent write-through already removed the entry.

### Metrics

`src/reconcile/metrics.ts` emits a JSON log line after each reconcile cycle:
```json
{
  "event": "reconcile_complete",
  "items_checked": 60166,
  "adds_applied": 0,
  "removes_applied": 0,
  "removes_skipped_reverify": 0,
  "wall_ms": 487000
}
```

## Migration orchestrator

`scripts/migrate-mirror.ts` — one-time migration that is also re-runnable as an idempotent operation. Calls `runFullHydration(deps)` — the same function used by nightly reconcile.

```
env-vault env.vault -- npx tsx scripts/migrate-mirror.ts [--dry-run]
```

**Dry-run**: walkers use `BODY.PEEK` (read-only IMAP); Gmail uses metadata-only fetch; `dryRun` flag plumbed through `runFullHydration`. No DB writes in dry-run mode.

**Self-audit on completion**: queries actual table counts, compares against reported metrics, fails `exit 1` with descriptive message on any mismatch or invariant violation. See [architecture/madison-pipeline.md](../architecture/madison-pipeline.md) for invariant list.

**Re-run awareness**: the audit fires `exit 1` on the second run for false positives (e.g. prior deleted_inferred count flagging as drift). Correct fix: compare deltas against pre-migration snapshot, not absolute counts. Tracked as deferred improvement.

## Startup wiring diagram

```mermaid
flowchart TD
  Ingestor["ingestor.ts\n(composition root)"]
  GmailHistory["gmail-history.ts\nhistory.list handler"]
  GmailHeartbeat["gmail-heartbeat.ts\ndaily ping"]
  ProtonIdle["proton-idle.ts\nIDLE + re-IDLE"]
  ProtonCondstore["proton-condstore.ts\nMODSEQ poller"]
  ReconcileSched["reconcile/scheduler.ts\n04:00 local"]
  Hydrate["reconcile/hydrate.ts\nrunFullHydration()"]
  Apply["reconcile/apply.ts\napply phase"]

  Ingestor -->|starts| GmailHistory
  Ingestor -->|starts| GmailHeartbeat
  Ingestor -->|starts per account| ProtonIdle
  Ingestor -->|starts per account| ProtonCondstore
  Ingestor -->|"passes runFullHydration\n(composition root pattern)"| ReconcileSched
  GmailHistory -->|"on 404"| Hydrate
  ProtonCondstore -->|"on MODSEQ regression"| Hydrate
  ReconcileSched -->|"at 04:00"| Hydrate
  Hydrate --> Apply
```

The scheduler and the 404 / MODSEQ-regression handlers all call the same `runFullHydration()` from `src/reconcile/hydrate.ts`. The ingestor wires the `runFn` at the composition root — the scheduler module itself does not import `hydrate.ts` directly (decoupled; testable with a stub).

## Apply path detail

```mermaid
flowchart LR
  Walker["Proton/Gmail walker\n(AsyncGenerator)"] -->|upstream triples| Delta["delta.ts\nbuildLabelDelta\nbuildFolderUidDelta\nfindInferredDeletes\ncollapseStormRemovals"]
  Delta -->|adds, removes, inferred_deletes| Apply["apply.ts\napplyLabelDelta\napplyFolderUidDelta\napplyInferredDeletes"]
  Apply -->|INSERT OR IGNORE| DB[("store.db")]
  Apply -->|re-verify callback| Walker
```

## Operational notes

**env-vault prefix required** — both containers require `INBOX_DB_KEY` from env.vault. See [lode/lessons.md — Mailroom deploys must use env-vault](../lessons.md) for the full rule and the incident that documented it.

**Both containers rebuild when `src/store/` changes** — the store layer is imported by both ingestor (live polling, watermarks) and inbox-mcp (all read tools + write-through). See [lode/lessons.md — Both mailroom containers need rebuild](../lessons.md).

**btrfs snapshots at `/home/jeff/containers/data/.snapshots/mailroom/`** — hourly. `INBOX_DB_KEY` is in env.vault + password manager; snapshots are worthless without the key.

## Related

- [architecture/madison-pipeline.md](../architecture/madison-pipeline.md) — mirror data model, session-hash pattern, hydration phases
- [mailroom-rules.md](mailroom-rules.md) — rule engine + ingest pipeline
- [madison-pipeline.md](madison-pipeline.md) — push-driven event delivery to Madison
- Plan: `lode/plans/active/2026-04-madison-read-power/tracker.md`

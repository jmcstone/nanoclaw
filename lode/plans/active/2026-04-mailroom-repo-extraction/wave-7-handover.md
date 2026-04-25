# Wave 7 Handover — Session 2026-04-25 (afternoon)

Session got long; context window saturated. This handover captures everything needed to resume in a fresh session.

## Production state right now (~14:45 CDT / 19:45 UTC, 2026-04-25)

- **Mailroom containers**: both healthy on `mailroom-local:latest` (image `2bc976daf4ba`), built from `~/Projects/mailroom/`, recreated post-cutover at 18:22 UTC, restarted at 19:28 UTC.
- **Proton push**: ALIVE post-restart. 5 IDLE sessions + 5 UIDNEXT pollers running. New Proton mail flows in within seconds.
- **Gmail push**: DEAD. Warning fires on every container start: `Gmail account needs hydration (last_history_id sentinel or null) — skipping incremental sync worker`. Zero Gmail messages have flowed through mailroom since cutover.
- **Madison Inbox notifications**: stopped working at 18:22:40 UTC — that was the last `emitted inbox:routine event`. Subsequent Proton ingest matches silent-archive rules so no events emitted; Gmail off so no ingest. Subscriber side (nanoclaw) is healthy — `ipc-out/` was empty because subscriber consumed everything.
- **Jeff's Proton inbox**: 26 unread conversations, including 2:09 PM Indeed + 1:46 PM BookBub which mailroom DID ingest + matched silent-archive rules but did NOT actually archive upstream. Backlog spans roughly 7am to 2pm CDT. **All in INBOX, none archived in Proton.**

## Two production bugs surfaced

### BUG-A: Gmail `last_history_id` resets on container restart
- Every `docker compose up -d` (or `restart`) re-fires the `needs hydration` warning.
- Either the DB column is being cleared on startup, OR the column is null/sentinel and stays that way (no migration to populate it).
- **Workaround**: run `docker exec mailroom-ingestor-1 npx tsx scripts/migrate-mirror.ts` to do a full hydration. Should populate `accounts.last_history_id` from Gmail API and restore push.
- **Investigation needed**: why does sentinel/null persist across container restarts? Did the source extraction lose a migration step that lived elsewhere? Compare current `~/Projects/mailroom/` source vs. the older `containers/mailroom/mailroom/` version on the `madison-read-power` branch (still on jarvis locally, 0 commits past main but pre-extraction).
- **Likely TD entry name**: `TD-MAIL-GMAIL-HISTORY-ID-RESET-ON-RESTART`.

### BUG-B: Proton upstream archive isn't propagating
- Symptom: rules engine logs `archived: true` and `auto-archived silently (no event emitted)`, but messages remain in Proton INBOX.
- Error pattern from the rules-apply-proton component:
  ```
  WARN: Proton COPY to label folder failed; skipping this label
    folder: Labels/Free Books (or Labels/Job Postings, etc.)
    response: B NO a mailbox with that name already exists
    executedCommand: B CREATE "Labels/Free Books"
  ```
- The error is on `CREATE` (not on the COPY of the message). Bridge says "mailbox already exists" — that's expected, the label folder already exists from prior use. The code probably tries CREATE before COPY without idempotently handling the "already exists" case.
- Affects **label-add** ops (the visible error) and **likely archive ops** too (archive is a COPY-to-Archive + EXPUNGE-from-INBOX pattern; if it goes through the same CREATE-first path, the same EEXIST error would block the archive).
- **Code location to investigate**: `~/Projects/mailroom/src/rules/apply/proton.ts` — probably has a `imap.mailboxCreate(folder)` call that doesn't tolerate `[ALREADYEXISTS]` response. Compare against the matching `gmail.ts` apply path.
- **Likely TD entry name**: `TD-MAIL-PROTON-LABEL-CREATE-EEXIST-CASCADES`.
- **User impact**: every silent-archive rule is silently failing upstream. Inbox accumulates indefinitely. Jeff's 26-conversation backlog is the visible result.

## Resume checklist

1. **Read the lode**:
   - This file
   - `~/Projects/mailroom/lode/lode-map.md` (new mailroom lode index)
   - `~/Projects/mailroom/lode/practices.md` (deploy workflow)
   - `~/Projects/mailroom/lode/terminology.md` (domain vocab)
   - This plan's tracker.md + progress.md
2. **Confirm mailroom runtime is still healthy**: `docker ps --filter name=mailroom`. Ingestor + inbox-mcp should both be Up.
3. **Decide on order of bug fixes**:
   - **Quick win**: `docker exec mailroom-ingestor-1 npx tsx scripts/migrate-mirror.ts` to hydrate Gmail. ~10 minutes wall. Restores Gmail push immediately. But doesn't fix BUG-A — next restart will need re-hydration unless we also find/fix the reset cause.
   - **Real fix**: Root-cause BUG-A first (so Gmail stays hydrated through restarts), then BUG-B (so silent-archives actually propagate to Proton). Both fixes land in `~/Projects/mailroom/`, get committed there, image rebuilt + redeployed.
4. **Backlog cleanup**: even after BUG-B is fixed, the 26 unread emails won't auto-archive retroactively (the rules-process logic only fires on ingest, not on already-classified-but-still-in-inbox messages). Options:
   - Manual archive in Proton web UI (fast, one-shot)
   - Add a one-shot script that walks `messages WHERE archived_at IS NOT NULL AND <upstream-still-in-inbox>` and re-issues the archive op
   - Wait for the next reconcile to detect the divergence and re-attempt (depends on how reconcile handles it — may or may not work).

## Session work completed (commits)

Three repos all in sync, pushed to origin:

| Repo | Tip commit | Subject |
|---|---|---|
| nanoclaw | `571e6d4` | lode: Wave 6 migration — mailroom plans + domain docs moved to ~/Projects/mailroom |
| ConfigFiles | `6c26600` | mailroom: extract source to ~/Projects/mailroom; slim compose stack |
| mailroom | `<lode-migration>` | lode: migrate mailroom-belonging plans + domain docs from nanoclaw |

Earlier in this session:
- nanoclaw: `d46079f` (madison-read-power closure), `2737618` (plan message-enrichment + document-to-markdown), `d9521e7` (close mailroom-extraction; plan mailroom-repo-extraction), `f35ad81` (Waves 0–5 + 5.5 complete on the repo extraction)
- mailroom: `85163f2` (initial 79-commit history via subtree split), `1e4b98f` (remove env.vault + docker-compose.yml from source repo)

Wave 6 of mailroom-repo-extraction is complete. Wave 7 (24h soak + final closure) is in progress — these two bugs surfaced during the soak and need addressing before final closure.

## Useful commands for next session

```bash
# Confirm runtime
docker ps --filter name=mailroom
docker logs mailroom-ingestor-1 --since 5m | tail -30

# See recent ingest activity + event emission
docker logs mailroom-ingestor-1 --since 30m 2>&1 | grep -E '(Protonmail email processed|Gmail|emitted inbox|silently|COPY.*failed)'

# Restart ingestor (if push wedges again)
cd ~/containers/mailroom && env-vault env.vault -- docker compose restart ingestor

# Hydrate Gmail
docker exec mailroom-ingestor-1 npx tsx scripts/migrate-mirror.ts

# Inspect rule engine config
cat ~/Documents/Obsidian/Main/NanoClaw/Inbox/_Settings/rules.json | jq '.rules[17,18,19]'  # rules 17, 18, 19 are the Free Books / Job Postings ones

# Build a new image after fixing a bug in ~/Projects/mailroom/
cd ~/Projects/mailroom && docker build -t mailroom-local:latest .
cd ~/containers/mailroom && env-vault env.vault -- docker compose up -d
```

## Other follow-ups (lower priority)

- **Investigate the original destructive-merge anomaly**: ConfigFiles' origin/main was emptied of mailroom files by a prior Claude/agent session that resolved a merge conflict by accepting "delete." Worth understanding to prevent recurrence. Check shell history, prior Claude session logs, etc.
- **NanoClaw → `~/Projects/nanoclaw/` move**: separate follow-up plan, same pattern as mailroom. Lower urgency.
- **Wave 6.8** (mailroom→nanoclaw cross-repo path scan): deferred to after Wave 7 closes and this plan migrates to mailroom's lode.

# Async jobs — long-running commands with deferred reporting

## Problem

When Madison runs a >5min command (e.g. Calibre import, large download, long
scrape), her response turn ends and the SDK session terminates. The background
process keeps running but no live agent ever notices it finished, so the user
never gets a result. Workaround today: user has to ask "is it done?" manually.

This is the same root cause as the input-receipt ack work (commit `bdab5a9`):
once a turn ends there is no live agent. The fix there was an instant ack on
input. The fix here is a **scheduled watcher** that re-spawns Madison briefly
to check the job and either report or reschedule.

## Approach

Three pieces, no orchestrator/host code changes required — everything plugs
into existing infrastructure:

1. **Job state on disk.** Madison launches a backgrounded command that writes
   status files to `/workspace/group/.jobs/<id>/`:
   ```
   .jobs/<id>/cmd          # the command line
   .jobs/<id>/started_at   # ISO timestamp
   .jobs/<id>/label        # short human label, used in reports
   .jobs/<id>/output       # combined stdout+stderr (truncated tail used in report)
   .jobs/<id>/exit_code    # written when the job finishes
   .jobs/<id>/done         # sentinel file, touched last
   .jobs/<id>/check_count  # incremented by each watcher iteration
   ```

2. **Watcher chain via `schedule_task`.** Right after launching the job,
   Madison calls `mcp__nanoclaw__schedule_task` with a fixed-template prompt
   that points at the job dir. The host's existing scheduler picks it up,
   spawns a fresh ~10s container, and Madison-as-watcher reads the protocol
   from this skill and either (a) reports + cleans up, (b) drops watcher at
   24h cap, or (c) creates the next `once` task per the backoff curve.
   Each iteration is a brand new task — no self-rescheduling needed, so the
   watcher doesn't need to know its own task ID.

3. **Skill that teaches the pattern.** `container/skills/async-jobs/SKILL.md`
   is the only artifact. It teaches both roles (launcher and watcher) and
   defines the protocol the watcher follows.

## Design decisions (locked 2026-05-09)

| Choice | Decision |
|--------|----------|
| Backoff curve | check_count <3 → 60s, <8 → 300s, else 900s (cap) |
| Runaway cap | 24h elapsed → post "still running, watcher dropped, check `nanoclaw-jobs`" and stop chain. Job itself keeps running. |
| Where Madison learns it | SKILL.md only. No `groups/main/CLAUDE.md` changes. Auto-loaded when relevant per skill metadata. |
| Helper binary | None. Pure bash patterns inside SKILL.md. Mirrors the `tasks` skill style. |
| Self-ID awareness | Not needed — each watcher iteration creates a fresh `once` task instead of rescheduling itself. |

## Tasks

- [x] Confirm `schedule_task` + `update_task` MCP tools exist in the container's agent-runner
- [x] Confirm IPC `schedule_task` handler accepts container-issued requests (`src/ipc.ts:209`)
- [x] Confirm `container/skills/` syncs into every group's `.claude/skills/` (`src/container-runner.ts:174-184`)
- [ ] Write `container/skills/async-jobs/SKILL.md` with launcher + watcher protocol
- [ ] Add a tiny "list jobs" pattern to the skill so the user can ask "what jobs are running?"
- [ ] Manual test: run a 60s `sleep` job, confirm watcher fires and reports
- [ ] Manual test: simulate runaway by editing `started_at` to 25h ago, confirm cap triggers
- [ ] Update `lode/lessons.md` if anything surprising surfaces

## Out of scope

- No host-side code changes to `task-scheduler.ts`, `ipc.ts`, or `db.ts`.
- No new MCP tools — reuse `schedule_task` / `update_task` / `send_message`.
- No automatic detection of "this command will be long" — Madison decides.
- Killing runaway jobs — left to the user. The 24h cap drops the *watcher*,
  not the job.

## Verification goals

1. After launching a 60-second `sleep 60 && echo done` job and posting an ack,
   Madison's main turn can end cleanly (container can shut down).
2. ~60s later, the scheduler fires a watcher task. The container spawns,
   reads the job dir, sees `done`, posts a summary to chat, removes the job
   dir. No further tasks remain in the chain.
3. For a 30min job, the chain produces ≤6 watcher invocations (1m, 2m, 7m,
   17m, 32m matching the 1/5/15min backoff scaled by check_count thresholds).
4. For a job with `started_at` 25h in the past, the next watcher posts the
   runaway message and does not reschedule.

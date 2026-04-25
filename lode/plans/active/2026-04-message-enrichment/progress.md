# Progress — Message Enrichment

## Reboot check

1. **Where am I?** Plan drafted; no code changes yet. Awaiting branch creation + go-ahead from Jeff.
2. **Where am I going?** Wave 1 — write `scripts/measure-attachments.ts` and run it against the live mailroom to replace estimates with measurements before committing to Wave 5 cost.
3. **What is the goal?** Madison can answer recipient / list-mail / attachment questions and fetch attachment bytes; one-shot resumable backfill for all 60k existing messages.
4. **What have I learned?** Proton Bridge v3 stores no message bodies on disk (~50 KB total state) — backfill must pay the API cost regardless; this also strengthens the case for caching blobs locally as the only durable backup. SQLCipher pages are max-entropy so btrfs compression is effectively off for store.db; encryption-at-rest beats compression for this workload. Three-state attachment design (count + metadata + optional blob) future-proofs lazy/disabled/tiered caching.
5. **What have I done?** Drafted tracker.md, findings.md, progress.md. Captured pre-measurement cost ballpark, decisions, and acceptance criteria.

## Sessions

### 2026-04-25 — plan authored

- Identified the To/CC visibility gap during a Madison conversation: schema/ingest/MCP all silent on recipients.
- Verified `madison-read-power` was merged and graduated the plan to `complete/`; ticked the 10 remaining boxes after Jeff confirmed Wave 5 + 5.5.13 + 5.6.8 verifications complete; refreshed `lode/infrastructure/mailroom-mirror.md` for UIDNEXT polling + recency-tiered reconcile (Wave 5.7.10).
- Rolled up attachment visibility into the same plan because both gaps share the same expensive backfill (full upstream re-fetch per message).
- Inspected the `protonmail-bridge` container — no on-disk message cache.
- Locked decisions: DB-resident BLOBs (separate table); `attachment_count` + state-machine; one-shot resumable backfill; BCC + Reply-To + List-Id + List-Unsubscribe in scope.
- Drafted the three-file plan structure with seven waves (pre-reqs / measure / schema / ingest / MCP / backfill / deploy / graduate).

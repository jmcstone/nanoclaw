# Progress — Mailroom Repo Extraction

## Reboot check

1. **Where am I?** Plan drafted; no code or repo changes yet. Awaits Wave 0 — branch greenup on both nanoclaw and ConfigFiles.
2. **Where am I going?** Wave 0: merge `fix/morning-brief-audit` to main on both repos. Then Wave 1: `git filter-repo` extraction in a scratch ConfigFiles clone, push to a new GitLab repo `jmcstone/mailroom`, clone to `~/Projects/mailroom/`.
3. **What is the goal?** Mailroom source lives in its own GitLab repo at `~/Projects/mailroom/`. ConfigFiles' `containers/mailroom/` slims to a thin compose stack referencing `image: registry.local/mailroom:latest`. Mailroom plan-lode migrates to the new repo. Runtime path (`~/containers/mailroom` symlink) and data subvolume unchanged. Madison keeps receiving mail across the cutover.
4. **What have I learned?** Mailroom and nanoclaw are 5/5 paired-active during burst periods, but ~94% of the apparent coupling is lode-bookkeeping artifact, not interface code — the lode-migration step in Wave 6 dissolves most of it. Bridge has no on-disk message cache (verified ~50 KB total state in the container), so attachment backfill in the message-enrichment plan must hit the Proton API regardless of caching strategy. Image-tag scheme is `latest` per Jeff's personal-instance pattern: the act of pushing is the deploy signal.
5. **What have I done?** Verified-and-closed the predecessor `2026-04-mailroom-extraction` plan in the same session (M6.3 confirmed via compose inspection; M7 lode work confirmed mapped to permanent infrastructure docs; M8/M9 deferred to `TD-MAIL-FRESH-INSTALL-SKILLS`). Drafted this plan's tracker (8 acceptance criteria, 11 locked decisions, 7 waves), findings.md (rationale + architecture state), this progress.md.

## Sessions

### 2026-04-25 — plan authored

- Surfaced from a discussion about getting `fix/morning-brief-audit` merged to main and the bigger structural problem that mailroom (a sizable application) lives inside ConfigFiles (a config-snippets repo).
- Investigated `~/containers/`, `~/Projects/ConfigFiles/`, and the bridge container. Confirmed: ConfigFiles is 587 MB / 230 MB-in-containers; bridge has no on-disk message cache; nanoclaw is the working precedent for "real repo not symlink, source lives outside ConfigFiles."
- Ran a 90-day git-history pairing analysis. 5 mailroom-active days, 5 of 5 also nanoclaw-active, 0 mailroom-only days. Drilled into the 98-commit nanoclaw burst: ~6% integration code, ~94% lode bookkeeping for mailroom plans whose trackers live in nanoclaw's lode. Confirms the diagnosis that the split (with lode migration) reduces real coupling rather than introduces it.
- Walked through the four implementation decisions: GitLab (matches ConfigFiles), `latest` tag (personal-instance pattern), verify-and-close old plan (done in same session), plan name `mailroom-repo-extraction` (distinguishes from the closed `mailroom-extraction` plan).
- Closed predecessor plan: ticked M6.3 (ports stanza removed — verified in compose), M7.1–M7.5 (lode graduation mapped to existing infrastructure docs), deferred M8/M9 to a new tech-debt entry `TD-MAIL-FRESH-INSTALL-SKILLS`. Moved plan to `complete/`.
- Drafted this tracker's 7 waves: branch greenup → repo extraction → image build/push → ConfigFiles compose slim-down → cutover → lode migration → verification.

# Mailroom Repo Extraction

Branch: `feat/mailroom-repo-split` (to be created when work starts; plan currently authored on `fix/morning-brief-audit`).

## Goal

Split mailroom out of `~/Projects/ConfigFiles/containers/mailroom/mailroom/` into its own GitLab repository at `~/Projects/mailroom/`. ConfigFiles' `containers/mailroom/` slims down to a thin Docker compose stack that pulls a registry-tagged image. Source code, branches, and the entire mailroom plan-tracking lode migrate to the new repo. Runtime path (`~/containers/mailroom` symlink) and the mailroom data subvolume (`~/containers/data/mailroom/`) are unchanged.

This is a structural cleanup — not a feature change. Mailroom must keep ingesting mail end-to-end through the cutover, and Madison must keep receiving notifications.

## Read first

- [lode/plans/complete/2026-04-mailroom-extraction/tracker.md](../../complete/2026-04-mailroom-extraction/tracker.md) — predecessor plan that extracted mailroom from nanoclaw's host process into its own Docker stack. This plan extracts that Docker stack's *source code* into its own git repo. Different concern, builds on the prior work.
- [lode/infrastructure/mailroom-mirror.md](../../../infrastructure/mailroom-mirror.md) — the runtime mailroom architecture; nothing here changes operationally.
- [lode/practices.md](../../../practices.md) — deploy checklist; this plan touches the rebuild-and-restart path because compose's `build:` becomes `image:`.
- `~/Projects/ConfigFiles/containers/mailroom/docker-compose.yml` — the current compose file (mounts the source as a `build:` context). Becomes `image: registry.local/mailroom:latest` post-extraction.
- `~/Projects/ConfigFiles/containers/mailroom/mailroom/` — the source subtree to extract. Note the *double* `mailroom` — outer dir is the compose stack; inner is the Node.js source.
- `~/Projects/nanoclaw/` (target after follow-up move) and the existing `~/containers/nanoclaw/` repo for reference on the "Projects-rooted source repo" pattern this plan establishes for mailroom.

## Acceptance criteria (goal-backward)

### Repo structure
- AC-R1 New GitLab repo `jmcstone/mailroom` exists with full mailroom history extracted via `git filter-repo --subdirectory-filter containers/mailroom/mailroom`. Paths in the new repo are re-rooted (no `containers/mailroom/mailroom/` prefix).
- AC-R2 Working tree at `~/Projects/mailroom/`. `git remote -v` shows GitLab as `origin`. Builds, tests, type-checks all green from this location.
- AC-R3 The mailroom plan lode (active + complete plans about mailroom: `2026-04-mailroom-extraction`, `2026-04-mail-push-redesign`, `2026-04-madison-read-power`, `2026-04-wave-5.8-writethrough-correctness`, `2026-04-message-enrichment`, `2026-04-morning-brief-blindness`, `2026-04-rule-schema-unification`, plus this plan once it graduates) lives at `~/Projects/mailroom/lode/`. Cross-cutting plans (groups, channels, session machinery) stay in nanoclaw's lode.

### ConfigFiles slim-down
- AC-C1 `~/Projects/ConfigFiles/containers/mailroom/` no longer contains the `mailroom/` source subtree.
- AC-C2 `docker-compose.yml` references `image: registry.local/mailroom:latest` instead of `build:`. Other stanzas (volumes, env_file, networks, healthcheck) preserved.
- AC-C3 `env.vault`, README crumb noting the move + new repo URL, and any operational scripts (rules.json symlink) remain in place.

### Image build / push
- AC-I1 Image builds locally from `~/Projects/mailroom/Dockerfile` and tags as `registry.local/mailroom:latest`.
- AC-I2 Manual `docker push registry.local/mailroom:latest` works against the local registry at `~/containers/registry/registry`.
- AC-I3 No CI required for now — Jeff's pattern is "build and push only when I want to use it; compose pulls `latest`." Document the build-push-deploy workflow in mailroom's README.md.

### Runtime continuity
- AC-T1 `~/containers/mailroom` symlink continues to point into ConfigFiles' compose stack. Madison's view of the system path is unchanged.
- AC-T2 `~/containers/data/mailroom/` (BTRFS-snapshotted store.db + accounts.json + rules.json) is untouched — runtime state lives there independent of source.
- AC-T3 Mailroom containers come back healthy after the cutover: 5 Proton IDLE sessions, 5 UIDNEXT pollers, recency scheduler running, inbox-mcp serving Madison.
- AC-T4 No mail dropped during the cutover. Verified by overnight tail of `mailroom-ingestor` logs across the switch.

### Branch precondition
- AC-B1 Both nanoclaw and ConfigFiles `fix/morning-brief-audit` branches merged to main (no work-in-flight) before extraction starts. Extraction starts from clean main on both.

### Lode migration
- AC-L1 `~/Projects/mailroom/lode/lode-map.md` exists, indexing the migrated plans + a curated subset of the infrastructure docs that pertain to mailroom.
- AC-L2 Nanoclaw's lode-map updates to reflect what moved out — entries for migrated plans become outbound pointers to the mailroom-repo lode (e.g., `→ migrated to ~/Projects/mailroom/lode/plans/...`).
- AC-L3 Cross-references between the two lodes use absolute filesystem paths or repo-qualified references; no broken relative links.
- AC-L4 The `2026-04-message-enrichment` plan (currently active, drafted just before this plan) references the new mailroom repo paths after migration.

### Verification
- AC-V1 Mailroom test suite green at `~/Projects/mailroom/`: `tsc --noEmit` zero errors, full vitest pass.
- AC-V2 Image builds + pushes + the new compose pulls + recreated containers: end-to-end flow validated.
- AC-V3 Madison receives a real test email after cutover; mailroom subscriber routes it; agent container queries inbox-mcp; reply path works.
- AC-V4 `mcp__messages__audit_label_coverage(since_hours: 24)` returns zero missing — confirms ingest-path invariant intact across the switch.

## Decisions (locked)

| Decision | Rationale |
|---|---|
| Source repo on GitLab | Matches ConfigFiles host (`gitlab.com/jmcstone/ConfigFiles`); same auth, same pull/push scripts. |
| Source location `~/Projects/mailroom/` | Matches Jeff's stated convention — projects under `~/Projects/`, runtime aggregation under `~/containers/`. Convenience scripts for clone/pull/push expect `~/Projects/`. |
| ConfigFiles' compose stays at `~/Projects/ConfigFiles/containers/mailroom/` | Compose is *configuration* — fits ConfigFiles' purpose. The `~/containers/mailroom` symlink already points there. |
| Image tag `latest` | Personal-use pattern: build + push happens only when Jeff wants to deploy. The act of pushing `latest` is the deploy signal; compose pulls it. No CI tag automation needed. Document in mailroom README. |
| Local registry (`registry.local/mailroom:latest`) at `~/containers/registry/registry` | Already running in Jeff's stack; no external dependency. |
| `git filter-repo` (not `filter-branch`) | Modern, faster, recommended; preserves history; subdirectory-filter re-roots paths cleanly. |
| Plan name `mailroom-repo-extraction` | Distinguishes from the older `mailroom-extraction` plan (host-process → Docker stack) which is now closed. |
| Migrate mailroom plan-lode into the new repo | Eliminates 70%+ of the cross-repo paired commits the git-history analysis surfaced. A mailroom code change becomes one commit in mailroom (code + lode together). |
| Cross-cutting lode (groups, channels, session machinery) stays in nanoclaw | Those concerns belong to nanoclaw, not mailroom. Mailroom is the data plane; nanoclaw is the agent host. |
| NanoClaw repo move (`~/containers/nanoclaw` → `~/Projects/nanoclaw`) is a separate follow-up plan | Same pattern, but independent scope. Don't bundle. |
| Branches merge to main first | Extraction needs to start from clean state. Both repos `fix/morning-brief-audit` → main before anything moves. |

## Phases / Waves

### Wave 0 — Branch greenup (precondition)
- [ ] 0.1 nanoclaw: open PR `fix/morning-brief-audit` → main (or fast-forward locally). Land it.
- [ ] 0.2 ConfigFiles: same — `fix/morning-brief-audit` → main.
- [ ] 0.3 Confirm both repos at clean `main`, no untracked work-in-flight beyond the pre-existing `2026-04-rule-schema-unification` lode dir (which gets tracked as part of its own plan, not this one).
- [ ] 0.4 Take a btrfs snapshot of `~/containers/data/mailroom/` as a paranoid safety net before any structural changes (the snapshot is automatic hourly; this is just the manual confirmation it ran recently).

### Wave 1 — Repo extraction (no production change)
- [ ] 1.1 Fresh full clone of ConfigFiles to a scratch location: `git clone git@gitlab.com:jmcstone/ConfigFiles.git /tmp/cf-extract`.
- [ ] 1.2 Install `git-filter-repo` if not present (`pip install git-filter-repo` or distro package).
- [ ] 1.3 In the scratch clone: `git filter-repo --subdirectory-filter containers/mailroom/mailroom`. Verify the result has only mailroom history and re-rooted paths (`ls`, `git log --oneline`, spot-check a few commits).
- [ ] 1.4 Create the new GitLab repo `jmcstone/mailroom` (empty, no auto-README).
- [ ] 1.5 In the scratch clone: `git remote add origin git@gitlab.com:jmcstone/mailroom.git && git push -u origin main` (and any other branches preserved by filter-repo).
- [ ] 1.6 Clone the new repo to `~/Projects/mailroom/`. Confirm: build (`./build.sh` or equivalent), tests (`vitest`), type-check (`tsc --noEmit`) all pass against the fresh checkout.

### Wave 2 — Image build + registry push
- [ ] 2.1 From `~/Projects/mailroom/`: `docker build -t registry.local/mailroom:latest .` (or whatever the existing Dockerfile expects). Confirm image builds successfully.
- [ ] 2.2 `docker push registry.local/mailroom:latest`. Confirm the local registry has the image: `curl -s http://registry.local/v2/_catalog | jq` or equivalent.
- [ ] 2.3 Document the build/push workflow in `~/Projects/mailroom/README.md` (or `DEPLOY.md`): "Edit code → `docker build && docker push` → `dcc up -d mailroom`."

### Wave 3 — ConfigFiles compose slim-down (NOT yet deployed)
- [ ] 3.1 In ConfigFiles working tree, branch `feat/mailroom-image-pull`.
- [ ] 3.2 Edit `containers/mailroom/docker-compose.yml`: `build: ./mailroom` → `image: registry.local/mailroom:latest`. Preserve volumes, env_file, networks, healthcheck, depends_on.
- [ ] 3.3 Update or write `containers/mailroom/README.md`: source now at `~/Projects/mailroom/` + the new repo URL. Remove the path note "compose builds from ./mailroom/" and replace with "compose pulls registry.local/mailroom:latest; rebuild with `cd ~/Projects/mailroom && docker build -t ... && docker push ...`".
- [ ] 3.4 Do NOT yet `git rm` the source subdir — that happens in Wave 5 after the new compose is verified working.
- [ ] 3.5 `tsc --noEmit` (where applicable in ConfigFiles), commit on the branch.

### Wave 4 — Cutover
- [ ] 4.1 Stop running mailroom containers: `cd ~/containers/mailroom && env-vault env.vault -- docker compose stop`. (Bridge keeps running — different stack.)
- [ ] 4.2 Apply the ConfigFiles `feat/mailroom-image-pull` branch (merge to local main) so the symlinked `~/containers/mailroom/docker-compose.yml` now references `image:` instead of `build:`.
- [ ] 4.3 `cd ~/containers/mailroom && env-vault env.vault -- docker compose pull` — confirms the image pulls cleanly from the local registry.
- [ ] 4.4 `env-vault env.vault -- docker compose up -d` — recreate containers from the registry image.
- [ ] 4.5 Verify: 5 IDLE sessions starting, 5 UIDNEXT pollers, recency scheduler started, inbox-mcp healthy on port 18080. `docker logs mailroom-ingestor-1 --tail 100` for clean startup.
- [ ] 4.6 Verify Madison still receives mail: send a real test email from a known sender; observe ipc-out event → nanoclaw subscriber → group queue → Telegram.
- [ ] 4.7 Run `mcp__messages__audit_label_coverage(since_hours: 24)` — confirm zero missing.

### Wave 5 — ConfigFiles source removal
- [ ] 5.1 In ConfigFiles working tree (still on `feat/mailroom-image-pull`): `git rm -r containers/mailroom/mailroom/`.
- [ ] 5.2 Commit + push branch.
- [ ] 5.3 Open PR (or merge directly to main if Jeff isn't reviewing).
- [ ] 5.4 Land on main. Confirm `~/Projects/ConfigFiles/containers/mailroom/` now contains only: `docker-compose.yml`, `env.vault`, `README.md`, any operational scripts. No `mailroom/` source subdir.

### Wave 6 — Lode migration
- [ ] 6.1 Identify mailroom-belonging plans currently in nanoclaw's lode (active + complete). Move list:
  - `complete/2026-04-mailroom-extraction/`
  - `complete/2026-04-mail-push-redesign/`
  - `complete/2026-04-madison-read-power/`
  - `complete/2026-04-wave-5.8-writethrough-correctness/`
  - `active/2026-04-message-enrichment/`
  - `active/2026-04-morning-brief-blindness/`
  - `active/2026-04-rule-schema-unification/`
  - `active/2026-04-mailroom-repo-extraction/` (this plan, after it graduates)
- [ ] 6.2 Move them to `~/Projects/mailroom/lode/plans/{active,complete}/`. Use `git mv` so history is preserved within each repo.
- [ ] 6.3 Identify mailroom-domain infrastructure docs that belong in the new repo's lode:
  - `lode/infrastructure/mailroom-mirror.md`
  - `lode/infrastructure/mailroom-rules.md`
  - `lode/architecture/madison-pipeline.md` (mirror data model — debatable; arguably a shared concern)
  - `lode/reference/rules-schema.md`
- [ ] 6.4 Decide split for the architecture/madison-pipeline.md doc: recipient + attachment data model is mailroom's; nanoclaw subscriber path is nanoclaw's. Either split into two docs or copy and adapt.
- [ ] 6.5 Create `~/Projects/mailroom/lode/lode-map.md`, `summary.md`, `terminology.md`, `practices.md`. Index the migrated content.
- [ ] 6.6 Update nanoclaw's `lode/lode-map.md`: replace migrated plan entries with outbound pointers ("→ migrated to ~/Projects/mailroom/lode/...").
- [ ] 6.7 Search nanoclaw's lode for stale relative paths into the migrated content; rewrite as absolute paths or as outbound references. Exclude history/ and lessons/ (those are historical, leave intact).
- [ ] 6.8 Search the new mailroom lode for stale relative paths back into nanoclaw's lode; rewrite similarly.

### Wave 7 — Verification + closure
- [ ] 7.1 24-hour soak: mailroom continues to ingest, push events, serve MCP. Spot-check `mailroom-ingestor` logs daily.
- [ ] 7.2 Run a real feature change end-to-end on the new repo to validate the workflow: edit code in `~/Projects/mailroom/`, build + push, redeploy, verify. Pick a tiny no-op change (e.g., a log message tweak) so the validation is fast and reversible.
- [ ] 7.3 Verify the message-enrichment plan's references in its tracker now point at the new mailroom repo paths (not the old `~/Projects/ConfigFiles/containers/mailroom/mailroom/`). Update the tracker if any references are stale.
- [ ] 7.4 Confirm `TD-MAIL-FRESH-INSTALL-SKILLS` is updated with the new mailroom repo URL — the deferred `/add-gmail` skill update will need to point new instances at GitLab now.
- [ ] 7.5 Move this plan to `~/Projects/mailroom/lode/plans/complete/` (after Wave 6 establishes the new lode).

## Risks

- **Compose path resolution**: per the read-power restore tool note, compose's `../data/...` paths only resolve correctly when cwd is the symlinked `~/containers/mailroom`. Confirm post-cutover that this still holds with the new `image:` directive.
- **env.vault re-encryption**: env.vault is bound to compose; not affected by source location. But verify the path it expects hasn't drifted.
- **Image-build cache on the local registry**: a stale layer could mask a config error. Sanity-check by inspecting the running container's CMD + entrypoint match expectations.
- **Lode broken links**: the migration wave is the highest-risk lode operation in months. Run a `grep -rn 'plans/active/2026-04-' lode/` after migration in both repos to catch dangling references.
- **Filter-repo destructiveness**: filter-repo rewrites history. The scratch clone in Wave 1.1 isolates this — don't run filter-repo against the working ConfigFiles clone, only against the throwaway one.
- **Two-stage commit on ConfigFiles**: Wave 3 (compose change) and Wave 5 (source removal) are separate commits. Don't bundle them — Wave 3 must be verified working before Wave 5 deletes the safety net.

## Errors

| Error | Resolution |
|---|---|

*(none yet)*

## Current status

**Not started.** Plan drafted 2026-04-25 after Jeff confirmed the three-repo split direction + the four implementation decisions (GitLab, `latest` tag, verify-and-close old plan, new plan name = `mailroom-repo-extraction`). Predecessor `2026-04-mailroom-extraction` plan closed in the same session. Awaits branch-greenup precondition (Wave 0) before code work starts.

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

## Trading work (group-specific)
- **Adopt AlgoTrader's anti-overfit rubric.** See `~/Projects/AlgoTrader/lode/practices.md`. Single-variable testing, cross-asset validation, `.shift(1)` on daily filters, "pick one good filter, not two", no hyperparameter grid search.
- **Strategy reports go to the synced vault** at `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/` so Jeff can read them on any device. Do **not** write to `~/Projects/AlgoTrader/obsidian_vault/` for nightly nanoclaw-authored reports.
- Ingested source material goes under `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/Sources/` (per type: magazine/, book/, web/, academic_paper/) and `~/Documents/Obsidian/Main/NanoClaw/AlgoTrader/Web Research/`.
- `~/Documents/Obsidian/Main/Trading/` is Jeff's personal archive of prior trading research — **not mounted to Madison**, leave alone.

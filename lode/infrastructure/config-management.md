# Config Management

All dotfiles and user-level config files on jarvis are managed from `~/Projects/ConfigFiles/`, deployed via GNU Stow. The design goal is a **stateless local OS**: an OS reinstall should be recoverable via `restore Projects → stow-all → mount iSCSI → go`.

## ConfigFiles layout

```
~/Projects/ConfigFiles/
├── bin/
│   └── stow/
│       └── stow-all.sh        # deploys all packages
├── home/                       # stow packages targeting $HOME
│   ├── alacritty/
│   ├── claude/                 # some Claude Code config
│   ├── fish/
│   ├── git/
│   ├── hypr/, hyprland/
│   ├── nvim/, vim/
│   ├── ssh/
│   ├── tmux/
│   └── ...
├── system/                     # system-level configs (requires root stow)
├── containers/                 # Docker Compose stacks (NOT stow-deployed)
├── packages/arch/              # Arch install scripts (NOT stow-deployed)
├── qcm/                        # Python CLI utilities (uv-managed, NOT stow-deployed)
└── CLAUDE.md                   # the ConfigFiles project's own Claude guide
```

## Stow semantics

`bin/stow/stow-all.sh` iterates over directories under `home/` and runs `stow` to create symlinks from `$HOME` into those directories. Files under `home/<package>/<path>` become `$HOME/<path>`.

## What's covered vs. not

**Covered** (via stow):
- Shell configs (fish, tmux, etc.)
- Editor configs (nvim, vim)
- Window manager (Hyprland)
- Some Claude Code config files under `home/claude/`

**NOT covered by stow — tracked by other means**:
- Container image state — backed by `~/containers/data/` subvolumes + snapshots (see [persistence.md](persistence.md))
- Project source trees — backed by Git + remote
- `~/Data/` legacy paths — being migrated to `~/containers/data/`

**NOT covered anywhere** (gaps, track and fix):
- `~/.claude.json` — top-level Claude Code config including MCP server registrations. Lost on OS rebuild. TODO: migrate into `~/Projects/ConfigFiles/home/claude/` under stow.

## Rebuild sequence (outline)

A full OS rebuild should look roughly like:

1. Reinstall OS + base packages.
2. Restore `~/Projects/` from Git.
3. Attach iSCSI NAS; mount to `~/containers/`.
4. Run `~/Projects/ConfigFiles/bin/stow/stow-all.sh`.
5. Restore any non-stow-managed state from snapshots or remote.
6. Start services (e.g. `systemctl --user enable --now nanoclaw`).

(Details beyond this outline should be captured in a dedicated runbook when the full sequence is validated.)

## Conformance rule

New user-facing config or secret files SHOULD live under `~/Projects/ConfigFiles/` (with the exception of container-internal data, which lives in subvolumes per [persistence.md](persistence.md)). Anything created directly in `$HOME` is a rebuild hazard.

## Related

- [persistence.md](persistence.md) — persistent data convention (`~/containers/data/<Project>/`)

# Persistence Convention

Persistent data for every container-based project on jarvis lives under `~/containers/data/<Project>/`, with each project as its own BTRFS subvolume. The parent filesystem is NAS-backed (iSCSI) and snapshotted hourly.

## Layout

```
~/containers/                         # project root (not a subvolume)
├── data/                             # BTRFS parent (root-owned)
│   ├── .snapshots/                   # hourly snapshots, one dir per child subvolume
│   ├── <Project>/                    # each project = one subvolume
│   └── ...
├── .snapshots/                       # NOT the snapshot dir — do not use
└── <project-repos>/                  # source trees (e.g. nanoclaw/)
```

Each entry directly under `~/containers/data/` is a BTRFS subvolume. The hourly snapshot job picks up every subvolume automatically — no explicit registration required. Deleting a subvolume also removes it from the rotation.

Snapshot path: **`~/containers/data/.snapshots/<Project>/`** (not `~/containers/.snapshots/`).

## Ownership

Two patterns are in use:

| Owner | Mode | Example subvolumes | Used when |
|-------|------|--------------------|-----------|
| `jeff:jeff` | `2775` (drwxrwsr-x, setgid) | calibre, gitlab, siftly, NanoClaw | user-mode services (systemd `--user`, direct host access) |
| `root:root` | `0755` (drwxr-xr-x) | beszel, mealie, karakeep, paperless, obsidian-livesync, ollama-nvidia | Docker-managed services with root-owned container processes |
| `999:jeff` | varies | neural-finance | container-specific UIDs |

User-owned subvolumes use the setgid bit so new files inherit the `jeff` group — keeps permissions sane when rsync or scripts create subpaths.

## Adding a new subvolume

```bash
sudo btrfs subvolume create /home/jeff/containers/data/<Project>
# For user-mode services (systemd --user):
sudo chown jeff:jeff /home/jeff/containers/data/<Project>
sudo chmod 2775 /home/jeff/containers/data/<Project>
```

The hourly snapshot job picks it up on the next cycle. Verify by checking `~/containers/data/.snapshots/` after an hour.

## NAS / iSCSI

`~/containers/` lives on an iSCSI-mounted BTRFS volume from the NAS. The snapshot rotation is hourly. Recovery from hourly loss = copy from `~/containers/data/.snapshots/<Project>/<timestamp>/` back into place.

## Why this matters

- **Rebuild-safe**: a bare-metal OS reinstall restores data via NAS re-attach, not local backup.
- **Atomic-ish rollback**: mistakes in any single project can be reverted from the latest snapshot without affecting others.
- **Per-project isolation**: subvolumes are independent — one project's corruption/fs issue doesn't cascade.

## Conformance

Every project that persists data MUST use this convention. Known exceptions should be tracked and migrated — do not add new exceptions.

As of 2026-04-18:
- **NanoClaw** uses this convention at `~/containers/data/NanoClaw/` via the `NANOCLAW_DATA_ROOT` env var in `.env` and `data/env/env`.

## Related

- [config-management.md](config-management.md) — dotfile and config management via GNU Stow

#!/usr/bin/env python3
"""
NanoClaw / MCP restart helper.

Picks one or more MCP servers, sessions, or NanoClaw itself from a checklist
and runs the right sequence of restart + session-clear + orchestrator-bounce
steps in the right order.

WHY THIS EXISTS — the failure mode this prevents:

  When an MCP server upgrades its tool list without changing its URL,
  NanoClaw's auto-rotation hash (`computeGroupMcpHash` in src/index.ts)
  does NOT detect the change — it hashes URL + type, not the tool list.
  Madison's SDK session keeps using the old tool self-image cached in
  its conversation transcript, so she "doesn't see" new tools or thinks
  she has tools that no longer exist.

  The fix is to manually rotate sessions for affected groups after the
  MCP restart. This script does that, plus handles the races:
    - waits for the MCP server to actually answer tools/list before
      letting NanoClaw spawn agents that would bake an empty tool list
      into a fresh session
    - restarts NanoClaw whenever sessions are cleared, so the in-memory
      `sessions[group.folder]` cache doesn't immediately re-stamp the
      cleared sessionId on the next message

This is the canonical NanoClaw restart workflow. (It replaced the older
~/containers/mailroom/restart-all.sh and restart-inbox.sh shell scripts
— those have been removed.)

Usage:
    ./scripts/restart.py                # interactive picker
    ./scripts/restart.py --pick trawl,mailroom-inbox
    ./scripts/restart.py --all          # everything (old restart-all.sh)
    ./scripts/restart.py --dry-run      # show plan, change nothing

Adding a new MCP server: append to MCP_SERVICES below. Set `affects=["*"]`
if every group consumes it (like trawl wildcard mode), else list the
specific group folders.

Two server kinds are supported:
  - Long-lived Docker container (e.g. trawl, mailroom-inbox-mcp). Set
    `container="<name>"`; the script docker-restarts and waits.
  - Stdio MCP spawned by the agent SDK per-invocation (e.g. agentmail-mcp).
    Set `container=None`; the script only clears sessions and bounces
    nanoclaw — there's no container to restart.
"""

from __future__ import annotations

import argparse
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional, Sequence
from urllib.error import URLError
from urllib.request import urlopen

NANOCLAW_DB = Path.home() / "containers/data/NanoClaw/store/messages.db"
NANOCLAW_SERVICE = "nanoclaw"  # systemd --user unit name


# ---------------------------------------------------------------------------
# Known MCP services NanoClaw consumes. ADD NEW ENTRIES HERE.
# ---------------------------------------------------------------------------
@dataclass
class McpService:
    key: str  # short selector, e.g. "trawl"
    container: Optional[str]  # docker container name (for state probe), or None for stdio-MCP
    affects: list[str] = field(default_factory=list)  # group folders OR ["*"] for all
    health_url: Optional[str] = None  # if set, HTTP-wait after restart
    # `dcc` is a make-based docker-compose wrapper that injects env-vault secrets;
    # it must run from a dir containing docker-compose.yml and takes a *service*
    # name, not a container name. Set both for any container-backed entry.
    compose_dir: Optional[Path] = None
    service: Optional[str] = None
    discover_affects: Optional[Callable[[], list[str]]] = (
        None  # populates affects at build time
    )


def _discover_agentmail_affected() -> list[str]:
    """Scan .env for AGENTMAIL_INBOX_<FOLDER>=... keys and return the folder
    list. Empty list ⇒ AgentMail not configured ⇒ entry is hidden from the
    picker. Mirrors src/config.ts:discoverAgentMailInboxes() so host and
    helper agree on which groups the integration touches."""
    env_path = Path.cwd() / ".env"
    if not env_path.exists():
        return []
    folders: list[str] = []
    prefix = "AGENTMAIL_INBOX_"
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        eq = line.find("=")
        if eq == -1:
            continue
        key = line[:eq].strip()
        if not key.startswith(prefix) or key == prefix:
            continue
        # Skip the API key itself if someone follows the naming pattern
        if key == "AGENTMAIL_INBOX_API_KEY":
            continue
        folder = key[len(prefix) :].lower()
        if folder:
            folders.append(folder)
    return folders


_CONTAINERS = Path.home() / "containers"

MCP_SERVICES: list[McpService] = [
    McpService(
        key="mailroom-inbox",
        container="mailroom-inbox-mcp-1",
        compose_dir=_CONTAINERS / "mailroom",
        service="inbox-mcp",
        affects=["telegram_inbox"],
    ),
    McpService(
        key="mailroom-ingestor",
        container="mailroom-ingestor-1",
        compose_dir=_CONTAINERS / "mailroom",
        service="ingestor",
        affects=["telegram_inbox"],
    ),
    McpService(
        key="trawl",
        container="trawl-trawl-1",
        compose_dir=_CONTAINERS / "trawl",
        service="trawl",
        affects=["*"],
        health_url="https://trawl.crested-gecko.ts.net/mcp",
    ),
    # Stdio MCP — spawned per-invocation by the agent SDK as `npx -y agentmail-mcp`.
    # No container to restart; this entry exists so we can targeted-clear sessions
    # for AgentMail-configured groups without nuking everything via "sessions: all".
    # Hidden from the picker on installs that haven't configured any inbox.
    McpService(
        key="agentmail",
        container=None,
        discover_affects=_discover_agentmail_affected,
    ),
]


# ---------------------------------------------------------------------------
# Picker option model — flat list of selectable items shown in the menu.
# ---------------------------------------------------------------------------
@dataclass
class Option:
    key: str  # selector matched against --pick
    kind: str  # "mcp" | "sessions" | "nanoclaw"
    label: str
    detail: str
    state: str  # raw state string (e.g. "running")
    healthy: bool  # used only for the status glyph
    service: Optional[McpService] = None  # set when kind == "mcp"


# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------
def container_state(name: str) -> str:
    try:
        r = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Status}}", name],
            capture_output=True,
            text=True,
            check=True,
        )
        return r.stdout.strip()
    except subprocess.CalledProcessError:
        return "missing"


def systemd_state(svc: str) -> str:
    r = subprocess.run(
        ["systemctl", "--user", "is-active", svc],
        capture_output=True,
        text=True,
    )
    return r.stdout.strip() or "unknown"


def wait_for_url(url: str, timeout: int = 30) -> bool:
    print(f"    waiting for {url}")
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            with urlopen(url, timeout=2) as r:
                # Any response below 500 means the server is up. MCP endpoints
                # often 405 on GET — that's fine, the process is alive.
                if r.status < 500:
                    return True
        except (URLError, OSError):
            pass
        time.sleep(1)
    print(
        f"    ! {url} not responding after {timeout}s — continuing anyway",
        file=sys.stderr,
    )
    return False


def wait_for_container_running(name: str, timeout: int = 30) -> bool:
    print(f"    waiting for container {name} → running")
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        if container_state(name) == "running":
            return True
        time.sleep(1)
    print(
        f"    ! {name} not running after {timeout}s — continuing anyway",
        file=sys.stderr,
    )
    return False


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
def restart_container(s: McpService, dry_run: bool) -> None:
    # `dcc` reads docker-compose.yml from cwd and operates on service names.
    if s.compose_dir is None or s.service is None:
        raise ValueError(f"{s.key}: container-backed entry needs compose_dir + service")
    print(f"  → (cd {s.compose_dir}) dcc r {s.service}")
    if not dry_run:
        subprocess.run(["dcc", "r", s.service], check=True, cwd=s.compose_dir)


def clear_sessions(folders: Sequence[str], dry_run: bool) -> None:
    if "*" in folders:
        print("  → DELETE FROM sessions  (all groups)")
        if not dry_run:
            with sqlite3.connect(NANOCLAW_DB) as con:
                con.execute("DELETE FROM sessions WHERE 1=1;")
        return
    print(f"  → DELETE sessions for: {', '.join(folders)}")
    if not dry_run:
        placeholders = ",".join("?" for _ in folders)
        sql = f"DELETE FROM sessions WHERE group_folder IN ({placeholders});"
        with sqlite3.connect(NANOCLAW_DB) as con:
            con.execute(sql, list(folders))


def stop_nanoclaw(dry_run: bool) -> None:
    print(f"  → systemctl --user stop {NANOCLAW_SERVICE}")
    if not dry_run:
        subprocess.run(
            ["systemctl", "--user", "stop", NANOCLAW_SERVICE],
            check=True,
        )


def start_nanoclaw(dry_run: bool) -> None:
    print(f"  → systemctl --user start {NANOCLAW_SERVICE}")
    if not dry_run:
        subprocess.run(
            ["systemctl", "--user", "start", NANOCLAW_SERVICE],
            check=True,
        )


def remove_dangling(dry_run: bool) -> None:
    print("  → remove dangling nanoclaw-* containers")
    if dry_run:
        return
    r = subprocess.run(
        ["docker", "ps", "-a", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        check=True,
    )
    names = [n for n in r.stdout.splitlines() if n.startswith("nanoclaw-")]
    if names:
        subprocess.run(["docker", "rm", "-f"] + names, check=True)


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------
def build_options() -> list[Option]:
    options: list[Option] = []
    for s in MCP_SERVICES:
        # Stdio MCP services discover their affected folders at build time so
        # the picker reflects current .env state. Hide the entry when nothing
        # is configured — keeps the picker clean on minimal installs.
        if s.discover_affects is not None:
            s.affects = s.discover_affects()
            if not s.affects:
                continue

        if s.container is None:
            # Stdio MCP: no container to probe; show as session-clear-only.
            affects = "all groups" if s.affects == ["*"] else ", ".join(s.affects)
            options.append(
                Option(
                    key=s.key,
                    kind="mcp",
                    label=f"{s.key} (stdio MCP)",
                    detail=f"clear sessions → restart nanoclaw  · affects: {affects}",
                    state="n/a",
                    healthy=True,
                    service=s,
                )
            )
            continue

        st = container_state(s.container)
        affects = "all groups" if s.affects == ["*"] else ", ".join(s.affects)
        options.append(
            Option(
                key=s.key,
                kind="mcp",
                label=s.container,
                detail=f"({st}) → affects: {affects}",
                state=st,
                healthy=(st == "running"),
                service=s,
            )
        )
    nc = systemd_state(NANOCLAW_SERVICE)
    options.append(
        Option(
            key="nanoclaw",
            kind="nanoclaw",
            label="nanoclaw service",
            detail=f"({nc}) — restart orchestrator only",
            state=nc,
            healthy=(nc == "active"),
        )
    )
    options.append(
        Option(
            key="sessions",
            kind="sessions",
            label="sessions: clear all",
            detail="wipe every session pointer (force fresh tool lists)",
            state="n/a",
            healthy=True,
        )
    )
    return options


def parse_selection(raw: str, options: list[Option]) -> list[int]:
    """Accept '1,3', 'trawl,nanoclaw', 'all', or any mix."""
    raw = raw.strip().lower()
    if not raw:
        return []
    if raw in ("all", "a", "*"):
        return list(range(len(options)))
    picked: set[int] = set()
    for tok in raw.replace(" ", "").split(","):
        if not tok:
            continue
        if tok.isdigit():
            i = int(tok) - 1
            if 0 <= i < len(options):
                picked.add(i)
            else:
                print(f"  ! out of range: {tok}", file=sys.stderr)
            continue
        # Name match: substring against option key.
        matches = [i for i, o in enumerate(options) if tok in o.key]
        if len(matches) == 1:
            picked.add(matches[0])
        elif not matches:
            print(f"  ! unknown selector: {tok}", file=sys.stderr)
        else:
            print(
                f"  ! ambiguous: {tok} matches {[options[i].key for i in matches]}",
                file=sys.stderr,
            )
    return sorted(picked)


def interactive_pick(options: list[Option]) -> list[int]:
    print()
    print("NanoClaw restart helper")
    print()
    for i, o in enumerate(options, 1):
        glyph = "✓" if o.healthy else "✗" if o.state not in ("n/a",) else " "
        print(f"  [{i}] {glyph} {o.label:25s} {o.detail}")
    print()
    print("Pick (e.g. '1,3', 'trawl,nano', 'all', or empty to abort)")
    raw = input("> ")
    return parse_selection(raw, options)


# ---------------------------------------------------------------------------
# Plan + execute
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(
        description="NanoClaw / MCP restart helper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  ./scripts/restart.py                  # interactive\n"
            "  ./scripts/restart.py --pick trawl     # only trawl\n"
            "  ./scripts/restart.py --all --dry-run  # preview full reset\n"
        ),
    )
    ap.add_argument(
        "--dry-run", action="store_true", help="show the plan, change nothing"
    )
    ap.add_argument("--pick", help="non-interactive selection (comma-separated)")
    ap.add_argument(
        "--all",
        action="store_true",
        help="select everything (equivalent to old restart-all.sh)",
    )
    ap.add_argument(
        "--yes", "-y", action="store_true", help="skip the confirmation prompt"
    )
    args = ap.parse_args()

    if not NANOCLAW_DB.exists():
        print(f"! sessions DB not found at {NANOCLAW_DB}", file=sys.stderr)
        return 2

    options = build_options()
    if args.all:
        picked_idx = list(range(len(options)))
    elif args.pick:
        picked_idx = parse_selection(args.pick, options)
    else:
        picked_idx = interactive_pick(options)

    if not picked_idx:
        print("Nothing selected. Exiting.")
        return 0

    picked = [options[i] for i in picked_idx]
    mcps = [o.service for o in picked if o.kind == "mcp" and o.service]
    nano_explicit = any(o.kind == "nanoclaw" for o in picked)
    sessions_all = any(o.kind == "sessions" for o in picked)

    # Compute affected groups (union of MCP affects + explicit "all").
    affected: set[str] = set()
    for s in mcps:
        affected.update(s.affects)
    if sessions_all:
        affected.add("*")

    # Safety: clearing sessions without restarting NanoClaw leaves the
    # in-memory sessions[group.folder] cache stale — the next message would
    # re-stamp the cleared sessionId. So if we touch sessions, we restart.
    restart_nano = nano_explicit or bool(affected)

    print()
    print("=== Plan ===")
    if not (mcps or affected or restart_nano):
        print("  (nothing to do)")
        return 0
    for s in mcps:
        if s.container is None:
            print(f"  - {s.key}: stdio MCP — no container restart, sessions only")
            continue
        print(f"  - restart MCP container: {s.container}")
        if s.health_url:
            print(f"      then wait for HTTP {s.health_url}")
        else:
            print("      then wait for container running")
    if affected:
        if "*" in affected:
            print("  - DELETE all sessions")
        else:
            print(f"  - DELETE sessions for: {', '.join(sorted(affected))}")
    if restart_nano:
        print("  - stop nanoclaw → remove dangling nanoclaw-* → start nanoclaw")
    if affected and not nano_explicit:
        print("    (nanoclaw restart added automatically because sessions changed)")
    print()

    if not args.dry_run and not args.yes:
        ans = input("Proceed? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            print("Aborted.")
            return 0

    print()
    print("=== Executing ===")
    # Restart all container-backed MCPs first, then wait — cheaper to overlap
    # boot times. Stdio MCPs (container is None) skip both phases; clearing the
    # session and bouncing nanoclaw is the entire fix for those.
    for s in mcps:
        if s.container is None:
            continue
        restart_container(s, args.dry_run)
    if not args.dry_run:
        for s in mcps:
            if s.container is None:
                continue
            if s.health_url:
                wait_for_url(s.health_url)
            else:
                wait_for_container_running(s.container)

    if affected:
        clear_sessions(sorted(affected), args.dry_run)

    if restart_nano:
        stop_nanoclaw(args.dry_run)
        remove_dangling(args.dry_run)
        start_nanoclaw(args.dry_run)

    print()
    print("Done." + ("  (dry run — nothing changed)" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())

---
name: tasks
description: Create tasks in the user's Obsidian Tasks system by appending `#task` markers to a `_tasks.md` file in your group's Obsidian working folder. Use when the user asks to remember a todo, follow up on something later, or capture an action item. Skip when no Obsidian working folder is mounted.
---

# Creating tasks for the user

The user runs an Obsidian-based task system. The vault scanner watches the
**entire vault** for `#task` markers and promotes each one to a managed task
file in `Tasks/Active/`.

When the user asks you to remember something, follow up later, or capture a
todo, **append a `#task` line to `_tasks.md` in your group's Obsidian
working folder**. No new mount is needed — your group's existing Obsidian
folder is already part of the vault, so the scanner will find it.

## Find your Obsidian working folder

Your group's Obsidian working folder is mounted under `/workspace/extra/`.
It's the directory there that contains markdown notes and (optionally) a
`CLAUDE.md` — **not** an `a-mem` or `context-mode` database directory.

```bash
# List candidates
ls -1 /workspace/extra/ 2>/dev/null
```

If you can't tell which is yours, ask the user once and remember it in your
group memory (`/workspace/group/CLAUDE.md`). Typical names match the group
(e.g. `Personal`, `AlgoTrader`, `Inbox`).

If `/workspace/extra/` is empty, this skill is unavailable — fall back to a
plain message reminder or `mcp__nanoclaw__schedule_task`.

## How to add a task

Append (don't overwrite) a single line to `_tasks.md` in your working folder:

```
#task <title> [tokens...]
```

If `_tasks.md` doesn't exist yet, create it with this frontmatter on first
use (the `project` slug stamps every `#task` line so you can find your
tasks later):

```markdown
---
project: madison-<groupFolder>
tags: [madison]
---

# Madison inbox

```

Replace `<groupFolder>` with your actual group folder name (visible as the
basename of `/workspace/group`'s host path, or in your group CLAUDE.md).

## Token reference

Tokens can appear in any order on the same line:

| Token | Syntax | Example |
|-------|--------|---------|
| Context | `@name` | `@home` `@pc` `@errands` |
| Project | `+slug` | `+home-renovation` |
| Tag | `#name` | `#urgent` `#finance` |
| Date | `YYYY-MM-DD` | `2026-05-10` |

**Date positioning:**
- Date *before* the title → `start_date`
- Date *after* the title → `due_date`
- Two dates → first is start, second is due

Stop words `due`, `on`, `by`, `start`, `starting`, `from` are consumed
automatically — write naturally:

```
#task fix kitchen faucet @home #urgent due 2026-05-10
#task 2026-05-05 review Q2 plans +work-q2
#task call dentist by 2026-05-08
```

## What you can and can't do

- **Create:** append `#task` lines to `_tasks.md`. ✅
- **List your own:** read `_tasks.md` to see what you've created in this
  group. (Promoted tasks live in `Tasks/Active/` elsewhere in the vault and
  aren't mounted here.) ✅
- **Modify / complete / cancel:** not yet supported by the inline syntax.
  When the user asks to close out a task, tell them to mark it done in
  Obsidian or via their task CLI. ❌

## Implementation pattern

```bash
WORKDIR=/workspace/extra/<your-folder>

# First-time init
if [ ! -f "$WORKDIR/_tasks.md" ]; then
  cat > "$WORKDIR/_tasks.md" <<'EOF'
---
project: madison-<groupFolder>
tags: [madison]
---

# Madison inbox

EOF
fi

# Append a task
echo "#task fix kitchen faucet @home #urgent due 2026-05-10" >> "$WORKDIR/_tasks.md"
```

Always **append** — never truncate the file or rewrite the frontmatter.

## When to use this vs scheduled tasks

- **`#task` (this skill)** — long-lived todos the user works on themselves:
  errands, follow-ups, things with a date but no automation.
- **`mcp__nanoclaw__schedule_task`** — recurring or time-triggered work
  *you* should perform automatically (daily summary, periodic check).

If unsure, ask the user.

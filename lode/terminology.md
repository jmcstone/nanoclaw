# Terminology

- **Group** — an isolated agent context with its own `CLAUDE.md`, filesystem mount, and memory. One group per logical workspace (e.g. `telegram_main`, `telegram_trading`).
- **Channel** — inbound/outbound transport (Telegram, WhatsApp, Slack, Gmail, Protonmail IMAP, etc.). Implemented as a skill that self-registers in `src/channels/registry.ts`.
- **Channel skill** — a `skill/*` branch merged into main that adds a channel. See `CONTRIBUTING.md`.
- **Container skill** — a skill mounted into the agent container at runtime (e.g. `container/skills/browser`, `container/skills/formatting`). Not a feature skill.
- **Trigger pattern** — regex in `src/config.ts` that gates which inbound messages invoke the agent.
- **IPC** — file-based inter-process communication between host orchestrator and containerized agents (`src/ipc.ts`).
- **Router** — `src/router.ts`. Formats Markdown to each channel's native syntax before delivery.
- **OneCLI** — the credential gateway on port 3002. Injects API keys and OAuth tokens into container requests so secrets never leave the host.
- **Scheduled task** — cron-like job registered via `src/task-scheduler.ts`; runs in a group container on a schedule.
- **Agent swarm** — Telegram-only feature (`/add-telegram-swarm`) giving each subagent its own bot identity in a group. Useful for adversarial or specialist roles.
- **Madison** — Jeff's agent persona (not "Andy"; renamed 2026).
- **AlgoTrader** — Jeff's Python backtesting framework at `~/Projects/AlgoTrader/`. Has its own lode with ORB-focused research and strict anti-overfit practices. The trading group shells out to AlgoTrader to run backtests.
- **S&C** — Stocks and Commodities Magazine. Jeff has 20 years of PDFs to ingest into `~/Documents/Obsidian/Main/Trading/Stocks and Commodities/`.

# Mailroom Extraction — Findings

## Context

This plan extracts mail ingestion out of the `nanoclaw` host process into a standalone Docker stack. Origin context (why we pivoted here, not to Phase 2 of `unified-inbox`) is recorded in the `unified-inbox` progress.md entry at `23:05 CDT 2026-04-21`.

## Jeff's compose-stack conventions (verified from his files)

### Stow-managed pattern (new-stack convention)

- Source of truth: `~/Projects/ConfigFiles/containers/<stack>/<stack>/docker-compose.yml`
- Stow target: `~/containers/<stack>/` (symlink tree, created by `~/Projects/ConfigFiles/bin/stow/stow-all.sh`)
- Data: `../data/<stack>/` resolves to `~/containers/data/<stack>/`, BTRFS subvolume, permissions `jeff:jeff 2775`, hourly snapshots, NAS-backed via iSCSI
- ConfigFiles repo is version-controlled; `.env.example` committed (template), `env.vault` committed (AES-256 encrypted), actual decrypted `.env` not committed

Exemplar: `~/Projects/ConfigFiles/containers/trawl/trawl/`.

### Direct pattern (legacy)

- Compose at `~/containers/<stack>/docker-compose.yml` (not stow-managed, not in ConfigFiles)
- Data still at `~/containers/data/<stack>/`
- Examples: protonmail, calibre. Pre-dates the stow pattern. Not the target for new stacks.

## `dcc` wrapper

Location: `~/Projects/ConfigFiles/bin/docker-compose/dcc`. Bash wrapper that calls `make -f docker-compose.mk up SERVICES=<stack>`. The Makefile decrypts env.vault via `env-vault env.vault -- docker-compose up ...`.

**Rule (verbatim from trawl tracker): "never `docker compose` directly — skips env-vault".**

Observed subcommands: `dcc up <stack>`, `dcc pull-up <stack>`, `dcc build-push <service> --tag <tag>`, `dcc tag <service> --tag <value>`.

## `env-vault`

Go binary at `~/go/bin/env-vault` (from github.com/romantomjak/env-vault v0.4.0).

On-disk format: AES-256 encrypted file with header `env-vault;1.0;AES256`, file permissions `700`.

Editing: `env-vault edit env.vault` — opens `$EDITOR`, re-encrypts on save.

Runtime: `env-vault <path> -- <command>` — decrypts into the shell's environment, runs `<command>`. dcc's Makefile does this automatically.

**Critical**: compose services must declare `environment: - VAR_NAME` (pass-through syntax — empty form). Without the declaration, the variable sits on the shell running docker-compose but never reaches the container.

Example from trawl:
```yaml
services:
  trawl:
    environment:
      - OPENROUTER_API_KEY
      - ANTHROPIC_API_KEY
      # passed through from env.vault-decrypted shell env
```

## Cross-compose networking pattern

The "reference another stack's network as external" pattern:

```yaml
networks:
  default:
  tsdproxy:
    external: true
    name: tsdproxy_default  # owned by tsdproxy stack

services:
  trawl:
    networks: [default, tsdproxy]
```

The dependency stack (tsdproxy in the example) owns the network. Consumer stacks declare it `external: true` and reference it by `name`. Lifecycle: if the dependency stack is fully torn down (`docker compose down` that removes networks), consumers lose connectivity until the dependency comes back up.

For the mailroom:
- `protonmail_default` is owned by `~/containers/protonmail/docker-compose.yml`. Mailroom references it external.
- `mailroom_shared` is owned by mailroom's own docker-compose. Nanoclaw attaches agent containers to it at spawn time via `--network mailroom_shared`.

## tsdproxy

Stack at `~/containers/tsdproxy/docker-compose.yml`. Mounts Docker socket, Tailscale state volume, a config volume. Requires a tailscale_auth_key secret (file-backed). Dashboard at port 9091.

For a service to get a Tailnet hostname without publishing host ports:
1. Join `tsdproxy_default` (declared as external with `name: tsdproxy_default`)
2. Add labels: `tsdproxy.enable: true`, `tsdproxy.name: <hostname>`, `tsdproxy.container_port: <port>`
3. Result: service reachable at `<hostname>.crested-gecko.ts.net` on the tailnet

tsdproxy v2 supports TCP mode, not just HTTP(S).

**Mailroom does NOT use tsdproxy** (decision locked; Madison is the only consumer and lives on jarvis).

## OneCLI

Mentioned in `~/containers/nanoclaw/.claude/skills/setup/SKILL.md` as a host-side credential vault for the NanoClaw agent orchestrator. **Not integrated into any docker-compose stack.** Container secrets flow via env-vault exclusively.

## Gmail OAuth credentials (current state, pre-extraction)

Location: `~/.gmail-mcp/`
- `gcp-oauth.keys.json` (574B, mtime 2026-03-30): static client ID + client secret — does not change unless the GCP OAuth client is rotated
- `credentials.json` (411B, mtime 2026-04-21 16:01): live OAuth tokens — **autowritten on refresh**. Contains `access_token`, `refresh_token`, `scope`, `token_type`, `expiry_date`

Set up via the `/add-gmail` skill at `~/containers/nanoclaw/.claude/skills/add-gmail/SKILL.md`. Skill steps:
1. User creates GCP OAuth client, downloads `gcp-oauth.keys.json` to `~/.gmail-mcp/`
2. User runs `npx -y @gongrzhe/server-gmail-autoauth-mcp auth` (interactive browser OAuth on the host)
3. Tool writes `credentials.json` into the same directory

**Implication for mailroom**: `credentials.json` must be a writable file, not an env var — the OAuth client rewrites it on every refresh. Mailroom migration:
- Target dir: `~/containers/data/mailroom/gmail-mcp/` (BTRFS subvolume under the standard data root)
- Bind mount: RW into ingestor
- Copy existing state at M0.7: `cp -r ~/.gmail-mcp/ ~/containers/data/mailroom/gmail-mcp/`

## Protonmail bridge current state

Compose: `~/containers/protonmail/docker-compose.yml` (direct pattern, not stow). Container runs `protonmail-bridge-local` image; mounts `protonmail:/root` volume for bridge state; publishes `0.0.0.0:1143:143` (IMAP) and `0.0.0.0:1025:25` (SMTP).

Config consumed by nanoclaw: `~/.protonmail-bridge/config.json` — JSON with `addresses[]` (7 addresses), `host`, `imapPort`, `smtpPort`, `password`. Currently `host: "host.docker.internal"` which fails from the host process (root cause of the 3-week Protonmail dark period).

For mailroom:
- `host: "protonmail-bridge"` (Docker service DNS on `protonmail_default`)
- `imapPort: 143` (internal port, not the published 1143)
- `password` → env.vault `PROTONMAIL_BRIDGE_PASSWORD` pass-through
- `addresses[]` → either env.vault as JSON string `PROTONMAIL_ADDRESSES` or a file at `~/containers/data/mailroom/proton-addresses.json`. TBD during M0.4.

## Host-side Protonmail channel diagnosis (rolled up from unified-inbox)

ENOTFOUND has been dominant since 2026-03-30 20:21. 67 successful "Protonmail email delivered" events all belong to PID 4002599 which held an older cached config in memory for 6 hours on 2026-03-30 after Jeff wrote `host.docker.internal` to `~/.protonmail-bridge/config.json` at 14:03. First restart after that (20:21:47) read the new config and started failing; every restart since has been dark.

Madison's container-side path (`fetch-protonmail.js`) kept working because nanoclaw's container-runner injects `--add-host=host.docker.internal:host-gateway` into spawned agent containers. That flag is not present on the host process itself, by design (`src/container-runtime.ts:44-50` with comment "On Linux, host.docker.internal isn't built-in").

Mailroom resolves this by going through Docker service-name DNS (`protonmail-bridge:143`) on `protonmail_default`, avoiding both the `host.docker.internal` trick and the published port.

## Phase 1.6 SQLCipher transplant notes

The Phase 1.6 work on `unified-inbox` (`0fd4081`) transplants to mailroom without conceptual change:

- `package.json`: alias `better-sqlite3` → `better-sqlite3-multiple-ciphers@11.10.0`. Same line.
- `Dockerfile`: `npm ci --ignore-scripts && npm rebuild better-sqlite3 && npm run build && npm prune --omit=dev`. Necessary because multiple-ciphers has no Node 22 prebuild.
- `loadInboxDbKey()` helper: 64-hex-char validation, `readEnvFile` fallback for `INBOX_DB_KEY`. In mailroom, `readEnvFile` isn't needed — env.vault pass-through puts the value in `process.env` directly. Simplify to just `process.env.INBOX_DB_KEY` with the same validation.
- `PRAGMA cipher='sqlcipher'` + `PRAGMA key="x'<64-hex>'"` at open, before schema. Identical.
- Tests: `db.encryption.test.ts` round-trip + FTS5 + key-validation. Transplant verbatim.

## MCP Streamable HTTP (for inbox-mcp conversion)

Current inbox-mcp uses `@modelcontextprotocol/sdk`'s `StdioServerTransport`. To convert to HTTP (like trawl's `FastMCP` setup on the Python side), use `@modelcontextprotocol/sdk/server/streamableHttp.js`'s `StreamableHTTPServerTransport`.

Verified (from MCP SDK source): `StreamableHTTPServerTransport` handles POST to `/mcp` with session management via `Mcp-Session-Id` header. Request handler wraps an `http.Server` (or express).

Reference implementation: trawl's Python MCP server uses FastMCP which handles this. Jeff's trawl container runs `uv run trawl mcp-server --host 0.0.0.0 --port 8088` — the shape mailroom's inbox-mcp Dockerfile entry should mirror.

## Open technical items discovered during design

1. **Event delivery format** (`ipc-out/inbox-new-*.json`): precise schema needs to match nanoclaw's existing router expectations. Check `src/router.ts` + `src/types.ts` NewMessage shape during M1.4.
2. **Urgency classification**: today's per-email-arrival policy (Phase 0.5 of unified-inbox) does classification IN the channel before dispatch. If classification moves to mailroom, that's scope creep. If it stays in nanoclaw's `mailroom-subscriber`, mailroom just emits raw arrival events and subscriber classifies. Decision: **keep classification in nanoclaw** — mailroom is ingestion/storage only, classification is policy.
3. **Test strategy**: mailroom is a new repo. Re-run the ported vitest suite against mailroom's source, or skip per-file tests and rely on integration tests via `docker compose run`? Decide during M0.
4. **Monitoring / healthchecks**: mealie-style healthcheck on ingestor? Probably yes for `depends_on: service_healthy`.

## Resources (URLs, takeaways)

- MCP SDK Streamable HTTP example: check `@modelcontextprotocol/sdk/dist/server/streamableHttp.js` in the installed package for current API surface (version `1.13.3` per `container/inbox-mcp/package.json`).
- env-vault: `github.com/romantomjak/env-vault` — AES-256 symmetric encryption over .env files.
- tsdproxy: `github.com/almeidapaulopt/tsdproxy` — Tailscale-native reverse proxy.

# inbox-mcp

Self-contained MCP server that exposes the NanoClaw unified inbox SQLite database
to agent containers via three read-only tools.

## Environment

| Variable | Required | Description |
|---|---|---|
| `INBOX_DB_PATH` | yes | Absolute path to the inbox SQLite file (mounted into the container) |

The server opens the database in **readonly** mode (`fileMustExist: true`). It will
refuse to start without `INBOX_DB_PATH` set, but does not access the file until the
first tool call.

## Tools

| Tool | Description |
|---|---|
| `mcp__inbox__search` | Full-text search across messages; optional source filter |
| `mcp__inbox__thread` | Fetch a thread header + all ordered messages by thread_id |
| `mcp__inbox__recent` | Fetch messages newer than a watermark for a given account |

## Build (inside Docker image)

```bash
npm ci && npm run build
```

The compiled entry point is `dist/index.js`. The container image runs it via stdio transport.

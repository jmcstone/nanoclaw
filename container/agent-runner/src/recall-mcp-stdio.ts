/**
 * Recall MCP Server for NanoClaw (Option C)
 *
 * In-container stdio MCP that exposes recall_sessions() — FTS5 search over
 * the per-group session recall DB. Returns capped, dated excerpts directly to
 * the calling agent (Madison), which synthesizes the summary. No second model
 * call, no credential required — synthesis is done by the main agent using its
 * Max-plan subscription quota.
 *
 * Isolation model: each container receives ONLY its own group's recall DB,
 * bind-mounted read-only at /recall/recall.db by container-runner.ts
 * (outside /workspace/extra/ — see RECALL_DB_PATH comment below).
 * No tokens, no scope parameter — isolation is by construction (the container
 * physically cannot access another group's file).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import fs from 'fs';

/**
 * Path where container-runner.ts bind-mounts the per-group recall DB (read-only).
 * Lives at /recall/ rather than /workspace/extra/recall/ so the agent-runner's
 * /workspace/extra/* additional-directory scanner does not pick up the SQLite
 * binary and add it to Claude's workspace — recall is accessed only via this
 * MCP tool, not as a raw file.
 */
const RECALL_DB_PATH = '/recall/recall.db';

const DEFAULT_LIMIT = 12;
/**
 * Max tokens per excerpt produced by FTS5 snippet().
 * This is the 6th argument to snippet(table, col_idx, start, end, ellipsis, tokens).
 */
const SNIPPET_TOKEN_COUNT = 24;

/**
 * FTS5 query: retrieve top-k excerpts by BM25 relevance rank.
 * Column index 5 in snippet() = content (0-indexed: msg_id, session_id,
 * agent_group, ts, role, content — UNINDEXED flags do NOT shift the index).
 * bm25() returns negative values; lower (more negative) = more relevant,
 * so ORDER BY rank ASC gives best matches first.
 */
const RECALL_SQL = [
  'SELECT msg_id, ts, role,',
  `  snippet(session_fts, 5, '«', '»', '…', ${SNIPPET_TOKEN_COUNT}) AS snip,`,
  '  bm25(session_fts) AS rank',
  'FROM session_fts',
  'WHERE session_fts MATCH ?',
  'ORDER BY rank',
  'LIMIT ?',
].join(' ');

type RecallRow = { msg_id: string; ts: string; role: string; snip: string; rank: number };

function log(msg: string): void {
  console.error(`[RECALL] ${msg}`);
}

const server = new McpServer({
  name: 'recall',
  version: '1.0.0',
});

server.tool(
  'recall_sessions',
  'Search this assistant\'s own past conversations (full-text over the per-group recall index). Returns the most relevant dated excerpts — summarize them for the user. Use when asked about earlier discussions or history you don\'t already have in context. Tip: use few, broad keywords (FTS5 ANDs terms by default); prefer OR for alternatives (e.g. "budget OR cost").',
  {
    query: z
      .string()
      .describe(
        'FTS5 keyword query — what to search for in past conversations (e.g. "hotel booking Paris", "quarterly report deadline"). Use plain keywords; FTS5 operators (AND, OR, NOT, phrases in quotes) are supported.',
      ),
    limit: z
      .number()
      .optional()
      .describe(
        `Maximum number of excerpts to retrieve. Defaults to ${DEFAULT_LIMIT}. Increase for broad topics; decrease for focused queries.`,
      ),
  },
  async (args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;

    log(`Searching recall DB for: "${args.query}" (limit=${limit})`);

    // Guard: recall DB not present — group has no indexed history yet.
    if (!fs.existsSync(RECALL_DB_PATH)) {
      log('Recall DB not found — no history for this group');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              excerpts: [],
              note: 'No recall history is available for this group yet.',
            }),
          },
        ],
      };
    }

    // FTS5 automerge: SQLite's FTS5 implementation writes to internal shadow
    // tables even during read-only MATCH queries (segment merge). Because the
    // DB is bind-mounted :ro by container-runner.ts, we copy it to /tmp and
    // open the writable copy — the original is never modified.
    let db: Database;
    const tmpDbPath = `/tmp/recall-${process.pid}.db`;
    let tmpCreated = false;
    try {
      fs.copyFileSync(RECALL_DB_PATH, tmpDbPath);
      tmpCreated = true;
      db = new Database(tmpDbPath);
    } catch (err) {
      if (tmpCreated) { try { fs.unlinkSync(tmpDbPath); } catch {} }
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to open recall DB: ${msg}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              excerpts: [],
              note: `No recall history is available for this group yet.`,
            }),
          },
        ],
      };
    }

    let rows: RecallRow[];
    try {
      rows = db.prepare(RECALL_SQL).all(args.query, limit) as RecallRow[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`FTS5 query error: ${msg}`);
      // Most likely an FTS5 syntax error from the query string.
      return {
        content: [
          {
            type: 'text' as const,
            text: `Recall search failed — the query "${args.query}" caused an error (possibly invalid FTS5 syntax). Try plain keywords without special characters. Detail: ${msg}`,
          },
        ],
        isError: true,
      };
    } finally {
      db.close();
      try { fs.unlinkSync(tmpDbPath); } catch {}
    }

    log(`Found ${rows.length} matching excerpts`);

    if (rows.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              excerpts: [],
              note: `No past conversations matched "${args.query}".`,
            }),
          },
        ],
      };
    }

    const excerpts = rows.map((r) => ({
      date: r.ts,
      role: r.role,
      snippet: r.snip,
    }));

    log(`Recall complete: ${rows.length} excerpts returned`);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            excerpts,
            note: `${rows.length} past-conversation excerpts matching "${args.query}". Summarize them into a concise, dated answer for the user; say so if nothing is relevant.`,
          }),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`Recall MCP server ready (db: ${RECALL_DB_PATH})`);

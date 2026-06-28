/**
 * Recall MCP Server for NanoClaw (Option B)
 *
 * In-container stdio MCP that exposes recall_sessions() — FTS5 search over
 * the per-group session recall DB, summarized via Claude Haiku on the
 * Max-plan subscription through the OneCLI credential proxy.
 *
 * Isolation model: each container receives ONLY its own group's recall DB,
 * bind-mounted read-only at /recall/recall.db by container-runner.ts
 * (outside /workspace/extra/ — see RECALL_DB_PATH comment below).
 * No tokens, no scope parameter — isolation is by construction (the container
 * physically cannot access another group's file).
 *
 * Reachability: the OneCLI proxy injects HTTPS_PROXY + CA certs into the
 * container environment so any HTTPS call to api.anthropic.com gets the
 * Max-plan credential injected at the proxy — no explicit API key needed.
 * The recall MCP child inherits process.env (including HTTPS_PROXY) via
 * env: { ...process.env } in the MCP registration in index.ts.
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

/**
 * Summarize via Claude Haiku on the Max-plan subscription.
 * The OneCLI proxy (HTTPS_PROXY) injects the credential — no API key set here.
 */
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const SUMMARIZE_MODEL = 'claude-haiku-4-5';

const DEFAULT_LIMIT = 12;
/** Max tokens for the Haiku summary response. */
const SUMMARY_MAX_TOKENS = 400;
/**
 * Max tokens per excerpt produced by FTS5 snippet().
 * This is the 6th argument to snippet(table, col_idx, start, end, ellipsis, tokens).
 */
const SNIPPET_TOKEN_COUNT = 24;
/**
 * Fetch timeout for the Anthropic summarization call.
 * Prevents the tool call from hanging indefinitely when the OneCLI proxy is
 * unreachable — the caller will gracefully degrade to raw excerpts instead.
 */
const SUMMARIZE_TIMEOUT_MS = 20_000;

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

async function summarizeViaAnthropic(query: string, excerpts: string): Promise<string> {
  // AbortController enforces SUMMARIZE_TIMEOUT_MS: if the OneCLI proxy is
  // unreachable the tool call degrades to raw excerpts rather than hanging.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        // No authorization header — the OneCLI HTTPS_PROXY injects the
        // Max-plan credential at the proxy layer.
      },
      body: JSON.stringify({
        model: SUMMARIZE_MODEL,
        max_tokens: SUMMARY_MAX_TOKENS,
        system:
          'You are a recall assistant. Summarize the following past-conversation excerpts ' +
          "in ≤120 words, directly answering the user's query. Cite relevant dates from " +
          'the excerpts.',
        messages: [
          {
            role: 'user',
            content: `Query: "${query}"\n\nExcerpts:\n${excerpts}`,
          },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = data.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('Anthropic response missing content[0].text');
  }
  return text;
}

const server = new McpServer({
  name: 'recall',
  version: '1.0.0',
});

server.tool(
  'recall_sessions',
  'Search past conversation history for relevant context. Returns a summary of the most relevant conversation excerpts with dated citations. Use this to recall previous discussions, decisions, plans, or topics mentioned in prior sessions.',
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
        `Maximum number of excerpts to retrieve before summarizing. Defaults to ${DEFAULT_LIMIT}. Increase for broad topics; decrease for focused queries.`,
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
              summary:
                'No recall history available — the recall database has not been set up for this conversation group yet.',
              citations: [],
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
              summary: `No recall history available — could not open the recall database: ${msg}`,
              citations: [],
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
              summary: `Nothing relevant found for "${args.query}".`,
              citations: [],
            }),
          },
        ],
      };
    }

    // Build a numbered excerpt list for the summarizer. Format:
    //   [1] (2026-06-15T10:23:00Z, user) «highlighted term» with context…
    const excerpts = rows
      .map((r, i) => `[${i + 1}] (${r.ts}, ${r.role}) ${r.snip}`)
      .join('\n');

    let summary: string;
    try {
      summary = await summarizeViaAnthropic(args.query, excerpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Summarization failed (${msg}) — degrading to unsummarized excerpts`);
      // Degrade gracefully rather than failing the entire tool call.
      summary = `[Summarization unavailable: ${msg}]\n\nRaw excerpts:\n${excerpts}`;
    }

    const citations = rows.map((r) => ({
      date: r.ts,
      role: r.role,
      snippet: r.snip,
    }));

    log(`Recall complete: ${rows.length} citations, ${summary.length} char summary`);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ summary, citations }),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(
  `Recall MCP server ready (db: ${RECALL_DB_PATH}, summarizer: ${SUMMARIZE_MODEL} via OneCLI proxy, timeout: ${SUMMARIZE_TIMEOUT_MS}ms)`,
);

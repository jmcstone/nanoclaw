/**
 * Recall MCP Server for NanoClaw (Option B)
 *
 * In-container stdio MCP that exposes recall_sessions() — FTS5 search over
 * the per-group session recall DB, summarized via LiteLLM.
 *
 * Isolation model: each container receives ONLY its own group's recall DB,
 * bind-mounted read-only at /workspace/extra/recall/recall.db by
 * container-runner.ts. No tokens, no scope parameter — isolation is by
 * construction (the container physically cannot access another group's file).
 *
 * Reachability: LiteLLM is reached at http://172.31.0.1:4000 (the gwbridge
 * IP where the host-published :4000 is reachable from v2 containers).
 * LITELLM_BASE_URL / LITELLM_API_KEY are injected by container-runner.ts
 * alongside the existing per-group virtual key (same env vars the
 * litellm-route MCP uses).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import fs from 'fs';

const RECALL_DB_PATH = '/workspace/extra/recall/recall.db';
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || 'http://172.31.0.1:4000';
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || '';
/**
 * LiteLLM model alias for cheap summarization.
 * "haiku" is the alias registered in the LiteLLM gateway config
 * (documented in design doc MEMORY-RECALL-DESIGN.md §2 and litellm-host-client.ts).
 */
const SUMMARIZE_MODEL = 'haiku';

const DEFAULT_LIMIT = 12;

/**
 * FTS5 query: retrieve top-k excerpts by BM25 relevance rank.
 * Column index 5 in snippet() = content (0-indexed: msg_id, session_id,
 * agent_group, ts, role, content — UNINDEXED flags do NOT shift the index).
 * bm25() returns negative values; lower (more negative) = more relevant,
 * so ORDER BY rank ASC gives best matches first.
 */
const RECALL_SQL = [
  'SELECT msg_id, ts, role,',
  "  snippet(session_fts, 5, '«', '»', '…', 24) AS snip,",
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

async function summarizeViaLiteLLM(query: string, excerpts: string): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (LITELLM_API_KEY) {
    headers['Authorization'] = `Bearer ${LITELLM_API_KEY}`;
  }

  const prompt =
    `Summarize the following conversation excerpts in ≤120 words, directly answering the ` +
    `query: "${query}". Cite relevant dates.\n\n${excerpts}`;

  const res = await fetch(`${LITELLM_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: SUMMARIZE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: 200,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LiteLLM error (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LiteLLM response missing choices[0].message.content');
  }
  return content;
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

    let db: Database;
    try {
      db = new Database(RECALL_DB_PATH, { readonly: true });
    } catch (err) {
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
      summary = await summarizeViaLiteLLM(args.query, excerpts);
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
log(`Recall MCP server ready (db: ${RECALL_DB_PATH}, gateway: ${LITELLM_BASE_URL})`);

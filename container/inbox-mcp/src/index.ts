#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { searchMessages, getThread, getRecentMessages } from './queries.js';
import {
  INBOX_SOURCES,
  InboxSource,
  RecentArgs,
  SearchArgs,
  ThreadArgs,
} from './types.js';

const server = new Server(
  { name: 'inbox-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing or invalid required string argument: ${key}`);
  }
  return v;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Invalid number argument: ${key}`);
  }
  return v;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`Invalid string argument: ${key}`);
  return v;
}

function optionalSource(
  args: Record<string, unknown>,
  key: string,
): InboxSource | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !INBOX_SOURCES.includes(v as InboxSource)) {
    throw new Error(
      `Invalid source: expected one of ${INBOX_SOURCES.join(', ')}`,
    );
  }
  return v as InboxSource;
}

function parseSearchArgs(args: Record<string, unknown>): SearchArgs {
  return {
    query: requireString(args, 'query'),
    limit: optionalNumber(args, 'limit'),
    source: optionalSource(args, 'source'),
  };
}

function parseThreadArgs(args: Record<string, unknown>): ThreadArgs {
  return { thread_id: requireString(args, 'thread_id') };
}

function parseRecentArgs(args: Record<string, unknown>): RecentArgs {
  return {
    account_id: requireString(args, 'account_id'),
    since_watermark: optionalString(args, 'since_watermark'),
    limit: optionalNumber(args, 'limit'),
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'mcp__inbox__search',
      description:
        'Full-text search across inbox messages. Returns matching messages ordered by received_at DESC.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'FTS5 search query' },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 100)',
          },
          source: {
            type: 'string',
            enum: [...INBOX_SOURCES],
            description: 'Filter by source account type',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'mcp__inbox__thread',
      description:
        'Fetch a thread header and all its messages ordered by received_at ASC. Returns null if thread not found.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          thread_id: {
            type: 'string',
            description: 'Thread ID to retrieve',
          },
        },
        required: ['thread_id'],
      },
    },
    {
      name: 'mcp__inbox__recent',
      description:
        'Fetch messages newer than a watermark for a given account. Returns messages ordered ASC plus the new watermark value.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          account_id: {
            type: 'string',
            description: 'Account ID (e.g. "gmail:user@example.com")',
          },
          since_watermark: {
            type: 'string',
            description: 'Watermark from previous call; omit to use stored watermark',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 50, max 200)',
          },
        },
        required: ['account_id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  switch (req.params.name) {
    case 'mcp__inbox__search':
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(searchMessages(parseSearchArgs(args))),
          },
        ],
      };
    case 'mcp__inbox__thread':
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(getThread(parseThreadArgs(args))),
          },
        ],
      };
    case 'mcp__inbox__recent':
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(getRecentMessages(parseRecentArgs(args))),
          },
        ],
      };
    default:
      throw new Error(`Unknown tool: ${req.params.name}`);
  }
});

process.stderr.write('inbox-mcp: starting stdio transport\n');
await server.connect(new StdioServerTransport());

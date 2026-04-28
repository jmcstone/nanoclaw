/**
 * LiteLLM Route MCP Server for NanoClaw
 *
 * Exposes LiteLLM's OpenAI-compatible /v1/chat/completions endpoint as MCP tools.
 * The container agent (Madison) calls these tools to route specific tasks to
 * non-Anthropic models — typically OpenRouter-hosted (Grok, Gemini, GPT) or
 * local Ollama models — while keeping the default Anthropic-direct path
 * (subscription + prompt caching) untouched.
 *
 * Auth: per-Madison virtual key from LITELLM_API_KEY env var. Each Madison
 * gets her own key with budget caps issued from the LiteLLM admin UI.
 *
 * Reachability: LITELLM_BASE_URL defaults to host.docker.internal:4000. On
 * Linux, container-runner.ts adds --add-host=host.docker.internal:host-gateway.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import fs from 'fs';
import path from 'path';

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || 'http://host.docker.internal:4000';
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || '';
const LITELLM_STATUS_FILE = '/workspace/ipc/litellm_status.json';

function log(msg: string): void {
  console.error(`[LITELLM] ${msg}`);
}

function writeStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${LITELLM_STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(LITELLM_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, LITELLM_STATUS_FILE);
  } catch {
    /* best-effort */
  }
}

async function litellmFetch(endpoint: string, options?: RequestInit): Promise<Response> {
  if (!LITELLM_API_KEY) {
    throw new Error(
      'LITELLM_API_KEY is not set. The container needs a per-group virtual key injected by container-runner.ts.',
    );
  }
  const url = `${LITELLM_BASE_URL}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${LITELLM_API_KEY}`,
    ...(options?.headers ?? {}),
  };
  try {
    return await fetch(url, { ...options, headers });
  } catch (err) {
    if (LITELLM_BASE_URL.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallbackUrl, { ...options, headers });
    }
    throw err;
  }
}

const server = new McpServer({
  name: 'litellm',
  version: '1.0.0',
});

server.tool(
  'litellm_list_models',
  'List models registered in the LiteLLM gateway. These are routes to OpenRouter (Grok, Gemini, GPT, etc.) and possibly local Ollama. Use this to see which models are available before calling litellm_generate.',
  {},
  async () => {
    log('Listing models...');
    writeStatus('listing', 'Listing available models');
    try {
      const res = await litellmFetch('/v1/models');
      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [
            {
              type: 'text' as const,
              text: `LiteLLM error (${res.status}): ${errorText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const models = data.data || [];

      if (models.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No models registered in LiteLLM. Jeff can register models in the LiteLLM admin UI (port 4000).',
            },
          ],
        };
      }

      const list = models.map((m) => `- ${m.id}`).join('\n');
      log(`Found ${models.length} models`);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Registered LiteLLM models:\n${list}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to reach LiteLLM at ${LITELLM_BASE_URL}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'litellm_generate',
  'Send a prompt to a model registered in LiteLLM (OpenRouter-hosted exotics like grok-4-fast, gemini-2-flash, gpt-4o-mini). Returns the completion plus token usage. Use this for tasks where a specific non-Claude model is the right call (e.g. 1M-context whole-book summarization with grok-4-fast). Default to your own reasoning (Claude) for everything else — your prompt cache stays warm and Jeff\'s Max-plan covers it.',
  {
    model: z.string().describe('Model name as registered in LiteLLM (e.g. "grok-4-fast", "gemini-2-flash", "gpt-4o-mini")'),
    prompt: z.string().describe('The user prompt to send to the model'),
    system: z.string().optional().describe('Optional system prompt to set model behavior'),
    max_tokens: z
      .number()
      .optional()
      .describe('Max tokens in the response. Default lets the model decide. Use this to cap cost on long-context calls.'),
    temperature: z.number().optional().describe('Sampling temperature 0-2. Defaults to model default. Lower = more deterministic.'),
  },
  async (args) => {
    log(`>>> Generating with ${args.model} (${args.prompt.length} chars)...`);
    writeStatus('generating', `Generating with ${args.model}`);

    const messages: Array<{ role: string; content: string }> = [];
    if (args.system) messages.push({ role: 'system', content: args.system });
    messages.push({ role: 'user', content: args.prompt });

    const body: Record<string, unknown> = {
      model: args.model,
      messages,
      stream: false,
    };
    if (typeof args.max_tokens === 'number') body.max_tokens = args.max_tokens;
    if (typeof args.temperature === 'number') body.temperature = args.temperature;

    try {
      const startedAt = Date.now();
      const res = await litellmFetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [
            {
              type: 'text' as const,
              text: `LiteLLM error (${res.status}): ${errorText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string }; finish_reason?: string }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        model?: string;
      };

      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      const text = data.choices?.[0]?.message?.content ?? '';
      const finish = data.choices?.[0]?.finish_reason;
      const usage = data.usage;

      const metaParts: string[] = [data.model || args.model, `${elapsedSec}s`];
      if (usage) {
        metaParts.push(`${usage.prompt_tokens}↓ ${usage.completion_tokens}↑ tokens`);
      }
      if (finish && finish !== 'stop') metaParts.push(`finish=${finish}`);
      const meta = `\n\n[${metaParts.join(' | ')}]`;

      log(`<<< Done: ${args.model} | ${elapsedSec}s | ${usage?.total_tokens ?? '?'} tokens | ${text.length} chars`);
      writeStatus('done', `${args.model} | ${elapsedSec}s | ${usage?.total_tokens ?? '?'} tokens`);

      return { content: [{ type: 'text' as const, text: text + meta }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to call LiteLLM: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`LiteLLM MCP server ready (gateway: ${LITELLM_BASE_URL})`);

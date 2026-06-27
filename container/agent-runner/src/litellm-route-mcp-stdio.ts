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
 * Reachability: LITELLM_BASE_URL is set per-group in container_config to the
 * gwbridge gateway IP (http://172.31.0.1:4000), where the LiteLLM gateway
 * (0.0.0.0:4000 on the host) is reachable from v2 containers.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || 'http://172.31.0.1:4000';
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

server.tool(
  'litellm_generate_image',
  'Generate an image from a text prompt via the LiteLLM gateway (routes to OpenRouter image models like "gemini-3.1-flash-image" aka nano-banana). Writes the image to a file path you choose and returns the path + final dimensions. Generic — use for website art, briefing-room heroes, illustrations, anything. The model returns roughly 16:9; pass width AND height to crop/resize to an exact size. output_path must live inside a writable mount: /workspace/group, /workspace/downloads, /workspace/extra/shared, or a subfolder of those.',
  {
    prompt: z
      .string()
      .describe(
        'Full image description. Be specific about subject, style, lighting, composition. For a consistent set (e.g. briefing-room cards), reuse a fixed style prefix across every call and vary only the subject.',
      ),
    output_path: z
      .string()
      .describe(
        'Absolute container path to write to, e.g. /workspace/extra/shared/AVP/briefings/data-centers.jpg. Parent dirs are created automatically. The extension sets the format: .jpg/.jpeg = JPEG, .png = PNG, .webp = WebP.',
      ),
    model: z
      .string()
      .optional()
      .describe('LiteLLM image model name. Default "gemini-3.1-flash-image".'),
    width: z
      .number()
      .optional()
      .describe('Resize target width in px. Must be paired with height.'),
    height: z
      .number()
      .optional()
      .describe('Resize target height in px. Must be paired with width.'),
    fit: z
      .enum(['cover', 'contain', 'inside', 'fill'])
      .optional()
      .describe(
        'Resize strategy when width+height are given. "cover" (default) crops to fill the box exactly; "contain" letterboxes; "inside" fits within without cropping; "fill" stretches.',
      ),
  },
  async (args) => {
    const model = args.model || 'gemini-3.1-flash-image';

    if ((args.width && !args.height) || (args.height && !args.width)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'width and height must be provided together (or neither, to keep the model\'s native size).',
          },
        ],
        isError: true,
      };
    }

    log(`>>> Generating image with ${model} -> ${args.output_path}`);
    writeStatus('generating', `Image: ${model}`);

    try {
      const startedAt = Date.now();
      const res = await litellmFetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: args.prompt }],
          modalities: ['image', 'text'],
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [
            { type: 'text' as const, text: `LiteLLM error (${res.status}): ${errorText}` },
          ],
          isError: true,
        };
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            images?: Array<{ image_url?: { url?: string } }>;
          };
        }>;
      };

      const msg = data.choices?.[0]?.message;
      const url = msg?.images?.[0]?.image_url?.url;
      if (!url) {
        const text = msg?.content ? ` Model said: ${msg.content.slice(0, 300)}` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `No image in response from ${model}. The model may not support image output, or refused the prompt.${text}`,
            },
          ],
          isError: true,
        };
      }

      let raw: Buffer;
      if (url.startsWith('data:')) {
        raw = Buffer.from(url.split(',', 2)[1], 'base64');
      } else {
        const imgRes = await fetch(url);
        raw = Buffer.from(await imgRes.arrayBuffer());
      }

      // Always pipe through sharp so the output format matches the file
      // extension (model returns JPEG) and any requested resize is applied.
      let pipeline = sharp(raw);
      if (args.width && args.height) {
        pipeline = pipeline.resize(args.width, args.height, { fit: args.fit || 'cover' });
      }
      const ext = path.extname(args.output_path).toLowerCase();
      if (ext === '.png') pipeline = pipeline.png();
      else if (ext === '.webp') pipeline = pipeline.webp();
      else pipeline = pipeline.jpeg({ quality: 90 });
      const out = await pipeline.toBuffer();

      fs.mkdirSync(path.dirname(args.output_path), { recursive: true });
      fs.writeFileSync(args.output_path, out);

      const meta = await sharp(out).metadata();
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      const summary = `Wrote ${args.output_path} (${meta.width}×${meta.height}, ${(out.length / 1024).toFixed(0)}KB, ${elapsedSec}s, model=${model})`;
      log(`<<< ${summary}`);
      writeStatus('done', summary);

      return { content: [{ type: 'text' as const, text: summary }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to generate image: ${err instanceof Error ? err.message : String(err)}`,
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

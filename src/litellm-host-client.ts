/**
 * Host-side LiteLLM client — calls the LiteLLM gateway from the orchestrator process.
 *
 * Credential decision (D10): host-side callers (recall summariser, distiller) use a
 * DEDICATED key `LITELLM_HOST_API_KEY` in `.env`, separate from the per-group virtual
 * keys that are injected into containers at spawn time. The host-side caller has no group
 * identity, so borrowing a per-group key would conflate budget tracking and break the
 * per-group spend isolation the LiteLLM admin UI enforces.
 *
 * Reachability: the host process reaches LiteLLM at `http://localhost:4000`. Containers
 * reach the same gateway at `http://172.31.0.1:4000` (the gwbridge IP); that address is
 * NOT used here — this file is host-only.
 */
import { readEnvFile } from './env.js';

/** Base URL for the LiteLLM gateway as seen from the host process. */
const HOST_LITELLM_BASE_URL = 'http://localhost:4000';

// Read the host API key once at module load: process.env override first (deploy/test
// override), then the .env file — same precedence as other madison-extensions.ts exports.
const _envVars = readEnvFile(['LITELLM_HOST_API_KEY']);
const _defaultApiKey: string | undefined =
  (process.env.LITELLM_HOST_API_KEY || _envVars.LITELLM_HOST_API_KEY) || undefined;

/**
 * Call the LiteLLM gateway from the host process and return the assistant reply string.
 *
 * @param model   LiteLLM model name (e.g. `"haiku"`, `"gemini-2-flash"`)
 * @param messages OpenAI-style message array
 * @param opts    Optional overrides — `apiKey` replaces the default `LITELLM_HOST_API_KEY`
 * @returns The assistant message content string from the first choice
 * @throws Error with HTTP status + body excerpt on non-2xx responses
 */
export async function callHostLiteLLM(
  model: string,
  messages: Array<{ role: string; content: string }>,
  opts?: { apiKey?: string },
): Promise<string> {
  const apiKey = opts?.apiKey ?? _defaultApiKey;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${HOST_LITELLM_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages }),
  });

  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`LiteLLM host request failed (${res.status}): ${snippet}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { role: string; content: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LiteLLM host response missing choices[0].message.content');
  }
  return content;
}

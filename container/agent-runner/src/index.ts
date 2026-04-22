/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  trawl?: TrawlConfig;
}

type TrawlMode = 'wildcard' | 'category' | 'explicit';

interface TrawlConfig {
  enabled: boolean;
  mode?: TrawlMode;
  excludedTools?: string[];
  allowedTools?: string[];
  allowedCategories?: string[];
  url?: string;
}

interface TrawlToolInfo {
  name: string;
  category?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

/**
 * Locate the context-mode npm package root by walking Node's module search
 * paths. Can't use require.resolve('context-mode/package.json') directly —
 * Node 22 enforces the package's `exports` field strictly and context-mode
 * doesn't expose `./package.json` as a subpath. So we walk the same paths
 * Node would search and pick the first directory containing a package.json.
 *
 * Returns null on failure (package not installed, etc.) — callers should
 * degrade gracefully. Cached after first call.
 */
let _ctxModeRootCache: string | null | undefined = undefined;
function resolveCtxModeRoot(): string | null {
  if (_ctxModeRootCache !== undefined) return _ctxModeRootCache;
  try {
    const req = createRequire(import.meta.url);
    const searchPaths = req.resolve.paths('context-mode') ?? [];
    for (const searchDir of searchPaths) {
      const candidate = path.join(searchDir, 'context-mode');
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        _ctxModeRootCache = candidate;
        return _ctxModeRootCache;
      }
    }
    log(`context-mode: not found in any module search path (${searchPaths.join(', ')})`);
    _ctxModeRootCache = null;
  } catch (err) {
    log(`context-mode: resolve error — ${err instanceof Error ? err.message : String(err)}`);
    _ctxModeRootCache = null;
  }
  return _ctxModeRootCache;
}

/**
 * Spawn a context-mode hook script and pipe hook input/output over stdio.
 * Path is resolved at runtime via resolveCtxModeRoot() — no hardcoded location.
 */
function createContextModeHook(scriptName: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const root = resolveCtxModeRoot();
    if (!root) return {};

    const hookScript = path.join(root, 'hooks', `${scriptName}.mjs`);
    if (!fs.existsSync(hookScript)) {
      log(`context-mode hook: script not found: ${hookScript}`);
      return {};
    }

    return new Promise<Record<string, unknown>>((resolve) => {
      const child = spawn('node', [hookScript], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });

      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        log(`context-mode hook: ${scriptName} timed out — continuing`);
        resolve({});
      }, 60_000);

      child.on('close', () => {
        clearTimeout(timer);
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : {});
        } catch {
          log(`context-mode hook: ${scriptName} returned non-JSON stdout — ignoring`);
          resolve({});
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        log(`context-mode hook: ${scriptName} spawn error — ${err.message}`);
        resolve({});
      });

      try {
        child.stdin.write(JSON.stringify(input));
      } catch { /* ignore write errors */ }
      child.stdin.end();
    });
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// --- Trawl MCP helpers -----------------------------------------------------
// Trawl downtime must never brick the container: on any lookup failure we
// skip Trawl registration and continue with native tools.

const TRAWL_DEFAULT_URL = 'https://trawl.crested-gecko.ts.net/mcp';
const TRAWL_TOOLS_LIST_TIMEOUT_MS = 10_000;
const TRAWL_TOOL_PREFIX = 'mcp__trawl__';

/** Match `zoho_*`, `save_*`, exact names. Only trailing `*` is supported. */
function patternMatches(pattern: string, name: string): boolean {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

function anyPatternMatches(patterns: readonly string[], name: string): boolean {
  return patterns.some(p => patternMatches(p, name));
}

function prefixed(name: string): string {
  return TRAWL_TOOL_PREFIX + name;
}

/**
/**
 * Fetch Trawl's tool list. MCP Streamable HTTP requires a full handshake
 * before tools/list is accepted — initialize (to obtain a session id),
 * then notifications/initialized, then tools/list with the session header.
 * A bare tools/list POST returns HTTP 400 "Missing session ID".
 */
async function fetchTrawlTools(url: string): Promise<TrawlToolInfo[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRAWL_TOOLS_LIST_TIMEOUT_MS);

  const commonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  const parseBody = (text: string): unknown | null => {
    // Streamable HTTP may return plain JSON or a single SSE `data:` frame.
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      try { return JSON.parse(trimmed); } catch { return null; }
    }
    const dataLine = trimmed.split('\n').find(l => l.startsWith('data:'));
    if (!dataLine) return null;
    try { return JSON.parse(dataLine.slice('data:'.length).trim()); } catch { return null; }
  };

  try {
    // Step 1: initialize handshake. FastMCP returns the session id in the
    // `mcp-session-id` response header.
    const initRes = await fetch(url, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'nanoclaw-agent-runner', version: '1' },
        },
      }),
      signal: controller.signal,
    });
    if (!initRes.ok) {
      log(`Trawl initialize HTTP ${initRes.status}`);
      return null;
    }
    const sessionId = initRes.headers.get('mcp-session-id');
    if (!sessionId) {
      log('Trawl initialize: no mcp-session-id header');
      return null;
    }
    // Drain the init body so the connection can be reused.
    await initRes.text();

    const sessionHeaders = { ...commonHeaders, 'mcp-session-id': sessionId };

    // Step 2: notifications/initialized (no response body expected).
    await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: controller.signal,
    });

    // Step 3: tools/list with session.
    const listRes = await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: controller.signal,
    });
    if (!listRes.ok) {
      log(`Trawl tools/list HTTP ${listRes.status}`);
      return null;
    }
    const payload = parseBody(await listRes.text());
    if (!payload) {
      log('Trawl tools/list: unparseable response');
      return null;
    }
    const toolsRaw = (payload as { result?: { tools?: unknown } } | undefined)?.result?.tools;
    if (!Array.isArray(toolsRaw)) {
      log('Trawl tools/list: no tools array in response');
      return null;
    }
    const tools: TrawlToolInfo[] = [];
    for (const t of toolsRaw) {
      if (!t || typeof (t as { name?: unknown }).name !== 'string') continue;
      const rec = t as { name: string; _meta?: { category?: string }; annotations?: { category?: string } };
      // Trawl should expose `_tool_category` via MCP metadata — support a few
      // common shapes (annotations.category, _meta.category) so we aren't
      // brittle to the exact FastMCP wrapping.
      const category = rec._meta?.category || rec.annotations?.category;
      tools.push({ name: rec.name, category });
    }
    return tools;
  } catch (err) {
    log(`Trawl tools/list failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTrawlAllowedTools(cfg: TrawlConfig): Promise<string[]> {
  const mode: TrawlMode = cfg.mode ?? 'wildcard';

  if (mode === 'explicit') {
    return (cfg.allowedTools ?? []).map(prefixed);
  }

  const tools = await fetchTrawlTools(cfg.url ?? TRAWL_DEFAULT_URL);
  if (!tools) {
    log(`Trawl ${mode}: tools/list unavailable, skipping registration`);
    return [];
  }

  let keep: (t: TrawlToolInfo) => boolean;
  let detail: string;
  if (mode === 'wildcard') {
    const excluded = cfg.excludedTools ?? [];
    keep = t => !anyPatternMatches(excluded, t.name);
    detail = `excluded: ${excluded.join(', ') || 'none'}`;
  } else if (mode === 'category') {
    const cats = cfg.allowedCategories ?? [];
    // Require an explicit non-empty category on each tool — otherwise an
    // untagged tool would match every allowlist.
    keep = t => typeof t.category === 'string' && cats.includes(t.category);
    detail = `categories: ${cats.join(', ') || 'none'}`;
  } else {
    log(`Trawl: unknown mode "${mode}", skipping`);
    return [];
  }

  const kept = tools.filter(keep);
  log(`Trawl ${mode}: ${kept.length}/${tools.length} tools allowed (${detail})`);
  return kept.map(t => prefixed(t.name));
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // a-mem MCP is enabled when the per-group ChromaDB mount exists at
  // /workspace/extra/a-mem/. Groups opt in by adding the mount to
  // container_config; groups without it get no a-mem tools.
  const hasAmem = fs.existsSync('/workspace/extra/a-mem');
  log(`a-mem MCP: ${hasAmem ? 'enabled' : 'disabled'}`);
  const hasContextMode = fs.existsSync('/workspace/extra/context-mode');
  log(`context-mode: ${hasContextMode ? 'enabled' : 'disabled'}`);
  // Inbox MCP is enabled only for Madison Inbox (telegram_inbox). The
  // mailroom stack publishes its MCP server on the host at
  // 127.0.0.1:18080 (loopback-only; host 8080 is taken by registry-ui),
  // reachable from this container on the default Docker bridge via
  // host.docker.internal.
  const hasInbox = containerInput.groupFolder === 'telegram_inbox';
  log(`inbox MCP: ${hasInbox ? 'enabled' : 'disabled'}`);

  const mcpServers: Record<string, any> = {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    },
  };
  if (hasContextMode) {
    const ctxRoot = resolveCtxModeRoot();
    if (ctxRoot) {
      mcpServers['context-mode'] = {
        type: 'stdio',
        command: 'node',
        args: [path.join(ctxRoot, 'start.mjs')],
      };
    } else {
      log('context-mode: sentinel present but package not resolvable — skipping MCP registration');
    }
  }
  if (hasAmem) {
    mcpServers['a-mem'] = {
      command: 'a-mem-mcp',
      env: {
        LLM_BACKEND: 'ollama',
        LLM_MODEL: 'qwen3.5:9b',
        OLLAMA_HOST: 'http://host.docker.internal:11434',
        OLLAMA_API_BASE: 'http://host.docker.internal:11434',
        EMBEDDING_MODEL: 'all-MiniLM-L6-v2',
        CHROMA_DB_PATH: '/workspace/extra/a-mem/chroma',
        HF_HOME: '/opt/a-mem/hf-cache',
      },
    };
  }
  if (hasInbox) {
    mcpServers['inbox'] = {
      type: 'http',
      url: 'http://host.docker.internal:18080/mcp',
    };
  }

  const trawlCfg = containerInput.trawl;
  const hasTrawl = trawlCfg?.enabled === true;
  log(`Trawl MCP: ${hasTrawl ? `enabled (mode=${trawlCfg?.mode ?? 'wildcard'})` : 'disabled'}`);
  let trawlAllowed: string[] = [];
  if (hasTrawl && trawlCfg) {
    // Register atomically: resolve the allowlist first, then only attach
    // the MCP server if we have tools to expose. A registered server with
    // zero allowed tools still gets connection-handshaked per turn — pure
    // latency cost for no benefit.
    trawlAllowed = await resolveTrawlAllowedTools(trawlCfg);
    if (trawlAllowed.length > 0) {
      mcpServers.trawl = {
        type: 'http',
        url: trawlCfg.url ?? TRAWL_DEFAULT_URL,
      };
    } else {
      log('Trawl MCP: allowlist empty, skipping server registration');
    }
  }

  const allowedTools = [
    'Bash',
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage',
    'TodoWrite', 'ToolSearch', 'Skill',
    'NotebookEdit',
    'mcp__nanoclaw__*',
    ...(hasAmem ? ['mcp__a-mem__*'] : []),
    ...(hasContextMode ? ['mcp__context-mode__*'] : []),
    ...(hasInbox ? ['mcp__inbox__*'] : []),
    ...trawlAllowed,
  ];

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools,
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers,
      hooks: {
        PreToolUse: hasContextMode
          ? [
              'Bash', 'Read', 'Grep', 'WebFetch', 'Agent',
              'mcp__context-mode__ctx_execute',
              'mcp__context-mode__ctx_execute_file',
              'mcp__context-mode__ctx_batch_execute',
            ].map((m) => ({ matcher: m, hooks: [createContextModeHook('pretooluse')] }))
          : [],
        PostToolUse: hasContextMode
          ? [
              'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
              'TodoWrite', 'TaskCreate', 'TaskUpdate',
              'EnterPlanMode', 'ExitPlanMode', 'Skill', 'Agent',
              'AskUserQuestion', 'EnterWorktree', 'mcp__',
            ].map((m) => ({ matcher: m, hooks: [createContextModeHook('posttooluse')] }))
          : [],
        PreCompact: [{
          hooks: hasContextMode
            ? [createPreCompactHook(containerInput.assistantName), createContextModeHook('precompact')]
            : [createPreCompactHook(containerInput.assistantName)],
        }],
        SessionStart: hasContextMode
          ? [{ hooks: [createContextModeHook('sessionstart')] }]
          : [],
        UserPromptSubmit: hasContextMode
          ? [{ hooks: [createContextModeHook('userpromptsubmit')] }]
          : [],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (stderr) {
        log(`Script stderr: ${stderr.slice(0, 500)}`);
      }

      if (error) {
        log(`Script error: ${error.message}`);
        return resolve(null);
      }

      // Parse last non-empty line of stdout as JSON
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log('Script produced no output');
        return resolve(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          return resolve(null);
        }
        resolve(result as ScriptResult);
      } catch {
        log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();

/**
 * MCP tool-list discovery for session toolset-hash invalidation.
 *
 * Computes a SHA-256 hash of the sorted set of MCP server names that would be
 * active for a given group spawn. When the set of active servers changes (a
 * server added, removed, or Trawl config updated), the hash changes, triggering
 * session invalidation so Madison starts fresh with accurate tool knowledge.
 *
 * Hashing policy:
 * - For most servers (nanoclaw, a-mem, context-mode, inbox), name-only suffices
 *   because their tool surface is configuration-stable: they always expose the
 *   same set of tools when enabled.
 * - For Trawl, the configuration determines which tools are actually exposed
 *   (allowlist mode + allowedTools/allowedCategories/excludedTools + URL).
 *   These fields are included in the hash input so any material change triggers
 *   session invalidation. Fields that don't affect the tool list (e.g., bind
 *   addresses, log levels) are intentionally excluded.
 * - When per-server `serverVersions` are passed in (populated by
 *   probeMcpVersions(), which calls each MCP's `initialize` and reads
 *   serverInfo.version), they're folded into the hash. Trawl and inbox-mcp
 *   inject a per-process boot UUID into that field, so a container restart
 *   OR a uvicorn --reload swap bumps the hash → Madison's session auto-rotates
 *   on her next message instead of holding a dead MCP-Session-Id.
 */

import { createHash } from 'crypto';

// Server-name keys used both as set members in `serverNames` and as map keys
// in `serverVersions`. Centralized here so a typo in one place doesn't
// silently sever the version-folding wiring.
const SERVER_TRAWL = 'trawl';
const SERVER_MESSAGES = 'messages';
const SERVER_TASKS = 'tasks';

// Inbox-mcp publishes on the docker_gwbridge IP per ~/containers/mailroom/
// docker-compose.yml. Agent containers reach it via host.docker.internal,
// which resolves to this same IP from inside containers — but the
// orchestrator runs on the host, so we hit the bridge IP directly.
const INBOX_MCP_PROBE_URL = 'http://172.31.0.1:18080/mcp';

// Tasks-mcp publishes on the docker0 gateway via the same pattern — see
// ~/containers/tasks/docker-compose.yml `mcp.ports`. Keep the two constants
// in sync if the host port ever changes.
const TASKS_MCP_PROBE_URL = 'http://172.31.0.1:18088/mcp';

// Which groups get mcp__tasks__* registered. Tasks-mcp writes to Jeff's
// Obsidian Tasks vault, so it should only be enabled where a Madison
// instance has a legitimate reason to manage tasks — currently the inbox
// (where she triages email-derived todos) and main (where Jeff talks to
// her directly). Keep this in sync with the same gate in
// container/agent-runner/src/index.ts.
const TASKS_ELIGIBLE_GROUPS = new Set(['telegram_inbox', 'telegram_main']);

// Mirror of TRAWL_DEFAULT_URL in container/agent-runner/src/index.ts. Trawl
// configs in registered_groups frequently leave trawl.url unset (the agent-
// runner applies the fallback at spawn time); without this fallback here, the
// orchestrator probe would skip trawl entirely and the hash would never bump
// on trawl restart. Keep these two constants in sync — they describe the same
// fact (where Trawl lives on this network).
const TRAWL_DEFAULT_PROBE_URL = 'https://trawl.crested-gecko.ts.net/mcp';

// 30s probe cache. Madison spawns are infrequent enough that a fresh probe
// per spawn would be fine, but the cache makes burst spawns free and keeps
// load off the MCP servers during message storms.
const VERSION_CACHE_TTL_MS = 30_000;

interface VersionCacheEntry {
  version: string;
  at: number;
}

const versionCache = new Map<string, VersionCacheEntry>();
const lastGoodVersionsByGroup = new Map<string, Record<string, string>>();

export interface McpServerSet {
  /** Sorted list of MCP server names that would be active for this group. */
  serverNames: string[];
  /** SHA-256 hex of the canonical hash input (server names + Trawl config). */
  hash: string;
}

/**
 * Trawl configuration fields that materially affect the tool surface.
 * Mirrors the three-mode allowlist engine in agent-runner.
 */
export interface TrawlConfig {
  enabled?: boolean;
  url?: string;
  mode?: string;
  allowedTools?: string[];
  allowedCategories?: string[];
  excludedTools?: string[];
}

/**
 * Options describing a group's container configuration, used to determine
 * which MCP servers would be active on the next spawn.
 */
export interface GroupMcpOptions {
  /** Group folder name (e.g. 'telegram_inbox'). */
  groupFolder: string;
  /** Whether the group has an a-mem mount configured. */
  hasAmem: boolean;
  /** Whether the group has a context-mode mount configured. */
  hasContextMode: boolean;
  /** Trawl config for the group (undefined = Trawl not configured). */
  trawl?: TrawlConfig;
  /**
   * Per-server boot versions reported by `initialize` (keys: 'trawl',
   * 'messages', 'tasks'). Populated by probeMcpVersions(). When present
   * and the key matches an active server, the version is folded into the
   * hash so an MCP process restart bumps the hash. Absent → no version
   * contribution (back-compat: pre-probe call sites and unit tests get the
   * legacy hash).
   */
  serverVersions?: Record<string, string>;
}

/**
 * Compute the MCP server set and its hash for a group.
 *
 * The set mirrors the logic in container/agent-runner/src/index.ts that decides
 * which MCP servers to register per spawn:
 *   - nanoclaw  — always present
 *   - context-mode — when hasContextMode
 *   - a-mem     — when hasAmem
 *   - messages  — when groupFolder === 'telegram_inbox'
 *   - tasks     — when groupFolder is in TASKS_ELIGIBLE_GROUPS
 *   - trawl     — when trawl.enabled === true
 *
 * For Trawl, the hash also covers mode + allowlist fields + URL so that
 * config-only changes (without toggling enabled) still invalidate stale sessions.
 */
export function computeGroupMcpHash(options: GroupMcpOptions): McpServerSet {
  const names: string[] = ['nanoclaw'];

  if (options.hasContextMode) names.push('context-mode');
  if (options.hasAmem) names.push('a-mem');
  if (options.groupFolder === 'telegram_inbox') names.push(SERVER_MESSAGES);
  if (TASKS_ELIGIBLE_GROUPS.has(options.groupFolder)) names.push(SERVER_TASKS);
  if (options.trawl?.enabled === true) names.push(SERVER_TRAWL);

  const sorted = [...names].sort();

  // Build a deterministic hash input: server names + Trawl config fields that
  // affect the tool surface. Use stable JSON (sorted keys via explicit object).
  const trawlHashPart =
    options.trawl?.enabled === true
      ? JSON.stringify({
          url: options.trawl.url ?? null,
          mode: options.trawl.mode ?? null,
          allowedTools: (options.trawl.allowedTools ?? []).slice().sort(),
          allowedCategories: (options.trawl.allowedCategories ?? [])
            .slice()
            .sort(),
          excludedTools: (options.trawl.excludedTools ?? []).slice().sort(),
        })
      : '';

  // Fold per-server boot versions into the hash. Only count keys whose server
  // is actually in the active set — a stale `messages` version on a non-inbox
  // group would otherwise leak into the hash and cause spurious mismatches.
  const versions = options.serverVersions;
  let versionPart = '';
  if (versions) {
    const activeKeys = Object.keys(versions)
      .filter((k) => sorted.includes(k))
      .sort();
    if (activeKeys.length > 0) {
      versionPart = activeKeys.map((k) => `${k}=${versions[k]}`).join('\n');
    }
  }

  const hashInput =
    sorted.join('\n') +
    (trawlHashPart ? '\n' + trawlHashPart : '') +
    (versionPart ? '\n' + versionPart : '');
  const hash = createHash('sha256').update(hashInput).digest('hex');

  return { serverNames: sorted, hash };
}

/**
 * Default fetcher: open a Streamable HTTP MCP `initialize` call against `url`,
 * parse the SSE response, return `serverInfo.version`. Returns null on any
 * failure (network, non-200, parse error, missing field). Callers fold null
 * results back into "reuse last-good" via probeMcpVersions().
 */
async function defaultMcpVersionFetcher(url: string): Promise<string | null> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'nanoclaw-orchestrator-probe', version: '0' },
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
      signal: controller.signal,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- fetch can throw diverse network/abort errors; return null on any failure
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;
  let text: string;
  try {
    text = await res.text();
    // eslint-disable-next-line no-catch-all/no-catch-all -- res.text() can throw diverse stream errors; return null on any failure
  } catch {
    return null;
  }
  // SSE: scan for the first 'data: <json>' line that parses to an init result.
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const json = line.slice(5).trim();
    try {
      const parsed = JSON.parse(json);
      const v = parsed?.result?.serverInfo?.version;
      if (typeof v === 'string') return v;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // try next line
    }
  }
  return null;
}

/**
 * Probe each enabled MCP server for its current `initialize.serverInfo.version`.
 * Returns a `{ serverName: version }` map ready to be passed as
 * `GroupMcpOptions.serverVersions` to `computeGroupMcpHash`.
 *
 * - Trawl: probes `opts.trawl.url` when trawl.enabled === true.
 * - Inbox-mcp ('messages'): probes the docker-bridge URL when groupFolder is
 *   'telegram_inbox'.
 * - Tasks-mcp ('tasks'): probes the docker-bridge URL when groupFolder is in
 *   TASKS_ELIGIBLE_GROUPS.
 * - Stdio MCPs (e.g. agentmail): not probed — they spawn fresh per Madison
 *   invocation, so transport-session and tool-list staleness can't accumulate.
 *
 * Result caching: 30s per URL. On probe failure, falls back to the last-good
 * version recorded for this group + server, so a transient probe failure
 * (e.g. trawl mid-restart) does NOT churn Madison's session.
 *
 * `fetcher` is injectable for tests; defaults to a real HTTP `initialize` call.
 */
export async function probeMcpVersions(
  opts: GroupMcpOptions,
  fetcher: (url: string) => Promise<string | null> = defaultMcpVersionFetcher,
): Promise<Record<string, string>> {
  const targets: Record<string, string> = {};
  if (opts.trawl?.enabled === true) {
    // Match agent-runner's url ?? TRAWL_DEFAULT_URL fallback so groups that
    // omit trawl.url (the common case) still get probed.
    targets[SERVER_TRAWL] =
      typeof opts.trawl.url === 'string' && opts.trawl.url.length > 0
        ? opts.trawl.url
        : TRAWL_DEFAULT_PROBE_URL;
  }
  if (opts.groupFolder === 'telegram_inbox') {
    targets[SERVER_MESSAGES] = INBOX_MCP_PROBE_URL;
  }
  if (TASKS_ELIGIBLE_GROUPS.has(opts.groupFolder)) {
    targets[SERVER_TASKS] = TASKS_MCP_PROBE_URL;
  }

  // Probe all targets concurrently — each is a 5s-bounded HTTP roundtrip and
  // they're independent. Sequential awaits would compound the timeouts and
  // add up to (N × 5s) to spawn latency on a probe-storm.
  const resolved = await Promise.all(
    Object.entries(targets).map(async ([name, url]) => {
      const cached = versionCache.get(url);
      if (cached && Date.now() - cached.at < VERSION_CACHE_TTL_MS) {
        return [name, cached.version] as const;
      }
      const v = await fetcher(url);
      if (v !== null) {
        versionCache.set(url, { version: v, at: Date.now() });
        return [name, v] as const;
      }
      const lg = lastGoodVersionsByGroup.get(opts.groupFolder)?.[name];
      // Missing → omit. computeGroupMcpHash treats absent keys as no version
      // contribution, falling back to name-only — matching legacy behaviour
      // and avoiding false-positive session churn.
      return lg !== undefined ? ([name, lg] as const) : null;
    }),
  );

  const out: Record<string, string> = {};
  for (const entry of resolved) {
    if (entry) out[entry[0]] = entry[1];
  }

  if (Object.keys(out).length > 0) {
    lastGoodVersionsByGroup.set(opts.groupFolder, {
      ...(lastGoodVersionsByGroup.get(opts.groupFolder) ?? {}),
      ...out,
    });
  }
  return out;
}

/** Test helper — drop probe cache + last-good map between cases. */
export function _resetVersionProbeStateForTest(): void {
  versionCache.clear();
  lastGoodVersionsByGroup.clear();
}

/**
 * Derive GroupMcpOptions from a RegisteredGroup's containerConfig.
 *
 * a-mem and context-mode are detected from `additionalMounts` — they are
 * enabled when a mount with containerPath containing '/extra/a-mem' or
 * '/extra/context-mode' is present (matching container-runner/mount-security).
 * Trawl config is read from the `trawl` key directly.
 */
export function groupMcpOptionsFromConfig(
  groupFolder: string,
  containerConfig?: Record<string, unknown>,
): GroupMcpOptions {
  const cfg = containerConfig ?? {};
  const mounts =
    (cfg['additionalMounts'] as
      | Array<{ containerPath?: string }>
      | undefined) ?? [];
  const hasAmem = mounts.some(
    (m) =>
      typeof m.containerPath === 'string' && m.containerPath.includes('a-mem'),
  );
  const hasContextMode = mounts.some(
    (m) =>
      typeof m.containerPath === 'string' &&
      m.containerPath.includes('context-mode'),
  );
  return {
    groupFolder,
    hasAmem,
    hasContextMode,
    trawl: cfg['trawl'] as TrawlConfig | undefined,
  };
}

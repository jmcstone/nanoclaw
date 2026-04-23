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
 */

import { createHash } from 'crypto';

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
}

/**
 * Compute the MCP server set and its hash for a group.
 *
 * The set mirrors the logic in container/agent-runner/src/index.ts that decides
 * which MCP servers to register per spawn:
 *   - nanoclaw  — always present
 *   - context-mode — when hasContextMode
 *   - a-mem     — when hasAmem
 *   - inbox     — when groupFolder === 'telegram_inbox'
 *   - trawl     — when trawl.enabled === true
 *
 * For Trawl, the hash also covers mode + allowlist fields + URL so that
 * config-only changes (without toggling enabled) still invalidate stale sessions.
 */
export function computeGroupMcpHash(options: GroupMcpOptions): McpServerSet {
  const names: string[] = ['nanoclaw'];

  if (options.hasContextMode) names.push('context-mode');
  if (options.hasAmem) names.push('a-mem');
  if (options.groupFolder === 'telegram_inbox') names.push('inbox');
  if (options.trawl?.enabled === true) names.push('trawl');

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

  const hashInput = sorted.join('\n') + (trawlHashPart ? '\n' + trawlHashPart : '');
  const hash = createHash('sha256').update(hashInput).digest('hex');

  return { serverNames: sorted, hash };
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

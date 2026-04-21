/**
 * Per-group Trawl default config.
 *
 * Used by scripts/group-config.ts `trawl-defaults <folder>`. Apply is
 * idempotent: running it twice with the same folder yields the same
 * container_config JSON. Existing non-trawl keys are preserved untouched.
 *
 * Source of truth for the per-group defaults:
 *   lode/plans/active/2026-04-trawl-mcp-integration/tracker.md
 *   section "Allowlist design → Per-group defaults"
 *
 * Three exclusion categories layer into the per-group lists:
 *
 * 1. BASE_EXCLUSIONS — applies to every Madison instance. These tools
 *    duplicate Madison's native capabilities (Write/Read, a-mem) or expose
 *    Trawl-internal plumbing (stash, delegate_task). Excluding keeps
 *    Madison's tool surface clean and avoids confusion between Trawl's
 *    isolated filesystem / memory and Madison's own workspace.
 *
 * 2. `zoho_*` — mutation blast radius. Added to every group except AVP
 *    (AVP's whole purpose is CRM ingestion) and Jeff main (admin).
 *
 * 3. Social scraping (`search_facebook`) — niche, rarely needed. Excluded
 *    by default; individual groups can opt in by dropping it from the list.
 *
 * | Group                      | Mode      | Exclusions                 |
 * |----------------------------|-----------|----------------------------|
 * | telegram_avp               | wildcard  | BASE + search_facebook     |
 * | main / telegram_main       | wildcard  | (none — admin)             |
 * | telegram_trading           | wildcard  | BASE + zoho_* + fb         |
 * | telegram_inbox             | wildcard  | BASE + zoho_* + fb         |
 * | * (fallback)               | wildcard  | BASE + zoho_* + fb         |
 */

export interface TrawlDefault {
  enabled: boolean;
  mode: 'wildcard' | 'category' | 'explicit';
  excludedTools?: string[];
  allowedTools?: string[];
  allowedCategories?: string[];
}

type JsonObj = { [k: string]: unknown };

/**
 * Excluded from every Madison instance:
 *
 *  - save_*, write_output, read_file — duplicate Madison's native Write/Read
 *    and land in Trawl's /app/output/ which Madison can't see.
 *  - memory — duplicates a-mem (MCP client's own per-group semantic memory).
 *  - stash — per-invocation scratch inside Trawl's agent loop; meaningless
 *    outside it.
 *  - delegate_task — low-level primitive for Trawl's LLM to fan out
 *    sub-agents. External clients should use the `trawl_delegate` meta-tool
 *    which wraps the full agent loop with explicit model override.
 *
 * NOT excluded (left available):
 *
 *  - query_data, list_data, get_page_data — these are the client-facing
 *    return channel for Trawl's handle-based data store. Large Trawl
 *    results return a compact summary + handle_id; the client then uses
 *    query_data / get_page_data to drill into specific categories without
 *    re-fetching. Excluding them defeats the whole point of handles.
 */
const BASE_EXCLUSIONS: string[] = [
  'save_*',
  'write_output',
  'read_file',
  'memory',
  'stash',
  'delegate_task',
];

/** Social-media scraping. Niche, excluded by default; opt-in per group. */
const SOCIAL_EXCLUSIONS: string[] = ['search_facebook'];

const FULL_WILDCARD: TrawlDefault = {
  enabled: true,
  mode: 'wildcard',
};

const AVP_WILDCARD: TrawlDefault = {
  enabled: true,
  mode: 'wildcard',
  // AVP keeps zoho_* (its whole purpose); strip internal-plumbing and
  // duplicate-purpose tools and the social-scraper.
  excludedTools: [...BASE_EXCLUSIONS, ...SOCIAL_EXCLUSIONS],
};

const SAFE_WILDCARD: TrawlDefault = {
  enabled: true,
  mode: 'wildcard',
  // Base exclusions + Zoho blast-radius + social.
  excludedTools: [...BASE_EXCLUSIONS, 'zoho_*', ...SOCIAL_EXCLUSIONS],
};

const FOLDER_TO_DEFAULT: Record<string, TrawlDefault> = {
  telegram_avp: AVP_WILDCARD,
  // Jeff's main chat is admin-equivalent — no exclusions.
  main: FULL_WILDCARD,
  telegram_main: FULL_WILDCARD,
  telegram_trading: SAFE_WILDCARD,
  telegram_inbox: SAFE_WILDCARD,
};

export function getTrawlDefault(folder: string): TrawlDefault {
  return FOLDER_TO_DEFAULT[folder] ?? SAFE_WILDCARD;
}

/**
 * Return a new container_config object with the `trawl` key replaced by the
 * given default. Non-trawl keys are preserved. Does not mutate input.
 */
export function applyTrawlDefault(
  existing: JsonObj,
  trawlDefault: TrawlDefault,
): JsonObj {
  const next: JsonObj = { ...existing };
  next.trawl = { ...trawlDefault };
  return next;
}

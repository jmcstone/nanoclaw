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
 * Excluded from every Madison instance: these either duplicate Madison's
 * native Write/Read/a-mem tools (the save/read/memory group), are Trawl-
 * internal plumbing invisible to MCP clients (stash, query_data, list_data),
 * or are the low-level primitive superseded by the `trawl_delegate`
 * meta-tool (delegate_task).
 */
const BASE_EXCLUSIONS: string[] = [
  'save_*',
  'write_output',
  'read_file',
  'memory',
  'stash',
  'query_data',
  'list_data',
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

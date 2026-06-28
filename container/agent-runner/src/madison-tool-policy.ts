/**
 * Madison fork — extra MCP tool denylist, spread into the provider's
 * SDK_DISALLOWED_TOOLS. Isolated here (not inlined into the upstream provider)
 * so the upstream file stays mergeable.
 *
 * Trawl runs in groups that process untrusted web/email, so a prompt-injected
 * agent must NOT reach Trawl's external write/act tools:
 *   - trawl_delegate     — runs Trawl's full agent loop with access to EVERY
 *                          tool → would bypass this very denylist
 *   - trawl_pipeline_run — runs arbitrary pre-defined multi-step pipelines
 *   - submit_form        — submits HTML forms externally
 *   - zoho_{insert,update,upsert,setup}_records/module — Zoho CRM writes
 * Reads / search / research and local DataStore writes stay allowed. Disallow
 * wins over the `mcp__trawl__*` allow glob, and the provider's preToolUse hook
 * checks the same list for defense-in-depth.
 */
export const MADISON_DISALLOWED_TOOLS = [
  'mcp__trawl__trawl_delegate',
  'mcp__trawl__trawl_pipeline_run',
  'mcp__trawl__submit_form',
  'mcp__trawl__zoho_insert_records',
  'mcp__trawl__zoho_update_records',
  'mcp__trawl__zoho_upsert_records',
  'mcp__trawl__zoho_setup_module',
];

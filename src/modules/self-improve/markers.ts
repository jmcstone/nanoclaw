/**
 * Self-improve marker constants — format tokens written into skill/memory files
 * that the host process and container composition logic read back.
 *
 * Single source of truth: the writer (approvals.ts) and the reader
 * (claude-md-compose.ts) both import from here so format divergence is caught
 * at compile time rather than at runtime.
 */

/** First line of every trial skill's instructions.md — signals provisional status. */
export const TRIAL_MARKER = '<!-- trial: true -->';

/**
 * Returns true iff the given skill fragment content begins with the trial marker.
 * Used by claude-md-compose.ts to select inline (with warning) vs symlink rendering.
 */
export function isTrialSkillFragment(content: string): boolean {
  return content.startsWith(TRIAL_MARKER);
}

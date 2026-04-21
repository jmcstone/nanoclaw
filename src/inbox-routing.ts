import { RegisteredGroup } from './types.js';

export const EMAIL_TARGET_FOLDER = 'telegram_inbox';

/**
 * Pick the group that inbound inbox events should be delivered to.
 *
 * Prefers a group whose folder is `telegram_inbox` (the dedicated inbox-triage
 * group), and falls back to the first group flagged `isMain`. Returns the JID
 * of the chosen group, or null if no candidate exists.
 */
export function findEmailTargetJid(
  groups: Record<string, RegisteredGroup>,
): string | null {
  const entries = Object.entries(groups);

  const inbox = entries.find(([, g]) => g.folder === EMAIL_TARGET_FOLDER);
  if (inbox) return inbox[0];

  const main = entries.find(([, g]) => g.isMain === true);
  if (main) return main[0];

  return null;
}

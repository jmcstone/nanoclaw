import { RegisteredGroup } from './types.js';

export const EMAIL_TARGET_FOLDER = 'telegram_inbox';

export interface EmailTarget {
  jid: string;
  /**
   * True only when the chosen group's folder is `EMAIL_TARGET_FOLDER` — the
   * single condition agent-runner gates the inbox MCP on. When false, the
   * subscriber should use a degraded prompt that explains the agent can
   * describe the email but lacks tools to search, label, archive, or reply.
   */
  inboxCapable: boolean;
}

/**
 * Pick the group that inbound inbox events should be delivered to.
 *
 * Cascades, in order:
 *   1. The dedicated inbox-triage group (folder === EMAIL_TARGET_FOLDER).
 *   2. The group flagged `isMain` — Jeff sees the email even if no dedicated
 *      inbox group exists, but `inboxCapable: false` so the prompt degrades.
 *   3. Any registered group, as a last resort before dropping the event.
 */
export function findEmailTarget(
  groups: Record<string, RegisteredGroup>,
): EmailTarget | null {
  const entries = Object.entries(groups);

  const inbox = entries.find(([, g]) => g.folder === EMAIL_TARGET_FOLDER);
  if (inbox) return { jid: inbox[0], inboxCapable: true };

  const main = entries.find(([, g]) => g.isMain === true);
  if (main) return { jid: main[0], inboxCapable: false };

  const first = entries[0];
  if (first) return { jid: first[0], inboxCapable: false };

  return null;
}

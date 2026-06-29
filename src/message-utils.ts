/**
 * Shared message-content extraction utilities.
 *
 * Consumed by session-indexer.ts (FTS index write path) and the self-improve
 * distiller (transcript read path).  A single source of truth ensures both
 * callers agree on what "the text" of a session message is.
 */

/**
 * Extract indexable plain text from a session message content JSON blob.
 *
 * Both messages_in and messages_out store `content` as a JSON string.
 * The expected shape for user/email messages is `{ text: string, ... }`;
 * agent (outbound) messages may use `{ text: string }` or `{ markdown: string }`.
 * Falls back gracefully if the shape differs or JSON parse fails.
 */
export function extractText(contentStr: string): string {
  try {
    const parsed = JSON.parse(contentStr) as Record<string, unknown>;
    if (typeof parsed.text === 'string' && parsed.text) return parsed.text;
    if (typeof parsed.markdown === 'string' && parsed.markdown) return parsed.markdown;
    if (typeof parsed.content === 'string' && parsed.content) return parsed.content;
  } catch {
    // Not JSON — index the raw string as-is if it's non-empty.
    const trimmed = contentStr.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

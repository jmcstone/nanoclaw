// Vendored from src/inbox-store/types.ts — keep in sync until Phase 2 shared package.

export type InboxSource = 'gmail' | 'protonmail';

export const INBOX_SOURCES: readonly InboxSource[] = [
  'gmail',
  'protonmail',
] as const;

export interface InboxAccount {
  account_id: string; // stable local id; e.g. "gmail:jeff@americanvoxpop.com"
  source: InboxSource;
  email_address: string;
}

export interface InboxSender {
  sender_id: string; // stable hash of email_address
  email_address: string;
  display_name: string | null;
}

export interface InboxThread {
  thread_id: string; // from Gmail threadId; from Proton derived-root-message-id
  source: InboxSource;
  subject: string | null;
  last_message_at: string; // ISO 8601
  message_count: number;
}

export interface InboxMessage {
  message_id: string; // "<source>:<source_message_id>"
  source: InboxSource;
  account_id: string;
  source_message_id: string; // Gmail id, or Proton Message-ID header value
  thread_id: string;
  sender_id: string;
  subject: string | null;
  body_markdown: string; // Markdown-rendered (turndown already applied upstream)
  received_at: string; // ISO 8601
  raw_headers_json: string | null; // optional: stringified headers map for debugging
}

export interface Watermark {
  account_id: string;
  watermark_value: string; // Proton: highest UID per address; Gmail: RFC3339 timestamp of last seen
  updated_at: string;
}

// MCP tool I/O shapes
export interface SearchArgs {
  query: string;
  limit?: number;
  source?: InboxSource;
}

export interface ThreadArgs {
  thread_id: string;
}

export interface RecentArgs {
  account_id: string;
  since_watermark?: string;
  limit?: number;
}

export interface SearchResult {
  matches: InboxMessage[];
}

export interface ThreadResult {
  thread: InboxThread;
  messages: InboxMessage[];
}

export interface RecentResult {
  messages: InboxMessage[];
  new_watermark: string;
}

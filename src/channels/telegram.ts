/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile, readEnvKeysWithPrefix } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { parseTextStyles } from '../text-styles.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

// Split text on line boundaries into pieces under `max` chars. Each piece is
// rendered to HTML independently, so chunking never splits an HTML tag.
function chunkByLines(text: string, max: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > max) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

/**
 * Send agent text to Telegram as HTML (parse_mode: 'HTML'), via our channel
 * formatter (text-styles.ts). HTML is more truncation-tolerant than the
 * adapter's MarkdownV2 path and supports GFM tables (rendered as <pre> grids).
 * Renders each line-bounded chunk independently (no mid-tag splits); on an HTML
 * parse error from Telegram, retries that chunk as plain text.
 */
async function sendTelegramHtml(token: string, platformId: string, text: string): Promise<string | undefined> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return undefined;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let lastId: string | undefined;
  for (const chunk of chunkByLines(text, 3500)) {
    const html = parseTextStyles(chunk, 'telegram');
    const post = (body: Record<string, unknown>) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, ...body }),
      });
    let res = await post({ text: html, parse_mode: 'HTML' });
    let json = (await res.json()) as { ok?: boolean; result?: { message_id?: number } };
    if (!json.ok) {
      // HTML rejected (rare malformed entity) — send the original chunk plain.
      log.warn('Telegram HTML send failed, retrying plain', { platformId });
      res = await post({ text: chunk });
      json = (await res.json()) as { ok?: boolean; result?: { message_id?: number } };
    }
    if (json.result?.message_id != null) lastId = String(json.result.message_id);
  }
  return lastId;
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

function buildTelegramAdapter(token: string, instance?: string): ChannelAdapter {
  const telegramAdapter = createTelegramAdapter({
    botToken: token,
    mode: 'polling',
  });
  const bridge = createChatSdkBridge({
    adapter: telegramAdapter,
    concurrency: 'concurrent',
    extractReplyContext,
    supportsThreads: false,
    transformOutboundText: sanitizeTelegramLegacyMarkdown,
    maxTextLength: 4000,
  });

  const botUsernamePromise = fetchBotUsername(token);

  const wrapped: ChannelAdapter = {
    ...bridge,
    // A named instance (a dedicated bot) routes independently of the default.
    ...(instance ? { instance } : {}),
    resolveChannelName: async (platformId: string) => {
      const chatId = platformId.split(':').slice(1).join(':');
      if (!chatId) return null;
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId }),
        });
        const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
        return data.ok ? (data.result?.title ?? null) : null;
      } catch {
        return null;
      }
    },
    async deliver(platformId, threadId, message) {
      const content = (message.content ?? {}) as Record<string, unknown>;
      const hasFiles = Array.isArray(message.files) && message.files.length > 0;
      const isCard =
        message.kind === 'ask_question' || message.kind === 'send_card' || 'options' in content || 'title' in content;
      const text = (content.text as string) || (content.markdown as string) || '';
      // Plain agent text → our HTML path (GFM tables + truncation-tolerant,
      // avoids the adapter's fragile MarkdownV2). Cards, file attachments, and
      // empty/structured payloads fall through to the Chat SDK bridge.
      if (!isCard && !hasFiles && text) {
        return sendTelegramHtml(token, platformId, text);
      }
      return bridge.deliver(platformId, threadId, message);
    },
    async setup(hostConfig: ChannelSetup) {
      const intercepted: ChannelSetup = {
        ...hostConfig,
        onInbound: createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token),
      };
      return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
    },
  };
  return wrapped;
}

// Default bot → the 'telegram' instance (messaging groups with instance='telegram').
registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    return buildTelegramAdapter(env.TELEGRAM_BOT_TOKEN);
  },
});

// Additional named telegram bots: TELEGRAM_BOT_TOKEN__<INSTANCE>=<token> in .env.
// Each registers as its own instance so a dedicated bot (e.g. for a shared /
// outreach group with external members) routes independently of the default bot.
// instance = <INSTANCE> lowercased; wire the messaging group to that instance.
for (const [key, token] of Object.entries(readEnvKeysWithPrefix('TELEGRAM_BOT_TOKEN__'))) {
  const instance = key.slice('TELEGRAM_BOT_TOKEN__'.length).toLowerCase();
  if (!instance || !token) continue;
  // 'telegram' is the default instance (registered above). Re-registering it
  // would silently clobber the default bot's factory in the registry Map, so
  // the main bot would stop responding with no diagnostic. Refuse it loudly.
  if (instance === 'telegram') {
    log.warn('Ignoring TELEGRAM_BOT_TOKEN__TELEGRAM — "telegram" is the reserved default instance', { key });
    continue;
  }
  registerChannelAdapter(instance, { factory: () => buildTelegramAdapter(token, instance) });
}

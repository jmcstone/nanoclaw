import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, DOWNLOADS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- Telegram API throws diverse errors (parse-mode, network, rate-limit); fall back to plain text
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

/** Download a file from Telegram's servers to a local path. */
async function downloadTelegramFile(
  botToken: string,
  filePath: string,
  destPath: string,
): Promise<void> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- Telegram API throws diverse errors (auth, network) during bot init
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 *
 * Returns true if the message was sent through the pool, false if the pool
 * is unavailable for this sender (no bots initialized, pool saturated for a
 * new identity, or the send itself failed). Callers should fall back to the
 * normal channel sender on false to avoid silently dropping replies.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<boolean> {
  if (poolApis.length === 0) {
    logger.warn('No pool bots available, cannot send pool message');
    return false;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    // Only assign a fresh slot while the pool has unused bots. Reusing a
    // slot would force setMyName() to overwrite an earlier sender's
    // identity, so once saturated we refuse and let the caller fall back.
    if (nextPoolIndex >= poolApis.length) {
      logger.warn(
        {
          sender,
          groupFolder,
          poolSize: poolApis.length,
          assigned: senderBotMap.size,
        },
        'Pool saturated — no free bot for new sender identity, falling back',
      );
      return false;
    }
    idx = nextPoolIndex;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- Telegram API throws diverse errors on setMyName; non-fatal, send anyway
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Telegram API throws diverse errors (network, rate-limit, auth) on send
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
    return false;
  }
}

/**
 * Telegram channel with **per-group bot routing**.
 *
 * Each token in `tokens` becomes a full Bot instance with the same handler
 * stack. A bot only delivers an inbound message to `onMessage` when the
 * receiving bot owns the chat (per `registered_groups.bot_username`). All
 * other inbounds are silently ignored, so multiple bots in the same chat
 * don't double-process.
 *
 * The first token (TELEGRAM_BOT_TOKEN) is the default — groups with NULL
 * `bot_username` fall back to it, preserving existing behavior.
 *
 * `/chatid` and `/ping` always respond regardless of ownership so a
 * fresh bot can be discovered and registered.
 */
export class TelegramChannel implements Channel {
  name = 'telegram';

  // botUsername (lowercased) → Bot instance
  private bots = new Map<string, Bot>();
  // botUsername (lowercased) → raw token (needed by downloadTelegramFile)
  private tokenByUsername = new Map<string, string>();
  // First-initialized bot's username — fallback for groups without bot_username
  private defaultBotUsername: string | null = null;

  private opts: TelegramChannelOpts;
  private tokens: string[];

  constructor(tokens: string[], opts: TelegramChannelOpts) {
    if (tokens.length === 0) {
      throw new Error('TelegramChannel requires at least one bot token');
    }
    this.tokens = tokens;
    this.opts = opts;
  }

  /**
   * Look up the bot username assigned to a chat, falling back to the default.
   * Returns lowercase. Returns null if no default is set (shouldn't happen
   * after connect()).
   */
  private assignedBotUsername(chatJid: string): string | null {
    const group = this.opts.registeredGroups()[chatJid];
    const explicit = group?.botUsername?.toLowerCase();
    return explicit || this.defaultBotUsername;
  }

  async connect(): Promise<void> {
    // Initialize each bot, capture its username, attach handlers
    for (const token of this.tokens) {
      try {
        const bot = new Bot(token, {
          client: {
            baseFetchConfig: { agent: https.globalAgent, compress: true },
          },
        });
        const me = await bot.api.getMe();
        if (!me.username) {
          logger.warn({ id: me.id }, 'Telegram bot has no username, skipping');
          continue;
        }
        const usernameLc = me.username.toLowerCase();
        if (this.bots.has(usernameLc)) {
          logger.warn(
            { username: me.username },
            'Duplicate Telegram bot token (same username already registered), skipping',
          );
          continue;
        }
        this.bots.set(usernameLc, bot);
        this.tokenByUsername.set(usernameLc, token);
        if (this.defaultBotUsername === null) {
          this.defaultBotUsername = usernameLc;
        }
        this.attachHandlers(bot, usernameLc, token);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Telegram API throws diverse errors (auth, network) during bot init; one bad token shouldn't sink the channel
      } catch (err) {
        logger.error({ err }, 'Failed to initialize Telegram bot');
      }
    }

    if (this.bots.size === 0) {
      throw new Error(
        'TelegramChannel: no bots successfully initialized (all tokens failed getMe)',
      );
    }

    // Start polling on every bot in parallel
    const startPromises: Promise<void>[] = [];
    for (const bot of this.bots.values()) {
      startPromises.push(
        new Promise<void>((resolve) => {
          bot.start({
            onStart: (botInfo) => {
              logger.info(
                { username: botInfo.username, id: botInfo.id },
                'Telegram bot connected',
              );
              console.log(`\n  Telegram bot: @${botInfo.username}`);
              resolve();
            },
          });
        }),
      );
    }
    await Promise.all(startPromises);
    console.log(
      `  Send /chatid to the bot in a Telegram chat to get its registration ID\n`,
    );
  }

  /**
   * Attach the full handler stack to a bot. Handlers respect chat ownership:
   * inbound messages only flow to onMessage if this bot is the assigned bot
   * for the chat (or the default, when the chat has no explicit assignment).
   */
  private attachHandlers(bot: Bot, usernameLc: string, token: string): void {
    // Command to get chat ID (always responds — needed for new-bot discovery).
    // Bot username goes inside backticks so underscores in usernames like
    // `madison_avp_outreach_bot` don't get parsed as Markdown italic markers.
    bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}\nBot: \`@${ctx.me?.username ?? '?'}\``,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status (always responds)
    bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online (via @${ctx.me?.username}).`);
    });

    // Returns true if this bot should process the message for this chat.
    // Bots that don't own a chat see every message (long-poll) but ignore it.
    const ownsChat = (chatJid: string): boolean => {
      const assigned = this.assignedBotUsername(chatJid);
      if (assigned === null) return false; // shouldn't happen post-connect
      return assigned === usernameLc;
    };

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const meUsername = ctx.me?.username?.toLowerCase();
      if (meUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${meUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Always store chat metadata for discovery (even for unowned chats)
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver if this bot owns the chat (registered + assigned, or default)
      if (!ownsChat(chatJid)) {
        logger.debug(
          { chatJid, chatName, receivingBot: usernameLc },
          'Telegram message ignored — different bot owns this chat',
        );
        return;
      }

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, bot: usernameLc },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (!ownsChat(chatJid)) return;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (!ownsChat(chatJid)) return;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const photos = ctx.message.photo;
      if (!photos || photos.length === 0) {
        storeNonText(ctx, '[Photo]');
        return;
      }
      const largest = photos[photos.length - 1];
      const fileName = `photo-${ctx.message.message_id}.jpg`;
      try {
        const file = await ctx.api.getFile(largest.file_id);
        if (!file.file_path) throw new Error('No file_path');
        const destName = `${Date.now()}-${fileName}`;
        const destPath = path.join(
          DOWNLOADS_DIR,
          group.folder,
          'telegram',
          destName,
        );
        await downloadTelegramFile(token, file.file_path, destPath);
        const containerPath = `/workspace/downloads/telegram/${destName}`;
        logger.info({ chatJid, destPath }, 'Telegram photo downloaded');
        storeNonText(ctx, `[Photo: ${containerPath}]`);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Telegram API and fs can throw diverse errors; fall back to placeholder
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to download Telegram photo');
        storeNonText(ctx, '[Photo] (download failed)');
      }
    });

    bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));

    bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (!ownsChat(chatJid)) return;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const doc = ctx.message.document;
      const fileName = doc?.file_name || 'file';
      const fileSize = doc?.file_size || 0;

      // Telegram Bot API limit: 20MB
      if (fileSize > 20 * 1024 * 1024) {
        storeNonText(
          ctx,
          `[Document: ${fileName}] (too large to download, ${Math.round(fileSize / 1024 / 1024)}MB)`,
        );
        return;
      }

      try {
        const file = await ctx.getFile();
        if (!file.file_path) throw new Error('No file_path');
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const destName = `${Date.now()}-${safeName}`;
        const destPath = path.join(
          DOWNLOADS_DIR,
          group.folder,
          'telegram',
          destName,
        );
        await downloadTelegramFile(token, file.file_path, destPath);
        const containerPath = `/workspace/downloads/telegram/${destName}`;
        logger.info(
          { chatJid, fileName, destPath },
          'Telegram document downloaded',
        );
        storeNonText(
          ctx,
          `[Document: ${fileName}] Downloaded to: ${containerPath}`,
        );
        // eslint-disable-next-line no-catch-all/no-catch-all -- Telegram API and fs can throw diverse errors; fall back to placeholder
      } catch (err) {
        logger.error(
          { chatJid, fileName, err },
          'Failed to download Telegram document',
        );
        storeNonText(ctx, `[Document: ${fileName}] (download failed)`);
      }
    });
    bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Per-bot error handler
    bot.catch((err) => {
      logger.error({ bot: usernameLc, err: err.message }, 'Telegram bot error');
    });
  }

  /**
   * Pick the right bot for an outbound message: assigned bot for the chat,
   * or the default. Returns null if no bot is available (shouldn't happen).
   */
  private botForChat(jid: string): Bot | null {
    const assigned = this.assignedBotUsername(jid);
    if (!assigned) return null;
    return this.bots.get(assigned) || null;
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    const bot = this.botForChat(jid);
    if (!bot) {
      logger.warn(
        {
          jid,
          assigned: this.assignedBotUsername(jid),
          available: Array.from(this.bots.keys()),
        },
        'No Telegram bot available for chat',
      );
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- Telegram API throws diverse errors (network, rate-limit, auth) on send
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bots.size > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    const stopPromises: Promise<void>[] = [];
    for (const bot of this.bots.values()) {
      stopPromises.push(Promise.resolve(bot.stop()));
    }
    await Promise.all(stopPromises);
    this.bots.clear();
    this.tokenByUsername.clear();
    this.defaultBotUsername = null;
    logger.info('Telegram bots stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const bot = this.botForChat(jid);
    if (!bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await bot.api.sendChatAction(numericId, 'typing');
      // eslint-disable-next-line no-catch-all/no-catch-all -- Telegram API throws diverse errors on chat action; typing is best-effort
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_POOL']);
  const mainToken =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  const poolRaw =
    process.env.TELEGRAM_BOT_POOL || envVars.TELEGRAM_BOT_POOL || '';

  // Default bot first (so the first-initialized one becomes the channel default
  // and existing groups with NULL bot_username keep talking to MadisonLumenBot).
  const tokens: string[] = [];
  if (mainToken) tokens.push(mainToken);
  for (const t of poolRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)) {
    if (!tokens.includes(t)) tokens.push(t);
  }

  if (tokens.length === 0) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(tokens, opts);
});

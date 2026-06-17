import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  resolveSessionMaxAgeHours,
  resolveSessionMaxMessages,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
} from './config.js';
import { pickAckPhrase } from './ack.js';
import { initBotPool } from './channels/telegram.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  clearSession,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getSessionInfo,
  getSessionToolHash,
  incrementSessionMessages,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setSessionToolHash,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  computeGroupMcpHash,
  groupMcpOptionsFromConfig,
  probeMcpVersions,
} from './mcp-tool-discovery.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { EMAIL_TARGET_FOLDER } from './inbox-routing.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { ChannelType } from './text-styles.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startMetricsSampler } from './metrics-sampler.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function writeAllTaskSnapshots(): void {
  const tasks = getAllTasks();
  const taskRows = tasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    script: t.script || undefined,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
  }));
  for (const group of Object.values(registeredGroups)) {
    writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
  }
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
    // eslint-disable-next-line no-catch-all/no-catch-all -- resolveGroupFolderPath throws for invalid folder paths; log and reject
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Compute the current MCP tool hash for a group by probing live MCP servers
 * and folding their boot versions into computeGroupMcpHash. Used both at
 * cold-spawn (runAgent) and on the IPC fast-path (message loop) to detect
 * MCP-version drift while a container is alive — see recycleContainer.
 */
async function getCurrentMcpToolHash(group: RegisteredGroup): Promise<string> {
  const mcpOpts = groupMcpOptionsFromConfig(
    group.folder,
    group.containerConfig as Record<string, unknown> | undefined,
  );
  const serverVersions = await probeMcpVersions(mcpOpts);
  return computeGroupMcpHash({ ...mcpOpts, serverVersions }).hash;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);

  // Fire-and-forget instant ack so the user knows we received their message.
  // Long agent runs (briefings, research) can otherwise look like silence —
  // typing indicators expire after ~5s on Telegram and don't exist on email.
  // The inbox group opts out entirely: it does email triage where Jeff finds
  // content-free acks ("On it 🎀") noisy, and its prompt already forbids them
  // (groups/telegram_inbox/CLAUDE.md "push vs pull doctrine").
  if (group.folder !== EMAIL_TARGET_FOLDER) {
    channel
      .sendMessage(chatJid, pickAckPhrase())
      .catch((err) =>
        logger.warn({ chatJid, err }, 'Failed to send input-ack message'),
      );
  }

  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    missedMessages.length,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // formatOutbound strips <internal>...</internal> and applies the
        // channel's native text-style conversion (markdown → HTML for telegram,
        // marker substitution for whatsapp/slack). Without this, raw markdown
        // ships under parse_mode: 'HTML' and renders as literal asterisks.
        const text = formatOutbound(raw, channel.name as ChannelType);
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  inboundMessageCount: number,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;

  // Session rotation: check age and message count (per-group budget).
  const sessionInfo = getSessionInfo(group.folder);
  let sessionId: string | undefined = sessions[group.folder];
  if (sessionId && sessionInfo) {
    const ageMs = sessionInfo.created_at
      ? Date.now() - new Date(sessionInfo.created_at).getTime()
      : 0;
    const ageHours = ageMs / (1000 * 60 * 60);
    const maxAgeHours = resolveSessionMaxAgeHours(group.folder);
    const maxMessages = resolveSessionMaxMessages(group.folder);
    if (ageHours > maxAgeHours || sessionInfo.message_count >= maxMessages) {
      logger.info(
        {
          group: group.folder,
          ageHours: Math.round(ageHours),
          messageCount: sessionInfo.message_count,
          maxAgeHours,
          maxMessages,
        },
        'Rotating session (age or message limit reached)',
      );
      clearSession(group.folder);
      delete sessions[group.folder];
      sessionId = undefined;
    }
  }

  // Session toolset-hash check: if the set of active MCP servers has changed
  // since this session was created, the session's tool self-image is stale.
  // Clear it so Madison starts fresh with accurate knowledge of her tools.
  const mcpOpts = groupMcpOptionsFromConfig(
    group.folder,
    group.containerConfig as Record<string, unknown> | undefined,
  );
  // Folding live MCP boot versions into the hash auto-rotates Madison's
  // session on any MCP process restart. See probeMcpVersions for caching
  // and last-good fallback behaviour.
  const serverVersions = await probeMcpVersions(mcpOpts);
  const { hash: currentToolHash } = computeGroupMcpHash({
    ...mcpOpts,
    serverVersions,
  });
  if (sessionId) {
    const storedHash = getSessionToolHash(group.folder);
    if (storedHash === null) {
      // NULL hash on an existing session means it predates hash tracking
      // (pre-migration row). Its tool self-image is unverifiable — clear it.
      logger.info(
        { group: group.folder, new: currentToolHash },
        'tool_list_hash null on existing session — clearing pre-migration session',
      );
      clearSession(group.folder);
      delete sessions[group.folder];
      sessionId = undefined;
    } else if (storedHash !== currentToolHash) {
      logger.info(
        { group: group.folder, old: storedHash, new: currentToolHash },
        'tool_list_hash mismatch — clearing session',
      );
      clearSession(group.folder);
      delete sessions[group.folder];
      sessionId = undefined;
    }
  }
  // Stamp (or update) the hash for this spawn so subsequent runs can compare.
  if (sessionId) {
    // Session is being resumed — update hash to latest value.
    setSessionToolHash(group.folder, currentToolHash);
  }
  // If sessionId is undefined at this point (new session or just cleared),
  // the hash will be stamped after the new session ID is persisted (post-spawn).

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
          setSessionToolHash(group.folder, currentToolHash);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        trawl: (group.containerConfig as { trawl?: unknown } | undefined)
          ?.trawl,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
      setSessionToolHash(group.folder, currentToolHash);
    }

    // Track message count for session rotation. Count inbound messages in
    // this batch so sessionMaxMessages reflects user activity, not container
    // invocations (a single run can drain MAX_MESSAGES_PER_PROMPT messages).
    if (sessions[group.folder] && inboundMessageCount > 0) {
      incrementSessionMessages(group.folder, inboundMessageCount);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
    // eslint-disable-next-line no-catch-all/no-catch-all -- container invocation can throw diverse errors (spawn, network, timeout)
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Before routing to a running container via IPC, check whether the
          // active MCP server set has changed since that container spawned.
          // The Claude SDK locks its MCP tool list at session init, so an
          // in-place refresh isn't possible — we have to recycle the container.
          // The probe is 5s-bounded with a 30s URL cache (mcp-tool-discovery),
          // so back-to-back messages pay ~0; once-per-30s pays ≤5s worst case.
          let mustRecycle = false;
          if (queue.isActive(chatJid)) {
            const currentToolHash = await getCurrentMcpToolHash(group);
            const storedHash = getSessionToolHash(group.folder);
            if (storedHash && storedHash !== currentToolHash) {
              logger.info(
                {
                  group: group.folder,
                  oldHash: storedHash.slice(0, 16),
                  newHash: currentToolHash.slice(0, 16),
                },
                'MCP tool hash changed since spawn — recycling running container',
              );
              mustRecycle = true;
            }
          }
          if (mustRecycle) {
            await queue.recycleContainer(chatJid);
            // Fall through to enqueueMessageCheck below: state.active is now
            // false (or about to flip via runForGroup's finally block).
            // runAgent will re-probe + rotate the session as part of cold spawn.
          }

          if (!mustRecycle && queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container (or just recycled) — enqueue a fresh one.
            // We deliberately do NOT advance lastAgentTimestamp here; the new
            // container's processGroupMessages will refetch via getMessagesSince
            // from the cursor, picking up everything in this batch.
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- message loop must not crash; diverse errors from DB/queue are all handled the same way
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers.
  //
  // SPLIT-BRAIN PREVENTION — DO NOT REMOVE WITHOUT REPLACEMENT.
  //
  // Channel `disconnect()` calls (Telegram, Gmail, etc.) can block on network
  // I/O — a hung WebSocket close or a stuck SMTP/IMAP poll will park us here
  // indefinitely. Without a hard ceiling, the orchestrator stays alive in
  // half-shutdown state for ~90s (systemd's default TimeoutStopSec), during
  // which a second instance can be started and BOTH will:
  //   - poll the same Telegram bot tokens
  //   - read/write the same SQLite session table
  //   - manage the same `sessions[group.folder]` cache with different IDs
  // The observed symptom is the agent "forgetting" prior turns: each spawn
  // resumes whichever sessionId happens to be in memory in the process that
  // grabbed the message, so the transcript splits across two SDK lineages.
  //
  // Layered timeouts (inner → outer):
  //   queue.shutdown(5000)   — drain in-flight tasks, 5s budget
  //   forceExit (8s)         — exit even if disconnect() never returns
  //   systemd TimeoutStopSec — SIGKILL backstop, set to 15s in the unit file
  //                            (~/.config/systemd/user/nanoclaw.service)
  // The 8s force-exit must stay strictly less than systemd's TimeoutStopSec
  // so we exit on our own terms (with logs flushed) rather than being killed.
  //
  // V2 UPGRADE NOTE: if shutdown is refactored, preserve these invariants:
  //   1. Some bounded force-exit must exist — never await disconnect unbounded.
  //   2. Force-exit budget < systemd TimeoutStopSec (currently 15s).
  //   3. The systemd unit's ExecStartPre cleanup (which kills lingering
  //      orchestrator processes before starting a new one) is a belt to this
  //      suspenders — keep both, they protect against different failure modes
  //      (this one: clean shutdown; that one: crashes / unclean exits).
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    const forceExit = setTimeout(() => {
      logger.warn(
        { signal },
        'Shutdown exceeded 8s budget — forcing exit to prevent split-brain',
      );
      process.exit(1);
    }, 8000);
    forceExit.unref();
    proxyServer.close();
    await queue.shutdown(5000);
    for (const ch of channels) await ch.disconnect();
    clearTimeout(forceExit);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    requestImmediateProcessing: (chatJid: string) => {
      // Skip if the group isn't registered (no-op safety) — happens when
      // an event arrives before the group is wired up.
      if (!registeredGroups[chatJid]) return;
      queue.enqueueMessageCheck(chatJid);
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Initialize Telegram bot pool for agent swarm support
  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  // Start resource metrics sampler (host CPU/RSS, nanoclaw-* containers, disk).
  // Filters by container name prefix so other containers on the host are ignored.
  startMetricsSampler();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text);
    },
    sendFile: (jid, hostPath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile) {
        throw new Error(`Channel ${channel.name} does not support attachments`);
      }
      return channel.sendFile(jid, hostPath, caption);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: writeAllTaskSnapshots,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  // Seed the tasks snapshots (IPC + Obsidian mirror) at startup so the
  // files are current before any message activity triggers a write.
  writeAllTaskSnapshots();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}

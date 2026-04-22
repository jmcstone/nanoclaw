import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { NewMessage, RegisteredGroup } from '../types.js';
import type { ChannelOpts } from './registry.js';
import { getChannelFactory } from './registry.js';

// Import for side effect: registers the 'mailroom-subscriber' factory.
import './mailroom-subscriber.js';

const TARGET_JID = 'telegram:inbox';

function makeGroup(folder = 'telegram_inbox'): Record<string, RegisteredGroup> {
  return {
    [TARGET_JID]: {
      name: 'Inbox',
      folder,
      trigger: 'Madison',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    },
  };
}

async function flushSchedulers(): Promise<void> {
  // The subscriber polls every 1s; wait long enough to trigger at
  // least one poll cycle.
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

type OnMessageFn = ChannelOpts['onMessage'];
type OnChatMetadataFn = ChannelOpts['onChatMetadata'];
type RequestImmediateFn = NonNullable<ChannelOpts['requestImmediateProcessing']>;

let tmpDir: string;
let onMessage: ReturnType<typeof vi.fn<OnMessageFn>>;
let onChatMetadata: ReturnType<typeof vi.fn<OnChatMetadataFn>>;
let requestImmediateProcessing: ReturnType<typeof vi.fn<RequestImmediateFn>>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscriber-test-'));
  process.env.MAILROOM_IPC_OUT_DIR = tmpDir;
  onMessage = vi.fn<OnMessageFn>();
  onChatMetadata = vi.fn<OnChatMetadataFn>();
  requestImmediateProcessing = vi.fn<RequestImmediateFn>();
});

afterEach(() => {
  delete process.env.MAILROOM_IPC_OUT_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEvent(filename: string, payload: unknown): void {
  fs.writeFileSync(path.join(tmpDir, filename), JSON.stringify(payload));
}

function baseEventPayload(
  event: 'inbox:urgent' | 'inbox:routine' | 'inbox:new',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event,
    version: 1,
    source: 'gmail',
    account_id: 'gmail:work@x.com',
    message_id: 'gmail:abc123',
    source_message_id: 'abc123',
    thread_id: 'gmail:t1',
    subject: 'Please sign',
    sender: { email: 'dse@docusign.net', name: 'DocuSign' },
    received_at: '2026-04-22T14:43:53Z',
    body_preview: 'Click to review.',
    ...overrides,
  };
}

async function makeSubscriber(): Promise<{
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}> {
  const factory = getChannelFactory('mailroom-subscriber');
  if (!factory) throw new Error('subscriber factory not registered');
  const sub = factory({
    onMessage,
    onChatMetadata,
    registeredGroups: () => makeGroup(),
    requestImmediateProcessing,
  });
  if (!sub) throw new Error('subscriber factory returned null');
  return { connect: () => sub.connect(), disconnect: () => sub.disconnect() };
}

describe('mailroom-subscriber — event routing', () => {
  test('inbox-urgent file triggers onMessage + requestImmediateProcessing', async () => {
    writeEvent(
      'inbox-urgent-abc.json',
      baseEventPayload('inbox:urgent', {
        applied: {
          labels_added: ['Tax'],
          labels_removed: [],
          archived: false,
          qcm_alert: false,
          matched_rule_indices: [0],
        },
      }),
    );

    const sub = await makeSubscriber();
    await sub.connect();
    await flushSchedulers();
    await sub.disconnect();

    expect(onMessage).toHaveBeenCalledOnce();
    const [jid, msg] = onMessage.mock.calls[0];
    expect(jid).toBe(TARGET_JID);
    const newMsg = msg as NewMessage;
    expect(newMsg.content).toContain('URGENT');
    expect(newMsg.content).toContain('DocuSign');
    expect(newMsg.content).toContain('Rules applied: labeled Tax');

    expect(requestImmediateProcessing).toHaveBeenCalledOnce();
    expect(requestImmediateProcessing).toHaveBeenCalledWith(TARGET_JID);

    // File should be consumed (unlinked) after successful dispatch.
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  test('inbox-routine file triggers onMessage only (no immediate processing)', async () => {
    writeEvent('inbox-routine-def.json', baseEventPayload('inbox:routine'));
    const sub = await makeSubscriber();
    await sub.connect();
    await flushSchedulers();
    await sub.disconnect();

    expect(onMessage).toHaveBeenCalledOnce();
    const [, msg] = onMessage.mock.calls[0];
    expect((msg as NewMessage).content).not.toContain('URGENT');
    expect(requestImmediateProcessing).not.toHaveBeenCalled();
  });

  test('legacy inbox-new file still works (backward compat during transition)', async () => {
    writeEvent('inbox-new-ghi.json', baseEventPayload('inbox:new'));
    const sub = await makeSubscriber();
    await sub.connect();
    await flushSchedulers();
    await sub.disconnect();

    expect(onMessage).toHaveBeenCalledOnce();
    expect(requestImmediateProcessing).not.toHaveBeenCalled();
  });

  test('filename prefix mismatch with payload — dispatches per payload event field', async () => {
    // Written as routine but payload says urgent — payload wins.
    writeEvent('inbox-routine-xyz.json', baseEventPayload('inbox:urgent'));
    const sub = await makeSubscriber();
    await sub.connect();
    await flushSchedulers();
    await sub.disconnect();

    expect(onMessage).toHaveBeenCalledOnce();
    expect(requestImmediateProcessing).toHaveBeenCalledOnce();
  });

  test('unknown-prefix file is ignored (not quarantined)', async () => {
    writeEvent('unrelated-file.json', baseEventPayload('inbox:urgent'));
    writeEvent('inbox-urgent-only.json', baseEventPayload('inbox:urgent'));

    const sub = await makeSubscriber();
    await sub.connect();
    await flushSchedulers();
    await sub.disconnect();

    // Only the urgent file was processed; unrelated-file stays.
    expect(onMessage).toHaveBeenCalledOnce();
    const remaining = fs.readdirSync(tmpDir).sort();
    expect(remaining).toEqual(['unrelated-file.json']);
  });

  test('invalid JSON is quarantined to ipc-errors', async () => {
    fs.writeFileSync(path.join(tmpDir, 'inbox-urgent-bad.json'), '{ not valid');
    const sub = await makeSubscriber();
    await sub.connect();
    await flushSchedulers();
    await sub.disconnect();

    expect(onMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'inbox-urgent-bad.json'))).toBe(
      false,
    );
    const errorsDir = path.join(tmpDir, '..', 'ipc-errors');
    expect(fs.existsSync(path.join(errorsDir, 'inbox-urgent-bad.json'))).toBe(
      true,
    );
    fs.rmSync(errorsDir, { recursive: true, force: true });
  });

  test('schema-invalid payload is quarantined', async () => {
    writeEvent('inbox-urgent-bad2.json', {
      event: 'inbox:urgent' /* missing required fields */,
    });
    const sub = await makeSubscriber();
    await sub.connect();
    await flushSchedulers();
    await sub.disconnect();

    expect(onMessage).not.toHaveBeenCalled();
    const errorsDir = path.join(tmpDir, '..', 'ipc-errors');
    expect(fs.existsSync(path.join(errorsDir, 'inbox-urgent-bad2.json'))).toBe(
      true,
    );
    fs.rmSync(errorsDir, { recursive: true, force: true });
  });

  test('multiple routine events batch via onMessage without multiple immediate spawns', async () => {
    for (let i = 0; i < 4; i++) {
      writeEvent(
        `inbox-routine-${i}.json`,
        baseEventPayload('inbox:routine', {
          message_id: `gmail:batch${i}`,
          source_message_id: `batch${i}`,
        }),
      );
    }

    const sub = await makeSubscriber();
    await sub.connect();
    await flushSchedulers();
    await sub.disconnect();

    expect(onMessage).toHaveBeenCalledTimes(4);
    expect(requestImmediateProcessing).not.toHaveBeenCalled();
  });

  test('no email target group → event dropped silently', async () => {
    const factory = getChannelFactory('mailroom-subscriber');
    if (!factory) throw new Error('missing');
    const sub = factory({
      onMessage,
      onChatMetadata,
      registeredGroups: () => ({}), // no groups
      requestImmediateProcessing,
    });
    if (!sub) throw new Error('null subscriber');

    writeEvent('inbox-urgent-orphan.json', baseEventPayload('inbox:urgent'));
    await sub.connect();
    await flushSchedulers();
    await sub.disconnect();

    expect(onMessage).not.toHaveBeenCalled();
    // Not quarantined — just noop; event file consumed.
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  DOWNLOADS_DIR: '/tmp/nanoclaw-test-downloads',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { spawn } from 'child_process';
import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('inbox store mount gating', () => {
  const spawnMock = spawn as ReturnType<typeof vi.fn>;
  const TEST_INBOX_KEY =
    'deadbeefcafefeeddeadbeefcafefeed' +
    'deadbeefcafefeeddeadbeefcafefeed';

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    spawnMock.mockClear();
    process.env.INBOX_DB_KEY = TEST_INBOX_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.INBOX_DB_KEY;
  });

  function getSpawnArgs(): string[] {
    return spawnMock.mock.calls[0]?.[1] ?? [];
  }

  function startAndClose(
    group: RegisteredGroup,
    folder: string,
  ): Promise<ContainerOutput> {
    const p = runContainerAgent(
      group,
      {
        prompt: 'Hello',
        groupFolder: folder,
        chatJid: 'x@g.us',
        isMain: false,
      },
      () => {},
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    fakeProc.emit('close', 0);
    return p;
  }

  it('telegram_inbox group includes inbox store bind mount (readonly)', async () => {
    const inboxGroup: RegisteredGroup = {
      name: 'Madison Inbox',
      folder: 'telegram_inbox',
      trigger: '@Madison',
      added_at: new Date().toISOString(),
    };

    startAndClose(inboxGroup, 'telegram_inbox');
    await vi.advanceTimersByTimeAsync(10);

    const args = getSpawnArgs();
    // readonlyMountArgs returns ['-v', 'host:container:ro'], so the mount
    // appears as a single combined arg: 'hostPath:/workspace/inbox/store.db:ro'
    const inboxMountArg = args.find(
      (a) => a.includes('/workspace/inbox/store.db') && a.includes(':ro'),
    );
    expect(inboxMountArg).toBeDefined();
    expect(inboxMountArg).toContain(
      'inbox/store.db:/workspace/inbox/store.db:ro',
    );
  });

  it('non-inbox group does not include inbox store bind mount', async () => {
    const mainGroup: RegisteredGroup = {
      name: 'Main Group',
      folder: 'telegram_main',
      trigger: '@Madison',
      added_at: new Date().toISOString(),
    };

    startAndClose(mainGroup, 'telegram_main');
    await vi.advanceTimersByTimeAsync(10);

    const args = getSpawnArgs();
    const hasInboxMount = args.some((a) =>
      a.includes('/workspace/inbox/store.db'),
    );
    expect(hasInboxMount).toBe(false);
  });

  it('trading group does not include inbox store bind mount', async () => {
    const tradingGroup: RegisteredGroup = {
      name: 'Trading',
      folder: 'telegram_trading',
      trigger: '@Madison',
      added_at: new Date().toISOString(),
    };

    startAndClose(tradingGroup, 'telegram_trading');
    await vi.advanceTimersByTimeAsync(10);

    const args = getSpawnArgs();
    const hasInboxMount = args.some((a) =>
      a.includes('/workspace/inbox/store.db'),
    );
    expect(hasInboxMount).toBe(false);
  });

  it('telegram_inbox group forwards INBOX_DB_KEY into container env', async () => {
    const inboxGroup: RegisteredGroup = {
      name: 'Madison Inbox',
      folder: 'telegram_inbox',
      trigger: '@Madison',
      added_at: new Date().toISOString(),
    };

    startAndClose(inboxGroup, 'telegram_inbox');
    await vi.advanceTimersByTimeAsync(10);

    const args = getSpawnArgs();
    const keyArg = args.find((a) => a.startsWith('INBOX_DB_KEY='));
    expect(keyArg).toBe(`INBOX_DB_KEY=${TEST_INBOX_KEY}`);
  });

  it('non-inbox group does not forward INBOX_DB_KEY', async () => {
    const mainGroup: RegisteredGroup = {
      name: 'Main Group',
      folder: 'telegram_main',
      trigger: '@Madison',
      added_at: new Date().toISOString(),
    };

    startAndClose(mainGroup, 'telegram_main');
    await vi.advanceTimersByTimeAsync(10);

    const args = getSpawnArgs();
    const hasKey = args.some((a) => a.startsWith('INBOX_DB_KEY='));
    expect(hasKey).toBe(false);
  });
});

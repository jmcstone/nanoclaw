/**
 * Resource metrics sampler for NanoClaw.
 *
 * Captures host orchestrator (this Node process) CPU/RSS, per-container
 * Docker stats for `nanoclaw-*` containers only, and persistent disk
 * footprint of NanoClaw data directories. Rows go into `metrics_samples`.
 *
 * The container filter is a hard prefix match on the container name,
 * which mirrors how the runner names them (`nanoclaw-{folder}-{ts}`).
 * Other containers on the host are never sampled.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';

import { DATA_DIR, DOWNLOADS_DIR, GROUPS_DIR, STORE_DIR } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import {
  recordMetricSamples,
  pruneMetricsOlderThan,
  MetricSampleRow,
} from './db.js';
import { logger } from './logger.js';

const execFileP = promisify(execFile);

const NUM_CPUS = Math.max(1, os.cpus().length);

interface SamplerHandle {
  stop: () => void;
}

interface SamplerOptions {
  statsIntervalMs: number;
  diskIntervalMs: number;
  retentionDays: number;
}

function parseSize(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^([\d.]+)\s*([kKmMgGtT]?i?[bB]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'B').toLowerCase();
  const mult: Record<string, number> = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    // bare unit prefix → docker often emits e.g. "1.5MiB"
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
    t: 1024 ** 4,
  };
  return Math.round(n * (mult[unit] ?? 1));
}

function parsePair(s: string | undefined): [number | null, number | null] {
  if (!s) return [null, null];
  const parts = s.split('/').map((p) => p.trim());
  return [parseSize(parts[0]), parseSize(parts[1])];
}

function parsePct(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

interface DockerStatsRow {
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string;
  NetIO?: string;
  BlockIO?: string;
}

async function listNanoclawContainers(): Promise<string[]> {
  const { stdout } = await execFileP(
    CONTAINER_RUNTIME_BIN,
    ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('nanoclaw-'));
}

async function sampleContainers(now: string): Promise<MetricSampleRow[]> {
  try {
    const names = await listNanoclawContainers();
    if (names.length === 0) return [];
    // `docker stats` on this host does not support --filter; pass names
    // explicitly. Belt-and-suspenders: we also re-check the prefix when
    // parsing rows below.
    const { stdout } = await execFileP(
      CONTAINER_RUNTIME_BIN,
      [
        'stats',
        '--no-stream',
        '--no-trunc',
        '--format',
        '{{json .}}',
        ...names,
      ],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const rows: MetricSampleRow[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      let parsed: DockerStatsRow;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const name = parsed.Name?.trim();
      if (!name || !name.startsWith('nanoclaw-')) continue;
      const [memUsed] = parsePair(parsed.MemUsage);
      const [netRx, netTx] = parsePair(parsed.NetIO);
      const [blkR, blkW] = parsePair(parsed.BlockIO);
      rows.push({
        ts: now,
        kind: 'container',
        source: name,
        cpuPct: parsePct(parsed.CPUPerc),
        rssBytes: memUsed,
        netRxBytes: netRx,
        netTxBytes: netTx,
        blockReadBytes: blkR,
        blockWriteBytes: blkW,
      });
    }
    return rows;
  } catch (err) {
    logger.debug({ err }, 'metrics: docker stats failed');
    return [];
  }
}

let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

function sampleOrchestrator(now: string): MetricSampleRow {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const nowMs = Date.now();
  const elapsedUs = (nowMs - lastCpuAt) * 1000;
  const usedUs = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
  lastCpu = cpu;
  lastCpuAt = nowMs;
  // Match docker-stats convention: % of one core. Multi-core handling is
  // up to the report layer (it knows NUM_CPUS via the extra field).
  const cpuPct = elapsedUs > 0 ? (usedUs / elapsedUs) * 100 : 0;
  return {
    ts: now,
    kind: 'orchestrator',
    source: 'orchestrator',
    cpuPct,
    rssBytes: mem.rss,
    extra: JSON.stringify({
      heapUsed: mem.heapUsed,
      external: mem.external,
      numCpus: NUM_CPUS,
    }),
  };
}

async function dirSize(p: string): Promise<number | null> {
  if (!fs.existsSync(p)) return null;
  try {
    const { stdout } = await execFileP('du', ['-sb', p], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const n = parseInt(stdout.split(/\s+/)[0], 10);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    logger.debug({ err, path: p }, 'metrics: du failed');
    return null;
  }
}

async function sampleDisk(now: string): Promise<MetricSampleRow[]> {
  const targets: Array<[string, string]> = [
    ['store', STORE_DIR],
    ['data', DATA_DIR],
    ['groups', GROUPS_DIR],
    ['downloads', DOWNLOADS_DIR],
  ];
  const rows: MetricSampleRow[] = [];
  for (const [label, p] of targets) {
    const bytes = await dirSize(p);
    if (bytes == null) continue;
    rows.push({
      ts: now,
      kind: 'disk',
      source: label,
      diskBytes: bytes,
      extra: JSON.stringify({ path: p }),
    });
  }
  return rows;
}

export function startMetricsSampler(
  optsIn: Partial<SamplerOptions> = {},
): SamplerHandle {
  const opts: SamplerOptions = {
    statsIntervalMs: parseInt(
      process.env.NANOCLAW_METRICS_INTERVAL_MS || '30000',
      10,
    ),
    diskIntervalMs: parseInt(
      process.env.NANOCLAW_METRICS_DISK_INTERVAL_MS || '300000',
      10,
    ),
    retentionDays: parseInt(
      process.env.NANOCLAW_METRICS_RETENTION_DAYS || '30',
      10,
    ),
    ...optsIn,
  };

  if (process.env.NANOCLAW_METRICS_DISABLED === '1') {
    logger.info('metrics: sampler disabled via NANOCLAW_METRICS_DISABLED');
    return { stop: () => {} };
  }

  let stopped = false;

  const tickStats = async () => {
    if (stopped) return;
    const now = new Date().toISOString();
    try {
      const orch = sampleOrchestrator(now);
      const containers = await sampleContainers(now);
      recordMetricSamples([orch, ...containers]);
    } catch (err) {
      logger.warn({ err }, 'metrics: stats tick failed');
    }
  };

  const tickDisk = async () => {
    if (stopped) return;
    const now = new Date().toISOString();
    try {
      const rows = await sampleDisk(now);
      recordMetricSamples(rows);
    } catch (err) {
      logger.warn({ err }, 'metrics: disk tick failed');
    }
  };

  const tickPrune = () => {
    if (stopped) return;
    try {
      const cutoff = new Date(
        Date.now() - opts.retentionDays * 86400_000,
      ).toISOString();
      const removed = pruneMetricsOlderThan(cutoff);
      if (removed > 0) {
        logger.debug({ removed, cutoff }, 'metrics: pruned old samples');
      }
    } catch (err) {
      logger.warn({ err }, 'metrics: prune failed');
    }
  };

  // Prime cpu baseline
  lastCpu = process.cpuUsage();
  lastCpuAt = Date.now();

  // Kick off async; don't await
  void tickStats();
  void tickDisk();

  const statsTimer = setInterval(tickStats, opts.statsIntervalMs);
  const diskTimer = setInterval(tickDisk, opts.diskIntervalMs);
  const pruneTimer = setInterval(tickPrune, 6 * 3600 * 1000);

  // Don't keep the event loop alive for these
  statsTimer.unref?.();
  diskTimer.unref?.();
  pruneTimer.unref?.();

  logger.info(
    {
      statsIntervalMs: opts.statsIntervalMs,
      diskIntervalMs: opts.diskIntervalMs,
      retentionDays: opts.retentionDays,
    },
    'metrics: sampler started',
  );

  return {
    stop: () => {
      stopped = true;
      clearInterval(statsTimer);
      clearInterval(diskTimer);
      clearInterval(pruneTimer);
    },
  };
}

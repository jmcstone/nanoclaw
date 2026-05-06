#!/usr/bin/env tsx
/**
 * metrics-report — summarize NanoClaw resource usage from `metrics_samples`.
 *
 * Usage:
 *   tsx scripts/metrics-report.ts            # last 24h
 *   tsx scripts/metrics-report.ts --hours 1
 *   tsx scripts/metrics-report.ts --days 7
 *   tsx scripts/metrics-report.ts --json
 *
 * Read-only. Opens the same SQLite file the orchestrator writes to.
 */
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

import { STORE_DIR } from '../src/config.ts';

function parseArgs(argv: string[]): { windowMs: number; json: boolean } {
  let hours = 24;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hours') hours = parseFloat(argv[++i]);
    else if (a === '--days') hours = parseFloat(argv[++i]) * 24;
    else if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') {
      console.log(
        'usage: metrics-report [--hours N | --days N] [--json]',
      );
      process.exit(0);
    }
  }
  return { windowMs: hours * 3600 * 1000, json };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  if (n < 1024) return `${n}B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(2)} ${units[u]}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(1)}%`;
}

interface Row {
  ts: string;
  kind: string;
  source: string;
  cpu_pct: number | null;
  rss_bytes: number | null;
  disk_bytes: number | null;
  extra: string | null;
}

function summarize(rows: Row[]): {
  count: number;
  cpu: { p50: number; p95: number; peak: number };
  rss: { p50: number; p95: number; peak: number };
} {
  const cpu = rows.map((r) => r.cpu_pct).filter((x): x is number => x != null);
  const rss = rows.map((r) => r.rss_bytes).filter((x): x is number => x != null);
  cpu.sort((a, b) => a - b);
  rss.sort((a, b) => a - b);
  return {
    count: rows.length,
    cpu: {
      p50: quantile(cpu, 0.5),
      p95: quantile(cpu, 0.95),
      peak: cpu.length ? cpu[cpu.length - 1] : 0,
    },
    rss: {
      p50: quantile(rss, 0.5),
      p95: quantile(rss, 0.95),
      peak: rss.length ? rss[rss.length - 1] : 0,
    },
  };
}

function main(): void {
  const { windowMs, json } = parseArgs(process.argv.slice(2));
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const dbPath = path.join(STORE_DIR, 'messages.db');
  const db = new Database(dbPath, { readonly: true });

  const tableExists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='metrics_samples'`,
    )
    .get();
  if (!tableExists) {
    console.error(
      'metrics_samples table not present yet. Restart NanoClaw to create the schema and start the sampler.',
    );
    process.exit(2);
  }

  const rows = db
    .prepare(
      `SELECT ts, kind, source, cpu_pct, rss_bytes, disk_bytes, extra
       FROM metrics_samples WHERE ts >= ? ORDER BY ts ASC`,
    )
    .all(cutoff) as Row[];

  // Orchestrator
  const orchRows = rows.filter((r) => r.kind === 'orchestrator');
  const orch = summarize(orchRows);

  // Containers — group by source (container name) to compute per-run peaks
  const byContainer = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.kind !== 'container') continue;
    const arr = byContainer.get(r.source) ?? [];
    arr.push(r);
    byContainer.set(r.source, arr);
  }

  const containerStats = [...byContainer.entries()]
    .map(([name, samples]) => {
      const summary = summarize(samples);
      const tsMin = samples[0].ts;
      const tsMax = samples[samples.length - 1].ts;
      const durationMs =
        new Date(tsMax).getTime() - new Date(tsMin).getTime();
      // Pull group folder from name: "nanoclaw-<folder>-<ts>"
      const m = name.match(/^nanoclaw-(.+)-\d+$/);
      const group = m?.[1] ?? '?';
      return {
        name,
        group,
        samples: summary.count,
        durationMs,
        peakCpu: summary.cpu.peak,
        peakRss: summary.rss.peak,
        p95Cpu: summary.cpu.p95,
        p95Rss: summary.rss.p95,
      };
    })
    .sort((a, b) => b.peakRss - a.peakRss);

  // Peak concurrent: count distinct container names per ts bucket
  const tsBuckets = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.kind !== 'container') continue;
    const set = tsBuckets.get(r.ts) ?? new Set();
    set.add(r.source);
    tsBuckets.set(r.ts, set);
  }
  let peakConcurrent = 0;
  let peakConcurrentAt = '';
  for (const [ts, set] of tsBuckets) {
    if (set.size > peakConcurrent) {
      peakConcurrent = set.size;
      peakConcurrentAt = ts;
    }
  }

  // Disk — first vs last per source
  const diskBySrc = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.kind !== 'disk') continue;
    const arr = diskBySrc.get(r.source) ?? [];
    arr.push(r);
    diskBySrc.set(r.source, arr);
  }
  const disk = [...diskBySrc.entries()].map(([source, samples]) => {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const growth = (last.disk_bytes ?? 0) - (first.disk_bytes ?? 0);
    return {
      source,
      samples: samples.length,
      first: first.disk_bytes,
      last: last.disk_bytes,
      growth,
    };
  });

  const numCpus = (() => {
    const ex = orchRows[orchRows.length - 1]?.extra;
    if (!ex) return os.cpus().length;
    try {
      return JSON.parse(ex).numCpus ?? os.cpus().length;
    } catch {
      return os.cpus().length;
    }
  })();

  if (json) {
    console.log(
      JSON.stringify(
        {
          window: { sinceIso: cutoff, hours: windowMs / 3600_000 },
          host: { numCpus },
          orchestrator: orch,
          containers: containerStats,
          peakConcurrentContainers: { count: peakConcurrent, atIso: peakConcurrentAt },
          disk,
        },
        null,
        2,
      ),
    );
    return;
  }

  const hours = windowMs / 3600_000;
  console.log(`NanoClaw metrics — last ${hours}h (since ${cutoff})`);
  console.log(`Host CPUs: ${numCpus}\n`);

  console.log('Orchestrator (Node process):');
  console.log(`  samples: ${orch.count}`);
  console.log(
    `  cpu: p50=${fmtPct(orch.cpu.p50)} p95=${fmtPct(orch.cpu.p95)} peak=${fmtPct(orch.cpu.peak)}  (% of one core; host has ${numCpus})`,
  );
  console.log(
    `  rss: p50=${fmtBytes(orch.rss.p50)} p95=${fmtBytes(orch.rss.p95)} peak=${fmtBytes(orch.rss.peak)}\n`,
  );

  console.log(
    `Containers (nanoclaw-* only) — peak concurrent: ${peakConcurrent}${
      peakConcurrentAt ? ` at ${peakConcurrentAt}` : ''
    }`,
  );
  if (containerStats.length === 0) {
    console.log('  (no container samples in window)');
  } else {
    console.log(
      '  ' +
        ['group', 'samples', 'duration', 'peak CPU', 'p95 CPU', 'peak RSS', 'p95 RSS'].join(' | '),
    );
    for (const c of containerStats.slice(0, 25)) {
      console.log(
        '  ' +
          [
            c.group.padEnd(14),
            String(c.samples).padStart(7),
            `${(c.durationMs / 1000).toFixed(0)}s`.padStart(8),
            fmtPct(c.peakCpu).padStart(8),
            fmtPct(c.p95Cpu).padStart(7),
            fmtBytes(c.peakRss).padStart(10),
            fmtBytes(c.p95Rss).padStart(10),
          ].join(' | '),
      );
    }
    if (containerStats.length > 25) {
      console.log(`  … ${containerStats.length - 25} more`);
    }
  }
  console.log();

  console.log('Disk usage (NanoClaw data dirs):');
  if (disk.length === 0) {
    console.log('  (no disk samples in window)');
  } else {
    for (const d of disk) {
      const sign = d.growth >= 0 ? '+' : '-';
      console.log(
        `  ${d.source.padEnd(10)} ${fmtBytes(d.last).padStart(10)}  Δ${sign}${fmtBytes(Math.abs(d.growth))} over ${d.samples} samples`,
      );
    }
  }
}

main();

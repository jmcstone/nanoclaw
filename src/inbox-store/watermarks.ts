import type Database from 'better-sqlite3';
import { getInboxDb } from './db.js';
import type { Watermark } from './types.js';

interface PreparedWatermarkStmts {
  select: Database.Statement;
  upsert: Database.Statement;
}

let cached: { db: Database.Database; stmts: PreparedWatermarkStmts } | null =
  null;

function stmts(): PreparedWatermarkStmts {
  const db = getInboxDb();
  if (cached && cached.db === db) return cached.stmts;
  cached = {
    db,
    stmts: {
      select: db.prepare(
        `SELECT account_id, watermark_value, updated_at FROM watermarks WHERE account_id = ?`,
      ),
      upsert: db.prepare(
        `INSERT INTO watermarks (account_id, watermark_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           watermark_value = excluded.watermark_value,
           updated_at      = excluded.updated_at
         WHERE watermarks.watermark_value <> excluded.watermark_value`,
      ),
    },
  };
  return cached.stmts;
}

export function getWatermark(account_id: string): Watermark | null {
  const row = stmts().select.get(account_id) as Watermark | undefined;
  return row ?? null;
}

export function setWatermark(
  account_id: string,
  watermark_value: string,
): void {
  stmts().upsert.run(account_id, watermark_value, new Date().toISOString());
}

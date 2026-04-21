import { getInboxDb } from './db.js';
import type { Watermark } from './types.js';

export function getWatermark(account_id: string): Watermark | null {
  const row = getInboxDb()
    .prepare(
      `SELECT account_id, watermark_value, updated_at FROM watermarks WHERE account_id = ?`,
    )
    .get(account_id) as Watermark | undefined;
  return row ?? null;
}

export function setWatermark(
  account_id: string,
  watermark_value: string,
): void {
  const updated_at = new Date().toISOString();
  getInboxDb()
    .prepare(
      `INSERT INTO watermarks (account_id, watermark_value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         watermark_value = excluded.watermark_value,
         updated_at = excluded.updated_at`,
    )
    .run(account_id, watermark_value, updated_at);
}

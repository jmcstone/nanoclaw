import Database from 'better-sqlite3';

let db: Database.Database | null = null;

export function getInboxDb(): Database.Database {
  if (db) return db;
  const dbPath = process.env.INBOX_DB_PATH;
  if (!dbPath) throw new Error('INBOX_DB_PATH env var is required');
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = true');
  return db;
}

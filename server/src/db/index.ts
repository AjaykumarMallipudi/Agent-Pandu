import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from './schema.js';

export type DB = Database.Database;

let db: DB | null = null;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  migrate(conn);
  return conn;
}

export function migrate(conn: DB): void {
  const version = conn.pragma('user_version', { simple: true }) as number;
  for (let i = version; i < migrations.length; i++) {
    conn.transaction(() => {
      conn.exec(migrations[i]!);
      conn.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export function initDb(file: string): DB {
  if (db) db.close();
  db = openDb(file);
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error('Database not initialised');
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export const nowIso = (): string => new Date().toISOString();

export function logEvent(type: string, message: string, entity?: { type: string; id: number }, data?: unknown): void {
  getDb()
    .prepare('INSERT INTO events (type, entity_type, entity_id, message, data_json) VALUES (?, ?, ?, ?, ?)')
    .run(type, entity?.type ?? null, entity?.id ?? null, message, data === undefined ? null : JSON.stringify(data));
}

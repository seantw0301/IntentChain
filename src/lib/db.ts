import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// node:sqlite is loaded through getBuiltinModule so the bundler never has to
// resolve it. Requires Node >= 22.13.
type SqliteModule = typeof import('node:sqlite');
type Database = InstanceType<SqliteModule['DatabaseSync']>;

export const TABLES = [
  'intents',
  'delegations',
  'decisions',
  'transactions',
  'recoveries',
] as const;
export type Table = (typeof TABLES)[number];

const g = globalThis as unknown as { __intentchain_db?: Database };

function open(): Database {
  const sqlite = process.getBuiltinModule('node:sqlite') as SqliteModule | undefined;
  if (!sqlite) throw new Error('node:sqlite is unavailable. Use Node.js 22.13 or newer.');
  const file = path.resolve(process.env.DATABASE_PATH || './data/intentchain.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const t of TABLES) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
      id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    )`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    data TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS audit_session ON audit_events (session_id, seq)');
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    last_seen TEXT NOT NULL,
    ai_calls INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
    day TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0
  )`);
  return db;
}

export function db(): Database {
  if (!g.__intentchain_db) g.__intentchain_db = open();
  return g.__intentchain_db;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function put<T extends { id: string; created_at: string }>(
  table: Table,
  session: string,
  row: T,
): T {
  db()
    .prepare(
      `INSERT INTO ${table} (id, session_id, data, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, id) DO UPDATE SET data = excluded.data`,
    )
    .run(row.id, session, JSON.stringify(row), row.created_at);
  return row;
}

export function get<T>(table: Table, session: string, id: string): T | null {
  const row = db()
    .prepare(`SELECT data FROM ${table} WHERE session_id = ? AND id = ?`)
    .get(session, id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as T) : null;
}

export function list<T>(table: Table, session: string): T[] {
  const rows = db()
    .prepare(`SELECT data FROM ${table} WHERE session_id = ? ORDER BY created_at, rowid`)
    .all(session) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as T);
}

export function clearSession(session: string): void {
  for (const t of TABLES) db().prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(session);
  db().prepare('DELETE FROM audit_events WHERE session_id = ?').run(session);
}

export function touchSession(session: string): void {
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO sessions (id, last_seen) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen`,
    )
    .run(session, now);
}

/** Drops every session that has been idle for more than 24 hours. */
export function purgeIdleSessions(): void {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const idle = db().prepare('SELECT id FROM sessions WHERE last_seen < ?').all(cutoff) as {
    id: string;
  }[];
  for (const s of idle) {
    clearSession(s.id);
    db().prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
  }
}

/** Returns true when one more AI call is allowed, and counts it. */
export function reserveAiCall(session: string): boolean {
  const perSession = Number(process.env.AI_MAX_CALLS_PER_SESSION || 60);
  const perDay = Number(process.env.AI_MAX_CALLS_PER_DAY || 2000);
  const day = new Date().toISOString().slice(0, 10);
  const s = db().prepare('SELECT ai_calls FROM sessions WHERE id = ?').get(session) as
    | { ai_calls: number }
    | undefined;
  const d = db().prepare('SELECT calls FROM ai_usage WHERE day = ?').get(day) as
    | { calls: number }
    | undefined;
  if ((s?.ai_calls ?? 0) >= perSession || (d?.calls ?? 0) >= perDay) return false;
  db().prepare('UPDATE sessions SET ai_calls = ai_calls + 1 WHERE id = ?').run(session);
  db()
    .prepare(
      `INSERT INTO ai_usage (day, calls) VALUES (?, 1)
       ON CONFLICT (day) DO UPDATE SET calls = calls + 1`,
    )
    .run(day);
  return true;
}

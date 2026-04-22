import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = BetterSqlite3Database;

const thisDir = path.dirname(fileURLToPath(import.meta.url));

// schema.sql is copied alongside the compiled JS via tsconfig (include pattern)
// OR lives relative to src; we probe both locations.
function findSchemaPath(): string {
  const candidates = [
    path.resolve(thisDir, 'schema.sql'),
    path.resolve(thisDir, '../../src/db/schema.sql'),
    path.resolve(thisDir, '../../../src/db/schema.sql'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Could not locate schema.sql (searched: ${candidates.join(', ')})`);
}

export function openDb(filePath: string): Db {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(findSchemaPath(), 'utf8');
  db.exec(schema);
  return db;
}

export function kvGet(db: Db, key: string): string | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
}

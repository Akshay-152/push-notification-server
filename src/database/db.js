import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Open (and configure) a SQLite connection.
 * foreign_keys + WAL keep referential integrity and concurrent reads sane.
 */
export function openDatabase(databasePath) {
  const inMemory = databasePath === ':memory:';
  const db = new Database(databasePath);

  db.pragma('foreign_keys = ON');
  if (!inMemory) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('busy_timeout = 5000');

  return db;
}

/**
 * Run pending SQL migrations in filename order. Each file is applied exactly
 * once inside a transaction and recorded in schema_migrations.
 */
export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const record = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)'
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    });
    tx();
  }
}

/** Convenience: open + migrate in one call. */
export function initDatabase(databasePath) {
  const db = openDatabase(databasePath);
  runMigrations(db);
  return db;
}

#!/usr/bin/env node
/**
 * Run pending database migrations.
 * Usage: npm run migrate
 */
import 'dotenv/config';
import path from 'node:path';
import { runMigrations, openDatabase } from '../src/database/db.js';

const databasePath = process.env.DATABASE_PATH || './data/app.sqlite';

try {
  const db = openDatabase(databasePath);
  const before = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  runMigrations(db);

  const migrations = db.prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name').all();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

  console.log(`Database: ${path.resolve(databasePath)}`);
  console.log(`Migrations applied (${migrations.length}):`);
  for (const m of migrations) console.log(`  ✓ ${m.name}  (${m.applied_at})`);
  const newTables = tables.filter((t) => !before.includes(t));
  if (newTables.length) console.log(`Tables created: ${newTables.join(', ')}`);
  db.close();
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exit(1);
}

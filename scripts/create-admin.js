#!/usr/bin/env node
/**
 * Create (or reset the password of) an administrator account.
 *
 * Usage:
 *   npm run create:admin                      # interactive prompts
 *   ADMIN_USERNAME=alice ADMIN_PASSWORD=... npm run create:admin
 *
 * There is no default account and no default password: if neither the
 * environment variables nor an interactive terminal provide credentials,
 * this script refuses to run.
 */
import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { openDatabase, runMigrations } from '../src/database/db.js';
import { hashPassword, verifyPassword } from '../src/routes/authRoutes.js';

const databasePath = process.env.DATABASE_PATH || './data/app.sqlite';
const MIN_PASSWORD = 12;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,64}$/;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function checkCredentials(username, password) {
  if (!USERNAME_RE.test(username)) {
    fail('Username must be 3-64 characters: letters, digits, dot, dash or underscore.');
  }
  if (password.length < MIN_PASSWORD) {
    fail(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (password.toLowerCase().includes(username.toLowerCase())) {
    fail('Password must not contain the username.');
  }
}

async function main() {
  const rl = readline.createInterface({ input, output });

  try {
    let username = process.env.ADMIN_USERNAME;
    let password = process.env.ADMIN_PASSWORD;

    if (!username || !password) {
      if (!input.isTTY) {
        fail(
          'No TTY for interactive input. Set ADMIN_USERNAME and ADMIN_PASSWORD environment variables:\n' +
            '  ADMIN_USERNAME=alice ADMIN_PASSWORD="your-long-password" npm run create:admin'
        );
      }
      console.log('Create the first administrator account.');
      username = username || (await rl.question('Username: ')).trim();
      password = password || (await rl.question('Password (min 12 chars): '));
      if (!password) {
        // Hidden-ish confirm: ask twice to catch typos when typing.
        const again = await rl.question('Repeat password: ');
        if (again !== password) fail('Passwords do not match.');
      }
    }

    checkCredentials(username, password);

    const db = openDatabase(databasePath);
    runMigrations(db);

    const existing = db.prepare('SELECT id, username FROM admins WHERE username = ?').get(username);

    if (existing) {
      const force = ['1', 'true', 'yes'].includes(String(process.env.ADMIN_FORCE || '').toLowerCase());
      let confirm = 'n';
      if (input.isTTY) {
        confirm = await rl.question(
          `Admin "${username}" already exists. Reset its password? [y/N]: `
        );
      } else if (force) {
        confirm = 'y'; // ADMIN_FORCE=1 in a non-interactive shell
      } else {
        fail(`Admin "${username}" already exists. Re-run with ADMIN_FORCE=1 to reset its password.`);
      }
      if (confirm.trim().toLowerCase() !== 'y') {
        console.log('Aborted. No changes made.');
        db.close();
        process.exit(0);
      }
      const hash = await hashPassword(password);
      db.prepare('UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?').run(
        hash,
        new Date().toISOString(),
        existing.id
      );
      console.log(`Password updated for admin "${username}" (id ${existing.id}).`);
    } else {
      const hash = await hashPassword(password);
      const info = db
        .prepare(
          `INSERT INTO admins (username, password_hash, role, created_at, updated_at)
           VALUES (?, ?, 'admin', ?, ?)`
        )
        .run(username, hash, new Date().toISOString(), new Date().toISOString());
      console.log(`Created admin "${username}" (id ${info.lastInsertRowid}).`);
    }

    // Sanity check: prove the stored hash verifies.
    const row = db.prepare('SELECT password_hash FROM admins WHERE username = ?').get(username);
    const ok = await verifyPassword(row.password_hash, password);
    if (!ok) fail('Post-create verification failed - hash does not verify.');

    console.log('Done. Sign in at /admin-login.html');
    db.close();
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

'use strict';
/**
 * সহজ মাইগ্রেশন রানার।
 * - src/db/migrations/*.sql ফাইলগুলো নামের ক্রমে চলে (001_..., 002_...)।
 * - প্রয়োগ করা সংস্করণ schema_migrations টেবিলে থাকে; একই মাইগ্রেশন দুইবার চলে না।
 * - প্রতিটি মাইগ্রেশন একটি ট্রানজাকশনে চলে।
 */
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function splitSql(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

async function runMigrations(db, { logger, dir = MIGRATIONS_DIR } = {}) {
  await db.execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)'
  );
  const done = new Set((await db.execute('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const applied = [];

  for (const file of listMigrationFiles(dir)) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    const statements = splitSql(fs.readFileSync(path.join(dir, file), 'utf8')).map((sql) => ({ sql }));
    statements.push({
      sql: 'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      args: [version, Date.now()],
    });
    await db.batch(statements);
    applied.push(version);
    logger?.info('মাইগ্রেশন প্রয়োগ হয়েছে', { version });
  }
  return applied;
}

module.exports = { runMigrations, splitSql, listMigrationFiles };

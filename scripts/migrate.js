#!/usr/bin/env node
'use strict';
/** ব্যবহার: npm run migrate  — ডাটাবেস স্কিমা তৈরি/আপডেট করে। */
const { loadDotenvFile, loadConfig } = require('../src/config');
const { createDb } = require('../src/db');
const { runMigrations } = require('../src/db/migrate');
const { createLogger } = require('../src/lib/logger');

(async () => {
  loadDotenvFile();
  const config = loadConfig();
  const logger = createLogger({ level: 'info' });
  const db = createDb(config);
  try {
    const applied = await runMigrations(db, { logger });
    console.log(
      applied.length
        ? `✅ ${applied.length}টি মাইগ্রেশন প্রয়োগ হয়েছে: ${applied.join(', ')}`
        : '✅ ডাটাবেস ইতিমধ্যে আপ-টু-ডেট।'
    );
  } catch (err) {
    console.error('❌ মাইগ্রেশন ব্যর্থ:', err.message, err.cause ? `(${err.cause.message})` : '');
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();

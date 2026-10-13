'use strict';
/**
 * লোকাল SQLite ড্রাইভার (Node বিল্ট-ইন `node:sqlite`)।
 * সব কোয়েরি প্যারামিটারাইজড (`?`), তাই SQL ইনজেকশনের সুযোগ নেই।
 */
const fs = require('node:fs');
const path = require('node:path');
const { DbError } = require('./errors');

function createSqliteDb({ file }) {
  // node:sqlite এখনও "experimental" — সতর্কবার্তা চুপ করানো যায়, কিন্তু আমরা ইচ্ছাকৃতভাবে লুকাই না।
  const { DatabaseSync } = require('node:sqlite');

  const isMemory = file === ':memory:';
  if (!isMemory) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (!isMemory) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      if (stmtCache.size > 200) stmtCache.clear();
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  const READS = /^\s*(select|with|pragma)\b/i;

  function runOne(sql, args = []) {
    try {
      const stmt = prepare(sql);
      if (READS.test(sql) || /\breturning\b/i.test(sql)) {
        const rows = stmt.all(...args).map((r) => ({ ...r }));
        return { rows, rowsAffected: 0, lastInsertRowid: null };
      }
      const info = stmt.run(...args);
      return {
        rows: [],
        rowsAffected: Number(info.changes),
        lastInsertRowid: info.lastInsertRowid == null ? null : Number(info.lastInsertRowid),
      };
    } catch (err) {
      throw new DbError('ডাটাবেস কোয়েরি ব্যর্থ হয়েছে', { cause: err, code: err.code || err.errcode });
    }
  }

  return {
    driver: 'sqlite',
    async execute(sql, args = []) {
      return runOne(sql, args);
    },
    /** সব স্টেটমেন্ট একটি ট্রানজাকশনে — একটি ব্যর্থ হলে সব রোলব্যাক। */
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((s) => runOne(s.sql, s.args || []));
        db.exec('COMMIT');
        return results;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ট্রানজাকশন আগেই শেষ হয়ে গেলে উপেক্ষা */
        }
        throw err;
      }
    },
    async ping() {
      runOne('SELECT 1 AS ok');
      return true;
    },
    async close() {
      stmtCache.clear();
      db.close();
    },
  };
}

module.exports = { createSqliteDb };

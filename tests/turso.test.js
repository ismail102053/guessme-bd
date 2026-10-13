'use strict';
/**
 * Turso (libSQL/Hrana-over-HTTP) ড্রাইভারের টেস্ট — একটি লোকাল মক সার্ভারের বিপরীতে।
 * ⚠️ এটি আসল Turso সার্ভার নয়: মকটি Hrana /v2/pipeline প্রোটোকলের নথি অনুযায়ী লেখা (SQLite-ভিত্তিক)।
 * তাই ড্রাইভারের এনকোডিং/ডিকোডিং/ব্যাচ-ট্রানজাকশন-যুক্তি যাচাই হয়, কিন্তু আসল ক্লাউডে প্রথম ডিপ্লয়ে /api/health দিয়ে আলাদা যাচাই লাগবে।
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { createTursoDb, toHttpUrl, encodeArg } = require('../src/db/turso');
const { runMigrations } = require('../src/db/migrate');
const { startTestServer, sampleQuiz, playQuiz } = require('./helpers');

const TOKEN = 'mock-secret-token-ABC123';
let mock, mockUrl, sqlite;
const seenBodies = [];

function enc(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint' || Number.isInteger(v)) return { type: 'integer', value: String(v) };
  if (typeof v === 'number') return { type: 'float', value: v };
  return { type: 'text', value: String(v) };
}
function dec(a) {
  if (a.type === 'null') return null;
  if (a.type === 'integer') return Number(a.value);
  if (a.type === 'float') return a.value;
  return a.value;
}

function runStmt(stmt) {
  const args = (stmt.args || []).map(dec);
  const prep = sqlite.prepare(stmt.sql);
  if (/^\s*(select|with|pragma)\b/i.test(stmt.sql)) {
    const rows = prep.all(...args);
    const cols = rows.length ? Object.keys(rows[0]).map((name) => ({ name })) : [];
    return {
      cols,
      rows: rows.map((r) => cols.map((c) => enc(r[c.name]))),
      affected_row_count: 0,
      last_insert_rowid: null,
    };
  }
  const info = prep.run(...args);
  return { cols: [], rows: [], affected_row_count: Number(info.changes), last_insert_rowid: String(info.lastInsertRowid) };
}

function evalCond(c, results, errors) {
  if (!c) return true;
  if (c.type === 'ok') return results[c.step] != null && errors[c.step] == null;
  if (c.type === 'error') return errors[c.step] != null;
  if (c.type === 'not') return !evalCond(c.cond, results, errors);
  throw new Error(`mock: অজানা শর্ত ${c.type}`);
}

before(async () => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `bad token ${req.headers.authorization}` })); // ইচ্ছাকৃতভাবে টোকেন-সহ বডি
        return;
      }
      if (req.url !== '/v2/pipeline') { res.writeHead(404); res.end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seenBodies.push(body);
      const results = body.requests.map((r) => {
        try {
          if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
          if (r.type === 'execute') return { type: 'ok', response: { type: 'execute', result: runStmt(r.stmt) } };
          if (r.type === 'batch') {
            const stepResults = [];
            const stepErrors = [];
            r.batch.steps.forEach((step, i) => {
              if (!evalCond(step.condition, stepResults, stepErrors)) { stepResults[i] = null; stepErrors[i] = null; return; }
              try { stepResults[i] = runStmt(step.stmt); stepErrors[i] = null; }
              catch (e) { stepResults[i] = null; stepErrors[i] = { message: e.message }; }
            });
            return { type: 'ok', response: { type: 'batch', result: { step_results: stepResults, step_errors: stepErrors } } };
          }
          throw new Error(`mock: অজানা অনুরোধ ${r.type}`);
        } catch (e) {
          return { type: 'error', error: { message: e.message, code: 'SQLITE_ERROR' } };
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ baton: null, base_url: null, results }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
});
after(async () => { await new Promise((r) => mock.close(r)); sqlite.close(); });

test('URL রূপান্তর ও আর্গুমেন্ট এনকোডিং', () => {
  assert.equal(toHttpUrl('libsql://my-db-org.turso.io/'), 'https://my-db-org.turso.io');
  assert.deepEqual(encodeArg(5), { type: 'integer', value: '5' });
  assert.deepEqual(encodeArg(1.5), { type: 'float', value: 1.5 });
  assert.deepEqual(encodeArg(null), { type: 'null' });
  assert.deepEqual(encodeArg('বাংলা'), { type: 'text', value: 'বাংলা' });
  assert.deepEqual(encodeArg(true), { type: 'integer', value: '1' });
});

test('execute: INSERT/SELECT রাউন্ড-ট্রিপ (বাংলা টেক্সট ও সংখ্যা সঠিক ফেরে)', async () => {
  const db = createTursoDb({ url: mockUrl, token: TOKEN });
  await db.execute('CREATE TABLE t1 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, n INTEGER, f REAL)');
  const ins = await db.execute('INSERT INTO t1 (name, n, f) VALUES (?, ?, ?)', ['রাফি', 42, 2.5]);
  assert.equal(ins.rowsAffected, 1);
  assert.equal(ins.lastInsertRowid, 1);
  const sel = await db.execute('SELECT id, name, n, f FROM t1 WHERE name = ?', ['রাফি']);
  assert.deepEqual(sel.rows, [{ id: 1, name: 'রাফি', n: 42, f: 2.5 }]);
  assert.deepEqual((await db.execute('SELECT * FROM t1 WHERE id = ?', [99])).rows, []);
  assert.equal(await db.ping(), true);
});

test('batch: সব সফল হলে কমিট; একটি ব্যর্থ হলে সব রোলব্যাক', async () => {
  const db = createTursoDb({ url: mockUrl, token: TOKEN });
  await db.execute('CREATE TABLE t2 (k TEXT PRIMARY KEY)');
  const ok = await db.batch([{ sql: 'INSERT INTO t2 VALUES (?)', args: ['a'] }, { sql: 'INSERT INTO t2 VALUES (?)', args: ['b'] }]);
  assert.equal(ok.length, 2);
  assert.equal(ok[0].rowsAffected, 1);
  assert.equal((await db.execute('SELECT COUNT(*) AS c FROM t2')).rows[0].c, 2);

  await assert.rejects(
    db.batch([{ sql: 'INSERT INTO t2 VALUES (?)', args: ['c'] }, { sql: 'INSERT INTO t2 VALUES (?)', args: ['a'] }]), // 'a' ডুপ্লিকেট
    /ডাটাবেস কোয়েরি ব্যর্থ/
  );
  assert.equal((await db.execute('SELECT COUNT(*) AS c FROM t2')).rows[0].c, 2, "'c' রোলব্যাক হওয়ার কথা");
  assert.equal((await db.execute("SELECT COUNT(*) AS c FROM t2 WHERE k = 'c'")).rows[0].c, 0);
  // রোলব্যাকের পর সংযোগ পরিষ্কার — পরের ব্যাচ কাজ করে
  await db.batch([{ sql: 'INSERT INTO t2 VALUES (?)', args: ['d'] }]);
  assert.equal((await db.execute('SELECT COUNT(*) AS c FROM t2')).rows[0].c, 3);
});

test('ত্রুটি: ভুল টোকেনে সাধারণ বার্তা — সার্ভারের বডি/টোকেন ত্রুটিতে ফাঁস হয় না', async () => {
  const db = createTursoDb({ url: mockUrl, token: 'wrong-token' });
  await assert.rejects(db.execute('SELECT 1'), (err) => {
    assert.match(err.message, /HTTP 401/);
    assert.ok(!err.message.includes('wrong-token') && !err.message.includes(TOKEN));
    assert.ok(!JSON.stringify(err).includes('wrong-token'));
    return true;
  });
});

test('ত্রুটি: সংযোগ ব্যর্থ হলে বাংলা DbError', async () => {
  const db = createTursoDb({ url: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 2000 });
  await assert.rejects(db.execute('SELECT 1'), /সংযোগ করা যায়নি/);
});

test('পুরো অ্যাপ Turso ড্রাইভারে: মাইগ্রেশন → কুইজ তৈরি → খেলা → ড্যাশবোর্ড', async () => {
  const t = await startTestServer({
    db: { driver: 'turso', tursoUrl: mockUrl, tursoToken: TOKEN, autoMigrate: true },
    limits: { quizzesPerIpPerDay: 1000 },
  });
  try {
    const q = (await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).json;
    assert.ok(q.id);
    const a = await playQuiz(t, q.id, 'সুমি', [1, 1, 0]);
    assert.equal(a.status, 201, a.text);
    assert.equal(a.json.score, 3);
    const d = await t.call('GET', `/api/owner/${q.id}`, { token: q.ownerToken });
    assert.equal(d.json.stats.attemptsCount, 1);
    assert.equal(d.json.questions[0].counts[1], 1);
    assert.equal((await t.call('GET', `/api/owner/${q.id}`, { token: 'x'.repeat(43) })).status, 403);
    assert.equal((await t.call('DELETE', `/api/owner/${q.id}`, { token: q.ownerToken })).status, 200);
    assert.equal((await t.call('GET', `/api/quizzes/${q.id}`)).status, 404);
    // ডাটাবেস টোকেন কখনো ক্লায়েন্ট রেসপন্সে নেই
    assert.ok(!JSON.stringify(a.json).includes(TOKEN));
  } finally {
    await t.close();
  }
});

test('মাইগ্রেশন Turso ড্রাইভারে আইডেম্পোটেন্ট (দ্বিতীয়বার কিছু প্রয়োগ করে না)', async () => {
  const db = createTursoDb({ url: mockUrl, token: TOKEN });
  assert.deepEqual(await runMigrations(db), []);
});

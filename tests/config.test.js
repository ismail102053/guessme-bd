'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, parseDotenv } = require('../src/config');
const { createLogger, redact } = require('../src/lib/logger');

test('প্রোডাকশনে APP_SECRET না থাকলে/ছোট হলে চালু হয় না (বাংলা বার্তা)', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /APP_SECRET বাধ্যতামূলক/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_SECRET: 'short' }), /কমপক্ষে ৩২/);
  const ok = loadConfig({ NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40) });
  assert.equal(ok.isProd, true);
  assert.equal(ok.ephemeralSecret, false);
});

test('ডেভেলপমেন্টে সিক্রেট না থাকলে অস্থায়ী সিক্রেট তৈরি হয় ও চিহ্নিত থাকে', () => {
  const c = loadConfig({ NODE_ENV: 'development' });
  assert.equal(c.ephemeralSecret, true);
  assert.ok(c.appSecret.length >= 32);
});

test('ভুল কনফিগ মান স্পষ্ট ত্রুটি দেয়', () => {
  assert.throws(() => loadConfig({ APP_SECRET: 'x'.repeat(40), PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ APP_SECRET: 'x'.repeat(40), DB_DRIVER: 'mysql' }), /DB_DRIVER/);
  assert.throws(() => loadConfig({ APP_SECRET: 'x'.repeat(40), DB_DRIVER: 'turso' }), /TURSO_DATABASE_URL/);
  assert.throws(() => loadConfig({ APP_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://a.com/path' }), /PUBLIC_BASE_URL/);
  assert.throws(() => loadConfig({ APP_SECRET: 'x'.repeat(40), RATE_LIMIT_CREATE_PER_HOUR: '0' }), /RATE_LIMIT_CREATE_PER_HOUR/);
  assert.equal(loadConfig({ APP_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://a.com/' }).publicBaseUrl, 'https://a.com');
});

test('.env পার্সার: কমেন্ট, কোট, ইনলাইন কমেন্ট', () => {
  const p = parseDotenv('# c\nA=1\nB="x y"\nC=\'z\'\nD=val # note\n  E = spaced \nbad line\n');
  assert.deepEqual(p, { A: '1', B: 'x y', C: 'z', D: 'val', E: 'spaced' });
});

test('লগার সিক্রেট/টোকেন-সদৃশ ফিল্ড মাস্ক করে এবং বড় স্ট্রিং ছাঁটে', () => {
  const lines = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  log.info('পরীক্ষা', { ownerToken: 'SECRET123', authorization: 'Bearer X', nested: { tursoToken: 'T', ok: 1 }, long: 'a'.repeat(1000) });
  const out = lines[0];
  assert.ok(!out.includes('SECRET123') && !out.includes('Bearer X') && !/"T"/.test(out));
  assert.ok(out.includes('[লুকানো]'));
  assert.ok(out.length < 700);
  assert.equal(redact(new Error('boom')).message, 'boom');
});

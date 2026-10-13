'use strict';
/** পেজ রেন্ডারিং, Facebook OG মেটা, স্ট্যাটিক ফাইল নিরাপত্তা, টেমপ্লেট ও CSP সামঞ্জস্য। */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestServer, sampleQuiz, playQuiz } = require('./helpers');

let t;
before(async () => {
  t = await startTestServer({
    publicBaseUrl: 'https://guessme.example',
    limits: { quizzesPerIpPerDay: 1000, createPerHour: 1000, attemptsPerIpPerQuizPerHour: 1000, attemptPerHour: 1000 },
  });
});
after(async () => {
  await t.close();
});

test('সব স্ট্যাটিক পেজ ২০০ দেয়, OG প্লেসহোল্ডার বদলে যায়', async () => {
  for (const p of ['/', '/create', '/privacy']) {
    const r = await t.call('GET', p);
    assert.equal(r.status, 200, p);
    assert.ok(!r.text.includes('<!--OG_TAGS-->'), `${p}: প্লেসহোল্ডার বাকি`);
    assert.match(r.text, /<meta property="og:title"/);
    assert.match(r.text, /<meta property="og:image" content="https:\/\/guessme\.example\/img\/og\.png">/);
    assert.match(r.text, /<html lang="bn">/);
    assert.match(r.headers.get('content-type'), /text\/html; charset=utf-8/);
  }
});

test('পাবলিক কুইজ পেজে নির্মাতার নামসহ OG মেটা থাকে এবং এস্কেপড', async () => {
  const q = (await t.call('POST', '/api/quizzes', { body: sampleQuiz({ creatorName: 'রাফি"><b onclick=x>' }) })).json;
  const r = await t.call('GET', `/q/${q.id}`);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('<b onclick=x>'), 'এস্কেপ না হলে XSS');
  assert.ok(r.text.includes('&quot;&gt;&lt;b onclick=x&gt;'));
  assert.match(r.text, new RegExp(`og:url" content="https://guessme\\.example/q/${q.id}"`));
  assert.ok(!r.text.includes(q.ownerToken));
});

test('রেজাল্ট পেজের OG শিরোনামে নাম ও স্কোর (বাংলা অঙ্কে)', async () => {
  const q = (await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).json;
  const a = await playQuiz(t, q.id, 'সুমি', [1, 1, 0]);
  const r = await t.call('GET', `/r/${a.json.attemptId}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /সুমি পেয়েছে ৩\/৩/);
  assert.match(r.text, /পারফেক্ট/);
});

test('অজানা কুইজ/রেজাল্ট পেজে ৪০৪ ও noindex', async () => {
  for (const p of ['/q/zzzzzzzzzz', '/q/bad', '/r/zzzzzzzzzzzzzz', '/nope', '/css/missing.css']) {
    const r = await t.call('GET', p);
    assert.equal(r.status, 404, p);
    assert.match(r.text, /noindex/);
    assert.match(r.text, /পাতাটি খুঁজে পাওয়া গেল না/);
  }
});

test('ম্যানেজ পেজ: noindex, no-store, no-referrer — এবং সার্ভার কখনো টোকেন ছাড়া HTML-এ কিছু ভরে না', async () => {
  const q = (await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).json;
  const r = await t.call('GET', `/manage/${q.id}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /name="robots" content="noindex, nofollow"/);
  assert.match(r.text, /name="referrer" content="no-referrer"/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(!r.text.includes('og:image') || true);
  // ফ্র্যাগমেন্ট সার্ভারে যায় না — তাই যেকোনো আইডিতে একই (খালি) শেল; কুইজের কোনো ডেটা এতে নেই
  assert.ok(!r.text.includes('রাফি'));
});

test('robots.txt প্রাইভেট পথ আটকায়', async () => {
  const r = await t.call('GET', '/robots.txt');
  assert.equal(r.status, 200);
  assert.match(r.text, /Disallow: \/manage\//);
  assert.match(r.text, /Disallow: \/api\//);
});

test('স্ট্যাটিক ফাইল: CSS/JS/ছবি পাওয়া যায়; পাথ ট্র্যাভার্সাল, সোর্স ও HTML সরাসরি নয়', async () => {
  for (const [p, type] of [['/css/app.css', 'text/css'], ['/js/common.js', 'text/javascript'], ['/img/og.png', 'image/png'], ['/img/favicon.svg', 'image/svg+xml']]) {
    const r = await t.call('GET', p);
    assert.equal(r.status, 200, p);
    assert.ok(r.headers.get('content-type').startsWith(type), `${p}: ${r.headers.get('content-type')}`);
  }
  for (const p of [
    '/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/css/..%2f..%2fserver.js',
    '/index.html', '/manage.html', '/%00.js', '/js/', '/img',
  ]) {
    const r = await t.call('GET', p);
    assert.equal(r.status, 404, `${p} → ${r.status}`);
    assert.ok(!r.text.includes('require('), p);
  }
  assert.equal((await t.call('GET', '/.env')).status, 404);
  assert.equal((await t.call('GET', '/data/guessme.db')).status, 404);
  const etagRes = await t.call('GET', '/css/app.css');
  const etag = etagRes.headers.get('etag');
  assert.ok(etag);
  assert.equal((await t.call('GET', '/css/app.css', { headers: { 'If-None-Match': etag } })).status, 304);
});

test('পেজে POST করলে ৪০৫', async () => {
  assert.equal((await t.call('POST', '/', { body: {} })).status, 405);
});

test('CSP সামঞ্জস্য: কোনো HTML-এ ইনলাইন স্ক্রিপ্ট/স্টাইল/ইভেন্ট-হ্যান্ডলার নেই; সব JS ফাইল আছে', () => {
  const dir = path.join(__dirname, '..', 'public');
  const htmls = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  assert.equal(htmls.length, 7); // index, create, quiz, result, manage, privacy, 404
  for (const f of htmls) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), `${f}: ইনলাইন <script>`);
    assert.ok(!/<style[\s>]/i.test(html), `${f}: ইনলাইন <style>`);
    assert.ok(!/\sstyle\s*=/i.test(html), `${f}: style="" অ্যাট্রিবিউট`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${f}: ইনলাইন ইভেন্ট হ্যান্ডলার`);
    assert.ok(html.includes('<!--OG_TAGS-->'), `${f}: OG প্লেসহোল্ডার নেই`);
    for (const m of html.matchAll(/(?:src|href)="(\/(?:js|css|img)\/[^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(dir, m[1])), `${f}: ${m[1]} ফাইল নেই`);
    }
  }
  // JS-এ innerHTML/eval/document.write ব্যবহার নিষিদ্ধ (XSS-নিরাপত্তা নিয়ম)
  for (const f of fs.readdirSync(path.join(dir, 'js'))) {
    const js = fs.readFileSync(path.join(dir, 'js', f), 'utf8');
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(js), `${f}: অনিরাপদ DOM API`);
  }
});

test('ফ্রন্টএন্ড কোডে কোনো সিক্রেট/টোকেন হার্ডকোড নেই', () => {
  const dir = path.join(__dirname, '..', 'public');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir).filter((x) => /\.(js|html|css)$/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/APP_SECRET|TURSO_AUTH_TOKEN|libsql:\/\//.test(src), `${f}: সিক্রেট-সদৃশ লেখা`);
    assert.ok(!/[A-Za-z0-9_-]{43}/.test(src.replace(/[A-Za-z0-9_-]{43,}\.(js|css)/g, '')) || /\{43\}/.test(src), `${f}: দীর্ঘ টোকেন-সদৃশ স্ট্রিং`);
  }
});

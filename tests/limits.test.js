'use strict';
/** রেট লিমিট ও স্প্যাম সুরক্ষার টেস্ট — প্রতিটি টেস্টে আলাদা সার্ভার, যাতে সীমা একে অপরকে প্রভাবিত না করে। */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, sampleQuiz, playQuiz } = require('./helpers');
const { createRateLimiter, getClientIp, normalizeIp } = require('../src/lib/ratelimit');
const T = require('../src/lib/tokens');

test('কুইজ তৈরির রেট লিমিট (ঘণ্টায়) — সীমা পেরোলে ৪২৯ ও Retry-After', async () => {
  const t = await startTestServer({ limits: { createPerHour: 3, quizzesPerIpPerDay: 100 } });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).status, 201);
    const r = await t.call('POST', '/api/quizzes', { body: sampleQuiz() });
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'rate_limited');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.match(r.json.error.message, /[ঀ-৿]/);
  } finally {
    await t.close();
  }
});

test('দৈনিক কুইজ তৈরির সীমা (ডাটাবেস-ভিত্তিক, আইপি হ্যাশ ধরে)', async () => {
  const t = await startTestServer({ limits: { createPerHour: 100, quizzesPerIpPerDay: 2 } });
  try {
    assert.equal((await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).status, 201);
    assert.equal((await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).status, 201);
    const r = await t.call('POST', '/api/quizzes', { body: sampleQuiz() });
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'daily_limit');
  } finally {
    await t.close();
  }
});

test('একই আইপি থেকে একই কুইজ ঘণ্টায় সীমিতবার খেলা যায়', async () => {
  const t = await startTestServer({ limits: { attemptsPerIpPerQuizPerHour: 2, attemptPerHour: 100 } });
  try {
    const q = (await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).json;
    assert.equal((await playQuiz(t, q.id, 'এক', [1, 1, 0])).status, 201);
    assert.equal((await playQuiz(t, q.id, 'এক', [1, 1, 0])).status, 201);
    const r = await playQuiz(t, q.id, 'এক', [1, 1, 0]);
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'too_many_attempts');
  } finally {
    await t.close();
  }
});

test('এক কুইজে মোট উত্তরের সর্বোচ্চ সীমা', async () => {
  const t = await startTestServer({ limits: { maxAttemptsPerQuiz: 2, attemptsPerIpPerQuizPerHour: 50, attemptPerHour: 100 } });
  try {
    const q = (await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).json;
    await playQuiz(t, q.id, 'এক', [1, 1, 0]);
    await playQuiz(t, q.id, 'দুই', [1, 1, 0]);
    const r = await playQuiz(t, q.id, 'তিন', [1, 1, 0]);
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'quiz_full');
  } finally {
    await t.close();
  }
});

test('বট-গতি সুরক্ষা: খুলেই সাথে সাথে জমা দিলে প্রত্যাখ্যাত', async () => {
  const t = await startTestServer({ limits: { minMsPerQuestion: 60_000 } });
  try {
    const q = (await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).json;
    const r = await playQuiz(t, q.id, 'বট', [1, 1, 0]);
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'too_fast');
  } finally {
    await t.close();
  }
});

test('ওনার টোকেন অনুমান-আক্রমণ: বারবার ব্যর্থ হলে আইপি ব্লক (৪২৯)', async () => {
  const t = await startTestServer({ limits: { authFailPer15Min: 5, ownerPerMinute: 1000 } });
  try {
    const q = (await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).json;
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await t.call('GET', `/api/owner/${q.id}`, { token: T.newOwnerToken() })).status, 403);
    }
    // এখন সঠিক টোকেন দিলেও ব্লক (আক্রমণকারী যেন ভাগ্যক্রমে না মেলাতে পারে)
    const blocked = await t.call('GET', `/api/owner/${q.id}`, { token: q.ownerToken });
    assert.equal(blocked.status, 429);
  } finally {
    await t.close();
  }
});

test('মেয়াদোত্তীর্ণ টিকেট প্রত্যাখ্যাত (৪১০)', async () => {
  const t = await startTestServer({ ticketTtlMs: 1 });
  try {
    const q = (await t.call('POST', '/api/quizzes', { body: sampleQuiz() })).json;
    const tk = (await t.call('GET', `/api/quizzes/${q.id}`)).json.ticket;
    await new Promise((r) => setTimeout(r, 20));
    const r = await t.call('POST', `/api/quizzes/${q.id}/attempts`, { body: { playerName: 'দেরি', answers: [1, 1, 0], ticket: tk } });
    assert.equal(r.status, 410);
  } finally {
    await t.close();
  }
});

test('X-Forwarded-For: বিশ্বস্ত প্রক্সি সংখ্যা অনুযায়ী ডান দিক থেকে আইপি নেয়, বাঁ দিকের জাল মান উপেক্ষা করে', () => {
  const req = (xff, sock = '10.0.0.1') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: sock } });
  assert.equal(getClientIp(req('6.6.6.6'), 0), '10.0.0.1', 'hops=0 হলে XFF উপেক্ষিত');
  assert.equal(getClientIp(req('9.9.9.9, 1.2.3.4'), 1), '1.2.3.4', 'জাল 9.9.9.9 উপেক্ষিত');
  assert.equal(getClientIp(req('1.2.3.4', '10.0.0.1'), 1), '1.2.3.4');
  assert.equal(getClientIp(req(null), 1), '10.0.0.1');
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), normalizeIp('2001:db8:1:2:1111:2222:3333:4444'), 'একই /64 = একই কী');
});

test('রেট লিমিটার ইউনিট: স্লাইডিং উইন্ডো ও sweep', () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ now: () => now });
  assert.equal(rl.hit('k', 2, 1000).allowed, true);
  assert.equal(rl.hit('k', 2, 1000).allowed, true);
  const blocked = rl.hit('k', 2, 1000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 1);
  now += 1001;
  assert.equal(rl.hit('k', 2, 1000).allowed, true);
  assert.equal(rl.peek('other', 1, 1000).allowed, true);
  now += 10_000_000;
  rl.sweep(1000);
  assert.equal(rl.size(), 0);
});

test('টোকেন/টিকেট ইউনিট: আইডি অক্ষরমালা, হ্যাশ, টিকেট সই', () => {
  const ids = new Set(Array.from({ length: 2000 }, () => T.newQuizId()));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^[a-hjkmnp-z2-9]{10}$/);
  const tok = T.newOwnerToken();
  assert.match(tok, T.OWNER_TOKEN_RE);
  assert.ok(T.safeEqualHex(T.hashToken(tok), T.hashToken(tok)));
  assert.ok(!T.safeEqualHex(T.hashToken(tok), T.hashToken(tok + 'x')));
  assert.ok(!T.safeEqualHex('', ''));
  const secret = 's'.repeat(40);
  const t0 = 1_700_000_000_000; // বাস্তবসম্মত (১৩ অঙ্কের) টাইমস্ট্যাম্প
  const ticket = T.issueTicket(secret, 'abcdefghjk', t0);
  assert.ok(T.verifyTicket(secret, ticket, 'abcdefghjk', t0 + 4000).ok);
  assert.equal(T.verifyTicket(secret, ticket, 'abcdefghjk', t0 + 4000).ageMs, 4000);
  assert.ok(!T.verifyTicket('z'.repeat(40), ticket, 'abcdefghjk', t0 + 4000).ok);
  assert.ok(!T.verifyTicket(secret, ticket, 'zzzzzzzzzz', t0 + 4000).ok);
  assert.ok(!T.verifyTicket(secret, ticket, 'abcdefghjk', t0 - 1000).ok, 'ভবিষ্যতের টিকেট অবৈধ');
  // আইপি হ্যাশ: একই আইপি+দিন = একই; ভিন্ন দিন = ভিন্ন
  assert.equal(T.hashIp(secret, '1.2.3.4', 0), T.hashIp(secret, '1.2.3.4', 1000));
  assert.notEqual(T.hashIp(secret, '1.2.3.4', 0), T.hashIp(secret, '1.2.3.4', 86_400_000));
});

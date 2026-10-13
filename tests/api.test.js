'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, sampleQuiz, playQuiz } = require('./helpers');

let t;
before(async () => {
  // এই ফাইলের টেস্টগুলো একই আইপি থেকে অনেক কুইজ বানায় — তাই এখানে সীমা বাড়ানো; সীমার আচরণ limits.test.js-এ যাচাই হয়
  t = await startTestServer({
    limits: {
      createPerHour: 1000,
      attemptPerHour: 1000,
      readPerMinute: 10000,
      ownerPerMinute: 10000,
      quizzesPerIpPerDay: 1000,
      attemptsPerIpPerQuizPerHour: 1000,
    },
  });
});
after(async () => {
  await t.close();
});

async function makeQuiz(overrides) {
  const r = await t.call('POST', '/api/quizzes', { body: sampleQuiz(overrides) });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

test('কুইজ তৈরি: ১টি ইউনিক আইডি, ওনার টোকেন ও সঠিক লিংক ফেরত আসে', async () => {
  const q = await makeQuiz();
  assert.match(q.id, /^[a-hjkmnp-z2-9]{10}$/);
  assert.match(q.ownerToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(q.publicUrl, `${t.base}/q/${q.id}`);
  assert.equal(q.manageUrl, `${t.base}/manage/${q.id}#${q.ownerToken}`);
  assert.ok(!q.publicUrl.includes(q.ownerToken), 'পাবলিক লিংকে টোকেন থাকা চলবে না');
  const q2 = await makeQuiz();
  assert.notEqual(q.id, q2.id);
  assert.notEqual(q.ownerToken, q2.ownerToken);
});

test('ডাটাবেসে ওনার টোকেন কাঁচা অবস্থায় নেই, শুধু SHA-256 হ্যাশ আছে; কাঁচা আইপিও নেই', async () => {
  const q = await makeQuiz();
  const row = (await t.db.execute('SELECT owner_token_hash, creator_ip_hash FROM quizzes WHERE id = ?', [q.id])).rows[0];
  assert.notEqual(row.owner_token_hash, q.ownerToken);
  assert.match(row.owner_token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!row.creator_ip_hash.includes('127.0.0.1'));
  assert.match(row.creator_ip_hash, /^[0-9a-f]{32}$/);
});

test('পাবলিক কুইজ: সঠিক উত্তর বা ওনার তথ্য কখনো ফাঁস হয় না', async () => {
  const q = await makeQuiz();
  const r = await t.call('GET', `/api/quizzes/${q.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.creatorName, 'রাফি');
  assert.equal(r.json.questions.length, 3);
  assert.ok(r.json.ticket);
  const dump = r.text;
  assert.ok(!/correct/i.test(dump), 'correct* ফিল্ড থাকা চলবে না');
  assert.ok(!dump.includes(q.ownerToken));
  assert.ok(!/owner_token|hash/i.test(dump));
});

test('অজানা বা ভুল ফরম্যাটের কুইজ আইডিতে ৪০৪', async () => {
  assert.equal((await t.call('GET', '/api/quizzes/abcdefghjk')).status, 404);
  assert.equal((await t.call('GET', '/api/quizzes/x')).status, 404);
  assert.equal((await t.call('GET', "/api/quizzes/'%20OR%201=1--")).status, 404);
});

test('উত্তর জমা: সার্ভার সঠিক স্কোর গণনা করে এবং রিভিউ দেয়', async () => {
  const q = await makeQuiz();
  const r = await playQuiz(t, q.id, 'সুমি', [1, 1, 1]); // সঠিক: [1,1,0] → ২টি ঠিক
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.score, 2);
  assert.equal(r.json.total, 3);
  assert.deepEqual(r.json.review.map((x) => x.isCorrect), [true, true, false]);
  assert.deepEqual(r.json.review.map((x) => x.correctIndex), [1, 1, 0]);
  assert.match(r.json.attemptId, /^[a-hjkmnp-z2-9]{14}$/);
});

test('শেয়ারযোগ্য রেজাল্ট কার্ড শুধু নাম ও স্কোর দেখায়', async () => {
  const q = await makeQuiz();
  const a = await playQuiz(t, q.id, 'তানভীর', [1, 1, 0]);
  const r = await t.call('GET', `/api/attempts/${a.json.attemptId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.playerName, 'তানভীর');
  assert.equal(r.json.score, 3);
  assert.equal(r.json.quiz.creatorName, 'রাফি');
  assert.ok(!('answers' in r.json));
  assert.ok(!r.text.includes(q.ownerToken));
});

test('ওনার ড্যাশবোর্ড: টোকেন ছাড়া/ভুল টোকেনে ৪০৩, সঠিক টোকেনে সম্পূর্ণ ডেটা', async () => {
  const q = await makeQuiz();
  await playQuiz(t, q.id, 'এক', [1, 1, 0]);
  await playQuiz(t, q.id, 'দুই', [0, 1, 1]);

  assert.equal((await t.call('GET', `/api/owner/${q.id}`)).status, 403);
  assert.equal((await t.call('GET', `/api/owner/${q.id}`, { token: 'x'.repeat(43) })).status, 403);
  assert.equal((await t.call('GET', `/api/owner/${q.id}?token=${q.ownerToken}`)).status, 403, 'কুয়েরি-স্ট্রিংয়ে টোকেন চলবে না');

  const other = await makeQuiz();
  assert.equal((await t.call('GET', `/api/owner/${q.id}`, { token: other.ownerToken })).status, 403, 'অন্য কুইজের টোকেন চলবে না');

  const d = await t.call('GET', `/api/owner/${q.id}`, { token: q.ownerToken });
  assert.equal(d.status, 200);
  assert.equal(d.json.stats.attemptsCount, 2);
  assert.equal(d.json.stats.perfectCount, 1);
  // 'এক' [1,1,0] = ৩/৩; 'দুই' [0,1,1] = ১/৩ (শুধু দ্বিতীয়টি ঠিক) → গড় (১ + ১/৩) / ২ = ৬৭%
  assert.equal(d.json.stats.averagePercent, 67);
  assert.equal(d.json.attempts.length, 2);
  assert.equal(d.json.questions[1].counts[1], 2);
  assert.equal(d.json.questions[0].correctPercent, 50);
  const names = d.json.attempts.map((a) => a.playerName).sort();
  assert.deepEqual(names, ['এক', 'দুই']);
  assert.ok(d.json.attempts.every((a) => a.answers.length === 3));
  assert.ok(!d.text.includes(q.ownerToken));
  assert.ok(!/ip_hash|owner_token/i.test(d.text));
});

test('অন্য কুইজের ওনার টোকেন দিয়ে মোছা/বন্ধ করা যায় না', async () => {
  const a = await makeQuiz();
  const b = await makeQuiz();
  assert.equal((await t.call('DELETE', `/api/owner/${a.id}`, { token: b.ownerToken })).status, 403);
  assert.equal((await t.call('PATCH', `/api/owner/${a.id}`, { token: b.ownerToken, body: { isClosed: true } })).status, 403);
  assert.equal((await t.call('GET', `/api/quizzes/${a.id}`)).status, 200);
});

test('কুইজ বন্ধ করলে নতুন উত্তর নেয় না; আবার খুললে নেয়', async () => {
  const q = await makeQuiz();
  const closed = await t.call('PATCH', `/api/owner/${q.id}`, { token: q.ownerToken, body: { isClosed: true } });
  assert.equal(closed.status, 200);
  const r = await playQuiz(t, q.id, 'কেউ', [1, 1, 0]);
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'quiz_closed');
  assert.equal((await t.call('GET', `/api/quizzes/${q.id}`)).json.isClosed, true);
  await t.call('PATCH', `/api/owner/${q.id}`, { token: q.ownerToken, body: { isClosed: false } });
  assert.equal((await playQuiz(t, q.id, 'কেউ', [1, 1, 0])).status, 201);
  assert.equal((await t.call('PATCH', `/api/owner/${q.id}`, { token: q.ownerToken, body: { isClosed: 'yes' } })).status, 422);
});

test('একটি উত্তর মোছা এবং পুরো কুইজ মোছা (সব সম্পর্কিত ডেটাসহ)', async () => {
  const q = await makeQuiz();
  const a1 = await playQuiz(t, q.id, 'এক', [1, 1, 0]);
  await playQuiz(t, q.id, 'দুই', [1, 1, 0]);

  const del = await t.call('DELETE', `/api/owner/${q.id}/attempts/${a1.json.attemptId}`, { token: q.ownerToken });
  assert.equal(del.status, 200);
  assert.equal((await t.call('GET', `/api/attempts/${a1.json.attemptId}`)).status, 404);
  assert.equal((await t.call('DELETE', `/api/owner/${q.id}/attempts/${a1.json.attemptId}`, { token: q.ownerToken })).status, 404);
  assert.equal((await t.call('GET', `/api/owner/${q.id}`, { token: q.ownerToken })).json.stats.attemptsCount, 1);

  assert.equal((await t.call('DELETE', `/api/owner/${q.id}`, { token: q.ownerToken })).status, 200);
  assert.equal((await t.call('GET', `/api/quizzes/${q.id}`)).status, 404);
  const left = async (sql) => (await t.db.execute(sql, [q.id])).rows[0].c;
  assert.equal(await left('SELECT COUNT(*) c FROM questions WHERE quiz_id = ?'), 0);
  assert.equal(await left('SELECT COUNT(*) c FROM attempts WHERE quiz_id = ?'), 0);
  assert.equal((await t.db.execute('SELECT COUNT(*) c FROM answers WHERE attempt_id NOT IN (SELECT id FROM attempts)')).rows[0].c, 0);
});

test('ভ্যালিডেশন: বাংলা ত্রুটি বার্তা ও ফিল্ড-ভিত্তিক ম্যাপ', async () => {
  const bad = [
    [{ ...sampleQuiz(), creatorName: '' }, 'creatorName'],
    [{ ...sampleQuiz(), creatorName: 'ক' }, 'creatorName'],
    [{ ...sampleQuiz(), creatorName: 'a'.repeat(31) }, 'creatorName'],
    [{ ...sampleQuiz(), questions: sampleQuiz().questions.slice(0, 2) }, 'questions'],
    [{ ...sampleQuiz(), questions: Array(16).fill(sampleQuiz().questions[0]) }, 'questions'],
    [{ ...sampleQuiz(), creatorName: 'দেখো www.spam.com' }, 'creatorName'],
    [{ ...sampleQuiz(), title: 'ফ্রি টাকা https://evil.example' }, 'title'],
  ];
  for (const [body, field] of bad) {
    const r = await t.call('POST', '/api/quizzes', { body });
    assert.equal(r.status, 422, JSON.stringify(body).slice(0, 80));
    assert.ok(r.json.error.fields[field], `${field} এর ত্রুটি থাকা উচিত`);
    assert.match(Object.values(r.json.error.fields)[0], /[ঀ-৿]/, 'বার্তা বাংলায় হবে');
  }
  const qs = sampleQuiz().questions;
  const r1 = await t.call('POST', '/api/quizzes', { body: sampleQuiz({ questions: [{ ...qs[0], correctIndex: 5 }, qs[1], qs[2]] }) });
  assert.ok(r1.json.error.fields['questions.0.correctIndex']);
  const r2 = await t.call('POST', '/api/quizzes', { body: sampleQuiz({ questions: [{ ...qs[0], options: ['এক'] }, qs[1], qs[2]] }) });
  assert.ok(r2.json.error.fields['questions.0.options']);
  const r3 = await t.call('POST', '/api/quizzes', { body: sampleQuiz({ questions: [{ ...qs[0], options: ['একই', 'একই'] }, qs[1], qs[2]] }) });
  assert.ok(r3.json.error.fields['questions.0.options.1']);
});

test('XSS/ইনজেকশন স্ট্রিং ডেটা হিসেবেই সংরক্ষিত হয় (এস্কেপ করার দায়িত্ব রেন্ডারারের), SQL ইনজেকশন কাজ করে না', async () => {
  const evil = `রাফি'); DROP TABLE quizzes;--`;
  const q = await makeQuiz({ creatorName: evil, title: '<img src=x onerror=alert(1)>' });
  const r = await t.call('GET', `/api/quizzes/${q.id}`);
  assert.equal(r.json.creatorName, evil);
  assert.equal(r.json.title, '<img src=x onerror=alert(1)>');
  assert.equal((await t.db.execute('SELECT COUNT(*) c FROM quizzes')).rows[0].c > 0, true);
  // OG পেজে এস্কেপ হচ্ছে কি না আলাদা পেজ-টেস্টে (page.test.js) যাচাই হবে
});

test('অ্যাটেম্পট ভ্যালিডেশন: ভুল সংখ্যক উত্তর, সীমার বাইরের ইনডেক্স, জাল টিকেট', async () => {
  const q = await makeQuiz();
  const open = await t.call('GET', `/api/quizzes/${q.id}`);
  const url = `/api/quizzes/${q.id}/attempts`;
  const ticket = open.json.ticket;

  assert.equal((await t.call('POST', url, { body: { playerName: 'ক খ', answers: [1, 1], ticket } })).status, 422);
  assert.equal((await t.call('POST', url, { body: { playerName: 'ক খ', answers: [1, 1, 9], ticket } })).status, 422);
  assert.equal((await t.call('POST', url, { body: { playerName: 'ক খ', answers: [1, 1, '0'], ticket } })).status, 422);
  assert.equal((await t.call('POST', url, { body: { playerName: '', answers: [1, 1, 0], ticket } })).status, 422);
  // প্রশ্ন ৩-এ মাত্র ২টি অপশন — ইনডেক্স ২ অবৈধ
  assert.equal((await t.call('POST', url, { body: { playerName: 'ক খ', answers: [1, 1, 2], ticket } })).status, 422);
  const forged = await t.call('POST', url, { body: { playerName: 'ক খ', answers: [1, 1, 0], ticket: `${q.id}.${Date.now() - 5000}.AAAAAAAAAAAAAAAAAAAAAAAAAAA` } });
  assert.equal(forged.status, 400);
  assert.equal(forged.json.error.code, 'bad_ticket');
  // অন্য কুইজের টিকেট
  const other = await makeQuiz();
  const otherTicket = (await t.call('GET', `/api/quizzes/${other.id}`)).json.ticket;
  assert.equal((await t.call('POST', url, { body: { playerName: 'ক খ', answers: [1, 1, 0], ticket: otherTicket } })).status, 400);
});

test('বিকৃত অনুরোধ: খারাপ JSON, ভুল Content-Type, বড় বডি, অচেনা রুট, ভুল মেথড', async () => {
  assert.equal((await t.call('POST', '/api/quizzes', { raw: '{bad json', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await t.call('POST', '/api/quizzes', { raw: 'a=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  const big = await t.call('POST', '/api/quizzes', { raw: JSON.stringify({ x: 'a'.repeat(70 * 1024) }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(big.status, 413);
  assert.equal((await t.call('GET', '/api/nope')).status, 404);
  assert.equal((await t.call('PUT', '/api/quizzes')).status, 404);
  assert.equal((await t.call('POST', '/api/quizzes', { body: [1, 2] })).status, 422);
  assert.equal((await t.call('POST', '/api/quizzes', { body: 'str' })).status, 422);
});

test('CSRF: ভিন্ন Origin থেকে পরিবর্তনকারী অনুরোধ ব্লক হয়', async () => {
  const r = await t.call('POST', '/api/quizzes', { body: sampleQuiz(), headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'bad_origin');
  const ok = await t.call('POST', '/api/quizzes', { body: sampleQuiz(), headers: { Origin: t.base } });
  assert.equal(ok.status, 201);
});

test('হানিপট ফিল্ড ভরা থাকলে (বট) অনুরোধ প্রত্যাখ্যাত হয়', async () => {
  const r = await t.call('POST', '/api/quizzes', { body: { ...sampleQuiz(), website: 'http://spam.example' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'spam_detected');
  const q = await makeQuiz();
  const tk = (await t.call('GET', `/api/quizzes/${q.id}`)).json.ticket;
  const r2 = await t.call('POST', `/api/quizzes/${q.id}/attempts`, { body: { playerName: 'বট', answers: [1, 1, 0], ticket: tk, website: 'x' } });
  assert.equal(r2.status, 400);
});

test('নিরাপত্তা হেডার, ত্রুটির রেসপন্সে স্ট্যাক ট্রেস/ভেতরের তথ্য নেই', async () => {
  const r = await t.call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.headers.get('x-request-id'));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const e = await t.call('GET', '/api/quizzes/zzzzzzzzzz');
  assert.ok(!/at .*\.js|node_modules|sqlite/i.test(e.text));
});

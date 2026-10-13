'use strict';
const { loadConfig } = require('../src/config');
const { createServer } = require('../server');

/** টেস্টের জন্য ইন-মেমোরি SQLite-সহ আসল সার্ভার চালু করে (র‍্যান্ডম পোর্টে)। */
async function startTestServer(overrides = {}) {
  const config = loadConfig(
    { NODE_ENV: 'test', APP_SECRET: 'test-secret-test-secret-test-secret-123456', LOG_SILENT: 'true' },
    {
      db: { driver: 'sqlite', sqlitePath: ':memory:', autoMigrate: true },
      port: 0,
      host: '127.0.0.1',
      silent: true,
      ...overrides,
      limits: { minMsPerQuestion: 0, ...(overrides.limits || {}) },
    }
  );
  const ctx = await createServer(config);
  await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;

  async function call(method, path, { body, token, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method,
      headers: h,
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* HTML বা টেক্সট */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  return { ...ctx, base, config, call };
}

function sampleQuiz(overrides = {}) {
  return {
    creatorName: 'রাফি',
    title: 'আমাকে কতটা চেনো?',
    questions: [
      { text: 'আমার প্রিয় খাবার কী?', options: ['বিরিয়ানি', 'খিচুড়ি', 'ভর্তা-ভাত'], correctIndex: 1 },
      { text: 'আমার প্রিয় ঋতু কোনটি?', options: ['গ্রীষ্ম', 'বর্ষা', 'শীত', 'বসন্ত'], correctIndex: 1 },
      { text: 'আমি কোন খেলা সবচেয়ে ভালোবাসি?', options: ['ক্রিকেট', 'ফুটবল'], correctIndex: 0 },
    ],
    ...overrides,
  };
}

/** কুইজ তৈরি → খুলে টিকেট নেওয়া → উত্তর জমা: পুরো ফ্লো-র শর্টকাট। */
async function playQuiz(t, quizId, playerName, answers) {
  const q = await t.call('GET', `/api/quizzes/${quizId}`);
  return t.call('POST', `/api/quizzes/${quizId}/attempts`, {
    body: { playerName, answers, ticket: q.json.ticket },
  });
}

module.exports = { startTestServer, sampleQuiz, playQuiz };

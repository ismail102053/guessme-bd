'use strict';
/**
 * JSON API হ্যান্ডলার।
 *
 * পাবলিক:
 *   POST   /api/quizzes                      কুইজ তৈরি → ownerToken একবারই দেওয়া হয়
 *   GET    /api/quizzes/:id                  পাবলিক কুইজ (সঠিক উত্তর ছাড়া) + টিকেট
 *   POST   /api/quizzes/:id/attempts         উত্তর জমা → স্কোর ও রিভিউ
 *   GET    /api/attempts/:id                 শেয়ারযোগ্য রেজাল্ট কার্ড (শুধু নাম ও স্কোর)
 * ওনার (Authorization: Bearer <ownerToken>):
 *   GET    /api/owner/:id                    ড্যাশবোর্ড
 *   PATCH  /api/owner/:id                    { isClosed: boolean }
 *   DELETE /api/owner/:id                    কুইজ মুছুন
 *   DELETE /api/owner/:id/attempts/:attemptId
 */
const { HttpError, readJson, sendJson } = require('../http/util');
const T = require('../lib/tokens');
const { validateCreateQuiz, validateAttempt } = require('../lib/validate');
const { getClientIp } = require('../lib/ratelimit');

const QUIZ_ID_RE = /^[a-hjkmnp-z2-9]{10}$/;
const ATTEMPT_ID_RE = /^[a-hjkmnp-z2-9]{14}$/;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const MSG = {
  tooMany: 'অনেক বেশি অনুরোধ করা হয়েছে। একটু অপেক্ষা করে আবার চেষ্টা করো।',
  notFound: 'কুইজটি খুঁজে পাওয়া যায়নি। লিংকটি ঠিক আছে কি না দেখো।',
  forbidden: 'এই লিংকটি সঠিক নয় বা মেয়াদোত্তীর্ণ। কুইজ তৈরির সময় পাওয়া গোপন লিংকটি ব্যবহার করো।',
};

function createApi({ config, repo, db, limiter, logger }) {
  const L = config.limits;

  function rateLimit(key, limit, windowMs) {
    const r = limiter.hit(key, limit, windowMs);
    if (!r.allowed) {
      throw new HttpError(429, 'rate_limited', MSG.tooMany, { retryAfterSec: r.retryAfterSec });
    }
  }

  async function authOwner(req, quizId, ip) {
    const failKey = `authfail:${ip}`;
    const blocked = limiter.peek(failKey, L.authFailPer15Min, 15 * 60_000);
    if (!blocked.allowed) {
      throw new HttpError(429, 'rate_limited', MSG.tooMany, { retryAfterSec: blocked.retryAfterSec });
    }
    const header = String(req.headers.authorization || '');
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    const storedHash = QUIZ_ID_RE.test(quizId) ? await repo.getOwnerHash(quizId) : null;
    // টাইমিং সমান রাখতে সবসময় একটি হ্যাশ তুলনা করি (কুইজ আছে কি না বোঝা যাবে না)
    const candidate = T.hashToken(m ? m[1] : 'invalid');
    const ok = Boolean(m && storedHash && T.safeEqualHex(candidate, storedHash));
    if (!ok) {
      limiter.hit(failKey, L.authFailPer15Min, 15 * 60_000);
      throw new HttpError(403, 'forbidden', MSG.forbidden);
    }
  }

  async function createQuiz(req, res, ctx) {
    rateLimit(`create:${ctx.ip}`, L.createPerHour, HOUR);
    const body = await readJson(req, config.bodyLimitBytes);
    if (body && typeof body.website === 'string' && body.website.trim() !== '') {
      throw new HttpError(400, 'spam_detected', 'অনুরোধটি গ্রহণ করা যায়নি।'); // হানিপট ফিল্ড
    }
    const v = validateCreateQuiz(body);
    if (!v.ok) throw new HttpError(422, 'validation_failed', 'কিছু তথ্য ঠিক করতে হবে।', v.errors);

    const since = Date.now() - DAY;
    if ((await repo.countQuizzesByIpSince(ctx.ipHash, since)) >= L.quizzesPerIpPerDay) {
      throw new HttpError(429, 'daily_limit', 'আজকের জন্য কুইজ তৈরির সীমা পূর্ণ হয়েছে। কাল আবার চেষ্টা করো।');
    }

    const ownerToken = T.newOwnerToken();
    let id;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      id = T.newQuizId();
      try {
        await repo.createQuiz({
          id,
          tokenHash: T.hashToken(ownerToken),
          creatorName: v.value.creatorName,
          title: v.value.title,
          questions: v.value.questions,
          ipHash: ctx.ipHash,
          now: Date.now(),
        });
        break;
      } catch (err) {
        const dup = /UNIQUE|constraint/i.test(String(err.cause?.message || err.message));
        if (!dup || attempt === 2) throw err;
      }
    }
    logger.info('কুইজ তৈরি হয়েছে', { quizId: id, questions: v.value.questions.length });
    const base = ctx.baseUrl;
    sendJson(res, 201, {
      id,
      ownerToken, // শুধু এই একটি রেসপন্সেই — সার্ভারে শুধু হ্যাশ থাকে
      publicUrl: `${base}/q/${id}`,
      manageUrl: `${base}/manage/${id}#${ownerToken}`, // # এর পরের অংশ সার্ভারে/লগে/Referer-এ যায় না
    });
  }

  async function getQuiz(req, res, ctx, id) {
    rateLimit(`read:${ctx.ip}`, L.readPerMinute, 60_000);
    if (!QUIZ_ID_RE.test(id)) throw new HttpError(404, 'not_found', MSG.notFound);
    const quiz = await repo.getPublicQuiz(id);
    if (!quiz) throw new HttpError(404, 'not_found', MSG.notFound);
    sendJson(res, 200, { ...quiz, ticket: T.issueTicket(config.appSecret, id) });
  }

  async function submitAttempt(req, res, ctx, id) {
    rateLimit(`attempt:${ctx.ip}`, L.attemptPerHour, HOUR);
    if (!QUIZ_ID_RE.test(id)) throw new HttpError(404, 'not_found', MSG.notFound);
    const body = await readJson(req, config.bodyLimitBytes);
    const quiz = await repo.getQuizWithKey(id);
    if (!quiz) throw new HttpError(404, 'not_found', MSG.notFound);

    if (body && typeof body.website === 'string' && body.website.trim() !== '') {
      throw new HttpError(400, 'spam_detected', 'অনুরোধটি গ্রহণ করা যায়নি।');
    }
    const v = validateAttempt(body, quiz.questions.length);
    if (!v.ok) throw new HttpError(422, 'validation_failed', 'কিছু তথ্য ঠিক করতে হবে।', v.errors);

    if (quiz.isClosed) {
      throw new HttpError(403, 'quiz_closed', 'কুইজের মালিক এই কুইজটি বন্ধ করে দিয়েছেন, তাই নতুন উত্তর নেওয়া হচ্ছে না।');
    }

    const t = T.verifyTicket(config.appSecret, v.value.ticket, id);
    if (!t.ok) {
      throw new HttpError(400, 'bad_ticket', 'পেজটির মেয়াদ শেষ বা তথ্য সঠিক নয়। পেজ রিফ্রেশ করে আবার খেলো।');
    }
    if (t.ageMs > config.ticketTtlMs) {
      throw new HttpError(410, 'ticket_expired', 'অনেকক্ষণ আগে খেলা শুরু করেছিলে। পেজ রিফ্রেশ করে আবার খেলো।');
    }
    if (t.ageMs < L.minMsPerQuestion * quiz.questions.length) {
      throw new HttpError(429, 'too_fast', 'একটু ধীরে! প্রশ্নগুলো পড়ে তারপর উত্তর দাও।');
    }

    if ((await repo.countAttempts(id)) >= L.maxAttemptsPerQuiz) {
      throw new HttpError(429, 'quiz_full', 'এই কুইজে সর্বোচ্চ সংখ্যক উত্তর জমা হয়ে গেছে।');
    }
    if ((await repo.countAttemptsByIpQuizSince(ctx.ipHash, id, Date.now() - HOUR)) >= L.attemptsPerIpPerQuizPerHour) {
      throw new HttpError(429, 'too_many_attempts', 'এই কুইজটি তুমি অনেকবার খেলে ফেলেছ। এক ঘণ্টা পরে আবার চেষ্টা করো।');
    }

    // সার্ভারেই স্কোর গণনা — ক্লায়েন্টের কথায় বিশ্বাস নয়
    const answers = [];
    let score = 0;
    for (let i = 0; i < quiz.questions.length; i += 1) {
      const q = quiz.questions[i];
      const chosen = v.value.answers[i];
      if (chosen >= q.optionCount) {
        throw new HttpError(422, 'validation_failed', 'কিছু তথ্য ঠিক করতে হবে।', { answers: 'উত্তরের ফরম্যাট সঠিক নয়।' });
      }
      const isCorrect = chosen === q.correctIndex;
      if (isCorrect) score += 1;
      answers.push({ questionId: q.id, chosenIndex: chosen, isCorrect });
    }

    const attemptId = T.newAttemptId();
    await repo.createAttempt({
      id: attemptId,
      quizId: id,
      playerName: v.value.playerName,
      score,
      total: quiz.questions.length,
      ipHash: ctx.ipHash,
      now: Date.now(),
      answers,
    });
    sendJson(res, 201, {
      attemptId,
      score,
      total: quiz.questions.length,
      resultUrl: `${ctx.baseUrl}/r/${attemptId}`,
      review: quiz.questions.map((q, i) => ({
        chosenIndex: v.value.answers[i],
        correctIndex: q.correctIndex,
        isCorrect: answers[i].isCorrect,
      })),
    });
  }

  async function getAttempt(req, res, ctx, id) {
    rateLimit(`read:${ctx.ip}`, L.readPerMinute, 60_000);
    if (!ATTEMPT_ID_RE.test(id)) throw new HttpError(404, 'not_found', 'রেজাল্টটি খুঁজে পাওয়া যায়নি।');
    const a = await repo.getPublicAttempt(id);
    if (!a) throw new HttpError(404, 'not_found', 'রেজাল্টটি খুঁজে পাওয়া যায়নি।');
    sendJson(res, 200, a);
  }

  async function ownerGet(req, res, ctx, id) {
    rateLimit(`owner:${ctx.ip}`, L.ownerPerMinute, 60_000);
    await authOwner(req, id, ctx.ip);
    const data = await repo.getOwnerDashboard(id);
    if (!data) throw new HttpError(404, 'not_found', MSG.notFound);
    sendJson(res, 200, data);
  }

  async function ownerPatch(req, res, ctx, id) {
    rateLimit(`owner:${ctx.ip}`, L.ownerPerMinute, 60_000);
    await authOwner(req, id, ctx.ip);
    const body = await readJson(req, config.bodyLimitBytes);
    if (!body || typeof body.isClosed !== 'boolean') {
      throw new HttpError(422, 'validation_failed', 'isClosed অবশ্যই true বা false হতে হবে।');
    }
    await repo.setClosed(id, body.isClosed);
    sendJson(res, 200, { isClosed: body.isClosed });
  }

  async function ownerDelete(req, res, ctx, id) {
    rateLimit(`owner:${ctx.ip}`, L.ownerPerMinute, 60_000);
    await authOwner(req, id, ctx.ip);
    await repo.deleteQuiz(id);
    logger.info('কুইজ মুছে ফেলা হয়েছে', { quizId: id });
    sendJson(res, 200, { deleted: true });
  }

  async function ownerDeleteAttempt(req, res, ctx, id, attemptId) {
    rateLimit(`owner:${ctx.ip}`, L.ownerPerMinute, 60_000);
    await authOwner(req, id, ctx.ip);
    if (!ATTEMPT_ID_RE.test(attemptId)) throw new HttpError(404, 'not_found', 'উত্তরটি খুঁজে পাওয়া যায়নি।');
    const ok = await repo.deleteAttempt(id, attemptId);
    if (!ok) throw new HttpError(404, 'not_found', 'উত্তরটি খুঁজে পাওয়া যায়নি।');
    sendJson(res, 200, { deleted: true });
  }

  async function health(req, res) {
    try {
      await db.ping();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      logger.error('হেলথ চেক ব্যর্থ', { err });
      sendJson(res, 503, { ok: false });
    }
  }

  /** @returns {Promise<boolean>} রুট মিললে true */
  async function handle(req, res, url, ctx) {
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;
    let r;
    let run = null; // মিলে যাওয়া হ্যান্ডলারের থাঙ্ক

    if (p === '/api/health' && m === 'GET') run = () => health(req, res);
    else if (p === '/api/quizzes' && m === 'POST') run = () => createQuiz(req, res, ctx);
    else if ((r = /^\/api\/quizzes\/([^/]+)$/.exec(p)) && m === 'GET') run = () => getQuiz(req, res, ctx, r[1]);
    else if ((r = /^\/api\/quizzes\/([^/]+)\/attempts$/.exec(p)) && m === 'POST') run = () => submitAttempt(req, res, ctx, r[1]);
    else if ((r = /^\/api\/attempts\/([^/]+)$/.exec(p)) && m === 'GET') run = () => getAttempt(req, res, ctx, r[1]);
    else if ((r = /^\/api\/owner\/([^/]+)$/.exec(p)) && m === 'GET') run = () => ownerGet(req, res, ctx, r[1]);
    else if ((r = /^\/api\/owner\/([^/]+)$/.exec(p)) && m === 'PATCH') run = () => ownerPatch(req, res, ctx, r[1]);
    else if ((r = /^\/api\/owner\/([^/]+)$/.exec(p)) && m === 'DELETE') run = () => ownerDelete(req, res, ctx, r[1]);
    else if ((r = /^\/api\/owner\/([^/]+)\/attempts\/([^/]+)$/.exec(p)) && m === 'DELETE') {
      run = () => ownerDeleteAttempt(req, res, ctx, r[1], r[2]);
    }

    if (!run) return false;
    await run(); // await করা জরুরি, যাতে ত্রুটি কলারের catch-এ পৌঁছায়
    return true;
  }

  return { handle, ctxFor: (req) => {
    const ip = getClientIp(req, config.trustProxyHops);
    return { ip, ipHash: T.hashIp(config.appSecret, ip) };
  } };
}

module.exports = { createApi, QUIZ_ID_RE, ATTEMPT_ID_RE };

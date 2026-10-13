'use strict';
/**
 * আইডি, ওনার টোকেন, আইপি হ্যাশ ও টিকেট সংক্রান্ত নিরাপত্তা ফাংশন।
 * সবকিছু Node crypto দিয়ে (CSPRNG, HMAC, SHA-256, timingSafeEqual)।
 */
const crypto = require('node:crypto');

// বিভ্রান্তিকর অক্ষর (0/o, 1/l/i) বাদ — শেয়ার করা লিংক পড়তে সুবিধা হয়
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomString(length, alphabet = ID_ALPHABET) {
  // rejection sampling — পক্ষপাতহীন র‍্যান্ডম
  const max = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const b of bytes) {
      if (b < max) {
        out += alphabet[b % alphabet.length];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

const newQuizId = () => randomString(10);
const newAttemptId = () => randomString(14);

/** ২৫৬-বিট র‍্যান্ডম ওনার টোকেন (base64url, ৪৩ অক্ষর)। */
const newOwnerToken = () => crypto.randomBytes(32).toString('base64url');
const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * আইপি-কে প্রতিদিন বদলানো HMAC হ্যাশে রূপান্তর (কাঁচা আইপি কখনো ডাটাবেসে যায় না)।
 * দৈনিক লবণ থাকায় দিনের সীমানা পেরোলে একই ব্যক্তিকে ট্র্যাক করা যায় না।
 */
function hashIp(secret, ip, now = Date.now()) {
  const day = Math.floor(now / 86_400_000);
  return crypto.createHmac('sha256', secret).update(`ip|${day}|${ip}`).digest('hex').slice(0, 32);
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 27);
}

/** কুইজ খোলার সময় ইস্যু করা স্টেটলেস টিকেট: "<quizId>.<issuedAtMs>.<sig>" */
function issueTicket(secret, quizId, now = Date.now()) {
  const payload = `ticket|${quizId}|${now}`;
  return `${quizId}.${now}.${sign(secret, payload)}`;
}

function verifyTicket(secret, ticket, quizId, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 80) return { ok: false, reason: 'format' };
  const parts = ticket.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  const [tQuiz, tIssued, tSig] = parts;
  if (tQuiz !== quizId || !/^\d{10,15}$/.test(tIssued)) return { ok: false, reason: 'format' };
  const expected = sign(secret, `ticket|${tQuiz}|${tIssued}`);
  const a = Buffer.from(tSig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature' };
  const ageMs = now - Number(tIssued);
  if (ageMs < 0) return { ok: false, reason: 'future' };
  return { ok: true, ageMs };
}

module.exports = {
  randomString,
  newQuizId,
  newAttemptId,
  newOwnerToken,
  OWNER_TOKEN_RE,
  hashToken,
  safeEqualHex,
  hashIp,
  issueTicket,
  verifyTicket,
};

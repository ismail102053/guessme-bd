'use strict';
/**
 * কনফিগারেশন লোডার।
 * - ছোট .env পার্সার (কোনো npm প্যাকেজ ছাড়াই)
 * - loadConfig(env) একটি ফ্রিজ করা কনফিগ অবজেক্ট দেয়, যাতে টেস্টে আলাদা কনফিগ দেওয়া যায়।
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function parseDotenv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // ইনলাইন কমেন্ট বাদ (শুধু কোট ছাড়া মানের জন্য)
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/** প্রজেক্ট রুটের .env ফাইল থেকে process.env-এ মান বসায় (আগে থেকে সেট থাকলে বদলায় না)। */
function loadDotenvFile(file = path.join(__dirname, '..', '.env')) {
  try {
    const parsed = parseDotenv(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function int(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`কনফিগ ত্রুটি: ${name} অবশ্যই ${min}–${max} এর মধ্যে একটি পূর্ণসংখ্যা হতে হবে (পেয়েছি: "${raw}")`);
  }
  return n;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function loadConfig(env = process.env, overrides = {}) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';

  let appSecret = env.APP_SECRET || '';
  let ephemeralSecret = false;
  if (!appSecret) {
    if (isProd) {
      throw new Error(
        'কনফিগ ত্রুটি: প্রোডাকশনে APP_SECRET বাধ্যতামূলক। তৈরি করুন: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }
    // ডেভেলপমেন্টে প্রতিবার চালুর সময় র‍্যান্ডম সিক্রেট (রিস্টার্টে পুরনো টিকেট অকেজো হবে)
    appSecret = crypto.randomBytes(32).toString('hex');
    ephemeralSecret = true;
  } else if (appSecret.length < 32 && isProd) {
    throw new Error('কনফিগ ত্রুটি: APP_SECRET কমপক্ষে ৩২ অক্ষরের হতে হবে।');
  }

  const dbDriver = (env.DB_DRIVER || 'sqlite').toLowerCase();
  if (!['sqlite', 'turso'].includes(dbDriver)) {
    throw new Error(`কনফিগ ত্রুটি: DB_DRIVER অবশ্যই "sqlite" অথবা "turso" হতে হবে (পেয়েছি: "${dbDriver}")`);
  }
  if (dbDriver === 'turso' && (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN)) {
    throw new Error('কনফিগ ত্রুটি: turso ড্রাইভারের জন্য TURSO_DATABASE_URL ও TURSO_AUTH_TOKEN দিতে হবে।');
  }

  let publicBaseUrl = (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (publicBaseUrl && !/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(publicBaseUrl)) {
    throw new Error('কনফিগ ত্রুটি: PUBLIC_BASE_URL অবশ্যই http(s)://ডোমেইন ফরম্যাটে হতে হবে (শেষে / বা পাথ ছাড়া)।');
  }

  const config = {
    nodeEnv,
    isProd,
    port: int(env, 'PORT', 3000, { min: 0, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    publicBaseUrl,
    appSecret,
    ephemeralSecret,
    trustProxyHops: int(env, 'TRUST_PROXY_HOPS', 0, { min: 0, max: 5 }),
    db: {
      driver: dbDriver,
      sqlitePath: env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'guessme.db'),
      tursoUrl: env.TURSO_DATABASE_URL || '',
      tursoToken: env.TURSO_AUTH_TOKEN || '',
      autoMigrate: bool(env, 'AUTO_MIGRATE', true),
    },
    limits: {
      createPerHour: int(env, 'RATE_LIMIT_CREATE_PER_HOUR', 10, { min: 1 }),
      attemptPerHour: int(env, 'RATE_LIMIT_ATTEMPT_PER_HOUR', 40, { min: 1 }),
      readPerMinute: int(env, 'RATE_LIMIT_READ_PER_MINUTE', 180, { min: 1 }),
      ownerPerMinute: int(env, 'RATE_LIMIT_OWNER_PER_MINUTE', 60, { min: 1 }),
      authFailPer15Min: int(env, 'RATE_LIMIT_AUTH_FAIL_PER_15MIN', 20, { min: 1 }),
      attemptsPerIpPerQuizPerHour: int(env, 'MAX_ATTEMPTS_PER_IP_PER_QUIZ_PER_HOUR', 6, { min: 1 }),
      quizzesPerIpPerDay: int(env, 'MAX_QUIZZES_PER_IP_PER_DAY', 15, { min: 1 }),
      maxAttemptsPerQuiz: int(env, 'MAX_ATTEMPTS_PER_QUIZ', 2000, { min: 1 }),
      minMsPerQuestion: int(env, 'MIN_MS_PER_QUESTION', 700, { min: 0 }),
    },
    bodyLimitBytes: 64 * 1024,
    ticketTtlMs: 6 * 60 * 60 * 1000,
    logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    silent: bool(env, 'LOG_SILENT', false),
  };

  // overrides শুধু টেস্টের জন্য (গভীর মার্জ)
  for (const [k, v] of Object.entries(overrides)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && config[k] && typeof config[k] === 'object') {
      config[k] = { ...config[k], ...v };
    } else {
      config[k] = v;
    }
  }
  return config;
}

module.exports = { loadConfig, loadDotenvFile, parseDotenv };

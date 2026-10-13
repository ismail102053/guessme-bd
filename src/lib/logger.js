'use strict';
/**
 * স্ট্রাকচার্ড JSON লগার।
 * নিরাপত্তা: কখনো রিকোয়েস্ট বডি, Authorization হেডার, টোকেন বা সিক্রেট লগ করা হয় না।
 * এছাড়া অজান্তে ঢুকে যাওয়া সম্ভাব্য সিক্রেট ফিল্ড স্বয়ংক্রিয়ভাবে মাস্ক করা হয়।
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /token|secret|authorization|password|cookie|ticket|owner/i;

function redact(value, depth = 0) {
  if (depth > 4) return '[গভীর]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: String(value.message).slice(0, 300), code: value.code };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[লুকানো]' : redact(v, depth + 1);
  }
  return out;
}

function createLogger({ level = 'info', silent = false, sink = (line) => process.stdout.write(line + '\n') } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  function log(lvl, msg, fields) {
    if (silent || LEVELS[lvl] < threshold) return;
    const entry = { t: new Date().toISOString(), level: lvl, msg, ...(fields ? redact(fields) : {}) };
    sink(JSON.stringify(entry));
  }
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}

module.exports = { createLogger, redact };

'use strict';
/**
 * ইন-মেমোরি স্লাইডিং-উইন্ডো রেট লিমিটার।
 * সীমাবদ্ধতা: একাধিক সার্ভার ইনস্ট্যান্স চালালে প্রতিটির নিজস্ব কাউন্টার থাকে।
 * তাই ডাটাবেস-ভিত্তিক সীমাও (আইপি হ্যাশ ধরে) আলাদাভাবে প্রয়োগ করা হয় — routes/api.js দেখুন।
 */
function createRateLimiter({ now = () => Date.now(), maxKeys = 50_000 } = {}) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  function prune(ts, windowMs, t) {
    let i = 0;
    while (i < ts.length && ts[i] <= t - windowMs) i += 1;
    if (i > 0) ts.splice(0, i);
  }

  function evictIfNeeded() {
    if (hits.size <= maxKeys) return;
    // সবচেয়ে পুরনো এন্ট্রি (Map-এর সন্নিবেশ ক্রম) বাদ দিই
    const drop = Math.ceil(maxKeys * 0.1);
    let n = 0;
    for (const k of hits.keys()) {
      hits.delete(k);
      if (++n >= drop) break;
    }
  }

  return {
    /** একটি হিট গোনে; সীমা পেরোলে { allowed:false, retryAfterSec } */
    hit(key, limit, windowMs) {
      const t = now();
      let ts = hits.get(key);
      if (!ts) {
        ts = [];
        hits.set(key, ts);
        evictIfNeeded();
      }
      prune(ts, windowMs, t);
      if (ts.length >= limit) {
        const retryAfterSec = Math.max(1, Math.ceil((ts[0] + windowMs - t) / 1000));
        return { allowed: false, retryAfterSec, remaining: 0 };
      }
      ts.push(t);
      return { allowed: true, retryAfterSec: 0, remaining: limit - ts.length };
    },
    /** গণনা না বাড়িয়ে শুধু দেখা (যেমন ব্যর্থ-অথ কাউন্টারের জন্য) */
    peek(key, limit, windowMs) {
      const t = now();
      const ts = hits.get(key);
      if (!ts) return { allowed: true, retryAfterSec: 0 };
      prune(ts, windowMs, t);
      if (ts.length >= limit) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((ts[0] + windowMs - t) / 1000)) };
      }
      return { allowed: true, retryAfterSec: 0 };
    },
    sweep(maxWindowMs = 24 * 3600 * 1000) {
      const t = now();
      for (const [k, ts] of hits) {
        prune(ts, maxWindowMs, t);
        if (ts.length === 0) hits.delete(k);
      }
    },
    size: () => hits.size,
  };
}

/** আইপি স্ট্রিং স্বাভাবিকীকরণ: IPv4-mapped থেকে v4, IPv6 হলে /64 প্রিফিক্স (সহজে ঘুরিয়ে এড়ানো ঠেকাতে)। */
function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
  if (!ip.includes(':')) return ip;
  // IPv6: প্রসারিত করে প্রথম ৪ গ্রুপ নিই
  const [head, tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = ip.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  const full = [...headParts, ...Array(Math.max(missing, 0)).fill('0'), ...tailParts];
  return full.slice(0, 4).map((g) => g.toLowerCase().padStart(4, '0')).join(':') + '::/64';
}

/**
 * ক্লায়েন্ট আইপি নির্ণয়।
 * hops = 0 → সরাসরি সকেট; hops = N → X-Forwarded-For এর ডান দিক থেকে N-তম এন্ট্রি
 * (ডান দিকের এন্ট্রি আমাদের বিশ্বস্ত প্রক্সি যোগ করে; বাম দিকেরগুলো ক্লায়েন্ট জাল করতে পারে)।
 */
function getClientIp(req, hops = 0) {
  const socketIp = req.socket?.remoteAddress || 'unknown';
  if (!hops) return normalizeIp(socketIp);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) {
    const list = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const picked = list[list.length - hops];
    if (picked) return normalizeIp(picked);
  }
  return normalizeIp(socketIp);
}

module.exports = { createRateLimiter, getClientIp, normalizeIp };

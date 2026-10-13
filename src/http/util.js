'use strict';

/** ক্লায়েন্টকে দেখানো যায় এমন HTTP ত্রুটি। */
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function applySecurityHeaders(res, { isProd }) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    ...headers,
  });
  res.end(payload);
}

/** JSON বডি পড়ে (সাইজ সীমাসহ)। Content-Type অবশ্যই application/json হতে হবে। */
function readJson(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json')) {
      reject(new HttpError(415, 'unsupported_media_type', 'অনুরোধটি JSON ফরম্যাটে হতে হবে।'));
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      reject(new HttpError(413, 'payload_too_large', 'অনুরোধটি অনেক বড়।'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        done = true;
        reject(new HttpError(413, 'payload_too_large', 'অনুরোধটি অনেক বড়।'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new HttpError(400, 'invalid_json', 'অনুরোধের JSON সঠিক নয়।'));
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        reject(new HttpError(400, 'bad_request', 'অনুরোধ পড়া যায়নি।'));
      }
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

module.exports = { HttpError, applySecurityHeaders, sendJson, readJson, escapeHtml };

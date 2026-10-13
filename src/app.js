'use strict';
/**
 * HTTP অ্যাপ: API রাউটিং, পেজ রেন্ডারিং (Facebook OG মেটা সহ), স্ট্যাটিক ফাইল, নিরাপত্তা হেডার, ত্রুটি হ্যান্ডলিং।
 * কোনো বাহ্যিক ফ্রেমওয়ার্ক নেই — শুধু Node বিল্ট-ইন http।
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError, applySecurityHeaders, sendJson, escapeHtml } = require('./http/util');
const { createApi, QUIZ_ID_RE, ATTEMPT_ID_RE } = require('./routes/api');
const { createRepo } = require('./repo');
const { createRateLimiter } = require('./lib/ratelimit');
const { toBn } = require('./lib/validate');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const PAGES = {
  '/': 'index.html',
  '/create': 'create.html',
  '/privacy': 'privacy.html',
};

const SITE_NAME = 'GuessMe BD';
const DEFAULT_DESC = 'বন্ধুরা তোমাকে কতটা চিনে? নিজের কুইজ বানাও, লিংক শেয়ার করো, কে কত নম্বর পায় দেখো — কোনো রেজিস্ট্রেশন ছাড়াই!';

function scoreMessage(score, total) {
  const r = total ? score / total : 0;
  if (r === 1) return 'পারফেক্ট! সত্যিকারের বেস্ট ফ্রেন্ড 🏆';
  if (r >= 0.7) return 'দারুণ! অনেক ভালো চেনে 🎉';
  if (r >= 0.4) return 'মোটামুটি চেনে 😄';
  return 'আরেকটু চেনা বাকি আছে 😅';
}

function createApp(config, { db, logger }) {
  const repo = createRepo(db);
  const limiter = createRateLimiter();
  const api = createApi({ config, repo, db, limiter, logger });

  // টেমপ্লেট স্টার্টআপে একবার পড়ি (পরিবর্তনের জন্য ডেভে রিস্টার্ট লাগবে — `npm run dev` নিজেই করে)
  const templates = new Map();
  function template(name) {
    if (!templates.has(name) || !config.isProd) {
      templates.set(name, fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8'));
    }
    return templates.get(name);
  }

  function baseUrlFor(req) {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    const host = String(req.headers.host || '');
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return 'http://localhost';
    const proto =
      config.trustProxyHops > 0 && /^https?$/.test(String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim())
        ? String(req.headers['x-forwarded-proto']).split(',')[0].trim()
        : 'http';
    return `${proto}://${host}`;
  }

  function ogTags({ base, urlPath, title, description, noindex }) {
    const url = `${base}${urlPath}`;
    const tags = [
      `<title>${escapeHtml(title)}</title>`,
      `<meta name="description" content="${escapeHtml(description)}">`,
      `<link rel="canonical" href="${escapeHtml(url)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="${SITE_NAME}">`,
      `<meta property="og:locale" content="bn_BD">`,
      `<meta property="og:title" content="${escapeHtml(title)}">`,
      `<meta property="og:description" content="${escapeHtml(description)}">`,
      `<meta property="og:url" content="${escapeHtml(url)}">`,
      `<meta property="og:image" content="${escapeHtml(base)}/img/og.png">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    ];
    if (noindex) tags.push('<meta name="robots" content="noindex, nofollow">');
    return tags.join('\n  ');
  }

  function sendHtml(req, res, status, file, og) {
    const html = template(file).replace('<!--OG_TAGS-->', ogTags({ base: baseUrlFor(req), ...og }));
    const body = Buffer.from(html);
    res.writeHead(status, {
      'Content-Type': MIME['.html'],
      'Content-Length': body.length,
      'Cache-Control': og.noStore ? 'no-store' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function notFoundPage(req, res) {
    sendHtml(req, res, 404, '404.html', {
      urlPath: '/404',
      title: `পাতাটি পাওয়া যায়নি — ${SITE_NAME}`,
      description: DEFAULT_DESC,
      noindex: true,
    });
  }

  async function servePage(req, res, pathname) {
    if (PAGES[pathname]) {
      const titles = {
        '/': `${SITE_NAME} — বন্ধুরা তোমাকে কতটা চিনে?`,
        '/create': `নিজের কুইজ বানাও — ${SITE_NAME}`,
        '/privacy': `গোপনীয়তা নীতি — ${SITE_NAME}`,
      };
      sendHtml(req, res, 200, PAGES[pathname], { urlPath: pathname, title: titles[pathname], description: DEFAULT_DESC });
      return true;
    }
    let m;
    if ((m = /^\/q\/([^/]+)$/.exec(pathname))) {
      const quiz = QUIZ_ID_RE.test(m[1]) ? await repo.getPublicQuiz(m[1]) : null;
      if (!quiz) return notFoundPage(req, res), true;
      sendHtml(req, res, 200, 'quiz.html', {
        urlPath: pathname,
        title: `${quiz.creatorName} কে তুমি কতটা চেনো? চ্যালেঞ্জ নাও! 🎯`,
        description: `${quiz.creatorName}-এর ${toBn(quiz.questions.length)}টি প্রশ্নের কুইজ খেলো আর দেখো কত নম্বর পাও। রেজিস্ট্রেশন লাগবে না!`,
      });
      return true;
    }
    if ((m = /^\/r\/([^/]+)$/.exec(pathname))) {
      const a = ATTEMPT_ID_RE.test(m[1]) ? await repo.getPublicAttempt(m[1]) : null;
      if (!a) return notFoundPage(req, res), true;
      sendHtml(req, res, 200, 'result.html', {
        urlPath: pathname,
        title: `${a.playerName} পেয়েছে ${toBn(a.score)}/${toBn(a.total)} — ${a.quiz.creatorName}-কে কতটা চেনে?`,
        description: `${scoreMessage(a.score, a.total)} তুমিও ${a.quiz.creatorName}-এর কুইজ খেলে দেখো!`,
      });
      return true;
    }
    if ((m = /^\/manage\/([^/]+)$/.exec(pathname))) {
      // প্রাইভেট পেজ: সার্চ ইঞ্জিন/প্রিভিউ থেকে দূরে, কখনো ক্যাশ নয়
      sendHtml(req, res, 200, 'manage.html', {
        urlPath: `/manage/${QUIZ_ID_RE.test(m[1]) ? m[1] : ''}`,
        title: `প্রাইভেট ড্যাশবোর্ড — ${SITE_NAME}`,
        description: 'এই পেজটি শুধু কুইজের মালিকের জন্য।',
        noindex: true,
        noStore: true,
      });
      return true;
    }
    return false;
  }

  function serveStatic(req, res, pathname) {
    if (pathname === '/robots.txt') {
      const body = 'User-agent: *\nDisallow: /api/\nDisallow: /manage/\nAllow: /\n';
      res.writeHead(200, { 'Content-Type': MIME['.txt'], 'Cache-Control': 'public, max-age=3600' });
      res.end(body);
      return true;
    }
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (rel.includes('\0') || rel.includes('..')) return false;
    const ext = path.extname(rel).toLowerCase();
    if (!MIME[ext] || ext === '.html') return false; // HTML কখনো সরাসরি নয় — শুধু পেজ রুটের মাধ্যমে
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return true;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': stat.size,
      'Cache-Control': config.isProd ? 'public, max-age=600' : 'no-cache',
      ETag: etag,
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
    return true;
  }

  /** CSRF-সুরক্ষা: পরিবর্তনকারী অনুরোধে Origin থাকলে অবশ্যই আমাদের হোস্টের হতে হবে। */
  function checkOrigin(req) {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return;
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'bad_origin', 'অনুরোধটি অনুমোদিত নয়।');
    }
    const allowed = new Set([String(req.headers.host || '')]);
    if (config.publicBaseUrl) allowed.add(new URL(config.publicBaseUrl).host);
    if (!allowed.has(host)) throw new HttpError(403, 'bad_origin', 'অনুরোধটি অনুমোদিত নয়।');
  }

  function handleError(req, res, err, reqId) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      const headers = {};
      if (err.status === 429 && err.details?.retryAfterSec) headers['Retry-After'] = String(err.details.retryAfterSec);
      const body = { error: { code: err.code, message: err.message } };
      if (err.status === 422 && err.details) body.error.fields = err.details;
      if (err.status === 429 && err.details?.retryAfterSec) body.error.retryAfterSec = err.details.retryAfterSec;
      sendJson(res, err.status, body, headers);
      return;
    }
    // অপ্রত্যাশিত ত্রুটি: বিস্তারিত শুধু লগে (বডি/টোকেন ছাড়া), ক্লায়েন্টকে সাধারণ বার্তা
    logger.error('অনাকাঙ্ক্ষিত সার্ভার ত্রুটি', { reqId, method: req.method, err });
    sendJson(res, 500, {
      error: { code: 'server_error', message: 'সার্ভারে একটি সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করো।', requestId: reqId },
    });
  }

  async function handler(req, res) {
    const started = Date.now();
    const reqId = crypto.randomBytes(4).toString('hex');
    res.setHeader('X-Request-Id', reqId);
    applySecurityHeaders(res, { isProd: config.isProd });
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: { code: 'bad_url', message: 'ঠিকানাটি সঠিক নয়।' } });
      return;
    }
    const { pathname } = url;

    res.on('finish', () => {
      if (pathname.startsWith('/api/') || res.statusCode >= 400) {
        logger.info('অনুরোধ', { reqId, method: req.method, path: pathname, status: res.statusCode, ms: Date.now() - started });
      }
    });

    try {
      if (pathname.startsWith('/api/')) {
        checkOrigin(req);
        const ctx = { ...api.ctxFor(req), baseUrl: baseUrlFor(req) };
        const handled = await api.handle(req, res, url, ctx);
        if (!handled) throw new HttpError(404, 'not_found', 'এই API ঠিকানাটি নেই।');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'এই পদ্ধতি অনুমোদিত নয়।');
      }
      if (await servePage(req, res, pathname.replace(/(.)\/+$/, '$1'))) return;
      if (serveStatic(req, res, pathname)) return;
      notFoundPage(req, res);
    } catch (err) {
      if (!pathname.startsWith('/api/') && !(err instanceof HttpError)) {
        logger.error('পেজ রেন্ডার ত্রুটি', { reqId, err });
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('সার্ভারে একটি সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করো।');
        return;
      }
      handleError(req, res, err, reqId);
    }
  }

  return { handler, repo, limiter };
}

module.exports = { createApp, scoreMessage };

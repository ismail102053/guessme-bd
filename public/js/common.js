/* GuessMe BD — শেয়ার্ড হেল্পার। সব DOM তৈরি textContent দিয়ে (innerHTML নয়) → XSS-নিরাপদ। */
(function () {
  'use strict';

  const BN = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  const toBn = (n) => String(n).replace(/\d/g, (d) => BN[Number(d)]);

  /** h('div', {class:'x', onclick: fn, dataset:{a:1}}, 'টেক্সট', childNode) */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  function mount(root, ...nodes) {
    root.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
  }

  /* ---------- API ---------- */
  class ApiError extends Error {
    constructor(message, { status = 0, code = 'error', fields = null, retryAfterSec = 0 } = {}) {
      super(message);
      this.status = status;
      this.code = code;
      this.fields = fields;
      this.retryAfterSec = retryAfterSec;
    }
  }

  async function api(method, path, { body, token } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch {
      throw new ApiError('ইন্টারনেট সংযোগ নেই, অথবা সার্ভারে পৌঁছানো যাচ্ছে না। সংযোগ দেখে আবার চেষ্টা করো।', { code: 'network' });
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* JSON নয় */
    }
    if (!res.ok) {
      const e = data && data.error;
      throw new ApiError((e && e.message) || 'কিছু একটা সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করো।', {
        status: res.status,
        code: (e && e.code) || 'error',
        fields: (e && e.fields) || null,
        retryAfterSec: (e && e.retryAfterSec) || 0,
      });
    }
    return data;
  }

  function friendlyError(err) {
    if (err instanceof ApiError && err.status === 429 && err.retryAfterSec) {
      const min = Math.ceil(err.retryAfterSec / 60);
      return `${err.message} (প্রায় ${toBn(min > 1 ? min : 1)} ${min > 1 ? 'মিনিট' : 'মিনিট'} পরে)`;
    }
    return err && err.message ? err.message : 'কিছু একটা সমস্যা হয়েছে।';
  }

  /* ---------- নিরাপদ স্টোরেজ (প্রাইভেট মোডে ব্যর্থ হতে পারে) ---------- */
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
  };

  const MY_KEY = 'gm_my_quizzes_v1';
  const myQuizzes = {
    list: () => (Array.isArray(store.get(MY_KEY, [])) ? store.get(MY_KEY, []) : []),
    add(item) {
      const list = myQuizzes.list().filter((q) => q.id !== item.id);
      list.unshift(item);
      return store.set(MY_KEY, list.slice(0, 20));
    },
    remove(id) {
      store.set(MY_KEY, myQuizzes.list().filter((q) => q.id !== id));
    },
    tokenFor(id) {
      const q = myQuizzes.list().find((x) => x.id === id);
      return q ? q.ownerToken : null;
    },
  };

  /* ---------- টোস্ট, কপি, শেয়ার ---------- */
  function toast(message, kind = '') {
    let box = document.getElementById('toasts');
    if (!box) {
      box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
      document.body.append(box);
    }
    const t = h('div', { class: `toast ${kind}`, text: message });
    box.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* ফলব্যাক */
    }
    try {
      const ta = h('textarea', { 'aria-hidden': 'true', readonly: true });
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function copyWithToast(text, okMsg = 'লিংক কপি হয়েছে! ✅') {
    const ok = await copyText(text);
    toast(ok ? okMsg : 'কপি করা যায়নি — লিংকটি চেপে ধরে নিজে কপি করো।', ok ? '' : 'error');
  }

  function facebookShareUrl(url) {
    return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
  }

  /** শেয়ার বোতামের সেট: Facebook + লিংক কপি (+ মোবাইলে নেটিভ শেয়ার) */
  function shareButtons(url, { text = '' } = {}) {
    const row = h('div', { class: 'btn-row' });
    row.append(
      h('a', { class: 'btn fb', href: facebookShareUrl(url), target: '_blank', rel: 'noopener noreferrer' }, '📘 Facebook-এ শেয়ার'),
      h('button', { class: 'btn white', type: 'button', onclick: () => copyWithToast(url) }, '🔗 লিংক কপি')
    );
    if (navigator.share) {
      row.append(
        h('button', {
          class: 'btn white',
          type: 'button',
          onclick: () => navigator.share({ title: 'GuessMe BD', text, url }).catch(() => {}),
        }, '📲 অন্য অ্যাপে পাঠাও')
      );
    }
    return row;
  }

  /* ---------- সময় ---------- */
  function timeAgo(ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return 'এইমাত্র';
    const m = Math.floor(s / 60);
    if (m < 60) return `${toBn(Math.max(m, 1))} মিনিট আগে`;
    const hr = Math.floor(m / 60);
    if (hr < 24) return `${toBn(hr)} ঘণ্টা আগে`;
    return `${toBn(Math.floor(hr / 24))} দিন আগে`;
  }

  /* ---------- স্কোর বার্তা (সার্ভারের scoreMessage-এর সাথে মেলে) ---------- */
  function scoreMessage(score, total) {
    const r = total ? score / total : 0;
    if (r === 1) return { emoji: '🏆', text: 'পারফেক্ট! সত্যিকারের বেস্ট ফ্রেন্ড!' };
    if (r >= 0.7) return { emoji: '🎉', text: 'দারুণ! অনেক ভালো চেনো।' };
    if (r >= 0.4) return { emoji: '😄', text: 'মোটামুটি চেনো — আরেকটু জানতে হবে!' };
    return { emoji: '😅', text: 'আরেকটু চেনা বাকি আছে!' };
  }

  /* ---------- ভাগ করা UI অংশ ---------- */
  function skeleton() {
    return h('div', { 'aria-busy': 'true', 'aria-label': 'লোড হচ্ছে' },
      h('div', { class: 'skeleton sk-block' }),
      h('div', { class: 'skeleton sk-line' }),
      h('div', { class: 'skeleton sk-line' })
    );
  }

  function errorView({ title = 'ওহো, সমস্যা হয়েছে!', message, onRetry, emoji = '😕' }) {
    return h('div', { class: 'card empty', role: 'alert' },
      h('span', { class: 'big', 'aria-hidden': 'true' }, emoji),
      h('h2', { text: title }),
      h('p', { class: 'muted', text: message }),
      h('div', { class: 'btn-row' },
        onRetry ? h('button', { class: 'btn', type: 'button', onclick: onRetry }, '🔄 আবার চেষ্টা করো') : null,
        h('a', { class: 'btn white', href: '/' }, '🏠 হোমে যাও')
      )
    );
  }

  function button(label, { cls = '', onclick, type = 'button' } = {}) {
    return h('button', { class: `btn ${cls}`.trim(), type, onclick }, label);
  }

  /** বোতামকে লোডিং অবস্থায় রাখে; ফাংশন শেষে ফিরিয়ে দেয়। */
  async function withLoading(btn, loadingLabel, fn) {
    const original = btn.textContent;
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${loadingLabel}`);
    try {
      return await fn();
    } finally {
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function hpField() {
    return h('div', { class: 'hp', 'aria-hidden': 'true' },
      h('label', {}, 'ওয়েবসাইট (খালি রাখুন)', h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' }))
    );
  }

  window.GM = {
    toBn, h, $, mount, api, ApiError, friendlyError, store, myQuizzes, toast, copyText, copyWithToast,
    facebookShareUrl, shareButtons, timeAgo, scoreMessage, skeleton, errorView, button, withLoading, hpField,
  };
})();

'use strict';
/**
 * ইনপুট ভ্যালিডেশন ও স্যানিটাইজেশন। সব ত্রুটির বার্তা বাংলায়।
 * ফলাফল: { ok: true, value } অথবা { ok: false, errors: { "field.path": "বার্তা" } }
 */

const LIMITS = Object.freeze({
  nameMin: 2,
  nameMax: 30,
  titleMax: 60,
  questionMin: 3,
  questionMax: 15,
  questionTextMin: 3,
  questionTextMax: 140,
  optionMin: 2,
  optionMax: 4,
  optionTextMax: 60,
});

// কন্ট্রোল ক্যারেক্টার, বাইডি-ওভাররাইড, জিরো-উইডথ স্পেস, BOM বাদ।
// ZWJ (U+200D) ও ZWNJ (U+200C) বাংলা লেখায় অর্থবহ — তাই রাখা হয়।
// eslint-disable-next-line no-control-regex
const STRIP_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;

const LINK_RE = /(https?:\/\/|www\.|\bt\.me\/|\bbit\.ly\b|\b[a-z0-9-]{2,}\.(com|net|org|xyz|info|bd|me|io|co|click|top|ru|ly|app|link|site|online)\b)/i;

function normalizeText(input) {
  if (typeof input !== 'string') return '';
  return input.normalize('NFC').replace(STRIP_RE, '').replace(/\s+/g, ' ').trim();
}

const len = (s) => [...s].length; // কোড-পয়েন্ট গণনা

function checkText(raw, { label, min = 1, max, allowEmpty = false }, errors, key) {
  const value = normalizeText(raw);
  if (!value) {
    if (allowEmpty) return '';
    errors[key] = `${label} লিখতে হবে।`;
    return null;
  }
  const n = len(value);
  if (n < min) {
    errors[key] = `${label} কমপক্ষে ${toBn(min)}টি অক্ষরের হতে হবে।`;
    return null;
  }
  if (n > max) {
    errors[key] = `${label} সর্বোচ্চ ${toBn(max)}টি অক্ষরের হতে পারবে।`;
    return null;
  }
  if (LINK_RE.test(value)) {
    errors[key] = `${label}-এ লিংক বা ওয়েবসাইটের ঠিকানা দেওয়া যাবে না।`;
    return null;
  }
  return value;
}

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
function toBn(n) {
  return String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateCreateQuiz(body) {
  const errors = {};
  if (!isPlainObject(body)) return { ok: false, errors: { _: 'অনুরোধের ফরম্যাট সঠিক নয়।' } };

  const creatorName = checkText(body.creatorName, { label: 'তোমার নাম', min: LIMITS.nameMin, max: LIMITS.nameMax }, errors, 'creatorName');
  const title = checkText(body.title, { label: 'কুইজের শিরোনাম', min: 1, max: LIMITS.titleMax, allowEmpty: true }, errors, 'title');

  let questions = [];
  if (!Array.isArray(body.questions)) {
    errors.questions = 'প্রশ্নের তালিকা পাওয়া যায়নি।';
  } else if (body.questions.length < LIMITS.questionMin) {
    errors.questions = `কমপক্ষে ${toBn(LIMITS.questionMin)}টি প্রশ্ন দিতে হবে।`;
  } else if (body.questions.length > LIMITS.questionMax) {
    errors.questions = `সর্বোচ্চ ${toBn(LIMITS.questionMax)}টি প্রশ্ন দেওয়া যাবে।`;
  } else {
    const seenQuestions = new Set();
    questions = body.questions.map((q, qi) => {
      const k = `questions.${qi}`;
      if (!isPlainObject(q)) {
        errors[k] = 'প্রশ্নের ফরম্যাট সঠিক নয়।';
        return null;
      }
      const text = checkText(q.text, { label: 'প্রশ্ন', min: LIMITS.questionTextMin, max: LIMITS.questionTextMax }, errors, `${k}.text`);
      if (text) {
        const key = text.toLowerCase();
        if (seenQuestions.has(key)) errors[`${k}.text`] = 'একই প্রশ্ন দুইবার দেওয়া যাবে না।';
        seenQuestions.add(key);
      }

      let options = [];
      if (!Array.isArray(q.options) || q.options.length < LIMITS.optionMin || q.options.length > LIMITS.optionMax) {
        errors[`${k}.options`] = `প্রতিটি প্রশ্নে ${toBn(LIMITS.optionMin)} থেকে ${toBn(LIMITS.optionMax)}টি অপশন থাকতে হবে।`;
      } else {
        const seen = new Set();
        options = q.options.map((o, oi) => {
          const ov = checkText(o, { label: 'অপশন', min: 1, max: LIMITS.optionTextMax }, errors, `${k}.options.${oi}`);
          if (ov) {
            const lk = ov.toLowerCase();
            if (seen.has(lk)) errors[`${k}.options.${oi}`] = 'একই অপশন দুইবার দেওয়া যাবে না।';
            seen.add(lk);
          }
          return ov;
        });
      }

      let correctIndex = null;
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= (options.length || 0)) {
        errors[`${k}.correctIndex`] = 'সঠিক উত্তরটি বেছে নিতে হবে।';
      } else {
        correctIndex = q.correctIndex;
      }
      return { text, options, correctIndex };
    });
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: { creatorName, title: title || '', questions },
  };
}

function validateAttempt(body, questionCount) {
  const errors = {};
  if (!isPlainObject(body)) return { ok: false, errors: { _: 'অনুরোধের ফরম্যাট সঠিক নয়।' } };

  const playerName = checkText(body.playerName, { label: 'তোমার নাম', min: LIMITS.nameMin, max: LIMITS.nameMax }, errors, 'playerName');

  if (!Array.isArray(body.answers) || body.answers.length !== questionCount) {
    errors.answers = 'সব প্রশ্নের উত্তর দিতে হবে।';
  } else if (!body.answers.every((a) => Number.isInteger(a) && a >= 0 && a <= 3)) {
    errors.answers = 'উত্তরের ফরম্যাট সঠিক নয়।';
  }
  if (typeof body.ticket !== 'string' || !body.ticket) errors.ticket = 'পেজটি রিফ্রেশ করে আবার চেষ্টা করো।';

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { playerName, answers: body.answers, ticket: body.ticket } };
}

module.exports = { LIMITS, normalizeText, validateCreateQuiz, validateAttempt, toBn, len };

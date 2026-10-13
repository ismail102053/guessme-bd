(function () {
  'use strict';
  const { h, mount, api, ApiError, friendlyError, toBn, myQuizzes, shareButtons, copyWithToast, withLoading, hpField, toast } = window.GM;

  const MIN_Q = 3;
  const MAX_Q = 15;
  const MAX_OPT = 4;
  const MIN_OPT = 2;

  const SUGGESTIONS = [
    'আমার প্রিয় খাবার কোনটি?',
    'আমার প্রিয় ঋতু কোনটি?',
    'আমি কোন খেলাটা সবচেয়ে বেশি ভালোবাসি?',
    'আমার স্বপ্নের ঘুরে বেড়ানোর জায়গা কোনটি?',
    'আমি সকালে চা খাই নাকি কফি?',
    'আমার সবচেয়ে বড় ভয় কী?',
    'আমার প্রিয় সিনেমার ধরন কোনটি?',
    'বৃষ্টির দিনে আমি কী করতে ভালোবাসি?',
    'আমার প্রিয় রঙ কোনটি?',
    'ছোটবেলায় আমার ডাকনাম কী ছিল?',
    'আমি কি রাতজাগা পাখি নাকি ভোরের পাখি?',
    'আমার সবচেয়ে প্রিয় ঈদের খাবার কোনটি?',
  ];

  const blankQuestion = () => ({ text: '', options: ['', '', ''], correct: null });
  const state = {
    creatorName: '',
    title: '',
    questions: [blankQuestion(), blankQuestion(), blankQuestion()],
  };
  let errors = {};
  let bannerMsg = '';
  const root = document.getElementById('create-root');

  /* ---------- যাচাই (ক্লায়েন্ট-সাইড; সার্ভার আবার যাচাই করে) ---------- */
  const clean = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();

  function buildPayload() {
    const errs = {};
    const creatorName = clean(state.creatorName);
    if (creatorName.length < 2) errs.creatorName = 'তোমার নাম লিখতে হবে (কমপক্ষে ২টি অক্ষর)।';
    if ([...creatorName].length > 30) errs.creatorName = 'নাম সর্বোচ্চ ৩০টি অক্ষরের হতে পারবে।';
    const title = clean(state.title);
    if ([...title].length > 60) errs.title = 'শিরোনাম সর্বোচ্চ ৬০টি অক্ষরের হতে পারবে।';

    const questions = state.questions.map((q, qi) => {
      const text = clean(q.text);
      if ([...text].length < 3) errs[`questions.${qi}.text`] = 'প্রশ্নটি লিখতে হবে (কমপক্ষে ৩টি অক্ষর)।';
      // ফাঁকা অপশন বাদ দিয়ে সঠিক উত্তরের ইনডেক্স নতুন করে মেলাই
      const opts = [];
      let correctIndex = null;
      q.options.forEach((o, oi) => {
        const t = clean(o);
        if (!t) return;
        if (oi === q.correct) correctIndex = opts.length;
        opts.push(t);
      });
      if (opts.length < MIN_OPT) errs[`questions.${qi}.options`] = 'কমপক্ষে ২টি অপশন লিখতে হবে।';
      else if (q.correct === null) errs[`questions.${qi}.correctIndex`] = 'সঠিক উত্তরটি বেছে নাও (✓ চিহ্ন দাও)।';
      else if (correctIndex === null) errs[`questions.${qi}.correctIndex`] = 'যে অপশনটি সঠিক বলে বেছেছ সেটি ফাঁকা।';
      return { text, options: opts, correctIndex };
    });
    return { errs, payload: { creatorName, title, questions } };
  }

  /* ---------- রেন্ডার ---------- */
  function fieldError(key) {
    return errors[key] ? h('p', { class: 'error-text', id: `err-${key}`, role: 'alert', text: errors[key] }) : null;
  }

  function textInput({ value, key, placeholder, max, onInput, label }) {
    const input = h('input', {
      type: 'text', value, placeholder, maxlength: max, autocomplete: 'off',
      'aria-label': label, 'aria-invalid': errors[key] ? 'true' : null,
      'aria-describedby': errors[key] ? `err-${key}` : null,
      class: errors[key] ? 'invalid' : '', dataset: { field: key },
    });
    input.addEventListener('input', () => {
      onInput(input.value);
      if (errors[key]) {
        delete errors[key];
        input.classList.remove('invalid');
        const e = document.getElementById(`err-${key}`);
        if (e) e.remove();
      }
    });
    return input;
  }

  function questionCard(q, qi) {
    const optRows = q.options.map((opt, oi) => {
      const key = `questions.${qi}.options.${oi}`;
      const radio = h('input', {
        type: 'radio', name: `correct-${qi}`, 'aria-label': `অপশন ${toBn(oi + 1)} সঠিক উত্তর`,
        checked: q.correct === oi,
        onchange: () => {
          q.correct = oi;
          delete errors[`questions.${qi}.correctIndex`];
          const e = document.getElementById(`err-questions.${qi}.correctIndex`);
          if (e) e.remove();
        },
      });
      return h('div', {},
        h('div', { class: 'opt-row' },
          textInput({
            value: opt, key, max: 60, placeholder: `অপশন ${toBn(oi + 1)}`, label: `প্রশ্ন ${toBn(qi + 1)}, অপশন ${toBn(oi + 1)}`,
            onInput: (v) => { q.options[oi] = v; },
          }),
          h('label', { class: 'correct-pick', title: 'এটি সঠিক উত্তর' }, radio, '✓ সঠিক'),
          q.options.length > MIN_OPT
            ? h('button', {
                class: 'icon-btn', type: 'button', 'aria-label': `অপশন ${toBn(oi + 1)} মুছে ফেলো`,
                onclick: () => {
                  q.options.splice(oi, 1);
                  if (q.correct === oi) q.correct = null;
                  else if (q.correct !== null && q.correct > oi) q.correct -= 1;
                  render();
                },
              }, '✕')
            : null
        ),
        fieldError(key)
      );
    });

    return h('section', { class: 'card q-card', 'aria-labelledby': `qh-${qi}` },
      h('div', { class: 'q-head' },
        h('h3', { id: `qh-${qi}` }, h('span', { class: 'q-badge', text: `প্রশ্ন ${toBn(qi + 1)}` })),
        state.questions.length > MIN_Q
          ? h('button', {
              class: 'btn small white', type: 'button', 'aria-label': `প্রশ্ন ${toBn(qi + 1)} মুছে ফেলো`,
              onclick: () => { state.questions.splice(qi, 1); errors = {}; render(); },
            }, '🗑 মুছো')
          : null
      ),
      textInput({
        value: q.text, key: `questions.${qi}.text`, max: 140, placeholder: 'যেমন: আমার প্রিয় খাবার কোনটি?',
        label: `প্রশ্ন ${toBn(qi + 1)} এর লেখা`, onInput: (v) => { q.text = v; },
      }),
      fieldError(`questions.${qi}.text`),
      h('p', { class: 'muted', text: '২–৪টি অপশন দাও, তারপর সঠিক উত্তরের পাশে ✓ চিহ্ন দাও:' }),
      ...optRows,
      fieldError(`questions.${qi}.options`),
      fieldError(`questions.${qi}.correctIndex`),
      q.options.length < MAX_OPT
        ? h('p', {}, h('button', {
            class: 'btn small white', type: 'button',
            onclick: () => { q.options.push(''); render(`[name="correct-${qi}"]`); },
          }, '➕ আরেকটি অপশন'))
        : null
    );
  }

  function suggestionChips() {
    return h('div', { class: 'card sun' },
      h('strong', { text: '💡 আইডিয়া লাগবে? ট্যাপ করো:' }),
      h('ul', { class: 'chips' },
        SUGGESTIONS.map((s) => h('li', {},
          h('button', {
            class: 'chip', type: 'button',
            onclick: () => {
              const empty = state.questions.find((q) => !clean(q.text));
              if (empty) empty.text = s;
              else if (state.questions.length < MAX_Q) state.questions.push({ text: s, options: ['', '', ''], correct: null });
              else return toast(`সর্বোচ্চ ${toBn(MAX_Q)}টি প্রশ্ন দেওয়া যায়।`, 'error');
              render();
            },
          }, s)
        ))
      )
    );
  }

  let submitting = false;
  function render(focusSelector) {
    const form = h('form', { novalidate: true, autocomplete: 'off' });
    form.addEventListener('submit', onSubmit);

    form.append(
      bannerMsg ? h('div', { class: 'banner error', role: 'alert', id: 'form-banner', text: bannerMsg }) : null,
      h('div', { class: 'card' },
        h('label', { class: 'field' }, 'তোমার নাম',
          h('span', { class: 'hint', text: 'বন্ধুরা এই নামেই তোমাকে দেখবে (সর্বোচ্চ ৩০ অক্ষর)' }),
          textInput({ value: state.creatorName, key: 'creatorName', max: 30, placeholder: 'যেমন: রাফি', label: 'তোমার নাম', onInput: (v) => { state.creatorName = v; } })
        ),
        fieldError('creatorName'),
        h('label', { class: 'field' }, 'কুইজের শিরোনাম (ঐচ্ছিক)',
          textInput({ value: state.title, key: 'title', max: 60, placeholder: 'যেমন: আমাকে কতটা চেনো?', label: 'কুইজের শিরোনাম', onInput: (v) => { state.title = v; } })
        ),
        fieldError('title')
      ),
      suggestionChips(),
      fieldError('questions'),
      ...state.questions.map(questionCard),
      state.questions.length < MAX_Q
        ? h('p', {}, h('button', {
            class: 'btn white block', type: 'button',
            onclick: () => { state.questions.push(blankQuestion()); render(`#qh-${state.questions.length - 1}`); },
          }, `➕ আরেকটি প্রশ্ন যোগ করো (${toBn(state.questions.length)}/${toBn(MAX_Q)})`))
        : h('p', { class: 'muted center', text: `সর্বোচ্চ ${toBn(MAX_Q)}টি প্রশ্ন হয়ে গেছে।` }),
      hpField(),
      h('button', { class: 'btn red block', type: 'submit', id: 'submit-btn' }, '🚀 কুইজ তৈরি করো'),
      h('p', { class: 'muted center', text: 'তৈরি করলে তুমি আমাদের গোপনীয়তা নীতি মেনে নিচ্ছ। কোনো অ্যাকাউন্ট লাগবে না।' })
    );
    mount(root, form);
    if (focusSelector) {
      const el = root.querySelector(focusSelector);
      if (el) el.focus({ preventScroll: false });
    }
  }

  function scrollToFirstError() {
    const first = root.querySelector('.error-text, #form-banner');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const bad = root.querySelector('input.invalid');
    if (bad) bad.focus({ preventScroll: true });
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    if (submitting) return;
    const { errs, payload } = buildPayload();
    errors = errs;
    bannerMsg = '';
    if (Object.keys(errs).length) {
      bannerMsg = 'কিছু তথ্য ঠিক করতে হবে — লাল চিহ্নিত জায়গাগুলো দেখো।';
      render();
      scrollToFirstError();
      return;
    }
    const hp = root.querySelector('input[name="website"]');
    if (hp && hp.value) payload.website = hp.value;
    const btn = document.getElementById('submit-btn');
    submitting = true;
    try {
      const created = await withLoading(btn, 'তৈরি হচ্ছে…', () => api('POST', '/api/quizzes', { body: payload }));
      myQuizzes.add({
        id: created.id, ownerToken: created.ownerToken, creatorName: payload.creatorName,
        title: payload.title, createdAt: Date.now(),
      });
      showSuccess(created, payload);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.fields) {
        // সার্ভারের ফিল্ড-ত্রুটি, শব্দ-মেলানো: প্রশ্নের অপশন ইনডেক্স ফাঁকা-বাদ-দেওয়ার কারণে সরে যেতে পারে, তাই প্রশ্ন-স্তরে দেখাই
        errors = {};
        for (const [k, v] of Object.entries(err.fields)) {
          const m = /^questions\.(\d+)\.options\.\d+$/.exec(k);
          errors[m ? `questions.${m[1]}.options` : k] = v;
        }
        bannerMsg = err.message;
      } else {
        bannerMsg = friendlyError(err);
      }
      render();
      scrollToFirstError();
    } finally {
      submitting = false;
    }
  }

  function linkBox(url, label) {
    const input = h('input', { type: 'text', readonly: true, value: url, 'aria-label': label });
    input.addEventListener('focus', () => input.select());
    return h('div', { class: 'copy-box' }, input,
      h('button', { class: 'btn small', type: 'button', onclick: () => copyWithToast(url) }, '📋 কপি'));
  }

  function showSuccess(created, payload) {
    const publicUrl = created.publicUrl;
    const manageUrl = created.manageUrl;
    document.title = 'কুইজ তৈরি হয়েছে! — GuessMe BD';
    mount(root,
      h('section', { class: 'card green center', 'aria-live': 'polite' },
        h('div', { class: 'pop', 'aria-hidden': 'true', text: '🎉' }),
        h('h2', { text: 'তোমার কুইজ তৈরি হয়ে গেছে!' }),
        h('p', { text: 'এই লিংকটি বন্ধুদের পাঠাও — কেউ লগইন ছাড়াই খেলতে পারবে।' })
      ),
      h('section', { class: 'card' },
        h('h3', { text: '👫 বন্ধুদের জন্য পাবলিক লিংক' }),
        linkBox(publicUrl, 'পাবলিক কুইজ লিংক'),
        shareButtons(publicUrl, { text: `${payload.creatorName}-কে তুমি কতটা চেনো? কুইজ খেলো!` }),
        h('p', {}, h('a', { class: 'btn small white', href: `/q/${created.id}` }, '👀 কুইজটি দেখে নাও'))
      ),
      h('section', { class: 'card red' },
        h('h3', { text: '🔐 তোমার গোপন ড্যাশবোর্ড লিংক' }),
        h('p', { class: 'banner warn' }, '⚠️ এই লিংকটি কাউকে দিও না! যার কাছে এটি থাকবে সে সব রেজাল্ট দেখতে ও কুইজ মুছতে পারবে। হারিয়ে ফেললে ফিরে পাওয়া যাবে না — তাই কোথাও সেভ করে রাখো।'),
        linkBox(manageUrl, 'গোপন ড্যাশবোর্ড লিংক'),
        h('div', { class: 'btn-row' },
          h('a', { class: 'btn green', href: manageUrl }, '📊 ড্যাশবোর্ডে যাও'),
          h('button', { class: 'btn white', type: 'button', onclick: () => copyWithToast(manageUrl, 'গোপন লিংক কপি হয়েছে! ✅') }, '📋 গোপন লিংক কপি')
        ),
        h('p', { class: 'muted', text: 'এই ফোন/ব্রাউজারে লিংকটি আপনা-আপনি সেভ হয়েছে (হোম পেজের "আমার কুইজ" অংশে পাবে)।' })
      )
    );
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  render();
})();

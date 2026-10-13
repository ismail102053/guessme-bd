(function () {
  'use strict';
  const { h, mount, api, ApiError, friendlyError, toBn, shareButtons, withLoading, hpField, skeleton, errorView, scoreMessage } = window.GM;

  const root = document.getElementById('quiz-root');
  const quizId = location.pathname.split('/').filter(Boolean)[1] || '';
  const LETTERS = ['ক', 'খ', 'গ', 'ঘ'];

  let quiz = null;
  const play = { name: '', answers: [], index: 0, hp: '' };
  let submitting = false;

  async function load() {
    mount(root, skeleton());
    try {
      quiz = await api('GET', `/api/quizzes/${encodeURIComponent(quizId)}`);
    } catch (err) {
      const notFound = err instanceof ApiError && err.status === 404;
      mount(root, errorView({
        title: notFound ? 'কুইজটি পাওয়া যায়নি' : 'লোড করা যাচ্ছে না',
        message: friendlyError(err),
        emoji: notFound ? '🧭' : '📡',
        onRetry: notFound ? null : load,
      }));
      return;
    }
    play.answers = Array(quiz.questions.length).fill(null);
    play.index = 0;
    showIntro();
  }

  function showIntro(errorMsg) {
    const initial = [...quiz.creatorName][0] || '?';
    const nameInput = h('input', {
      type: 'text', maxlength: 30, value: play.name, placeholder: 'তোমার নাম লেখো', autocomplete: 'nickname',
      'aria-label': 'তোমার নাম', id: 'player-name',
    });
    const err = h('p', { class: 'error-text', role: 'alert', hidden: !errorMsg, text: errorMsg || '' });
    const start = () => {
      const name = nameInput.value.normalize('NFC').replace(/\s+/g, ' ').trim();
      if ([...name].length < 2) {
        err.hidden = false;
        err.textContent = 'আগে তোমার নাম লেখো (কমপক্ষে ২টি অক্ষর)।';
        nameInput.classList.add('invalid');
        nameInput.focus();
        return;
      }
      play.name = name;
      const hpEl = form.querySelector('input[name="website"]');
      play.hp = hpEl ? hpEl.value : ''; // হানিপট: মানুষের হাতে সবসময় খালি
      play.index = 0;
      showQuestion();
    };

    const form = h('form', { novalidate: true },
      h('label', { class: 'field' }, 'তোমার নাম', h('span', { class: 'hint', text: 'রেজাল্টে এই নামই দেখা যাবে' }), nameInput),
      err,
      hpField(),
      quiz.isClosed
        ? h('p', { class: 'banner warn', role: 'status', text: '🔒 কুইজের মালিক এই কুইজটি বন্ধ করে দিয়েছেন, তাই এখন আর খেলা যাচ্ছে না।' })
        : h('button', { class: 'btn red block', type: 'submit' }, '🎯 চ্যালেঞ্জ শুরু করো')
    );
    form.addEventListener('submit', (e) => { e.preventDefault(); start(); });

    document.title = `${quiz.creatorName}-কে কতটা চেনো? — GuessMe BD`;
    mount(root,
      h('section', { class: 'card center' },
        h('div', { class: 'avatar pop', 'aria-hidden': 'true', text: initial }),
        h('span', { class: 'eyebrow', text: '🔥 চ্যালেঞ্জ' }),
        h('h1', { text: `${quiz.creatorName} তোমাকে চ্যালেঞ্জ করেছে!` }),
        quiz.title ? h('p', { class: 'q-text', text: `“${quiz.title}”` }) : null,
        h('p', { class: 'muted', text: `তুমি কি ওকে সত্যিই চেনো? ${toBn(quiz.questions.length)}টি প্রশ্ন${quiz.attemptsCount ? ` · ${toBn(quiz.attemptsCount)} জন খেলেছে` : ''}` })
      ),
      h('section', { class: 'card' }, form),
      h('p', { class: 'center' }, h('a', { href: '/create' }, '✏️ নিজেও একটা কুইজ বানাও'))
    );
    if (!quiz.isClosed) nameInput.focus({ preventScroll: true });
  }

  function showQuestion(errorMsg) {
    const total = quiz.questions.length;
    const i = play.index;
    const q = quiz.questions[i];
    const chosen = play.answers[i];
    const isLast = i === total - 1;
    const answeredCount = play.answers.filter((a) => a !== null).length;

    const bar = h('span');
    bar.style.width = `${Math.round((i / total) * 100)}%`;
    requestAnimationFrame(() => { bar.style.width = `${Math.round(((i + (chosen !== null ? 1 : 0)) / total) * 100)}%`; });

    const options = h('ul', { class: 'options' },
      q.options.map((text, oi) => h('li', {},
        h('button', {
          class: 'option', type: 'button', 'aria-pressed': chosen === oi ? 'true' : 'false',
          onclick: () => {
            play.answers[i] = oi;
            if (!isLast) {
              // একটু থেমে পরের প্রশ্নে — যাতে বাছাই চোখে পড়ে
              showQuestion();
              setTimeout(() => { if (play.index === i) { play.index = i + 1; showQuestion(); } }, 280);
            } else {
              showQuestion();
            }
          },
        }, h('span', { class: 'letter', 'aria-hidden': 'true', text: LETTERS[oi] }), h('span', { text }))
      ))
    );

    mount(root,
      h('div', { 'aria-live': 'polite' },
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(i + 1), 'aria-label': 'অগ্রগতি' }, bar),
        h('p', { class: 'muted', text: `প্রশ্ন ${toBn(i + 1)} / ${toBn(total)}` })
      ),
      h('section', { class: 'card' },
        h('h2', { class: 'q-text', text: q.text }),
        options,
        errorMsg ? h('p', { class: 'banner error', role: 'alert', text: errorMsg }) : null,
        h('div', { class: 'nav-row' },
          i > 0 ? h('button', { class: 'btn small white', type: 'button', onclick: () => { play.index = i - 1; showQuestion(); } }, '← আগের প্রশ্ন') : h('span'),
          isLast
            ? h('button', {
                class: 'btn green', type: 'button', id: 'submit-btn', disabled: answeredCount < total,
                onclick: submit,
              }, '✅ দেখো কত পেলে!')
            : h('button', {
                class: 'btn small white', type: 'button', disabled: chosen === null,
                onclick: () => { play.index = i + 1; showQuestion(); },
              }, 'পরের প্রশ্ন →')
        ),
        isLast && answeredCount < total
          ? h('p', { class: 'muted center', text: 'সবগুলো প্রশ্নের উত্তর দিলে বোতামটি চালু হবে।' })
          : null
      )
    );
  }

  async function submit() {
    if (submitting) return;
    const btn = document.getElementById('submit-btn');
    submitting = true;
    try {
      const body = { playerName: play.name, answers: play.answers, ticket: quiz.ticket };
      if (play.hp) body.website = play.hp;
      const res = await withLoading(btn, 'জমা হচ্ছে…', () => api('POST', `/api/quizzes/${encodeURIComponent(quizId)}/attempts`, { body }));
      showResult(res);
    } catch (err) {
      if (err instanceof ApiError && ['bad_ticket', 'ticket_expired'].includes(err.code)) {
        mount(root, errorView({ title: 'পেজটি রিফ্রেশ করতে হবে', message: err.message, emoji: '⏰', onRetry: () => location.reload() }));
      } else if (err instanceof ApiError && err.code === 'quiz_closed') {
        quiz.isClosed = true;
        showIntro(err.message);
      } else {
        showQuestion(friendlyError(err));
      }
    } finally {
      submitting = false;
    }
  }

  function showResult(res) {
    const msg = scoreMessage(res.score, res.total);
    document.title = `${play.name} পেয়েছে ${toBn(res.score)}/${toBn(res.total)} — GuessMe BD`;
    const review = h('ul', { class: 'review' },
      quiz.questions.map((q, i) => {
        const r = res.review[i];
        return h('li', { class: r.isCorrect ? 'ok' : 'no' },
          h('div', { class: 'qt', text: `${toBn(i + 1)}। ${q.text}` }),
          h('div', { text: `${r.isCorrect ? '✅' : '❌'} তোমার উত্তর: ${q.options[r.chosenIndex]}` }),
          r.isCorrect ? null : h('div', { text: `👉 সঠিক উত্তর: ${q.options[r.correctIndex]}` })
        );
      })
    );
    mount(root,
      h('section', { class: 'card score-card green' },
        h('p', { class: 'muted', text: `${play.name}, তুমি ${quiz.creatorName}-কে কতটা চেনো?` }),
        h('div', { class: 'score-num pop', role: 'status', text: `${toBn(res.score)}`}, h('small', { text: ` / ${toBn(res.total)}` })),
        h('div', { class: 'pop', 'aria-hidden': 'true', text: msg.emoji }),
        h('h2', { text: msg.text })
      ),
      h('section', { class: 'card' },
        h('h3', { text: '📣 বন্ধুদের দেখাও, চ্যালেঞ্জ দাও!' }),
        shareButtons(res.resultUrl, { text: `আমি ${quiz.creatorName}-এর কুইজে ${toBn(res.score)}/${toBn(res.total)} পেয়েছি! তুমি কত পাও?` }),
        h('p', { class: 'muted', text: 'এই লিংকে শুধু তোমার নাম ও স্কোর দেখা যাবে।' })
      ),
      h('section', { class: 'card' }, h('h3', { text: '📝 তোমার উত্তরগুলো' }), review),
      h('section', { class: 'card sun center' },
        h('h3', { text: 'এবার তোমার পালা! 😎' }),
        h('p', { text: 'নিজের কুইজ বানাও, দেখো বন্ধুরা তোমাকে কতটা চেনে।' }),
        h('a', { class: 'btn red', href: '/create' }, '✏️ নিজের কুইজ বানাও')
      )
    );
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  load();
})();

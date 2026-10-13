(function () {
  'use strict';
  const { h, mount, api, ApiError, friendlyError, toBn, myQuizzes, shareButtons, copyWithToast, timeAgo, skeleton, errorView, toast, withLoading } = window.GM;

  const root = document.getElementById('manage-root');
  const quizId = location.pathname.split('/').filter(Boolean)[1] || '';
  const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  const LETTERS = ['ক', 'খ', 'গ', 'ঘ'];

  /* টোকেন: URL-এর # অংশ থেকে (সার্ভারে/লগে/Referer-এ যায় না); না থাকলে এই ডিভাইসে সেভ করা থেকে */
  const hashToken = decodeURIComponent(location.hash.replace(/^#/, ''));
  let token = TOKEN_RE.test(hashToken) ? hashToken : myQuizzes.tokenFor(quizId);
  if (token && !TOKEN_RE.test(token)) token = null;

  let data = null;
  let refreshing = false;

  function askForToken(message) {
    const input = h('input', { type: 'text', placeholder: 'গোপন লিংকটি এখানে পেস্ট করো', autocomplete: 'off', 'aria-label': 'গোপন লিংক' });
    const err = h('p', { class: 'error-text', role: 'alert', hidden: !message, text: message || '' });
    const form = h('form', { novalidate: true },
      h('label', { class: 'field' }, 'গোপন ড্যাশবোর্ড লিংক', input), err,
      h('button', { class: 'btn green block', type: 'submit' }, '🔓 ড্যাশবোর্ড খোলো')
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const m = /\/manage\/([a-z0-9]{10})#([A-Za-z0-9_-]{43})/.exec(input.value.trim());
      if (!m) {
        err.hidden = false;
        err.textContent = 'লিংকটি সঠিক মনে হচ্ছে না। কুইজ তৈরির সময় পাওয়া সম্পূর্ণ গোপন লিংকটি পেস্ট করো।';
        return;
      }
      location.href = `/manage/${m[1]}#${m[2]}`;
    });
    mount(root,
      h('section', { class: 'card center' },
        h('span', { class: 'big', 'aria-hidden': 'true', text: '🔐' }),
        h('h1', { text: 'প্রাইভেট ড্যাশবোর্ড' }),
        h('p', { class: 'muted', text: 'রেজাল্ট দেখতে কুইজ তৈরির সময় পাওয়া গোপন লিংকটি দরকার।' })
      ),
      h('section', { class: 'card' }, form)
    );
  }

  async function load(initial = true) {
    if (!token) return askForToken();
    if (initial) mount(root, skeleton());
    try {
      data = await api('GET', `/api/owner/${encodeURIComponent(quizId)}`, { token });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        myQuizzes.remove(quizId);
        token = null;
        return askForToken(err.message);
      }
      return mount(root, errorView({ title: 'ড্যাশবোর্ড লোড হয়নি', message: friendlyError(err), onRetry: () => load(true) }));
    }
    render();
  }

  async function refresh(btn) {
    if (refreshing) return;
    refreshing = true;
    try {
      await withLoading(btn, 'আপডেট হচ্ছে…', async () => {
        data = await api('GET', `/api/owner/${encodeURIComponent(quizId)}`, { token });
      });
      render();
      toast('আপডেট হয়েছে ✅');
    } catch (err) {
      toast(friendlyError(err), 'error');
    } finally {
      refreshing = false;
    }
  }

  async function toggleClosed(btn) {
    try {
      await withLoading(btn, 'অপেক্ষা করো…', () => api('PATCH', `/api/owner/${encodeURIComponent(quizId)}`, { token, body: { isClosed: !data.isClosed } }));
      data.isClosed = !data.isClosed;
      render();
      toast(data.isClosed ? 'কুইজ বন্ধ করা হয়েছে 🔒' : 'কুইজ আবার চালু হয়েছে 🔓');
    } catch (err) {
      toast(friendlyError(err), 'error');
    }
  }

  async function deleteAttempt(a) {
    if (!confirm(`${a.playerName}-এর উত্তরটি মুছে ফেলবে? এটি ফেরত আনা যাবে না।`)) return;
    try {
      await api('DELETE', `/api/owner/${encodeURIComponent(quizId)}/attempts/${encodeURIComponent(a.id)}`, { token });
      toast('উত্তরটি মুছে ফেলা হয়েছে');
      await load(false);
    } catch (err) {
      toast(friendlyError(err), 'error');
    }
  }

  async function deleteQuiz(btn) {
    if (!confirm('সত্যিই পুরো কুইজ ও সব রেজাল্ট স্থায়ীভাবে মুছে ফেলবে? এটি আর ফেরত আনা যাবে না!')) return;
    try {
      await withLoading(btn, 'মুছে ফেলা হচ্ছে…', () => api('DELETE', `/api/owner/${encodeURIComponent(quizId)}`, { token }));
      myQuizzes.remove(quizId);
      mount(root, h('section', { class: 'card empty' },
        h('span', { class: 'big', 'aria-hidden': 'true', text: '🗑️' }),
        h('h1', { text: 'কুইজটি মুছে ফেলা হয়েছে' }),
        h('div', { class: 'btn-row' }, h('a', { class: 'btn green', href: '/create' }, '✏️ নতুন কুইজ বানাও'), h('a', { class: 'btn white', href: '/' }, '🏠 হোমে যাও'))
      ));
    } catch (err) {
      toast(friendlyError(err), 'error');
    }
  }

  function statBox(value, label) {
    return h('div', { class: 'stat' }, h('b', { text: value }), h('span', { text: label }));
  }

  function questionSummary(q, i) {
    const total = q.counts.reduce((s, n) => s + n, 0);
    return h('section', { class: 'card' },
      h('h3', { text: `${toBn(i + 1)}। ${q.text}` }),
      total ? h('p', { class: 'muted', text: `${toBn(q.correctPercent)}% সঠিক উত্তর দিয়েছে` }) : h('p', { class: 'muted', text: 'এখনো কেউ উত্তর দেয়নি' }),
      q.options.map((opt, oi) => {
        const pct = total ? Math.round((q.counts[oi] / total) * 100) : 0;
        const fill = h('span');
        const bar = h('div', { class: `bar${oi === q.correctIndex ? ' correct' : ''}`, role: 'img', 'aria-label': `${opt}: ${toBn(pct)}%` }, fill);
        requestAnimationFrame(() => { fill.style.width = `${pct}%`; });
        return h('div', { class: 'bar-row' },
          h('div', { class: 'bar-label' },
            h('span', { text: `${oi === q.correctIndex ? '✅ ' : ''}${opt}` }),
            h('span', { text: `${toBn(q.counts[oi])} জন · ${toBn(pct)}%` })
          ),
          bar
        );
      })
    );
  }

  function attemptRow(a, rank) {
    const detail = h('ul', { class: 'answers-mini' },
      data.questions.map((q, qi) => {
        const chosen = a.answers[qi];
        if (chosen === null || chosen === undefined) return h('li', { class: 'muted', text: `${toBn(qi + 1)}। —` });
        const ok = chosen === q.correctIndex;
        return h('li', { text: `${ok ? '✅' : '❌'} ${toBn(qi + 1)}। ${q.options[chosen] ?? '—'}${ok ? '' : `  (সঠিক: ${q.options[q.correctIndex]})`}` });
      })
    );
    return h('details', { class: 'attempt' },
      h('summary', {},
        h('div', { class: 'board-row' },
          h('span', { class: 'rank', text: toBn(rank) }),
          h('span', { class: 'who' }, a.playerName, h('small', { text: timeAgo(a.createdAt) })),
          h('span', { class: 'pill', text: `${toBn(a.score)}/${toBn(a.total)}` })
        )
      ),
      detail,
      h('p', { class: 'answers-mini' }, h('button', { class: 'linklike', type: 'button', onclick: () => deleteAttempt(a) }, '🗑 এই উত্তরটি মুছো'))
    );
  }

  function render() {
    const publicUrl = `${location.origin}/q/${data.id}`;
    const sorted = [...data.attempts].sort((a, b) => b.score - a.score || a.createdAt - b.createdAt);
    document.title = `ড্যাশবোর্ড — ${data.title || data.creatorName} — GuessMe BD`;

    const refreshBtn = h('button', { class: 'btn small white', type: 'button' }, '🔄 আপডেট');
    refreshBtn.addEventListener('click', () => refresh(refreshBtn));
    const closeBtn = h('button', { class: `btn small ${data.isClosed ? 'green' : 'white'}`, type: 'button' }, data.isClosed ? '🔓 আবার চালু করো' : '🔒 কুইজ বন্ধ করো');
    closeBtn.addEventListener('click', () => toggleClosed(closeBtn));
    const delBtn = h('button', { class: 'btn small red', type: 'button' }, '🗑 পুরো কুইজ মুছে ফেলো');
    delBtn.addEventListener('click', () => deleteQuiz(delBtn));

    mount(root,
      h('section', { class: 'card sky' },
        h('span', { class: 'eyebrow', text: '🔐 প্রাইভেট — শুধু তুমি দেখছ' }),
        h('h1', { text: data.title || `${data.creatorName}-এর কুইজ` }),
        data.isClosed ? h('p', { class: 'banner warn', role: 'status', text: '🔒 কুইজটি বন্ধ আছে — নতুন কেউ খেলতে পারছে না।' }) : null,
        h('div', { class: 'btn-row' }, refreshBtn, closeBtn)
      ),
      h('div', { class: 'stats' },
        statBox(toBn(data.stats.attemptsCount), 'জন খেলেছে'),
        statBox(`${toBn(data.stats.averagePercent)}%`, 'গড় স্কোর'),
        statBox(toBn(data.stats.perfectCount), 'পারফেক্ট')
      ),
      h('section', { class: 'card' },
        h('h2', { text: '📣 বন্ধুদের লিংক পাঠাও' }),
        h('div', { class: 'copy-box' },
          h('input', { type: 'text', readonly: true, value: publicUrl, 'aria-label': 'পাবলিক লিংক' }),
          h('button', { class: 'btn small', type: 'button', onclick: () => copyWithToast(publicUrl) }, '📋 কপি')
        ),
        shareButtons(publicUrl, { text: `${data.creatorName}-কে তুমি কতটা চেনো? কুইজ খেলো!` })
      ),
      h('section', { class: 'card' },
        h('h2', { text: '🏆 লিডারবোর্ড' }),
        sorted.length
          ? [
              sorted.map((a, i) => attemptRow(a, i + 1)),
              data.attemptsTruncated ? h('p', { class: 'muted', text: 'সর্বশেষ ২০০ জনের উত্তর দেখানো হচ্ছে।' }) : null,
              h('p', { class: 'muted', text: 'নামের উপর ট্যাপ করলে তার প্রতিটি উত্তর দেখতে পাবে।' }),
            ]
          : h('div', { class: 'empty' },
              h('span', { class: 'big', 'aria-hidden': 'true', text: '👀' }),
              h('h3', { text: 'এখনো কেউ খেলেনি' }),
              h('p', { class: 'muted', text: 'উপরের লিংকটি Facebook-এ শেয়ার করো — প্রথম খেলোয়াড় এলেই এখানে দেখা যাবে।' })
            )
      ),
      sorted.length ? h('h2', { text: '📊 প্রশ্নভিত্তিক সারসংক্ষেপ' }) : null,
      sorted.length ? data.questions.map(questionSummary) : null,
      h('section', { class: 'card danger-zone' },
        h('h2', { text: '⚙️ বিপজ্জনক এলাকা' }),
        h('p', { class: 'muted', text: 'কুইজ মুছে ফেললে সব প্রশ্ন ও বন্ধুদের উত্তর স্থায়ীভাবে চলে যাবে।' }),
        delBtn
      ),
      h('p', { class: 'muted center', text: 'গোপন লিংক কাউকে দিও না — এই পেজের ঠিকানাই তোমার চাবি।' })
    );
  }

  // একই পেজে শুধু # বদলালে (যেমন গোপন লিংক পেস্ট করলে) ব্রাউজার রিলোড করে না — আমরা নিজে রিলোড করি
  window.addEventListener('hashchange', () => location.reload());

  load(true);
})();

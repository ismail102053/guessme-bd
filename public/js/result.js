(function () {
  'use strict';
  const { h, mount, api, ApiError, friendlyError, toBn, shareButtons, skeleton, errorView, scoreMessage } = window.GM;

  const root = document.getElementById('result-root');
  const attemptId = location.pathname.split('/').filter(Boolean)[1] || '';

  async function load() {
    mount(root, skeleton());
    let a;
    try {
      a = await api('GET', `/api/attempts/${encodeURIComponent(attemptId)}`);
    } catch (err) {
      const nf = err instanceof ApiError && err.status === 404;
      mount(root, errorView({
        title: nf ? 'রেজাল্টটি পাওয়া যায়নি' : 'লোড করা যাচ্ছে না',
        message: friendlyError(err), emoji: nf ? '🧭' : '📡', onRetry: nf ? null : load,
      }));
      return;
    }
    const msg = scoreMessage(a.score, a.total);
    const url = location.origin + location.pathname;
    document.title = `${a.playerName} পেয়েছে ${toBn(a.score)}/${toBn(a.total)} — GuessMe BD`;
    mount(root,
      h('section', { class: 'card score-card green' },
        h('p', { class: 'muted', text: `${a.playerName} ${a.quiz.creatorName}-কে কতটা চেনে?` }),
        h('div', { class: 'score-num pop', role: 'status', text: toBn(a.score) }, h('small', { text: ` / ${toBn(a.total)}` })),
        h('div', { class: 'pop', 'aria-hidden': 'true', text: msg.emoji }),
        h('h1', { text: msg.text })
      ),
      h('section', { class: 'card sun center' },
        h('h2', { text: `তুমি ${a.quiz.creatorName}-কে কতটা চেনো? 🤔` }),
        a.quiz.isClosed
          ? h('p', { class: 'banner warn', text: '🔒 এই কুইজটি এখন বন্ধ আছে।' })
          : h('a', { class: 'btn red', href: `/q/${a.quiz.id}` }, '🎯 তুমিও খেলো')
      ),
      h('section', { class: 'card' },
        h('h3', { text: '📣 শেয়ার করো' }),
        shareButtons(url, { text: `${a.playerName} ${toBn(a.score)}/${toBn(a.total)} পেয়েছে! তুমি কত পাও?` })
      ),
      h('p', { class: 'center' }, h('a', { class: 'btn green', href: '/create' }, '✏️ নিজের কুইজ বানাও'))
    );
  }

  load();
})();

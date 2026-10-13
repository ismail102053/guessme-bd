(function () {
  'use strict';
  const { h, myQuizzes, timeAgo } = window.GM;

  const list = myQuizzes.list();
  if (!list.length) return;
  const box = document.getElementById('my-list');
  const section = document.getElementById('my-quizzes');
  list.forEach((q) => {
    box.append(
      h('div', { class: 'my-quiz' },
        h('div', {},
          h('strong', { text: q.title || `${q.creatorName}-এর কুইজ` }),
          h('div', { class: 'muted', text: timeAgo(q.createdAt) })
        ),
        h('a', { class: 'btn small green', href: `/manage/${q.id}#${q.ownerToken}` }, '📊 রেজাল্ট')
      )
    );
  });
  section.hidden = false;
})();

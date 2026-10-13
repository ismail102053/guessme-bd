'use strict';
/**
 * ডাটাবেস অ্যাক্সেস লেয়ার। সব কোয়েরি প্যারামিটারাইজড; ইউজার ইনপুট কখনো SQL স্ট্রিংয়ে জোড়া হয় না।
 * ডিলিট অপারেশনে সুস্পষ্ট ক্রমে (answers → attempts → questions → quizzes) মুছি,
 * যাতে ড্রাইভার/কনফিগে foreign_keys বন্ধ থাকলেও ঠিকমতো কাজ করে।
 */

function createRepo(db) {
  const parseOptions = (json) => JSON.parse(json);

  return {
    async createQuiz({ id, tokenHash, creatorName, title, questions, ipHash, now }) {
      const stmts = [
        {
          sql: `INSERT INTO quizzes (id, owner_token_hash, creator_name, title, is_closed, question_count, creator_ip_hash, created_at)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
          args: [id, tokenHash, creatorName, title, questions.length, ipHash, now],
        },
        ...questions.map((q, i) => ({
          sql: 'INSERT INTO questions (quiz_id, position, text, options_json, correct_index) VALUES (?, ?, ?, ?, ?)',
          args: [id, i, q.text, JSON.stringify(q.options), q.correctIndex],
        })),
      ];
      await db.batch(stmts);
    },

    async countQuizzesByIpSince(ipHash, since) {
      const r = await db.execute('SELECT COUNT(*) AS c FROM quizzes WHERE creator_ip_hash = ? AND created_at > ?', [ipHash, since]);
      return r.rows[0].c;
    },

    /** পাবলিক ভিউ — সঠিক উত্তর (correct_index) কখনো এখানে আসে না। */
    async getPublicQuiz(id) {
      const q = await db.execute(
        'SELECT id, creator_name, title, is_closed, question_count, created_at FROM quizzes WHERE id = ?',
        [id]
      );
      if (!q.rows.length) return null;
      const qs = await db.execute('SELECT position, text, options_json FROM questions WHERE quiz_id = ? ORDER BY position', [id]);
      const attempts = await db.execute('SELECT COUNT(*) AS c FROM attempts WHERE quiz_id = ?', [id]);
      const row = q.rows[0];
      return {
        id: row.id,
        creatorName: row.creator_name,
        title: row.title,
        isClosed: row.is_closed === 1,
        attemptsCount: attempts.rows[0].c,
        createdAt: row.created_at,
        questions: qs.rows.map((r) => ({ text: r.text, options: parseOptions(r.options_json) })),
      };
    },

    /** শুধু সার্ভারের ভেতরে ব্যবহার: উত্তর মেলানোর জন্য। */
    async getQuizWithKey(id) {
      const q = await db.execute('SELECT id, is_closed, question_count FROM quizzes WHERE id = ?', [id]);
      if (!q.rows.length) return null;
      const qs = await db.execute(
        'SELECT id, position, options_json, correct_index FROM questions WHERE quiz_id = ? ORDER BY position',
        [id]
      );
      return {
        id: q.rows[0].id,
        isClosed: q.rows[0].is_closed === 1,
        questions: qs.rows.map((r) => ({
          id: r.id,
          position: r.position,
          optionCount: parseOptions(r.options_json).length,
          correctIndex: r.correct_index,
        })),
      };
    },

    async getOwnerHash(id) {
      const r = await db.execute('SELECT owner_token_hash FROM quizzes WHERE id = ?', [id]);
      return r.rows.length ? r.rows[0].owner_token_hash : null;
    },

    async countAttempts(quizId) {
      const r = await db.execute('SELECT COUNT(*) AS c FROM attempts WHERE quiz_id = ?', [quizId]);
      return r.rows[0].c;
    },

    async countAttemptsByIpQuizSince(ipHash, quizId, since) {
      const r = await db.execute(
        'SELECT COUNT(*) AS c FROM attempts WHERE ip_hash = ? AND quiz_id = ? AND created_at > ?',
        [ipHash, quizId, since]
      );
      return r.rows[0].c;
    },

    async createAttempt({ id, quizId, playerName, score, total, ipHash, now, answers }) {
      await db.batch([
        {
          sql: 'INSERT INTO attempts (id, quiz_id, player_name, score, total, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [id, quizId, playerName, score, total, ipHash, now],
        },
        ...answers.map((a) => ({
          sql: 'INSERT INTO answers (attempt_id, question_id, chosen_index, is_correct) VALUES (?, ?, ?, ?)',
          args: [id, a.questionId, a.chosenIndex, a.isCorrect ? 1 : 0],
        })),
      ]);
    },

    /** পাবলিক রেজাল্ট কার্ড: শুধু নাম ও স্কোর (উত্তরের বিস্তারিত নয়)। */
    async getPublicAttempt(id) {
      const r = await db.execute(
        `SELECT a.id, a.player_name, a.score, a.total, a.created_at, q.id AS quiz_id, q.creator_name, q.title, q.is_closed
         FROM attempts a JOIN quizzes q ON q.id = a.quiz_id WHERE a.id = ?`,
        [id]
      );
      if (!r.rows.length) return null;
      const x = r.rows[0];
      return {
        id: x.id,
        playerName: x.player_name,
        score: x.score,
        total: x.total,
        createdAt: x.created_at,
        quiz: { id: x.quiz_id, creatorName: x.creator_name, title: x.title, isClosed: x.is_closed === 1 },
      };
    },

    /** ওনার ড্যাশবোর্ডের সম্পূর্ণ ডেটা। */
    async getOwnerDashboard(id, { attemptLimit = 200 } = {}) {
      const q = await db.execute(
        'SELECT id, creator_name, title, is_closed, question_count, created_at FROM quizzes WHERE id = ?',
        [id]
      );
      if (!q.rows.length) return null;
      const quiz = q.rows[0];

      const qs = await db.execute(
        'SELECT position, text, options_json, correct_index FROM questions WHERE quiz_id = ? ORDER BY position',
        [id]
      );
      const stats = await db.execute(
        `SELECT COUNT(*) AS c, COALESCE(AVG(score * 1.0 / total), 0) AS avg_ratio,
                COALESCE(SUM(CASE WHEN score = total THEN 1 ELSE 0 END), 0) AS perfect
         FROM attempts WHERE quiz_id = ?`,
        [id]
      );
      const attempts = await db.execute(
        `SELECT id, player_name, score, total, created_at FROM attempts
         WHERE quiz_id = ? ORDER BY created_at DESC, id LIMIT ?`,
        [id, attemptLimit]
      );
      const dist = await db.execute(
        `SELECT q.position AS position, a.chosen_index AS chosen, COUNT(*) AS c
         FROM answers a JOIN questions q ON q.id = a.question_id
         WHERE q.quiz_id = ? GROUP BY q.position, a.chosen_index`,
        [id]
      );
      const detail = await db.execute(
        `SELECT a.attempt_id AS attempt_id, q.position AS position, a.chosen_index AS chosen
         FROM answers a JOIN questions q ON q.id = a.question_id
         WHERE a.attempt_id IN (SELECT id FROM attempts WHERE quiz_id = ? ORDER BY created_at DESC, id LIMIT ?)`,
        [id, attemptLimit]
      );

      const counts = qs.rows.map((r) => Array(parseOptions(r.options_json).length).fill(0));
      for (const d of dist.rows) {
        if (counts[d.position] && counts[d.position][d.chosen] !== undefined) counts[d.position][d.chosen] = d.c;
      }
      const answersByAttempt = new Map();
      for (const d of detail.rows) {
        if (!answersByAttempt.has(d.attempt_id)) answersByAttempt.set(d.attempt_id, Array(qs.rows.length).fill(null));
        answersByAttempt.get(d.attempt_id)[d.position] = d.chosen;
      }

      const total = stats.rows[0].c;
      return {
        id: quiz.id,
        creatorName: quiz.creator_name,
        title: quiz.title,
        isClosed: quiz.is_closed === 1,
        createdAt: quiz.created_at,
        stats: {
          attemptsCount: total,
          averagePercent: Math.round(stats.rows[0].avg_ratio * 100),
          perfectCount: stats.rows[0].perfect,
        },
        questions: qs.rows.map((r, i) => {
          const options = parseOptions(r.options_json);
          const answered = counts[i].reduce((s, n) => s + n, 0);
          return {
            text: r.text,
            options,
            correctIndex: r.correct_index,
            counts: counts[i],
            correctPercent: answered ? Math.round((counts[i][r.correct_index] / answered) * 100) : 0,
          };
        }),
        attempts: attempts.rows.map((r) => ({
          id: r.id,
          playerName: r.player_name,
          score: r.score,
          total: r.total,
          createdAt: r.created_at,
          answers: answersByAttempt.get(r.id) || [],
        })),
        attemptsTruncated: total > attemptLimit,
      };
    },

    async setClosed(id, isClosed) {
      const r = await db.execute('UPDATE quizzes SET is_closed = ? WHERE id = ?', [isClosed ? 1 : 0, id]);
      return r.rowsAffected > 0;
    },

    async deleteQuiz(id) {
      await db.batch([
        { sql: 'DELETE FROM answers WHERE attempt_id IN (SELECT id FROM attempts WHERE quiz_id = ?)', args: [id] },
        { sql: 'DELETE FROM attempts WHERE quiz_id = ?', args: [id] },
        { sql: 'DELETE FROM questions WHERE quiz_id = ?', args: [id] },
        { sql: 'DELETE FROM quizzes WHERE id = ?', args: [id] },
      ]);
    },

    /** একটি attempt মোছে এবং মোছা হয়েছে কি না জানায়। */
    async deleteAttempt(quizId, attemptId) {
      const results = await db.batch([
        {
          sql: 'DELETE FROM answers WHERE attempt_id IN (SELECT id FROM attempts WHERE id = ? AND quiz_id = ?)',
          args: [attemptId, quizId],
        },
        { sql: 'DELETE FROM attempts WHERE id = ? AND quiz_id = ?', args: [attemptId, quizId] },
      ]);
      return results[1].rowsAffected > 0;
    },
  };
}

module.exports = { createRepo };

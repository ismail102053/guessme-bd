'use strict';
/**
 * Turso (libSQL) ড্রাইভার — HTTP "Hrana over HTTP" (/v2/pipeline) প্রোটোকলে, শুধু বিল্ট-ইন fetch দিয়ে।
 * কোনো npm প্যাকেজ লাগে না। ফ্রি-টায়ার হোস্টিংয়ে (যেখানে ডিস্ক স্থায়ী নয়) এটিই সুপারিশকৃত।
 *
 * সতর্কতা: এই ড্রাইভারটি একটি লোকাল মক সার্ভারের বিপরীতে টেস্ট করা হয়েছে (tests/turso.test.js),
 * আসল Turso সার্ভারের বিপরীতে নয়। প্রথম ডিপ্লয়ের সময় /api/health দিয়ে যাচাই করে নিন।
 */
const { DbError } = require('./errors');

function toHttpUrl(url) {
  return String(url).replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '');
}

function encodeArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  return { type: 'text', value: String(v) };
}

function decodeCell(cell) {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer') return Number(cell.value);
  if (cell.type === 'float') return Number(cell.value);
  return cell.value;
}

function decodeResult(result) {
  const cols = (result.cols || []).map((c) => c.name);
  const rows = (result.rows || []).map((r) => {
    const obj = {};
    cols.forEach((name, i) => {
      obj[name] = decodeCell(r[i]);
    });
    return obj;
  });
  return {
    rows,
    rowsAffected: Number(result.affected_row_count || 0),
    lastInsertRowid: result.last_insert_rowid == null ? null : Number(result.last_insert_rowid),
  };
}

function createTursoDb({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const base = toHttpUrl(url);
  const endpoint = `${base}/v2/pipeline`;

  async function pipeline(requests) {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DbError('ডাটাবেস সার্ভারে সংযোগ করা যায়নি', { cause: err, code: 'TURSO_NETWORK' });
    }
    if (!res.ok) {
      // রেসপন্স বডি লগে/ত্রুটিতে রাখা হয় না (টোকেন-সংক্রান্ত তথ্য থাকতে পারে)
      throw new DbError(`ডাটাবেস সার্ভার ত্রুটি (HTTP ${res.status})`, { code: `TURSO_HTTP_${res.status}` });
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new DbError('ডাটাবেস সার্ভারের উত্তর বোঝা যায়নি', { cause: err, code: 'TURSO_BAD_JSON' });
    }
    return data.results || [];
  }

  function stmtOf(sql, args = []) {
    return { sql, args: args.map(encodeArg), want_rows: true };
  }

  return {
    driver: 'turso',

    async execute(sql, args = []) {
      const results = await pipeline([{ type: 'execute', stmt: stmtOf(sql, args) }]);
      const first = results[0];
      if (!first || first.type === 'error') {
        throw new DbError('ডাটাবেস কোয়েরি ব্যর্থ হয়েছে', {
          cause: new Error(first?.error?.message || 'unknown'),
          code: first?.error?.code,
        });
      }
      return decodeResult(first.response.result);
    },

    /** BEGIN … COMMIT, কোনো ধাপ ব্যর্থ হলে ROLLBACK (libsql-client এর নিজস্ব পদ্ধতির মতো)। */
    async batch(statements) {
      const steps = [{ stmt: { sql: 'BEGIN', args: [] } }];
      statements.forEach((s, i) => {
        steps.push({ stmt: stmtOf(s.sql, s.args || []), condition: { type: 'ok', step: i } });
      });
      const commitIdx = steps.length;
      steps.push({ stmt: { sql: 'COMMIT', args: [] }, condition: { type: 'ok', step: commitIdx - 1 } });
      steps.push({
        stmt: { sql: 'ROLLBACK', args: [] },
        condition: { type: 'not', cond: { type: 'ok', step: commitIdx } },
      });

      const results = await pipeline([{ type: 'batch', batch: { steps } }]);
      const first = results[0];
      if (!first || first.type === 'error') {
        throw new DbError('ডাটাবেস ব্যাচ ব্যর্থ হয়েছে', { cause: new Error(first?.error?.message || 'unknown') });
      }
      const { step_results: stepResults = [], step_errors: stepErrors = [] } = first.response.result;
      for (let i = 0; i <= commitIdx; i += 1) {
        if (stepErrors[i]) {
          throw new DbError('ডাটাবেস কোয়েরি ব্যর্থ হয়েছে', { cause: new Error(stepErrors[i].message || 'unknown') });
        }
      }
      if (!stepResults[commitIdx]) {
        throw new DbError('ডাটাবেস ট্রানজাকশন সম্পন্ন হয়নি');
      }
      // ব্যবহারকারীর স্টেটমেন্টগুলোর ফলাফল = ধাপ ১..n
      return statements.map((_, i) => decodeResult(stepResults[i + 1] || {}));
    },

    async ping() {
      await this.execute('SELECT 1 AS ok');
      return true;
    },

    async close() {
      /* HTTP — বন্ধ করার কিছু নেই */
    },
  };
}

module.exports = { createTursoDb, toHttpUrl, encodeArg, decodeResult };

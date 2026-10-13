'use strict';
const { createSqliteDb } = require('./sqlite');
const { createTursoDb } = require('./turso');

function createDb(config) {
  if (config.db.driver === 'turso') {
    return createTursoDb({ url: config.db.tursoUrl, token: config.db.tursoToken });
  }
  return createSqliteDb({ file: config.db.sqlitePath });
}

module.exports = { createDb };

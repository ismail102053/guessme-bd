'use strict';

/** ডাটাবেস-সংক্রান্ত ত্রুটি। message ব্যবহারকারীকে দেখানো যেতে পারে; cause শুধু লগের জন্য। */
class DbError extends Error {
  constructor(message, { cause, code } = {}) {
    super(message);
    this.name = 'DbError';
    this.cause = cause;
    this.code = code;
  }
}

module.exports = { DbError };

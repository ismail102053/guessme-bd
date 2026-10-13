'use strict';
const http = require('node:http');
const { loadDotenvFile, loadConfig } = require('./src/config');
const { createLogger } = require('./src/lib/logger');
const { createDb } = require('./src/db');
const { runMigrations } = require('./src/db/migrate');
const { createApp } = require('./src/app');

/** সার্ভার তৈরি (টেস্টেও ব্যবহৃত)। listen করে না — কলার করে। */
async function createServer(config) {
  const logger = createLogger({ level: config.logLevel, silent: config.silent });
  const db = createDb(config);
  if (config.db.autoMigrate) await runMigrations(db, { logger });

  const app = createApp(config, { db, logger });
  const server = http.createServer(app.handler);
  // স্লো-লরিস ধরনের আক্রমণ ও ঝুলে থাকা সংযোগ ঠেকাতে
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  const sweeper = setInterval(() => app.limiter.sweep(), 10 * 60_000);
  sweeper.unref();

  async function close() {
    clearInterval(sweeper);
    await new Promise((resolve) => server.close(() => resolve()));
    await db.close();
  }
  return { server, db, app, close, logger };
}

async function main() {
  loadDotenvFile();
  const config = loadConfig();
  const { server, close, logger } = await createServer(config);

  if (config.ephemeralSecret) {
    logger.warn('APP_SECRET সেট করা নেই — অস্থায়ী সিক্রেট ব্যবহার হচ্ছে (শুধু ডেভেলপমেন্টে ঠিক আছে)।');
  }
  if (config.isProd && !config.publicBaseUrl) {
    logger.warn('PUBLIC_BASE_URL সেট করা নেই — Facebook শেয়ার লিংক Host হেডার থেকে তৈরি হবে।');
  }

  server.listen(config.port, config.host, () => {
    const addr = server.address();
    logger.info('GuessMe BD চালু হয়েছে', { port: addr.port, env: config.nodeEnv, db: config.db.driver });
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info('বন্ধ করা হচ্ছে', { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await close();
      process.exit(0);
    } catch (err) {
      logger.error('বন্ধ করতে সমস্যা', { err });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { err }));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ সার্ভার চালু করা যায়নি:', err.message);
    process.exit(1);
  });
}

module.exports = { createServer };

// server.js — LineUp Backend Entry Point
require('dotenv').config();

const app    = require('./src/app');
const db     = require('./src/db');
const cron   = require('./src/jobs/oddsCron');
const logger = require('./src/utils/logger');

const PORT = process.env.PORT || 3001;

async function start() {
  // 1. Verify DB connection
  try {
    await db.query('SELECT 1');
    logger.info('✅  Database connected');
  } catch (err) {
    logger.error('❌  Database connection failed:', err.message);
    logger.warn('⚠️   Running without DB — auth/picks endpoints will not work');
  }

  // 2. Start the Express server
  app.listen(PORT, () => {
    logger.info(`🚀  LineUp API running on http://localhost:${PORT}`);
    logger.info(`📖  Docs: http://localhost:${PORT}/api/health`);
  });

  // 3. Start the odds-refresh cron job
  cron.start();
  logger.info(`⏱️   Odds refresh cron started (every ${process.env.ODDS_REFRESH_INTERVAL_MINUTES || 30} min)`);
}

start();

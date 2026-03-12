// src/db.js — PostgreSQL connection pool
const { Pool } = require('pg');
const logger   = require('./utils/logger');

let pool;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false } // Required for Supabase / Heroku
      : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
} else {
  pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'lineup_db',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error:', err.message);
});

/**
 * Run a parameterised query.
 * @param {string} text  - SQL string with $1, $2 placeholders
 * @param {any[]}  params
 */
async function query(text, params) {
  const start = Date.now();
  const res   = await pool.query(text, params);
  const ms    = Date.now() - start;
  if (process.env.NODE_ENV === 'development') {
    logger.debug(`[DB] ${ms}ms — ${text.slice(0, 80)}`);
  }
  return res;
}

/**
 * Grab a client from the pool for multi-statement transactions.
 */
async function getClient() {
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);
  client.query = (...args) => {
    client._lastQuery = args;
    return originalQuery(...args);
  };
  return client;
}

module.exports = { query, getClient, pool };

// src/utils/logger.js
// Lightweight logger — swap for Winston/Pino in production if desired.

const isDev = process.env.NODE_ENV !== 'production';

const colors = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function fmt(level, color, ...args) {
  const prefix = isDev
    ? `${colors.dim}${timestamp()}${colors.reset} ${color}[${level}]${colors.reset}`
    : `[${level}] ${timestamp()}`;
  console.log(prefix, ...args);
}

module.exports = {
  info:  (...a) => fmt('INFO',  colors.green,  ...a),
  warn:  (...a) => fmt('WARN',  colors.yellow, ...a),
  error: (...a) => fmt('ERROR', colors.red,    ...a),
  debug: (...a) => { if (isDev) fmt('DEBUG', colors.cyan, ...a); },
};

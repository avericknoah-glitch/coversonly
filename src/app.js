// src/app.js — Express application factory
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');

const authRoutes   = require('./routes/auth');
const oddsRoutes   = require('./routes/odds');
const leagueRoutes = require('./routes/leagues');
const pickRoutes   = require('./routes/picks');
const userRoutes   = require('./routes/users');

const app = express();

// ── Trust proxy (required for Railway/Heroku deployments) ────────────────────
app.set('trust proxy', 1);

// ── Security & compression ──────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Disabled — frontend is a single inline HTML file
}));
app.use(compression());

// ── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ──────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ── Global rate limiting ─────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, please try again in 15 minutes.' },
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',    authLimiter, authRoutes);
app.use('/api/odds',    oddsRoutes);
app.use('/api/leagues', leagueRoutes);
app.use('/api/picks',   pickRoutes);
app.use('/api/users',   userRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// ── Serve frontend ───────────────────────────────────────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '../public/index.html');
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message;

  if (status === 500) {
    console.error('[ERROR]', err);
  }

  res.status(status).json({ error: message });
});

module.exports = app;

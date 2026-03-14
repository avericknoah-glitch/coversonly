// src/routes/auth.js
const express  = require('express');
const bcrypt   = require('bcryptjs');
const db       = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── POST /api/auth/register ──────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, username, first_name, last_name } = req.body;

    // Validation
    if (!email || !password || !username) {
      return res.status(400).json({ error: 'email, password, and username are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–30 chars, letters/numbers/underscores only' });
    }

    // Check uniqueness (case-insensitive comparisons, preserve stored casing)
    const { rows: emailConflict } = await db.query(
      'SELECT id FROM users WHERE lower(email) = $1',
      [email.toLowerCase()]
    );
    if (emailConflict.length > 0) {
      return res.status(409).json({ error: 'Email already taken' });
    }
    const { rows: usernameConflict } = await db.query(
      'SELECT id FROM users WHERE lower(username) = $1',
      [username.toLowerCase()]
    );
    if (usernameConflict.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hash = await bcrypt.hash(password, 12);

    const { rows } = await db.query(`
      INSERT INTO users (email, password_hash, username, first_name, last_name)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, email, username, first_name, last_name, created_at
    `, [email.toLowerCase(), hash, username, first_name || '', last_name || '']);

    const user  = rows[0];
    const token = signToken(user);

    res.status(201).json({ user, token });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { rows } = await db.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    const user = rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last_login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const token = signToken(user);
    const { password_hash, ...safeUser } = user;

    res.json({ user: safeUser, token });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.username, u.first_name, u.last_name,
             u.created_at, u.last_login,
             COUNT(DISTINCT lm.league_id) AS league_count,
             COUNT(DISTINCT CASE WHEN lm.role = 'commissioner' THEN lm.league_id END) AS commissioner_count
      FROM users u
      LEFT JOIN league_members lm ON lm.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id
    `, [req.user.id]);

    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/auth/profile ──────────────────────────────────────────────────
// Update the current user's profile. current_password is always required.
router.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const { first_name, last_name, username, email, current_password, new_password } = req.body;

    if (!current_password) {
      return res.status(400).json({ error: 'current_password is required' });
    }

    // Fetch stored hash
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const passwordOk = await bcrypt.compare(current_password, user.password_hash);
    if (!passwordOk) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Check uniqueness of username/email against other users (separate checks for specific errors)
    if (email) {
      const { rows: emailConflict } = await db.query(
        'SELECT id FROM users WHERE lower(email) = $1 AND id != $2',
        [email.toLowerCase(), req.user.id]
      );
      if (emailConflict.length > 0) {
        return res.status(409).json({ error: 'Email already taken' });
      }
    }
    if (username) {
      const { rows: usernameConflict } = await db.query(
        'SELECT id FROM users WHERE lower(username) = $1 AND id != $2',
        [username.toLowerCase(), req.user.id]
      );
      if (usernameConflict.length > 0) {
        return res.status(409).json({ error: 'Username already taken' });
      }
    }

    // Build update
    const newHash = new_password ? await bcrypt.hash(new_password, 12) : null;

    const { rows: updated } = await db.query(`
      UPDATE users SET
        first_name    = $1,
        last_name     = $2,
        username      = $3,
        email         = $4,
        password_hash = COALESCE($5, password_hash),
        updated_at    = NOW()
      WHERE id = $6
      RETURNING id, email, username, first_name, last_name, created_at, last_login
    `, [
      first_name ?? user.first_name,
      last_name  ?? user.last_name,
      username  || user.username,
      (email || user.email).toLowerCase(),
      newHash,
      req.user.id,
    ]);

    res.json({ user: updated[0] });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ────────────────────────────────────────────────────
// JWTs are stateless, so logout is handled client-side by deleting the token.
// This endpoint exists so clients have a consistent API surface.
router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;

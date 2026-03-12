// src/middleware/auth.js
const jwt    = require('jsonwebtoken');
const db     = require('../db');

const SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

/**
 * Middleware: verifies the Bearer token and attaches req.user.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, SECRET);
    // Optionally re-fetch user to ensure they still exist
    try {
      const { rows } = await db.query(
        'SELECT id, username, email, role FROM users WHERE id = $1',
        [payload.userId]
      );
      if (!rows[0]) return res.status(401).json({ error: 'User not found' });
      req.user = rows[0];
    } catch {
      // DB not available — trust the token payload
      req.user = { id: payload.userId, username: payload.username, email: payload.email };
    }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Middleware: only lets league commissioners or co-commissioners through.
 * Expects :leagueId in the route params.
 */
async function requireCommissioner(req, res, next) {
  const { leagueId } = req.params;
  const userId       = req.user.id;

  try {
    const { rows } = await db.query(`
      SELECT role FROM league_members
      WHERE league_id = $1 AND user_id = $2
    `, [leagueId, userId]);

    const role = rows[0]?.role;
    if (role === 'commissioner' || role === 'co_commissioner') return next();
    return res.status(403).json({ error: 'Commissioner access required' });
  } catch {
    return res.status(403).json({ error: 'Could not verify league role' });
  }
}

/**
 * Generate a signed JWT for a user.
 */
function signToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, email: user.email },
    SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

module.exports = { requireAuth, requireCommissioner, signToken };

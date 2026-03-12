// src/routes/users.js
const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/users/:username ─────────────────────────────────────────────────
// Public profile for any user
router.get('/:username', requireAuth, async (req, res, next) => {
  try {
    const { username } = req.params;

    const { rows } = await db.query(`
      SELECT u.id, u.username, u.first_name, u.last_name, u.created_at,
             COUNT(DISTINCT lm.league_id) AS league_count,
             COUNT(DISTINCT p.id)         AS total_picks,
             SUM(CASE WHEN p.result = 'win'  THEN 1 ELSE 0 END) AS wins,
             SUM(CASE WHEN p.result = 'loss' THEN 1 ELSE 0 END) AS losses,
             SUM(CASE WHEN p.result = 'push' THEN 1 ELSE 0 END) AS pushes,
             CASE
               WHEN SUM(CASE WHEN p.result IN ('win','loss') THEN 1 ELSE 0 END) = 0 THEN 0
               ELSE ROUND(
                 SUM(CASE WHEN p.result = 'win' THEN 1 ELSE 0 END)::numeric /
                 NULLIF(SUM(CASE WHEN p.result IN ('win','loss') THEN 1 ELSE 0 END), 0) * 100, 1
               )
             END AS win_pct
      FROM users u
      LEFT JOIN league_members lm ON lm.user_id = u.id
      LEFT JOIN picks p           ON p.user_id = u.id
      WHERE u.username = $1
      GROUP BY u.id
    `, [username.toLowerCase()]);

    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/users/me ───────────────────────────────────────────────────────
// Update own profile
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const { first_name, last_name } = req.body;
    const { rows } = await db.query(`
      UPDATE users
      SET first_name = COALESCE($1, first_name),
          last_name  = COALESCE($2, last_name),
          updated_at = NOW()
      WHERE id = $3
      RETURNING id, email, username, first_name, last_name
    `, [first_name, last_name, req.user.id]);

    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

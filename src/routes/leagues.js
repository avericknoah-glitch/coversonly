// src/routes/leagues.js
const express = require('express');
const db      = require('../db');
const { requireAuth, requireCommissioner } = require('../middleware/auth');

const router = express.Router();

(async function migrate() {
  try {
    await db.query(`
      ALTER TABLE leagues
      ADD COLUMN IF NOT EXISTS pick_type_limits JSONB DEFAULT NULL
    `);
  } catch(e) {
    console.warn('[migrate] pick_type_limits column:', e.message);
  }
})();

// ── GET /api/leagues ─────────────────────────────────────────────────────────
// Get all leagues the current user belongs to
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      WITH member_stats AS (
        SELECT lm.league_id,
               lm.user_id,
               SUM(CASE WHEN p.result = 'win'  THEN 1 ELSE 0 END) AS wins,
               SUM(CASE WHEN p.result = 'loss' THEN 1 ELSE 0 END) AS losses,
               SUM(CASE WHEN p.result = 'push' THEN 1 ELSE 0 END) AS pushes,
               CASE
                 WHEN SUM(CASE WHEN p.result IN ('win','loss','push') THEN 1 ELSE 0 END) = 0 THEN 0
                 ELSE ROUND(
                   (SUM(CASE WHEN p.result = 'win' THEN 1 ELSE 0 END) +
                    0.5 * SUM(CASE WHEN p.result = 'push' THEN 1 ELSE 0 END))::numeric /
                   NULLIF(SUM(CASE WHEN p.result IN ('win','loss','push') THEN 1 ELSE 0 END), 0) * 100, 1
                 )
               END AS win_pct
        FROM league_members lm
        LEFT JOIN picks p ON p.league_id = lm.league_id AND p.user_id = lm.user_id
        GROUP BY lm.league_id, lm.user_id
      ),
      ranked AS (
        SELECT league_id, user_id, wins, losses, pushes, win_pct,
               RANK() OVER (PARTITION BY league_id ORDER BY wins DESC, win_pct DESC) AS rank
        FROM member_stats
      )
      SELECT l.*,
             lm.role AS member_role,
             (SELECT COUNT(*) FROM league_members WHERE league_id = l.id) AS member_count,
             r.wins, r.losses, r.pushes, r.win_pct, r.rank
      FROM leagues l
      JOIN league_members lm ON lm.league_id = l.id AND lm.user_id = $1
      JOIN ranked r ON r.league_id = l.id AND r.user_id = $1
      ORDER BY l.created_at DESC
    `, [req.user.id]);

    res.json({ leagues: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/leagues/browse ───────────────────────────────────────────────────
// Public leagues that the user hasn't joined yet
router.get('/browse', requireAuth, async (req, res, next) => {
  try {
    const { search, sport } = req.query;

    let sql = `
      SELECT l.*,
             COUNT(lm.id) AS member_count,
             u.username   AS commissioner_name
      FROM leagues l
      JOIN league_members lm ON lm.league_id = l.id
      JOIN users u ON u.id = l.commissioner_id
      WHERE l.visibility = 'public'
        AND l.id NOT IN (
          SELECT league_id FROM league_members WHERE user_id = $1
        )
    `;
    const params = [req.user.id];

    if (search) {
      params.push(`%${search}%`);
      sql += ` AND l.name ILIKE $${params.length}`;
    }
    if (sport) {
      params.push(sport);
      sql += ` AND $${params.length} = ANY(l.sports)`;
    }

    sql += ` GROUP BY l.id, u.username ORDER BY member_count DESC LIMIT 50`;

    const { rows } = await db.query(sql, params);
    res.json({ leagues: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/leagues ────────────────────────────────────────────────────────
// Create a new league
router.post('/', requireAuth, async (req, res, next) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const {
      name,
      visibility    = 'private',
      sports        = ['nfl'],
      bet_types     = ['spread', 'moneyline', 'totals'],
      picks_per_week = 5,
      max_members   = 20,
      pick_deadline  = 'first_game',
      pick_type_limits = null,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'League name is required' });

    const { rows } = await client.query(`
      INSERT INTO leagues (
        name, visibility, sports, bet_types, picks_per_week,
        max_members, pick_deadline, commissioner_id, pick_type_limits
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [name, visibility, sports, bet_types, picks_per_week, max_members, pick_deadline, req.user.id, pick_type_limits ? JSON.stringify(pick_type_limits) : null]);

    const league = rows[0];

    // Auto-join creator as commissioner
    await client.query(`
      INSERT INTO league_members (league_id, user_id, role)
      VALUES ($1, $2, 'commissioner')
    `, [league.id, req.user.id]);

    // Generate a unique invite code
    const inviteCode = generateInviteCode(league.id);
    await client.query(`UPDATE leagues SET invite_code = $1 WHERE id = $2`, [inviteCode, league.id]);

    await client.query('COMMIT');

    // Re-fetch to get the complete row including pick_type_limits and invite_code
    const { rows: finalRows } = await db.query('SELECT * FROM leagues WHERE id = $1', [league.id]);
    res.status(201).json({ league: { ...finalRows[0], my_role: 'commissioner' } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ── GET /api/leagues/:leagueId ───────────────────────────────────────────────
// Full league detail including standings
router.get('/:leagueId', requireAuth, async (req, res, next) => {
  try {
    const { leagueId } = req.params;

    // Verify the user is a member
    const { rows: membership } = await db.query(
      'SELECT role FROM league_members WHERE league_id = $1 AND user_id = $2',
      [leagueId, req.user.id]
    );
    if (!membership[0]) return res.status(403).json({ error: 'Not a member of this league' });

    const { rows: leagueRows } = await db.query(`
      SELECT l.*, u.username AS commissioner_name
      FROM leagues l
      JOIN users u ON u.id = l.commissioner_id
      WHERE l.id = $1
    `, [leagueId]);

    if (!leagueRows[0]) return res.status(404).json({ error: 'League not found' });

    // Standings: all members with their win/loss/push records
    const { rows: standings } = await db.query(`
      SELECT u.id, u.username, u.first_name, u.last_name,
             lm.role,
             COUNT(p.id)                                       AS total_picks,
             SUM(CASE WHEN p.result = 'win'    THEN 1 ELSE 0 END) AS wins,
             SUM(CASE WHEN p.result = 'loss'   THEN 1 ELSE 0 END) AS losses,
             SUM(CASE WHEN p.result = 'push'   THEN 1 ELSE 0 END) AS pushes,
             SUM(CASE WHEN p.result = 'pending' THEN 1 ELSE 0 END) AS pending,
             CASE
               WHEN SUM(CASE WHEN p.result IN ('win','loss','push') THEN 1 ELSE 0 END) = 0 THEN 0
               ELSE ROUND(
                 (SUM(CASE WHEN p.result = 'win' THEN 1 ELSE 0 END) +
                  0.5 * SUM(CASE WHEN p.result = 'push' THEN 1 ELSE 0 END))::numeric /
                 NULLIF(SUM(CASE WHEN p.result IN ('win','loss','push') THEN 1 ELSE 0 END), 0) * 100, 1
               )
             END AS win_pct
      FROM league_members lm
      JOIN users u ON u.id = lm.user_id
      LEFT JOIN picks p ON p.league_id = $1 AND p.user_id = u.id
      WHERE lm.league_id = $1
      GROUP BY u.id, u.username, u.first_name, u.last_name, lm.role
      ORDER BY wins DESC, win_pct DESC
    `, [leagueId]);

    res.json({
      league:   { ...leagueRows[0], my_role: membership[0].role },
      standings,
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/leagues/:leagueId ─────────────────────────────────────────────
// Update league settings (commissioner only)
router.patch('/:leagueId', requireAuth, requireCommissioner, async (req, res, next) => {
  try {
    const { leagueId } = req.params;
    const allowed = ['name', 'visibility', 'sports', 'bet_types', 'picks_per_week', 'max_members', 'pick_deadline', 'odds_max', 'pick_type_limits'];

    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values     = [leagueId, ...Object.values(updates)];

    const { rows } = await db.query(
      `UPDATE leagues SET ${setClauses}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      values
    );

    res.json({ league: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/leagues/:leagueId/invite ───────────────────────────────────────
// Send an invite (by email or username)
router.post('/:leagueId/invite', requireAuth, requireCommissioner, async (req, res, next) => {
  try {
    const { leagueId } = req.params;
    const { identifier } = req.body; // email or username

    if (!identifier) return res.status(400).json({ error: 'identifier (email or username) required' });

    // Find user
    const { rows } = await db.query(
      'SELECT id, username, email FROM users WHERE email = $1 OR username = $1',
      [identifier.toLowerCase()]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    const invitee = rows[0];

    // Check already a member
    const { rows: existing } = await db.query(
      'SELECT id FROM league_members WHERE league_id = $1 AND user_id = $2',
      [leagueId, invitee.id]
    );
    if (existing[0]) return res.status(409).json({ error: 'User is already a member' });

    // Insert invite (pending)
    await db.query(`
      INSERT INTO league_invites (league_id, inviter_id, invitee_id, status)
      VALUES ($1, $2, $3, 'pending')
      ON CONFLICT (league_id, invitee_id) DO NOTHING
    `, [leagueId, req.user.id, invitee.id]);

    // TODO: send email notification here

    res.json({ message: `Invite sent to ${invitee.username}` });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/leagues/join ────────────────────────────────────────────────────
// Join a league via invite code in request body { invite_code }
router.post('/join', requireAuth, async (req, res, next) => {
  try {
    const { invite_code } = req.body;
    if (!invite_code) return res.status(400).json({ error: 'invite_code is required' });

    const { rows: leagues } = await db.query(
      'SELECT * FROM leagues WHERE invite_code = $1',
      [invite_code.toUpperCase()]
    );
    if (!leagues[0]) return res.status(404).json({ error: 'Invalid invite code' });

    const league = leagues[0];

    // Check already a member
    const { rows: existing } = await db.query(
      'SELECT id FROM league_members WHERE league_id = $1 AND user_id = $2',
      [league.id, req.user.id]
    );
    if (existing[0]) return res.status(409).json({ error: 'Already a member of this league' });

    // Check capacity
    const { rows: members } = await db.query(
      'SELECT COUNT(*) AS count FROM league_members WHERE league_id = $1',
      [league.id]
    );
    if (parseInt(members[0].count) >= league.max_members) {
      return res.status(409).json({ error: 'League is full' });
    }

    await db.query(
      'INSERT INTO league_members (league_id, user_id, role) VALUES ($1, $2, $3)',
      [league.id, req.user.id, 'member']
    );

    res.json({ league });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/leagues/join/:inviteCode ───────────────────────────────────────
// Join a league via invite code
router.post('/join/:inviteCode', requireAuth, async (req, res, next) => {
  try {
    const { inviteCode } = req.params;

    const { rows: leagues } = await db.query(
      'SELECT * FROM leagues WHERE invite_code = $1',
      [inviteCode.toUpperCase()]
    );
    if (!leagues[0]) return res.status(404).json({ error: 'Invalid invite code' });

    const league = leagues[0];

    // Check capacity
    const { rows: members } = await db.query(
      'SELECT COUNT(*) AS count FROM league_members WHERE league_id = $1',
      [league.id]
    );
    if (parseInt(members[0].count) >= league.max_members) {
      return res.status(409).json({ error: 'League is full' });
    }

    // Check already a member
    const { rows: existing } = await db.query(
      'SELECT id FROM league_members WHERE league_id = $1 AND user_id = $2',
      [league.id, req.user.id]
    );
    if (existing[0]) return res.status(409).json({ error: 'Already a member' });

    await db.query(
      'INSERT INTO league_members (league_id, user_id, role) VALUES ($1, $2, $3)',
      [league.id, req.user.id, 'member']
    );

    res.json({ message: `Joined ${league.name}!`, league });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/leagues/:leagueId ─────────────────────────────────────────────
// Delete a league entirely (commissioner only)
router.delete('/:leagueId', requireAuth, requireCommissioner, async (req, res, next) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { leagueId } = req.params;

    // Delete all picks for this league
    await client.query('DELETE FROM picks WHERE league_id = $1', [leagueId]);

    // Delete all league invites
    await client.query('DELETE FROM league_invites WHERE league_id = $1', [leagueId]);

    // Delete all league members
    await client.query('DELETE FROM league_members WHERE league_id = $1', [leagueId]);

    // Delete the league itself
    await client.query('DELETE FROM leagues WHERE id = $1', [leagueId]);

    await client.query('COMMIT');
    res.json({ message: 'League deleted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ── PATCH /api/leagues/:leagueId/members/:userId/role ────────────────────────
// Promote/demote a member (commissioner only)
router.patch('/:leagueId/members/:userId/role', requireAuth, requireCommissioner, async (req, res, next) => {
  try {
    const { leagueId, userId } = req.params;
    const { role } = req.body;

    const validRoles = ['member', 'co_commissioner'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
    }

    await db.query(
      'UPDATE league_members SET role = $1 WHERE league_id = $2 AND user_id = $3',
      [role, leagueId, userId]
    );

    res.json({ message: 'Role updated' });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/leagues/:leagueId/members/:userId/picks ─────────────────────────
// Get a specific member's picks in a league (any member can view)
router.get('/:leagueId/members/:userId/picks', requireAuth, async (req, res, next) => {
  try {
    const { leagueId, userId } = req.params;

    // Verify requesting user is a member of the league
    const { rows: membership } = await db.query(
      'SELECT id FROM league_members WHERE league_id = $1 AND user_id = $2',
      [leagueId, req.user.id]
    );
    if (!membership[0]) return res.status(403).json({ error: 'Not a member of this league' });

    // Verify target user is also a member
    const { rows: targetMembership } = await db.query(
      'SELECT id FROM league_members WHERE league_id = $1 AND user_id = $2',
      [leagueId, userId]
    );
    if (!targetMembership[0]) return res.status(404).json({ error: 'Member not found in this league' });

    const { rows: picks } = await db.query(`
      SELECT p.*,
             e.home_team, e.away_team, e.commence_time
      FROM picks p
      LEFT JOIN events e ON e.external_id = p.event_id
      WHERE p.user_id = $1 AND p.league_id = $2
      ORDER BY p.week DESC, COALESCE(e.commence_time, p.created_at) DESC
    `, [userId, leagueId]);

    res.json({ picks });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/stats/dashboard ─────────────────────────────────────────────────
// Get current user's this-week and all-time stats broken down by bet type
router.get('/stats/dashboard', requireAuth, async (req, res, next) => {
  try {
    const week = req.query.week ? parseInt(req.query.week) : null;

    // All-time stats by bet type
    const { rows: allTime } = await db.query(`
      SELECT
        CASE
          WHEN bet_type LIKE 'props%' THEN 'props'
          ELSE bet_type
        END AS type,
        SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN result = 'push' THEN 1 ELSE 0 END) AS pushes
      FROM picks
      WHERE user_id = $1 AND result IN ('win','loss','push')
      GROUP BY type
    `, [req.user.id]);

    // This week stats by bet type
    const { rows: thisWeek } = await db.query(`
      SELECT
        CASE
          WHEN bet_type LIKE 'props%' THEN 'props'
          ELSE bet_type
        END AS type,
        SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN result = 'push' THEN 1 ELSE 0 END) AS pushes
      FROM picks
      WHERE user_id = $1 AND week = $2 AND result IN ('win','loss','push')
      GROUP BY type
    `, [req.user.id, week]);

    res.json({ allTime, thisWeek });
  } catch (err) {
    next(err);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateInviteCode(leagueId) {
  const chars  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const prefix = leagueId.toString().slice(-3).toUpperCase().padStart(3, 'X');
  const suffix = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${prefix}-${suffix}`;
}

module.exports = router;

// src/picks.js
const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const oddsService     = require('../services/oddsService');
const gradingService  = require('../services/gradingService');

const router = express.Router();

// ── POST /api/picks/grade ─────────────────────────────────────────────────────
router.post('/grade', requireAuth, async (req, res, next) => {
  try {
    const count = await gradingService.gradeAllPendingPicks();
    res.json({ graded: count, message: `Graded ${count} picks` });
  } catch (err) { next(err); }
});

// ── GET /api/picks/grade-debug ────────────────────────────────────────────────
router.get('/grade-debug', requireAuth, async (req, res, next) => {
  try {
    const { rows: pendingPicks } = await db.query(
      `SELECT id, event_id, sport, bet_type, selection, line_data, result
       FROM picks WHERE user_id = $1 AND result = 'pending'`,
      [req.user.id]
    );
    const slugMap = {
      'basketball_nba':'nba','basketball_ncaab':'ncaamb','baseball_mlb':'mlb',
      'americanfootball_nfl':'nfl','americanfootball_ncaaf':'ncaafb',
    };
    const sports = [...new Set(pendingPicks.map(p => p.sport).filter(Boolean))];
    const scoresBySport = {};
    for (const sport of sports) {
      const slug = slugMap[sport] || sport;
      const scores = await gradingService.fetchScores(slug);
      scoresBySport[sport] = scores.map(s => ({
        id: s.id, home: s.home_team, away: s.away_team, completed: s.completed, scores: s.scores
      }));
    }
    const analysis = pendingPicks.map(p => {
      const scores = scoresBySport[p.sport] || [];
      const match = scores.find(s => s.id === p.event_id);
      return {
        pick_id: p.id, event_id: p.event_id, sport: p.sport,
        bet_type: p.bet_type, selection: p.selection,
        has_line_data: !!p.line_data,
        scores_fetched: scores.length,
        event_found: !!match,
        score_data: match || null,
      };
    });
    res.json({ pending_count: pendingPicks.length, sports, analysis });
  } catch (err) { next(err); }
});

// ── POST /api/picks ───────────────────────────────────────────────────────────
// Submit picks for a league/week.
// Body: { league_id, week, picks: [{ event_id, bet_type, selection, sport }] }
router.post('/', requireAuth, async (req, res, next) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { league_id, week, picks } = req.body;
    if (!league_id || !picks?.length) {
      return res.status(400).json({ error: 'league_id and picks[] are required' });
    }

    // Verify membership
    const { rows: membership } = await client.query(
      'SELECT id FROM league_members WHERE league_id = $1 AND user_id = $2',
      [league_id, req.user.id]
    );
    if (!membership[0]) return res.status(403).json({ error: 'Not a member of this league' });

    // Fetch league settings to validate bet types + picks limit
    const { rows: leagueRows } = await client.query(
      'SELECT * FROM leagues WHERE id = $1',
      [league_id]
    );
    const league = leagueRows[0];
    if (!league) return res.status(404).json({ error: 'League not found' });

    // Count how many picks this user already has this week in this league
    // ISO week number (Monday-based) — must match frontend calculation
    const weekVal = week || (() => {
      const d = new Date();
      const dayNum = d.getDay() || 7;
      d.setDate(d.getDate() + 4 - dayNum);
      const yearStart = new Date(d.getFullYear(), 0, 1);
      return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    })();
    console.log('[DEBUG picks-limit] week from request:', week, '| weekVal:', weekVal, '| league_id:', league_id, '| user_id:', req.user.id);
    console.log('[DEBUG picks-limit] week from request:', week, '| weekVal:', weekVal, '| league_id:', league_id, '| user_id:', req.user.id);
    const { rows: existingPicks } = await client.query(
      `SELECT COUNT(*) FROM picks
        WHERE user_id = $1 AND league_id = $2 AND week = $3`,
      [req.user.id, league_id, weekVal]
    );
    const existingCount = parseInt(existingPicks[0].count);

    // New picks that aren't replacements (upserts won't increase count)
    // We check: existing + net-new > limit
    // To find net-new: picks that don't already exist for same event+bet_type
    const { rows: alreadyPicked } = await client.query(
      `SELECT event_id, bet_type FROM picks
        WHERE user_id = $1 AND league_id = $2 AND week = $3`,
      [req.user.id, league_id, weekVal]
    );
    const alreadyPickedSet = new Set(alreadyPicked.map(p => `${p.event_id}|${p.bet_type}`));
    const netNewCount = picks.filter(p => {
      const bt = (p.bet_type || '').toLowerCase().replace('totals','ou').replace('over_under','ou').replace('moneyline','ml');
      return !alreadyPickedSet.has(`${p.event_id}|${bt}`);
    }).length;

    if (existingCount + netNewCount > league.picks_per_week) {
      return res.status(400).json({
        error: `League allows max ${league.picks_per_week} picks per week. You have ${existingCount} pick${existingCount !== 1 ? 's' : ''} this week.`,
      });
    }

    // Validate each pick's bet_type is allowed in this league
    // Normalize bet_type to canonical form first
    for (const pick of picks) {
      pick.bet_type = (pick.bet_type || '')
        .toLowerCase()
        .replace('totals', 'ou')
        .replace('over_under', 'ou')
        .replace('moneyline', 'ml');
      if (!league.bet_types.includes(pick.bet_type)) {
        return res.status(400).json({
          error: `Bet type '${pick.bet_type}' not allowed in this league. Allowed: ${league.bet_types.join(', ')}`,
        });
      }
    }

    // Lock in the current odds line for each pick (important for grading later)
    // Sport slug normalization — always store full API key
    const sportSlugToKey = {
      'nba':'basketball_nba', 'mlb':'baseball_mlb',
      'nfl':'americanfootball_nfl', 'ncaafb':'americanfootball_ncaaf',
      'ncaamb':'basketball_ncaab', 'ncaab':'basketball_ncaab',
      'soccer_epl':'soccer_epl', 'soccer_mls':'soccer_usa_mls',
      'soccer_uefa_champs':'soccer_uefa_champs_league',
      'soccer_copa_america':'soccer_conmebol_copa_america',
    };
    const savedPicks = [];
    for (const pick of picks) {
      const events = await oddsService.getOdds(pick.sport);
      const event  = events.find(e => e.id === pick.event_id);
      const lineData = pick.line_data || event?.lines || null;
      const sport = sportSlugToKey[pick.sport] || pick.sport;

      // Check deadline hasn't passed
      if (event && new Date(event.commence_time) <= new Date()) {
        return res.status(400).json({
          error: `Game has already started: ${event.home_team} vs ${event.away_team}`,
        });
      }

      // Upsert: replace any existing pick for same (user, league, week, event, bet_type)
      const { rows } = await client.query(`
        INSERT INTO picks (
          user_id, league_id, week, event_id,
          sport, bet_type, selection, line_data, result
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
        ON CONFLICT (user_id, league_id, week, event_id, bet_type)
        DO UPDATE SET
          selection  = EXCLUDED.selection,
          line_data  = EXCLUDED.line_data,
          result     = 'pending',
          updated_at = NOW()
        RETURNING *
      `, [
        req.user.id, league_id, week, pick.event_id,
        sport, pick.bet_type, pick.selection,
        JSON.stringify(lineData),
      ]);

      savedPicks.push(rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({ picks: savedPicks, count: savedPicks.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ── GET /api/picks/my ────────────────────────────────────────────────────────
// Get the current user's picks (optionally filtered by league/week)
router.get('/my', requireAuth, async (req, res, next) => {
  try {
    const { league_id, week, sport } = req.query;
    let sql = `
      SELECT p.*,
             e.home_team, e.away_team, e.commence_time
      FROM picks p
      LEFT JOIN events e ON e.external_id = p.event_id
      WHERE p.user_id = $1
    `;
    const params = [req.user.id];

    if (league_id) { params.push(league_id); sql += ` AND p.league_id = $${params.length}`; }
    if (week)       { params.push(week);       sql += ` AND p.week = $${params.length}`; }
    if (sport)      { params.push(sport);      sql += ` AND p.sport = $${params.length}`; }

    sql += ` ORDER BY p.created_at DESC LIMIT 100`;

    const { rows } = await db.query(sql, params);
    res.json({ picks: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/picks/league/:leagueId ──────────────────────────────────────────
// Get all picks for a league (any member can view all others' picks)
router.get('/league/:leagueId', requireAuth, async (req, res, next) => {
  try {
    const { leagueId } = req.params;
    const { week }     = req.query;

    // Must be a member to view
    const { rows: membership } = await db.query(
      'SELECT id FROM league_members WHERE league_id = $1 AND user_id = $2',
      [leagueId, req.user.id]
    );
    if (!membership[0]) return res.status(403).json({ error: 'Not a member of this league' });

    let sql = `
      SELECT p.*,
             u.username, u.first_name, u.last_name,
             e.home_team, e.away_team, e.commence_time
      FROM picks p
      JOIN users u  ON u.id = p.user_id
      LEFT JOIN events e ON e.external_id = p.event_id
      WHERE p.league_id = $1
    `;
    const params = [leagueId];

    if (week) { params.push(week); sql += ` AND p.week = $${params.length}`; }
    sql += ` ORDER BY p.user_id, p.created_at DESC`;

    const { rows } = await db.query(sql, params);

    // Group by user for easier frontend rendering
    const byUser = rows.reduce((acc, pick) => {
      const key = pick.user_id;
      if (!acc[key]) {
        acc[key] = {
          user_id:    pick.user_id,
          username:   pick.username,
          first_name: pick.first_name,
          last_name:  pick.last_name,
          picks: [],
          wins: 0, losses: 0, pushes: 0, pending: 0,
        };
      }
      acc[key].picks.push(pick);
      acc[key][pick.result] = (acc[key][pick.result] || 0) + 1;
      return acc;
    }, {});

    res.json({ leagueId, week: week || 'all', members: Object.values(byUser) });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/picks/member/:userId/league/:leagueId ───────────────────────────
// View a specific member's pick history — the "member page"
router.get('/member/:userId/league/:leagueId', requireAuth, async (req, res, next) => {
  try {
    const { userId, leagueId } = req.params;

    // Must be a league member to view peers
    const { rows: myMembership } = await db.query(
      'SELECT id FROM league_members WHERE league_id = $1 AND user_id = $2',
      [leagueId, req.user.id]
    );
    if (!myMembership[0]) return res.status(403).json({ error: 'Not a member of this league' });

    const { rows: picks } = await db.query(`
      SELECT p.*,
             e.home_team, e.away_team, e.commence_time
      FROM picks p
      LEFT JOIN events e ON e.external_id = p.event_id
      WHERE p.user_id = $1 AND p.league_id = $2
      ORDER BY p.created_at DESC
      LIMIT 200
    `, [userId, leagueId]);

    const { rows: user } = await db.query(
      'SELECT id, username, first_name, last_name FROM users WHERE id = $1',
      [userId]
    );

    // Aggregate stats
    const stats = picks.reduce((acc, p) => {
      acc[p.result] = (acc[p.result] || 0) + 1;
      return acc;
    }, { win: 0, loss: 0, push: 0, pending: 0 });

    stats.win_pct = stats.win + stats.loss > 0
      ? Math.round((stats.win / (stats.win + stats.loss)) * 1000) / 10
      : 0;

    res.json({ user: user[0], stats, picks });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/picks/manual-grade ─────────────────────────────────────────────
// Commissioner manually grades a prop pick (win/loss/push)
router.post('/manual-grade', requireAuth, async (req, res, next) => {
  try {
    const { pick_id, result } = req.body;
    if (!pick_id || !['win','loss','push','pending'].includes(result)) {
      return res.status(400).json({ error: 'pick_id and result (win/loss/push/pending) required' });
    }

    // Verify the requester is commissioner or co-commissioner of the pick's league
    const { rows: pickRows } = await db.query(
      `SELECT p.*, lm.role AS member_role
       FROM picks p
       JOIN league_members lm ON lm.league_id = p.league_id AND lm.user_id = $2
       WHERE p.id = $1`,
      [pick_id, req.user.id]
    );
    if (!pickRows[0]) return res.status(404).json({ error: 'Pick not found' });
    if (!['commissioner','co_commissioner'].includes(pickRows[0].member_role)) {
      return res.status(403).json({ error: 'Only the league commissioner can manually grade picks' });
    }

    await db.query(
      'UPDATE picks SET result = $1, graded_at = NOW() WHERE id = $2',
      [result, pick_id]
    );

    res.json({ ok: true, pick_id, result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// src/services/gradingService.js
// Fetches game scores from The Odds API and grades all pending picks.

const axios  = require('axios');
const db     = require('../db');
const logger = require('../utils/logger');
const propsGrading = require('./propsGradingService');

const BASE_URL = 'https://api.the-odds-api.com/v4';
const API_KEY  = process.env.ODDS_API_KEY;

const SPORT_KEYS = require('./oddsService').SPORT_KEYS;

// Sports where a draw (tie) is a distinct THIRD outcome (3-way moneyline).
// If you bet home or away ML on these sports and the game draws → LOSS (not a push).
// If you explicitly bet 'draw' (ml-draw) → WIN.
const THREE_WAY_ML_SPORTS = new Set([
  'soccer_epl', 'soccer_usa_mls', 'soccer_mls',
  'soccer_uefa_champs_league', 'soccer_conmebol_copa_america',
]);

/**
 * Fetch completed game scores from The Odds API scores endpoint.
 */
async function fetchScores(sportKey) {
  const SLUG_TO_KEY = {
    nba:'basketball_nba', mlb:'baseball_mlb', nfl:'americanfootball_nfl',
    ncaafb:'americanfootball_ncaaf', ncaamb:'basketball_ncaab',
    soccer_epl:'soccer_epl', soccer_mls:'soccer_usa_mls',
    soccer_uefa_champs:'soccer_uefa_champs_league',
    soccer_copa_america:'soccer_conmebol_copa_america',
  };
  const key = SLUG_TO_KEY[sportKey] || sportKey;

  if (!API_KEY || API_KEY === 'your_odds_api_key_here') {
    logger.warn('[GradingService] No API key — skipping live score fetch');
    return [];
  }

  logger.info(`[GradingService] Fetching scores for ${key}`);
  try {
    const response = await axios.get(`${BASE_URL}/sports/${key}/scores`, {
      params: { apiKey: API_KEY, daysFrom: 3 },
      timeout: 10_000,
    });
    const completed = response.data.filter(g => g.completed);
    logger.info(`[GradingService] ${key}: ${completed.length} completed of ${response.data.length} total`);
    return completed;
  } catch (err) {
    logger.error(`[GradingService] Score fetch failed for ${key}: ${err.message}`);
    if (err.response) logger.error(`[GradingService] API error body: ${JSON.stringify(err.response.data)}`);
    return [];
  }
}

/**
 * Grade a single pick given a completed game result.
 *
 * Real-world betting rules:
 *
 * SPREAD (includes MLB run line ±1.5 and NHL puck line ±1.5):
 *   - Favorite (negative spread) must win by MORE than the spread to cover.
 *     E.g. -3.5: must win by 4+ points.
 *   - Underdog (positive spread) covers if they win OR lose by less than the spread.
 *     E.g. +3.5: covers if they win, tie, or lose by 1-3 points.
 *   - PUSH: margin of victory equals the spread exactly (whole numbers only, e.g. -3).
 *     Half-point spreads (.5) can NEVER push.
 *
 * MONEYLINE:
 *   - Simply pick the winner. Negative odds = favorite, positive odds = underdog.
 *   - Non-soccer: if game ends in a tie → PUSH (stake returned). Rare in most US sports.
 *   - Soccer 3-way: draw is a THIRD betting option. Betting home/away on a drawn game = LOSS.
 *     Explicitly betting 'draw' on a drawn game = WIN.
 *
 * OVER/UNDER (TOTALS):
 *   - Bet on whether combined score is above or below the line.
 *   - PUSH: combined score equals the line exactly (whole numbers only).
 *   - Half-point totals can NEVER push.
 *
 * Returns: 'win' | 'loss' | 'push' | 'pending'
 */
function gradePick(pick, score) {
  const homeScore = score.scores?.find(s => s.name === score.home_team)?.score;
  const awayScore = score.scores?.find(s => s.name === score.away_team)?.score;

  if (homeScore === undefined || awayScore === undefined) return 'pending';

  const homePoints = parseFloat(homeScore);
  const awayPoints = parseFloat(awayScore);
  const diff       = homePoints - awayPoints; // positive = home won, 0 = draw

  const { selection, line_data } = pick;
  const sel = (selection || '').toLowerCase();

  const bet_type = (pick.bet_type || '').toLowerCase()
    .replace('moneyline', 'ml')
    .replace('totals', 'ou')
    .replace('over_under', 'ou');

  // ── MONEYLINE ────────────────────────────────────────────────────────────────
  if (bet_type === 'ml') {
    const isSoccerSport = THREE_WAY_ML_SPORTS.has(pick.sport) || THREE_WAY_ML_SPORTS.has(score.sport_key);

    // Determine which side was picked (new picks have stored picked_side)
    const storedSide = line_data?.picked_side; // 'home', 'away', or 'draw'
    let pickedSide;

    if (storedSide) {
      pickedSide = storedSide;
    } else {
      // Fallback fuzzy matching for old picks without picked_side
      const homeName = score.home_team.toLowerCase();
      const awayName = score.away_team.toLowerCase();
      const homeWords = homeName.split(' ').filter(w => w.length > 3);
      const awayWords = awayName.split(' ').filter(w => w.length > 3);
      const matchesHome = homeWords.some(w => sel.includes(w));
      const matchesAway = awayWords.some(w => sel.includes(w));
      if (matchesHome && !matchesAway) pickedSide = 'home';
      else if (matchesAway && !matchesHome) pickedSide = 'away';
      else pickedSide = sel.includes(homeName.split(' ').pop()) ? 'home' : 'away';
    }

    if (diff === 0) {
      // Game ended in a draw/tie
      if (isSoccerSport) {
        // Soccer 3-way: draw is a distinct bet option.
        // Bet on home or away → LOSS. Bet on draw → WIN.
        return pickedSide === 'draw' ? 'win' : 'loss';
      } else {
        // Non-soccer: tie → PUSH (stake returned)
        return 'push';
      }
    }

    // Game had a clear winner
    if (pickedSide === 'draw') return 'loss'; // Bet draw but game had winner
    return ((pickedSide === 'home') === (diff > 0)) ? 'win' : 'loss';
  }

  // ── SPREAD ───────────────────────────────────────────────────────────────────
  if (bet_type === 'spread') {
    // Use stored picked_side if available, else fuzzy match
    const storedSide = line_data?.picked_side;
    let pickedHome;
    if (storedSide === 'home') pickedHome = true;
    else if (storedSide === 'away') pickedHome = false;
    else {
      const homeWords = score.home_team.toLowerCase().split(' ').filter(w => w.length > 3);
      const awayWords = score.away_team.toLowerCase().split(' ').filter(w => w.length > 3);
      const matchesHome = homeWords.some(w => sel.includes(w));
      const matchesAway = awayWords.some(w => sel.includes(w));
      pickedHome = matchesHome && !matchesAway ? true
        : !matchesHome && matchesAway ? false
        : sel.includes(score.home_team.toLowerCase().split(' ').pop());
    }

    // Get the spread point for the picked side
    // Spread point is from the perspective of that team:
    //   Favorite home team at -3.5: line.home.point = -3.5
    //   Underdog away team at +3.5: line.away.point = 3.5
    const line = line_data?.spread;
    let point;
    if (line) {
      point = pickedHome ? (line.home?.point ?? null) : (line.away?.point ?? null);
    }
    if (point === null || point === undefined) {
      // Parse from selection label as last resort (e.g. "Houston Rockets +5.5")
      const match = sel.match(/([+-]?\d+\.?\d*)\s*$/);
      if (match) point = parseFloat(match[1]);
      else return 'pending';
    }

    // margin = (picked team final score) - (opponent final score)
    // Add spread point: if (margin + point) > 0 → WIN, = 0 → PUSH, < 0 → LOSS
    // Example: Home team -3.5 wins 28-24 → diff=4, pickedHome=true, margin=4, point=-3.5
    //   margin + point = 4 + (-3.5) = 0.5 → WIN ✅
    // Example: Away team +5.5 loses 120-145 → diff=-25, pickedHome=false, margin=25, point=5.5
    //   margin = awayPoints - homePoints = -diff = 25... wait, away lost by 25
    //   margin = awayPoints - homePoints = 120 - 145 = -25, point = 5.5
    //   margin + point = -25 + 5.5 = -19.5 → LOSS ✅
    const margin = pickedHome ? diff : -diff;
    const result = margin + point;

    if (result === 0) return 'push'; // Whole-number spread, exact margin match
    return result > 0 ? 'win' : 'loss';
  }

  // ── OVER/UNDER (TOTALS) ──────────────────────────────────────────────────────
  if (bet_type === 'ou') {
    // Get total line
    const line = line_data?.totals;
    let totalPoint;
    if (line?.point !== undefined && line.point !== null) {
      totalPoint = line.point;
    } else {
      // Parse from selection label e.g. "Over 221.5" or "Under 48"
      const match = sel.match(/([\d.]+)/);
      if (match) totalPoint = parseFloat(match[1]);
      else return 'pending';
    }

    const combinedScore = homePoints + awayPoints;

    // PUSH: combined score lands exactly on the line (whole numbers only)
    if (combinedScore === totalPoint) return 'push';

    // Determine over/under from stored side or label
    const storedSide = line_data?.picked_side;
    let pickedOver;
    if (storedSide === 'over') pickedOver = true;
    else if (storedSide === 'under') pickedOver = false;
    else pickedOver = sel.startsWith('over'); // fallback for old picks

    return (pickedOver ? combinedScore > totalPoint : combinedScore < totalPoint) ? 'win' : 'loss';
  }

  // ── PROPS ─────────────────────────────────────────────────────────────────────
  if (bet_type.startsWith('props')) {
    // Graded by propsGradingService via Ball Don't Lie API.
    // Push rule: stat lands exactly on a whole-number line → push.
    return 'pending';
  }

  return 'pending';
}

/**
 * Main grading run: fetch scores for all active sports, find picks
 * that reference completed games, grade them, and update the DB.
 */
async function gradeAllPendingPicks() {
  logger.info('[GradingService] Starting pick grading run...');

  let sports;
  try {
    const res = await db.query(`
      SELECT DISTINCT sport FROM picks WHERE result = 'pending' AND sport IS NOT NULL
    `);
    sports = res.rows.map(r => r.sport);
  } catch (err) {
    logger.warn('[GradingService] DB unavailable — skipping grading');
    return;
  }

  if (!sports.length) {
    logger.info('[GradingService] No pending picks to grade');
    return 0;
  }

  logger.info(`[GradingService] Grading sports: ${sports.join(', ')}`);
  let totalGraded = 0;

  for (const sport of sports) {
    const scores = await fetchScores(sport);
    if (!scores.length) continue;

    const completedIds = new Set(scores.map(s => s.id));

    const { rows: picks } = await db.query(`
      SELECT p.id, p.bet_type, p.selection, p.line_data, p.event_id, p.sport
      FROM picks p
      WHERE p.result = 'pending'
        AND p.sport = $1
        AND p.event_id = ANY($2)
    `, [sport, [...completedIds]]);

    for (const pick of picks) {
      const score = scores.find(s => s.id === pick.event_id);
      if (!score) continue;

      logger.info(`[Grade] Pick ${pick.id}: type=${pick.bet_type} sel="${pick.selection}" side=${pick.line_data?.picked_side || '(fuzzy)'} home=${score.home_team} away=${score.away_team} scores=${JSON.stringify(score.scores)}`);

      const result = gradePick(pick, score);
      logger.info(`[Grade] Pick ${pick.id} → ${result}`);
      if (result === 'pending') continue;

      await db.query(`
        UPDATE picks SET result = $1, graded_at = NOW() WHERE id = $2
      `, [result, pick.id]);

      totalGraded++;
    }
  }

  logger.info(`[GradingService] Graded ${totalGraded} picks across ${sports.length} sports`);

  // Grade player props via Ball Don't Lie API
  try {
    const propsGraded = await propsGrading.gradeNBAPropPicks();
    totalGraded += propsGraded;
  } catch (err) {
    logger.error('[GradingService] NBA props grading failed:', err.message);
  }

  try {
    const mlbPropsGraded = await propsGrading.gradeMLBPropPicks();
    totalGraded += mlbPropsGraded;
  } catch (err) {
    logger.error('[GradingService] MLB props grading failed:', err.message);
  }

  return totalGraded;
}

module.exports = { gradeAllPendingPicks, gradePick, fetchScores };

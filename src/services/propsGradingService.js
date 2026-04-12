// src/services/propsGradingService.js
// Grades player prop picks using the Ball Don't Lie API (NBA only for now).
// ALL-STAR tier required: $9.99/mo at app.balldontlie.io
//
// Prop pick structure:
//   selection: "Myles Turner Under 4.5 Assists"  (player + dir + line + stat type)
//   line_data: { market: "player_assists", direction: "under", point: 4.5 }
//   sport: "basketball_nba"  (always full API key format)
//   bet_type: "props"

const axios  = require('axios');
const db     = require('../db');
const logger = require('../utils/logger');

const BDL_BASE  = 'https://api.balldontlie.io/nba/v1';
const BDL_KEY   = process.env.BALLDONTLIE_API_KEY;

// Map Odds API market keys → Ball Don't Lie stat fields
const MARKET_TO_STAT = {
  player_points:       'pts',
  player_rebounds:     'reb',
  player_assists:      'ast',
  player_threes:       'fg3m',
  player_steals:       'stl',
  player_blocks:       'blk',
  player_turnovers:    'turnover',
  player_points_rebounds_assists: null, // combo — handled separately
  player_points_rebounds:         null,
  player_points_assists:          null,
  player_rebounds_assists:        null,
};

// Rate limit: ALL-STAR tier = 60 req/min → 250ms delay is conservative but safe
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Search Ball Don't Lie for a game by date and team names.
 * Returns the BDL game object or null.
 */
async function findBDLGame(gameDate, homeTeam, awayTeam) {
  // Try given date and day before (timezone shifts can cause off-by-one)
  const prev = new Date(gameDate + 'T12:00:00Z');
  prev.setDate(prev.getDate() - 1);
  const dates = [gameDate, prev.toISOString().split('T')[0]];

  for (const date of dates) {
    await delay(250);
    try {
      const res = await axios.get(`${BDL_BASE}/games`, {
        headers: { Authorization: BDL_KEY },
        params: { 'dates[]': date, per_page: 100 },
        timeout: 10_000,
      });
      const games = res.data.data || [];
      logger.info(`[PropsGrading] BDL returned ${games.length} games for ${date}: ` + games.map(g => g.home_team.full_name + ' vs ' + g.visitor_team.full_name).join(', '));
      const match = games.find(g => {
        const home = g.home_team.full_name.toLowerCase();
        const away = g.visitor_team.full_name.toLowerCase();
        const homeWords = homeTeam.toLowerCase().split(' ').filter(w => w.length > 3);
        const awayWords = awayTeam.toLowerCase().split(' ').filter(w => w.length > 3);
        return homeWords.some(w => home.includes(w)) && awayWords.some(w => away.includes(w));
      });
      if (match) return match;
    } catch (err) {
      logger.error('[PropsGrading] findBDLGame failed:', err.message);
    }
  }
  return null;
}

/**
 * Fetch player stats for a BDL game.
 * Returns array of { player_name, pts, reb, ast, stl, blk, fg3m, ... }
 */
async function fetchGameStats(bdlGameId) {
  await delay(250);
  try {
    const res = await axios.get(`${BDL_BASE}/stats`, {
      headers: { Authorization: BDL_KEY },
      params: {
        'game_ids[]': bdlGameId,
        per_page: 100,
      },
      timeout: 10_000,
    });

    return (res.data.data || []).map(s => ({
      player_name: `${s.player.first_name} ${s.player.last_name}`.toLowerCase(),
      pts:      s.pts      || 0,
      reb:      s.reb      || 0,
      ast:      s.ast      || 0,
      stl:      s.stl      || 0,
      blk:      s.blk      || 0,
      fg3m:     s.fg3m     || 0,
      turnover: s.turnover || 0,
      min:      s.min      || '0',
    }));
  } catch (err) {
    logger.error('[PropsGrading] fetchGameStats failed:', err.message);
    return [];
  }
}

/**
 * Extract player name from a prop selection string.
 * "Myles Turner Over 4.5" → "myles turner"
 * "Ayo Dosunmu Under 2.5" → "ayo dosunmu"
 */
function parsePlayerName(selection) {
  // Selection format: "Kon Knueppel Over 3.5 3-Pointers"
  // Strip everything from "Over"/"Under" onwards (case-insensitive)
  const match = selection.match(/^(.+?)\s+(?:over|under)\s+[\d.]/i);
  if (match) return match[1].trim().toLowerCase();

  // Fallback: strip trailing numbers and stat words
  return selection
    .replace(/\s+(over|under).*$/i, '')
    .trim()
    .toLowerCase();
}

function gradePropPick(pick, playerStats) {
  const lineData = typeof pick.line_data === 'string' ? JSON.parse(pick.line_data) : (pick.line_data || {});
  const market   = lineData.market;
  const point    = parseFloat(lineData.point);
  const dir      = (lineData.direction || '').toLowerCase();

  logger.info(`[PropsGrading] gradePropPick: selection="${pick.selection}" market="${market}" point=${point} dir="${dir}" line_data=${JSON.stringify(lineData)}`);

  // Resolve effective values with multiple fallback strategies
  let effectivePoint = point;
  let effectiveDir   = lineData.picked_side || dir; // prefer explicit picked_side

  if (isNaN(effectivePoint) || !effectiveDir) {
    const sel = (pick.selection || '').toLowerCase();

    // Direction fallback: check picked_side, then line_data.direction, then parse selection
    if (!effectiveDir) {
      effectiveDir = sel.includes('over') ? 'over' : sel.includes('under') ? 'under' : null;
    }

    // Point fallback: parse from selection string e.g. "Player Name Over 10.5 Points"
    if (isNaN(effectivePoint)) {
      // Match decimal number that comes after 'over' or 'under' in the selection
      const m = sel.match(/(?:over|under)\s+([\d.]+)/);
      if (m) {
        effectivePoint = parseFloat(m[1]);
      } else {
        // Last resort: first number in string
        const m2 = sel.match(/([\d.]+)/);
        effectivePoint = m2 ? parseFloat(m2[1]) : NaN;
      }
    }

    logger.warn(`[PropsGrading] Resolved via fallback: dir=${effectiveDir} point=${effectivePoint}`);
    if (!effectiveDir || isNaN(effectivePoint)) return 'pending';
  }

  const statField = MARKET_TO_STAT[market];
  if (!statField) {
    logger.warn(`[PropsGrading] No stat mapping for market: ${market}`);
    return 'pending';
  }

  const normalizeStr = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\./g, '').toLowerCase();
  const playerName = normalizeStr(parsePlayerName(pick.selection));
  const stats = playerStats.find(s => {
    const bdlName = normalizeStr(s.player_name);
    const pickWords = playerName.split(' ').filter(w => w.length > 2);
    return pickWords.every(w => bdlName.includes(w));
  });

  if (!stats) {
    const allNames = playerStats.map(s => s.player_name).join(', ');
    logger.warn(`[PropsGrading] No stats found for player: "${playerName}" — available: ${allNames}`);
    return 'pending';
  }

  const minPlayed = parseInt(stats.min) || 0;
  if (minPlayed === 0) {
    logger.info(`[PropsGrading] Player DNP: "${playerName}" — marking pending`);
    return 'pending';
  }

  const actualStat = stats[statField];
  const pickedOver = effectiveDir === 'over';

  logger.info(`[PropsGrading] ${playerName} ${market}: actual=${actualStat}, line=${effectivePoint}, dir=${effectiveDir}`);

  if (actualStat === effectivePoint) return 'push';
  return (pickedOver ? actualStat > effectivePoint : actualStat < effectivePoint) ? 'win' : 'loss';
}

/**
 * Main entry: grade all pending NBA prop picks.
 * Called from gradingService after team picks are graded.
 */
async function gradeNBAPropPicks() {
  if (!BDL_KEY) {
    logger.warn('[PropsGrading] No BALLDONTLIE_API_KEY — skipping props grading');
    return 0;
  }

  // Get pending prop picks for NBA
  const { rows: picks } = await db.query(`
    SELECT p.id, p.selection, p.bet_type, p.line_data, p.event_id, p.sport,
           e.commence_time, e.home_team, e.away_team
    FROM picks p
    LEFT JOIN events e ON e.external_id = p.event_id
    WHERE p.result = 'pending'
      AND p.bet_type LIKE 'props%'
      AND p.sport IN ('basketball_nba', 'nba')
  `);

  if (!picks.length) {
    logger.info('[PropsGrading] No pending NBA prop picks');
    return 0;
  }

  logger.info(`[PropsGrading] Grading ${picks.length} pending NBA prop picks`);

  // Group picks by event_id so we only fetch each game's stats once
  const byEvent = {};
  for (const pick of picks) {
    if (!byEvent[pick.event_id]) byEvent[pick.event_id] = { picks: [], pick };
    byEvent[pick.event_id].picks.push(pick);
  }

  let totalGraded = 0;

  for (const [eventId, { picks: eventPicks, pick: samplePick }] of Object.entries(byEvent)) {
    // Need game date and teams — try events table first, fall back to parsing event_id
    let gameDate, homeTeam, awayTeam;

    if (samplePick.commence_time) {
      gameDate  = new Date(samplePick.commence_time).toISOString().split('T')[0];
      homeTeam  = samplePick.home_team;
      awayTeam  = samplePick.away_team;
    } else {
      // Fall back to odds cache
      try {
        const oddsService = require('./oddsService');
        const cached = oddsService.getCachedEvents ? oddsService.getCachedEvents('nba') : null;
        const game = cached && cached.find(g => g.id === eventId);
        if (game) {
          gameDate = new Date(game.commence_time).toISOString().split('T')[0];
          homeTeam = game.home_team;
          awayTeam = game.away_team;
        }
      } catch(e) { /* ignore */ }
    }

    if (!gameDate || !homeTeam || !awayTeam) {
      logger.warn(`[PropsGrading] No event data for event_id ${eventId} — skipping`);
      continue;
    }

    logger.info(`[PropsGrading] Looking up BDL game: ${gameDate} ${awayTeam} @ ${homeTeam}`);

    const bdlGame = await findBDLGame(gameDate, homeTeam, awayTeam);
    if (!bdlGame) {
      logger.warn(`[PropsGrading] No BDL game found for ${gameDate} ${awayTeam} @ ${homeTeam}`);
      continue;
    }

    // Check game is complete
    const statusRaw = bdlGame.status || bdlGame.period_detail || '';
    const statusLower = statusRaw.toLowerCase();
    const isFinal = statusLower === 'final'
      || statusLower === 'post'
      || statusLower === 'complete'
      || statusLower === 'status_final'
      || (statusLower.includes('final') && !statusLower.includes('halftime'));
    logger.info(`[PropsGrading] Game status: "${statusRaw}" — isFinal: ${isFinal} — game id: ${bdlGame.id}`);
    if (!isFinal) {
      logger.info(`[PropsGrading] Game not final yet, skipping`);
      continue;
    }

    const playerStats = await fetchGameStats(bdlGame.id);
    logger.info(`[PropsGrading] Fetched ${playerStats.length} player stat rows for game ${bdlGame.id}`);
    if (!playerStats.length) {
      logger.warn(`[PropsGrading] No player stats for BDL game ${bdlGame.id} — checking raw API response`);
      // Try direct fetch to see raw response
      try {
        const testRes = await axios.get(`${BDL_BASE}/stats`, {
          headers: { Authorization: BDL_KEY },
          params: { 'game_ids[]': bdlGame.id, per_page: 10 },
          timeout: 10_000,
        });
        logger.info(`[PropsGrading] Raw stats response: ${JSON.stringify(testRes.data).substring(0, 500)}`);
      } catch(e) { logger.error(`[PropsGrading] Raw stats fetch error: ${e.message}`); }
      continue;
    }

    for (const pick of eventPicks) {
      const result = gradePropPick(pick, playerStats);
      logger.info(`[PropsGrading] Pick ${pick.id} "${pick.selection}": ${result}`);
      if (result === 'pending') continue;

      const lineData = typeof pick.line_data === 'string' ? JSON.parse(pick.line_data) : (pick.line_data || {});
      const statField = MARKET_TO_STAT[lineData.market];
      const playerName = parsePlayerName(pick.selection);
      const matchedStats = playerStats.find(s => {
        const normalizeStr = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\./g, '').toLowerCase();
        const bdlName = normalizeStr(s.player_name);
        const pickWords = normalizeStr(playerName).split(' ').filter(w => w.length > 2);
        return pickWords.every(w => bdlName.includes(w));
      });
      const actualStat = (matchedStats && statField) ? matchedStats[statField] : null;
      const updatedLineData = { ...lineData, graded_stat: actualStat };

      await db.query(
        `UPDATE picks SET result = $1, graded_at = NOW(), line_data = $3 WHERE id = $2`,
        [result, pick.id, JSON.stringify(updatedLineData)]
      );
      totalGraded++;
    }
  }

  logger.info(`[PropsGrading] Graded ${totalGraded} prop picks`);
  return totalGraded;
}

const MLB_BDL_BASE = 'https://api.balldontlie.io/mlb/v1';
const MLB_MARKET_TO_STAT = {
  batter_hits:          'hits',
  batter_home_runs:     'hr',
  batter_rbis:          'rbi',
  batter_walks:         'bb',
  batter_strikeouts:    'k',
  batter_total_bases:   'total_bases_calc',
  pitcher_strikeouts:   'p_k',
  pitcher_earned_runs:  'er',
  pitcher_outs:         'pitching_outs',
};

async function findMLBGame(gameDate, homeTeam, awayTeam) {
  const prev = new Date(gameDate + 'T12:00:00Z');
  prev.setDate(prev.getDate() - 1);
  const dates = [gameDate, prev.toISOString().split('T')[0]];

  for (const date of dates) {
    await delay(250);
    try {
      const res = await axios.get(`${MLB_BDL_BASE}/games`, {
        headers: { Authorization: BDL_KEY },
        params: { 'dates[]': date, per_page: 100 },
        timeout: 10_000,
      });
      const games = res.data.data || [];
      logger.info(`[MLBPropsGrading] BDL returned ${games.length} games for ${date}`);
      const match = games.find(g => {
        const home = (g.home_team?.display_name || g.home_team_name || '').toLowerCase();
        const away = (g.away_team?.display_name || g.away_team_name || '').toLowerCase();
        const homeWords = homeTeam.toLowerCase().split(' ').filter(w => w.length > 3);
        const awayWords = awayTeam.toLowerCase().split(' ').filter(w => w.length > 3);
        return homeWords.some(w => home.includes(w)) && awayWords.some(w => away.includes(w));
      });
      if (match) return match;
    } catch (err) {
      logger.error('[MLBPropsGrading] findMLBGame failed:', err.message);
    }
  }
  return null;
}

async function fetchMLBGameStats(bdlGameId) {
  await delay(250);
  try {
    const res = await axios.get(`${MLB_BDL_BASE}/stats`, {
      headers: { Authorization: BDL_KEY },
      params: { 'game_ids[]': bdlGameId, per_page: 100 },
      timeout: 10_000,
    });
    return (res.data.data || []).map(s => ({
      player_name: `${s.player.first_name} ${s.player.last_name}`.toLowerCase(),
      hits:    s.hits    || 0,
      hr:      s.hr      || 0,
      rbi:     s.rbi     || 0,
      bb:      s.bb      || 0,
      k:       s.k       || 0,
      p_k:     s.p_k     || 0,
      er:      s.er      || 0,
      ip:      s.ip      || null,
      at_bats: s.at_bats || 0,
      doubles: s.doubles || 0,
      triples: s.triples || 0,
      total_bases_calc: (s.hits || 0) + (s.doubles || 0) + (2 * (s.triples || 0)) + (3 * (s.hr || 0)),
      pitching_outs: s.ip ? Math.floor(s.ip) * 3 + Math.round((s.ip % 1) * 10) : 0,
    }));
  } catch (err) {
    logger.error('[MLBPropsGrading] fetchMLBGameStats failed:', err.message);
    return [];
  }
}

async function gradeMLBPropPicks() {
  if (!BDL_KEY) {
    logger.warn('[MLBPropsGrading] No BALLDONTLIE_API_KEY — skipping MLB props grading');
    return 0;
  }

  const { rows: picks } = await db.query(`
    SELECT p.id, p.selection, p.bet_type, p.line_data, p.event_id, p.sport,
           e.commence_time, e.home_team, e.away_team
    FROM picks p
    LEFT JOIN events e ON e.external_id = p.event_id
    WHERE p.result = 'pending'
      AND p.bet_type LIKE 'props%'
      AND p.sport IN ('baseball_mlb', 'mlb')
  `);

  if (!picks.length) {
    logger.info('[MLBPropsGrading] No pending MLB prop picks');
    return 0;
  }

  logger.info(`[MLBPropsGrading] Grading ${picks.length} pending MLB prop picks`);

  const byEvent = {};
  for (const pick of picks) {
    if (!byEvent[pick.event_id]) byEvent[pick.event_id] = { picks: [], pick };
    byEvent[pick.event_id].picks.push(pick);
  }

  let totalGraded = 0;

  for (const [eventId, { picks: eventPicks, pick: samplePick }] of Object.entries(byEvent)) {
    let gameDate, homeTeam, awayTeam;

    if (samplePick.commence_time) {
      gameDate = new Date(samplePick.commence_time).toISOString().split('T')[0];
      homeTeam = samplePick.home_team;
      awayTeam = samplePick.away_team;
    }

    if (!gameDate || !homeTeam || !awayTeam) {
      logger.warn(`[MLBPropsGrading] No event data for event_id ${eventId} — skipping`);
      continue;
    }

    logger.info(`[MLBPropsGrading] Looking up BDL MLB game: ${gameDate} ${awayTeam} @ ${homeTeam}`);

    const bdlGame = await findMLBGame(gameDate, homeTeam, awayTeam);
    if (!bdlGame) {
      logger.warn(`[MLBPropsGrading] No BDL MLB game found for ${gameDate} ${awayTeam} @ ${homeTeam}`);
      continue;
    }

    const statusRaw = bdlGame.status || '';
    const statusLower = statusRaw.toLowerCase();
    const isFinal = statusLower === 'final'
      || statusLower === 'status_final'
      || (statusLower.includes('final') && !statusLower.includes('halftime'));
    logger.info(`[MLBPropsGrading] Game status: "${statusRaw}" — isFinal: ${isFinal}`);
    if (!isFinal) continue;

    const playerStats = await fetchMLBGameStats(bdlGame.id);
    logger.info(`[MLBPropsGrading] Fetched ${playerStats.length} player stat rows`);
    if (!playerStats.length) continue;

    // Log all player names for debugging
    logger.info(`[MLBPropsGrading] Players in game: ${playerStats.map(s => s.player_name).join(', ')}`);

    for (const pick of eventPicks) {
      const lineData = typeof pick.line_data === 'string' ? JSON.parse(pick.line_data) : (pick.line_data || {});
      const market = lineData.market;
      logger.info(`[MLBPropsGrading] Processing pick ${pick.id}: "${pick.selection}" market=${market}`);
      const point = parseFloat(lineData.point);
      const dir = (lineData.direction || lineData.picked_side || '').toLowerCase();

      if (!market || isNaN(point) || !dir) {
        logger.warn(`[MLBPropsGrading] Pick ${pick.id} missing line_data fields — skipping`);
        continue;
      }

      const statField = MLB_MARKET_TO_STAT[market];
      if (!statField) {
        logger.warn(`[MLBPropsGrading] No MLB stat mapping for market: ${market}`);
        continue;
      }

      const normalizeStr = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\./g, '').toLowerCase();
      const playerName = normalizeStr(parsePlayerName(pick.selection));
      const stats = playerStats.find(s => {
        const bdlName = normalizeStr(s.player_name);
        const pickWords = playerName.split(' ').filter(w => w.length > 2);
        return pickWords.every(w => bdlName.includes(w));
      });

      if (!stats) {
        logger.warn(`[MLBPropsGrading] No MLB stats for player: "${playerName}" — available: ${playerStats.map(s => s.player_name).slice(0,10).join(', ')}`);
        continue;
      }

      const isPitcherStat = ['p_k', 'er', 'pitching_outs'].includes(statField);
      const didPlay = isPitcherStat
        ? (stats.pitching_outs > 0 || stats.p_k > 0 || stats.er > 0 || (stats.ip !== null && parseFloat(stats.ip) > 0))
        : (stats.at_bats + stats.bb) > 0;
      if (!didPlay) {
        logger.info(`[MLBPropsGrading] Player did not play: "${playerName}" — ip=${stats.ip} pitching_outs=${stats.pitching_outs} p_k=${stats.p_k} er=${stats.er} at_bats=${stats.at_bats} bb=${stats.bb}`);
        continue;
      }

      const actualStat = stats[statField];
      const pickedOver = dir === 'over';
      let result;
      if (actualStat === point) result = 'push';
      else result = (pickedOver ? actualStat > point : actualStat < point) ? 'win' : 'loss';

      logger.info(`[MLBPropsGrading] Pick ${pick.id} "${pick.selection}": actual=${actualStat} vs ${point} ${dir} → ${result}`);

      const existingLineData = typeof pick.line_data === 'string' ? JSON.parse(pick.line_data) : (pick.line_data || {});
      const updatedLineData = { ...existingLineData, graded_stat: actualStat };
      await db.query('UPDATE picks SET result = $1, graded_at = NOW(), line_data = $3 WHERE id = $2', [result, pick.id, JSON.stringify(updatedLineData)]);
      totalGraded++;
    }
  }

  logger.info(`[MLBPropsGrading] Graded ${totalGraded} MLB prop picks`);
  return totalGraded;
}

module.exports = { gradeNBAPropPicks, gradeMLBPropPicks, gradePropPick, parsePlayerName };

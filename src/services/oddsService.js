// src/services/oddsService.js
// Fetches live betting lines from The Odds API, normalises them,
// and maintains an in-memory cache so the DB / frontend aren't
// hammering the API on every request.

const axios  = require('axios');
const db     = require('../db');
const logger = require('../utils/logger');

const BASE_URL   = 'https://api.the-odds-api.com/v4';
const API_KEY    = process.env.ODDS_API_KEY;
const BOOKMAKERS = process.env.ODDS_BOOKMAKERS || 'draftkings,fanduel,betmgm';

// ── Sports we support and their The Odds API keys ────────────────────────────
const SPORT_KEYS = {
  nfl:                 'americanfootball_nfl',
  nba:                 'basketball_nba',
  mlb:                 'baseball_mlb',
  ncaafb:              'americanfootball_ncaaf',
  ncaamb:              'basketball_ncaab',
  soccer_epl:          'soccer_epl',
  soccer_mls:          'soccer_usa_mls',
  soccer_uefa_champs:  'soccer_uefa_champs_league',
  soccer_copa_america: 'soccer_conmebol_copa_america',
};

// ── In-memory cache ──────────────────────────────────────────────────────────
// Structure: { [sportKey]: { data: [...], fetchedAt: Date, remainingRequests: number } }
const cache = {};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert American odds (e.g. -110) to a label with sign.
 */
function formatAmericanOdds(price) {
  if (price === undefined || price === null) return null;
  return price > 0 ? `+${price}` : `${price}`;
}

/**
 * Find the best (most favourable) odds for a given outcome across all
 * bookmakers in the response. Returns the first bookmaker's line by default,
 * which is `draftkings` when ODDS_BOOKMAKERS starts with it.
 */
function pickBestOdds(outcomes, outcomeName) {
  const match = outcomes.find(o => o.name === outcomeName);
  return match ? match.price : null;
}

/**
 * Normalise a raw odds-api event into our internal shape.
 * Merges spread, moneyline (h2h), and totals into one object.
 */
function normaliseEvent(event, marketsMap) {
  const h2h    = marketsMap.h2h    || [];
  const spread = marketsMap.spreads || [];
  const totals = marketsMap.totals  || [];

  const homeML  = pickBestOdds(h2h,    event.home_team);
  const awayML  = pickBestOdds(h2h,    event.away_team);
  const homeSpread = spread.find(o => o.name === event.home_team);
  const awaySpread = spread.find(o => o.name === event.away_team);
  const overLine   = totals.find(o => o.name === 'Over');
  const underLine  = totals.find(o => o.name === 'Under');

  return {
    id:           event.id,
    sport_key:    event.sport_key,
    commence_time: event.commence_time,
    home_team:    event.home_team,
    away_team:    event.away_team,
    lines: {
      moneyline: homeML !== null ? {
        home: { odds: formatAmericanOdds(homeML),  price: homeML },
        away: { odds: formatAmericanOdds(awayML),  price: awayML },
      } : null,
      spread: homeSpread ? {
        home: {
          point: homeSpread.point,
          label: `${event.home_team} ${homeSpread.point > 0 ? '+' : ''}${homeSpread.point}`,
          odds:  formatAmericanOdds(homeSpread.price),
          price: homeSpread.price,
        },
        away: {
          point: awaySpread?.point,
          label: `${event.away_team} ${awaySpread?.point > 0 ? '+' : ''}${awaySpread?.point}`,
          odds:  formatAmericanOdds(awaySpread?.price),
          price: awaySpread?.price,
        },
      } : null,
      totals: overLine ? {
        point: overLine.point,
        over:  { label: `Over ${overLine.point}`,  odds: formatAmericanOdds(overLine.price),  price: overLine.price },
        under: { label: `Under ${underLine?.point}`, odds: formatAmericanOdds(underLine?.price), price: underLine?.price },
      } : null,
    },
  };
}

/**
 * Fetch odds for a single sport from the API.
 * Returns an array of normalised events.
 */
async function fetchSportOdds(sportSlug) {
  const sportApiKey = sportSlug in SPORT_KEYS ? SPORT_KEYS[sportSlug] : sportSlug;

  if (!API_KEY || API_KEY === 'your_odds_api_key_here') {
    logger.warn('[OddsService] No API key set — returning mock data');
    return getMockOdds(sportSlug);
  }

  try {
    const response = await axios.get(`${BASE_URL}/sports/${sportApiKey}/odds`, {
      params: {
        apiKey:     API_KEY,
        regions:    'us',
        markets:    'h2h,spreads,totals',
        oddsFormat: 'american',
        bookmakers: BOOKMAKERS,
      },
      timeout: 10_000,
    });

    // Log remaining credits from response headers
    const remaining = response.headers['x-requests-remaining'];
    const used      = response.headers['x-requests-used'];
    logger.info(`[OddsAPI] ${sportSlug}: ${response.data.length} events | credits used: ${used} | remaining: ${remaining}`);

    // Each event has a `bookmakers` array; we merge all markets from the
    // first bookmaker (usually draftkings) for consistency
    const events = response.data.map(event => {
      const bm = event.bookmakers?.[0];
      if (!bm) return null;

      const marketsMap = {};
      for (const market of bm.markets || []) {
        marketsMap[market.key] = market.outcomes;
      }

      return normaliseEvent(event, marketsMap);
    }).filter(Boolean);

    // Persist to DB (upsert so we keep history of line movements)
    await persistOddsToDb(events, sportSlug);

    // Update cache
    cache[sportSlug] = {
      data:              events,
      fetchedAt:         new Date(),
      remainingRequests: parseInt(remaining || '0'),
    };

    return events;
  } catch (err) {
    logger.error(`[OddsService] Failed to fetch ${sportSlug}:`, err.message);

    // Return stale cache if available
    if (cache[sportSlug]?.data) {
      logger.warn(`[OddsService] Returning stale cache for ${sportSlug}`);
      return cache[sportSlug].data;
    }

    return getMockOdds(sportSlug);
  }
}

/**
 * Upsert fetched odds into the `events` table so we have a full history
 * and can grade picks after game completion.
 */
async function persistOddsToDb(events, sportSlug) {
  for (const ev of events) {
    try {
      await db.query(`
        INSERT INTO events (
          external_id, sport_slug, commence_time,
          home_team, away_team, lines, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (external_id)
        DO UPDATE SET
          lines      = EXCLUDED.lines,
          updated_at = NOW()
      `, [
        ev.id,
        sportSlug,
        ev.commence_time,
        ev.home_team,
        ev.away_team,
        JSON.stringify(ev.lines),
      ]);
    } catch (dbErr) {
      // Non-fatal: DB might not be up during dev
      logger.debug('[OddsService] DB upsert skipped:', dbErr.message);
    }
  }
}

/**
 * Return cached odds for a sport, refreshing if stale.
 * @param {string}  sportSlug  - 'nfl', 'nba', etc.
 * @param {number}  maxAgeMin  - Max age in minutes before we re-fetch
 */
async function getOdds(sportSlug, maxAgeMin = 30) {
  const cached = cache[sportSlug];
  const now    = Date.now();

  if (cached && (now - cached.fetchedAt.getTime()) < maxAgeMin * 60_000) {
    logger.debug(`[OddsService] Cache hit for ${sportSlug}`);
    return cached.data;
  }

  return fetchSportOdds(sportSlug);
}

/**
 * Fetch odds for multiple sports at once (used by the cron job).
 */
async function refreshAllSports(sports = ['nfl', 'nba']) {
  const results = {};
  for (const sport of sports) {
    results[sport] = await fetchSportOdds(sport);
    // Small delay to be kind to the API
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

/**
 * Get the cache status for the admin health endpoint.
 */
function getCacheStatus() {
  return Object.entries(cache).map(([sport, entry]) => ({
    sport,
    events:      entry.data.length,
    fetchedAt:   entry.fetchedAt,
    ageMinutes:  Math.round((Date.now() - entry.fetchedAt.getTime()) / 60_000),
    remaining:   entry.remainingRequests,
  }));
}

// ── Mock data (used when no API key is configured) ────────────────────────────
function getMockOdds(sport) {
  const mockEvents = {
    nfl: [
      {
        id: 'mock_nfl_1',
        sport_key: 'americanfootball_nfl',
        commence_time: new Date(Date.now() + 86400000 * 2).toISOString(),
        home_team: 'Kansas City Chiefs',
        away_team: 'Las Vegas Raiders',
        lines: {
          moneyline: { home: { odds: '-320', price: -320 }, away: { odds: '+260', price: 260 } },
          spread:    { home: { point: -6.5, label: 'Kansas City Chiefs -6.5', odds: '-110', price: -110 }, away: { point: 6.5, label: 'Las Vegas Raiders +6.5', odds: '-110', price: -110 } },
          totals:    { point: 47.5, over: { label: 'Over 47.5', odds: '-110', price: -110 }, under: { label: 'Under 47.5', odds: '-110', price: -110 } },
        },
      },
      {
        id: 'mock_nfl_2',
        sport_key: 'americanfootball_nfl',
        commence_time: new Date(Date.now() + 86400000 * 2).toISOString(),
        home_team: 'Philadelphia Eagles',
        away_team: 'Dallas Cowboys',
        lines: {
          moneyline: { home: { odds: '-185', price: -185 }, away: { odds: '+155', price: 155 } },
          spread:    { home: { point: -4.5, label: 'Philadelphia Eagles -4.5', odds: '-115', price: -115 }, away: { point: 4.5, label: 'Dallas Cowboys +4.5', odds: '-105', price: -105 } },
          totals:    { point: 51.5, over: { label: 'Over 51.5', odds: '-108', price: -108 }, under: { label: 'Under 51.5', odds: '-112', price: -112 } },
        },
      },
      {
        id: 'mock_nfl_3',
        sport_key: 'americanfootball_nfl',
        commence_time: new Date(Date.now() + 86400000 * 3).toISOString(),
        home_team: 'Buffalo Bills',
        away_team: 'New York Jets',
        lines: {
          moneyline: { home: { odds: '-240', price: -240 }, away: { odds: '+200', price: 200 } },
          spread:    { home: { point: -5.5, label: 'Buffalo Bills -5.5', odds: '-110', price: -110 }, away: { point: 5.5, label: 'New York Jets +5.5', odds: '-110', price: -110 } },
          totals:    { point: 44.5, over: { label: 'Over 44.5', odds: '-112', price: -112 }, under: { label: 'Under 44.5', odds: '-108', price: -108 } },
        },
      },
    ],
    nba: [
      {
        id: 'mock_nba_1',
        sport_key: 'basketball_nba',
        commence_time: new Date(Date.now() + 86400000).toISOString(),
        home_team: 'Los Angeles Lakers',
        away_team: 'Boston Celtics',
        lines: {
          moneyline: { home: { odds: '+140', price: 140 }, away: { odds: '-165', price: -165 } },
          spread:    { home: { point: 3.5, label: 'Los Angeles Lakers +3.5', odds: '-108', price: -108 }, away: { point: -3.5, label: 'Boston Celtics -3.5', odds: '-112', price: -112 } },
          totals:    { point: 228.5, over: { label: 'Over 228.5', odds: '-110', price: -110 }, under: { label: 'Under 228.5', odds: '-110', price: -110 } },
        },
      },
      {
        id: 'mock_nba_2',
        sport_key: 'basketball_nba',
        commence_time: new Date(Date.now() + 86400000).toISOString(),
        home_team: 'Denver Nuggets',
        away_team: 'Miami Heat',
        lines: {
          moneyline: { home: { odds: '-175', price: -175 }, away: { odds: '+148', price: 148 } },
          spread:    { home: { point: -4.5, label: 'Denver Nuggets -4.5', odds: '-110', price: -110 }, away: { point: 4.5, label: 'Miami Heat +4.5', odds: '-110', price: -110 } },
          totals:    { point: 223.5, over: { label: 'Over 223.5', odds: '-115', price: -115 }, under: { label: 'Under 223.5', odds: '-105', price: -105 } },
        },
      },
    ],
  };

  return mockEvents[sport] || [];
}

module.exports = { getOdds, fetchSportOdds, refreshAllSports, getCacheStatus, SPORT_KEYS };

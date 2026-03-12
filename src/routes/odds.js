// src/routes/odds.js
// All odds data flows through these endpoints.
// The frontend never calls The Odds API directly.

const express      = require('express');
const { requireAuth } = require('../middleware/auth');
const oddsService  = require('../services/oddsService');
const logger       = require('../utils/logger');

const router = express.Router();

// ── GET /api/odds/events/:eventId/props ──────────────────────────────────────
// Fetches player prop markets for a single event directly from The Odds API.
// Query params:
//   ?sport=basketball_nba        (required — full API sport key)
//   ?markets=player_points,...   (comma-separated prop market keys)
router.get('/events/:eventId/props', requireAuth, async (req, res, next) => {
  try {
    const { eventId } = req.params;
    const sport   = req.query.sport;
    const markets = req.query.markets || 'player_points,player_rebounds,player_assists';

    if (!sport) {
      return res.status(400).json({ error: 'sport query param required' });
    }

    const API_KEY    = process.env.ODDS_API_KEY;
    const BOOKMAKERS = process.env.ODDS_BOOKMAKERS || 'draftkings,fanduel,betmgm';
    const BASE_URL   = 'https://api.the-odds-api.com/v4';

    if (!API_KEY || API_KEY === 'your_odds_api_key_here') {
      return res.json({ eventId, markets: [] });
    }

    const axios = require('axios');
    const response = await axios.get(
      `${BASE_URL}/sports/${sport}/events/${eventId}/odds`,
      {
        params: {
          apiKey:     API_KEY,
          regions:    'us',
          markets,
          oddsFormat: 'american',
          bookmakers: BOOKMAKERS,
        },
        timeout: 10_000,
      }
    );

    // Pick the first bookmaker that has props data
    const bookmakers = response.data?.bookmakers || [];
    const bm = bookmakers[0];

    if (!bm) {
      return res.json({ eventId, markets: [] });
    }

    // Return markets in the shape the frontend expects:
    // [ { key, outcomes: [ { description, name, price, point } ] } ]
    const propMarkets = (bm.markets || []).map(m => ({
      key:      m.key,
      outcomes: (m.outcomes || []).map(o => ({
        description: o.description || o.name,
        name:        o.name,
        price:       o.price,
        point:       o.point,
      })),
    }));

    const remaining = response.headers['x-requests-remaining'];
    logger.info(`[OddsAPI] props ${eventId}: ${propMarkets.length} markets | remaining: ${remaining}`);

    res.json({ eventId, markets: propMarkets });
  } catch (err) {
    logger.error('[OddsAPI] Props fetch failed:', err.message);
    res.json({ eventId: req.params.eventId, markets: [] });
  }
});

// ── GET /api/odds/:sport ─────────────────────────────────────────────────────
// Returns normalised upcoming events with lines for a given sport.
// Query params:
//   ?markets=spread,moneyline,totals  (filter which bet types to include)
//   ?bookmaker=draftkings             (override default bookmaker)
//
// Example: GET /api/odds/nfl?markets=spread,moneyline
router.get('/:sport', requireAuth, async (req, res, next) => {
  try {
    const { sport } = req.params;
    const markets   = req.query.markets?.split(',') || ['spread', 'moneyline', 'totals'];

    // Validate sport
    if (!oddsService.SPORT_KEYS[sport]) {
      return res.status(400).json({
        error: `Unknown sport '${sport}'.`,
        supported: Object.keys(oddsService.SPORT_KEYS),
      });
    }

    const events = await oddsService.getOdds(sport);

    // Filter to only the requested markets
    const filtered = events.map(ev => {
      const lines = {};
      if (markets.includes('moneyline') && ev.lines.moneyline) lines.moneyline = ev.lines.moneyline;
      if (markets.includes('spread')    && ev.lines.spread)    lines.spread    = ev.lines.spread;
      if (markets.includes('totals')    && ev.lines.totals)    lines.totals    = ev.lines.totals;
      return { ...ev, lines };
    }).filter(ev => Object.keys(ev.lines).length > 0);

    res.json({
      sport,
      count:     filtered.length,
      fetchedAt: new Date().toISOString(),
      events:    filtered,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/odds/:sport/event/:eventId ──────────────────────────────────────
// Returns full details for a single event — used when a user opens a pick card.
router.get('/:sport/event/:eventId', requireAuth, async (req, res, next) => {
  try {
    const { sport, eventId } = req.params;
    const events = await oddsService.getOdds(sport);
    const event  = events.find(e => e.id === eventId);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json({ event });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/odds (multi-sport) ───────────────────────────────────────────────
// Returns events for multiple sports in one call.
// Query param: ?sports=nfl,nba
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const sports = (req.query.sports || 'nfl,nba').split(',').map(s => s.trim());
    const valid  = sports.filter(s => oddsService.SPORT_KEYS[s]);

    if (valid.length === 0) {
      return res.status(400).json({
        error: 'No valid sports specified',
        supported: Object.keys(oddsService.SPORT_KEYS),
      });
    }

    const results = {};
    for (const sport of valid) {
      results[sport] = await oddsService.getOdds(sport);
    }

    // Flatten into a single list — preserve sport_key from event, add sport_slug for reference
    const events = Object.entries(results).flatMap(([sportSlug, evs]) =>
      evs.map(ev => ({ ...ev, sport_slug: sportSlug }))
    );

    res.json({
      sports:    valid,
      count:     events.length,
      fetchedAt: new Date().toISOString(),
      events,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/odds/admin/cache (no auth guard — add one before prod) ───────────
router.get('/admin/cache', async (req, res) => {
  res.json({
    cache:     oddsService.getCacheStatus(),
    timestamp: new Date().toISOString(),
  });
});

// ── POST /api/odds/refresh ───────────────────────────────────────────────────
// Manually trigger an odds refresh (costs API credits — use sparingly)
router.post('/refresh', requireAuth, async (req, res, next) => {
  try {
    const { runOddsRefresh } = require('../jobs/oddsCron');
    await runOddsRefresh();
    res.json({ ok: true, message: 'Odds refreshed', timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

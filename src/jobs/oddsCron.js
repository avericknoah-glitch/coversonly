// src/jobs/oddsCron.js
// Two scheduled jobs:
//   1. Refresh odds cache from The Odds API (smart schedule to conserve credits)
//   2. Grade completed picks (runs once per hour)
//
// Odds refresh schedule:
//   Weekdays (Mon-Fri): 1am, 5pm, 10pm        = 3 pulls/day
//   Weekends (Sat-Sun): 1am, 3pm, 5pm, 8pm, 10pm = 5 pulls/day
//   Weekly total: 15 + 10 = 25 pulls/week

const cron    = require('node-cron');
const odds    = require('../services/oddsService');
const grading = require('../services/gradingService');
const logger  = require('../utils/logger');

let oddsJob    = null;
let gradingJob = null;

async function runOddsRefresh() {
  const inSeason = getInSeasonSports();
  logger.info(`[Cron] Refreshing odds for: ${inSeason.join(', ')}`);
  try {
    await odds.refreshAllSports(inSeason);
    logger.info('[Cron] Odds refresh complete');
  } catch (err) {
    logger.error('[Cron] Odds refresh failed:', err.message);
  }
}

async function runGrading() {
  try {
    const count = await grading.gradeAllPendingPicks();
    if (count > 0) logger.info(`[Cron] Graded ${count} picks`);
  } catch (err) {
    logger.error('[Cron] Grading failed:', err.message);
  }
}

function start() {
  // ── Weekday schedule: 1am, 5pm, 10pm (Mon-Fri) ──────────────────────────
  // cron: minute hour * * day-of-week (0=Sun, 1=Mon...5=Fri)
  const weekdayJobs = [
    cron.schedule('0 1  * * 1-5', runOddsRefresh),  // 1:00am  Mon–Fri
    cron.schedule('0 17 * * 1-5', runOddsRefresh),  // 5:00pm  Mon–Fri
    cron.schedule('0 22 * * 1-5', runOddsRefresh),  // 10:00pm Mon–Fri
  ];

  // ── Weekend schedule: 1am, 3pm, 5pm, 8pm, 10pm (Sat-Sun) ───────────────
  const weekendJobs = [
    cron.schedule('0 1  * * 0,6', runOddsRefresh),  // 1:00am  Sat–Sun
    cron.schedule('0 15 * * 0,6', runOddsRefresh),  // 3:00pm  Sat–Sun
    cron.schedule('0 17 * * 0,6', runOddsRefresh),  // 5:00pm  Sat–Sun
    cron.schedule('0 20 * * 0,6', runOddsRefresh),  // 8:00pm  Sat–Sun
    cron.schedule('0 22 * * 0,6', runOddsRefresh),  // 10:00pm Sat–Sun
  ];

  oddsJob = { stop: () => { [...weekdayJobs, ...weekendJobs].forEach(j => j.stop()); } };

  logger.info('[Cron] Odds schedule: weekdays 1am/5pm/10pm | weekends 1am/3pm/5pm/8pm/10pm');

  // ── Grade picks on same schedule, 30min after each odds refresh ─────────
  // Weekdays: 1:30am, 5:30pm, 10:30pm
  // Weekends: 1:30am, 3:30pm, 5:30pm, 8:30pm, 10:30pm
  const gradingJobs = [
    cron.schedule('30 1  * * 1-5', runGrading),
    cron.schedule('30 17 * * 1-5', runGrading),
    cron.schedule('30 22 * * 1-5', runGrading),
    cron.schedule('30 1  * * 0,6', runGrading),
    cron.schedule('30 15 * * 0,6', runGrading),
    cron.schedule('30 17 * * 0,6', runGrading),
    cron.schedule('30 20 * * 0,6', runGrading),
    cron.schedule('30 22 * * 0,6', runGrading),
  ];
  gradingJob = { stop: () => gradingJobs.forEach(j => j.stop()) };

  // Warm the cache once on startup (does NOT count toward scheduled pulls)
  setImmediate(async () => {
    logger.info('[Cron] Initial odds fetch on startup...');
    await runOddsRefresh();
  });
}

function stop() {
  oddsJob?.stop();
  gradingJob?.stop();
}

function getInSeasonSports() {
  const month = new Date().getMonth() + 1; // 1-12
  const sports = [];

  if (month >= 9 || month <= 2)  sports.push('nfl');     // Sep–Feb
  if (month >= 10 || month <= 6) sports.push('nba');     // Oct–Jun
  if (month >= 4 && month <= 10) sports.push('mlb');     // Apr–Oct
  if (month >= 11 || month <= 4) sports.push('ncaamb');       // Nov–Apr (March Madness!)
  if (month >= 8 && month <= 12) sports.push('ncaafb');       // Aug–Dec
  sports.push('soccer_epl', 'soccer_mls');                    // Year-round
  if (month >= 2 && month <= 7) sports.push('soccer_copa_america');  // Copa América summer
  sports.push('soccer_uefa_champs');                          // Champions League Sep–May

  if (sports.length === 0) sports.push('nba');
  return [...new Set(sports)];
}

module.exports = { start, stop, getInSeasonSports, runOddsRefresh, runGrading };

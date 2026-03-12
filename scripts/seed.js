// scripts/seed.js
// Populates the DB with demo users, leagues, and picks for development.
// Run: node scripts/seed.js

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db     = require('../src/db');
const logger = require('../src/utils/logger');

async function seed() {
  logger.info('Seeding demo data...');

  // ── Users ─────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash('Password123!', 12);

  const { rows: users } = await db.query(`
    INSERT INTO users (email, password_hash, username, first_name, last_name) VALUES
      ('alex@demo.com',    $1, 'sharpshooter99', 'Alex',    'Johnson'),
      ('mike@demo.com',    $1, 'mikeyknows',      'Michael', 'Kim'),
      ('tyler@demo.com',   $1, 'tdchaserr',       'Tyler',   'Chen'),
      ('kelsey@demo.com',  $1, 'kelseyruns',      'Kelsey',  'Rodriguez'),
      ('brandon@demo.com', $1, 'betterhalf',      'Brandon', 'Harris')
    ON CONFLICT (email) DO NOTHING
    RETURNING id, username
  `, [hash]);

  if (!users.length) {
    logger.warn('Demo users already exist — skipping seed');
    process.exit(0);
  }

  const [alex, mike, tyler, kelsey, brandon] = users;
  logger.info(`Created ${users.length} users`);

  // ── League ────────────────────────────────────────────────────────────────
  const { rows: leagues } = await db.query(`
    INSERT INTO leagues (
      name, visibility, sports, bet_types, picks_per_week,
      max_members, pick_deadline, commissioner_id, invite_code
    ) VALUES (
      'Sunday Ballers', 'public', '{nfl,nba}', '{spread,moneyline,totals}',
      5, 10, 'first_game', $1, 'SUN-BALL'
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [alex.id]);

  const league = leagues[0];
  logger.info(`Created league: ${league.name}`);

  // ── Members ───────────────────────────────────────────────────────────────
  await db.query(`
    INSERT INTO league_members (league_id, user_id, role) VALUES
      ($1, $2, 'commissioner'),
      ($1, $3, 'member'),
      ($1, $4, 'member'),
      ($1, $5, 'member'),
      ($1, $6, 'member')
    ON CONFLICT DO NOTHING
  `, [league.id, alex.id, mike.id, tyler.id, kelsey.id, brandon.id]);

  // ── Demo events ───────────────────────────────────────────────────────────
  await db.query(`
    INSERT INTO events (external_id, sport_slug, commence_time, home_team, away_team, lines) VALUES
      ('demo_nfl_1', 'nfl', NOW() + INTERVAL '2 days',
       'Kansas City Chiefs', 'Las Vegas Raiders',
       '{"spread":{"home":{"point":-6.5,"label":"Kansas City Chiefs -6.5","odds":"-110"},"away":{"point":6.5,"label":"Las Vegas Raiders +6.5","odds":"-110"}},"moneyline":{"home":{"odds":"-320"},"away":{"odds":"+260"}},"totals":{"point":47.5,"over":{"label":"Over 47.5","odds":"-110"},"under":{"label":"Under 47.5","odds":"-110"}}}'),
      ('demo_nfl_2', 'nfl', NOW() + INTERVAL '2 days',
       'Philadelphia Eagles', 'Dallas Cowboys',
       '{"spread":{"home":{"point":-4.5,"label":"Philadelphia Eagles -4.5","odds":"-115"},"away":{"point":4.5,"label":"Dallas Cowboys +4.5","odds":"-105"}},"moneyline":{"home":{"odds":"-185"},"away":{"odds":"+155"}},"totals":{"point":51.5,"over":{"label":"Over 51.5","odds":"-108"},"under":{"label":"Under 51.5","odds":"-112"}}}')
    ON CONFLICT (external_id) DO NOTHING
  `);

  // ── Demo picks ────────────────────────────────────────────────────────────
  const pickData = [
    // Alex (W W L)
    [alex.id, league.id, 14, 'demo_nfl_1', 'nfl', 'spread', 'Kansas City Chiefs -6.5', 'win'],
    [alex.id, league.id, 14, 'demo_nfl_2', 'nfl', 'totals', 'Over 51.5',               'win'],
    [alex.id, league.id, 13, 'demo_nfl_1', 'nfl', 'moneyline', 'Las Vegas Raiders',    'loss'],
    // Mike (W W W)
    [mike.id, league.id, 14, 'demo_nfl_1', 'nfl', 'spread', 'Kansas City Chiefs -6.5', 'win'],
    [mike.id, league.id, 14, 'demo_nfl_2', 'nfl', 'moneyline', 'Philadelphia Eagles',  'win'],
    [mike.id, league.id, 13, 'demo_nfl_2', 'nfl', 'spread', 'Dallas Cowboys +4.5',     'win'],
  ];

  for (const [uid, lid, week, eid, sport, bt, sel, result] of pickData) {
    await db.query(`
      INSERT INTO picks (user_id, league_id, week, event_id, sport, bet_type, selection, result)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT DO NOTHING
    `, [uid, lid, week, eid, sport, bt, sel, result]);
  }

  logger.info('✅  Seed complete');
  logger.info('');
  logger.info('Demo login credentials:');
  logger.info('  Email: alex@demo.com | Password: Password123!');
  logger.info('  Email: mike@demo.com | Password: Password123!');
  process.exit(0);
}

seed().catch(err => {
  logger.error('Seed failed:', err);
  process.exit(1);
});

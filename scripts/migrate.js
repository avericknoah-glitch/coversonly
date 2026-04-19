// scripts/migrate.js
// Run: node scripts/migrate.js
// Creates all tables from scratch. Safe to re-run (uses IF NOT EXISTS).

require('dotenv').config();
const db     = require('../src/db');
const logger = require('../src/utils/logger');

async function migrate() {
  logger.info('Running migrations...');

  await db.query(`
    -- ── Extensions ────────────────────────────────────────────────────────────
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    -- ── Users ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      username      TEXT NOT NULL UNIQUE,
      first_name    TEXT NOT NULL DEFAULT '',
      last_name     TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
      last_login    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── Leagues ───────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS leagues (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      visibility       TEXT NOT NULL DEFAULT 'private',  -- 'public' | 'private'
      sports           TEXT[] NOT NULL DEFAULT '{nfl}',
      bet_types        TEXT[] NOT NULL DEFAULT '{spread,moneyline,totals}',
      picks_per_week   INTEGER NOT NULL DEFAULT 5,
      max_members      INTEGER NOT NULL DEFAULT 20,
      pick_deadline    TEXT NOT NULL DEFAULT 'first_game',
      commissioner_id  INTEGER NOT NULL REFERENCES users(id),
      invite_code      TEXT UNIQUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── League Members ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS league_members (
      id          SERIAL PRIMARY KEY,
      league_id   INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'member',          -- 'commissioner' | 'co_commissioner' | 'member'
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (league_id, user_id)
    );

    -- ── League Invites ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS league_invites (
      id          SERIAL PRIMARY KEY,
      league_id   INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      inviter_id  INTEGER NOT NULL REFERENCES users(id),
      invitee_id  INTEGER NOT NULL REFERENCES users(id),
      status      TEXT NOT NULL DEFAULT 'pending',          -- 'pending' | 'accepted' | 'declined'
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (league_id, invitee_id)
    );

    -- ── Events (cached from The Odds API) ─────────────────────────────────────
    -- Lines are stored as JSONB so we preserve the exact odds at pick time.
    CREATE TABLE IF NOT EXISTS events (
      id            SERIAL PRIMARY KEY,
      external_id   TEXT NOT NULL UNIQUE,   -- The Odds API event ID
      sport_slug    TEXT NOT NULL,           -- 'nfl', 'nba', etc.
      commence_time TIMESTAMPTZ NOT NULL,
      home_team     TEXT NOT NULL,
      away_team     TEXT NOT NULL,
      lines         JSONB NOT NULL DEFAULT '{}',
      final_score   JSONB,                   -- { home: 24, away: 17 } after completion
      completed     BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── Picks ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS picks (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      league_id   INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      week        INTEGER NOT NULL,           -- NFL week / NBA week number
      event_id    TEXT NOT NULL,              -- References events.external_id
      sport       TEXT NOT NULL,
      bet_type    TEXT NOT NULL,              -- 'spread' | 'moneyline' | 'totals'
      selection   TEXT NOT NULL,             -- e.g. "Kansas City Chiefs -6.5"
      line_data   JSONB,                     -- Full lines object at pick time
      result      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'win' | 'loss' | 'push'
      graded_at   TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, league_id, week, event_id, bet_type)
    );

    -- ── Indexes ───────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_picks_league_week   ON picks(league_id, week);
    CREATE INDEX IF NOT EXISTS idx_picks_user_league   ON picks(user_id, league_id);
    CREATE INDEX IF NOT EXISTS idx_picks_result        ON picks(result);
    CREATE INDEX IF NOT EXISTS idx_events_sport        ON events(sport_slug);
    CREATE INDEX IF NOT EXISTS idx_events_commence     ON events(commence_time);
    CREATE INDEX IF NOT EXISTS idx_league_members_user ON league_members(user_id);
  `);

  await db.query(`
    ALTER TABLE leagues ADD COLUMN IF NOT EXISTS season_start DATE DEFAULT NULL;
    ALTER TABLE leagues ADD COLUMN IF NOT EXISTS season_end DATE DEFAULT NULL;
    ALTER TABLE leagues ADD COLUMN IF NOT EXISTS week_structure TEXT DEFAULT 'monday_sunday';
    ALTER TABLE leagues ADD COLUMN IF NOT EXISTS odds_max INTEGER DEFAULT -120;
  `);

  logger.info('✅  Migrations complete');
  process.exit(0);
}

migrate().catch(err => {
  logger.error('Migration failed:', err);
  process.exit(1);
});

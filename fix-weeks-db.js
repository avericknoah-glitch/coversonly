#!/usr/bin/env node
// Run: node /mnt/c/Users/noaha/Downloads/fix-weeks-db.js
// 1. Recalculates correct ISO week for every pick based on game commence_time
// 2. Updates the DB

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

async function run() {
  // Get all picks with their game date
  const { rows: picks } = await pool.query(`
    SELECT p.id, p.week as stored_week, p.created_at,
           e.commence_time
    FROM picks p
    LEFT JOIN events e ON e.external_id = p.event_id
    ORDER BY p.id
  `);

  console.log(`Found ${picks.length} picks to check\n`);

  let fixed = 0;
  for (const pick of picks) {
    // Use commence_time if available, otherwise created_at
    const gameDate = pick.commence_time ? new Date(pick.commence_time) : new Date(pick.created_at);
    const correctWeek = isoWeek(gameDate);

    console.log(`Pick ${pick.id}: stored=${pick.stored_week} | game=${gameDate.toISOString().split('T')[0]} | correct=${correctWeek}`);

    if (pick.stored_week !== correctWeek) {
      await pool.query('UPDATE picks SET week = $1 WHERE id = $2', [correctWeek, pick.id]);
      console.log(`  → Fixed: ${pick.stored_week} → ${correctWeek}`);
      fixed++;
    }
  }

  console.log(`\n✅ Fixed ${fixed} pick(s)`);

  // Show final state
  const { rows: summary } = await pool.query(`
    SELECT week, MIN(created_at)::date as earliest, MAX(created_at)::date as latest, COUNT(*) as picks
    FROM picks GROUP BY week ORDER BY week
  `);
  console.log('\nFinal week distribution:');
  summary.forEach(r => console.log(`  Week ${r.week}: ${r.earliest} – ${r.latest} (${r.picks} picks)`));

  await pool.end();
}

run().catch(err => { console.error('❌', err.message); pool.end(); });

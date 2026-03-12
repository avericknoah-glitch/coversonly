// Run once from your backend directory:
//   cd ~/lineup/lineup-backend && node fix-odds-max.js

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // 1. Fix the column default so NEW leagues get -120
  await pool.query(`ALTER TABLE leagues ALTER COLUMN odds_max SET DEFAULT -120`);
  console.log('✅ Column default changed to -120');

  // 2. Fix all existing leagues that still have the stale 500 default
  //    (any league the commissioner never manually saved odds settings for)
  const { rowCount } = await pool.query(`
    UPDATE leagues SET odds_max = -120 WHERE odds_max = 500
  `);
  console.log(`✅ Fixed ${rowCount} league(s) with stale odds_max = 500`);

  // 3. Show current state of all leagues so you can verify
  const { rows } = await pool.query(`SELECT id, name, odds_max FROM leagues ORDER BY id`);
  console.log('\nCurrent league odds_max values:');
  rows.forEach(r => console.log(`  League ${r.id} "${r.name}": odds_max = ${r.odds_max}`));

  await pool.end();
}

run().catch(err => {
  console.error('❌ Error:', err.message);
  pool.end();
});

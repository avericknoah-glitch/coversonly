#!/usr/bin/env node
require('dotenv').config();
const oddsService = require('./src/services/oddsService');

async function run() {
  console.log('SPORT_KEYS:', Object.keys(oddsService.SPORT_KEYS));
  
  console.log('\n--- Testing soccer_epl ---');
  try {
    const events = await oddsService.getOdds('soccer_epl');
    console.log('Events returned:', events.length);
    if (events.length) console.log('Sample:', JSON.stringify(events[0], null, 2));
    else console.log('No events found');
  } catch(e) { console.error('Error:', e.message); }

  console.log('\n--- Testing soccer_mls ---');
  try {
    const events = await oddsService.getOdds('soccer_mls');
    console.log('Events returned:', events.length);
    if (events.length) console.log('Sample game:', events[0].home_team, 'vs', events[0].away_team, events[0].commence_time);
  } catch(e) { console.error('Error:', e.message); }
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

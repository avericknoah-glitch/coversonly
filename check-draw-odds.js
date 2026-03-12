#!/usr/bin/env node
require('dotenv').config();
const oddsService = require('./src/services/oddsService');

async function run() {
  const events = await oddsService.getOdds('soccer_epl');
  console.log('First event full structure:');
  console.log(JSON.stringify(events[0], null, 2));
  
  // Check how many have draw odds
  const withDraw = events.filter(e => e.lines?.moneyline?.draw);
  console.log(`\nEvents with draw odds: ${withDraw.length}/${events.length}`);
  if (withDraw.length) console.log('Sample draw odds:', withDraw[0].lines.moneyline.draw);
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

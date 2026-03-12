const db = require('./src/db');

Promise.all([
  db.query(
    "UPDATE picks SET selection=$1, line_data=$2 WHERE id=2",
    [
      'Ayo Dosunmu Under 3.5 Rebounds',
      { market: 'player_rebounds', direction: 'under', point: 3.5 }
    ]
  ),
  db.query(
    "UPDATE picks SET selection=$1, line_data=$2 WHERE id=7",
    [
      'Myles Turner Under 4.5 Assists',
      { market: 'player_assists', direction: 'under', point: 4.5 }
    ]
  )
]).then(() => { console.log('✅ updated'); process.exit(0); })
  .catch(e => { console.log('err:', e.message); process.exit(1); });

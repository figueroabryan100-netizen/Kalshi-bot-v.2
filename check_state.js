const fs = require('fs');
const state = JSON.parse(fs.readFileSync('kalshi_state.json', 'utf8'));
console.log('Keys:', Object.keys(state));
console.log('has scanCount:', 'scanCount' in state);
console.log('has tradeCount:', 'tradeCount' in state);
console.log('has AUTO_HIT_CYCLE:', 'AUTO_HIT_CYCLE' in state);
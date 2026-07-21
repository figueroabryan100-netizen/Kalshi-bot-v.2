const fs = require('fs');
const state = JSON.parse(fs.readFileSync('kalshi_state.json', 'utf8'));
console.log('has AUTO_HIT_CYCLE in saved file:', 'AUTO_HIT_CYCLE' in state);
console.log('AUTO_HIT_CYCLE in saved file:', state.AUTO_HIT_CYCLE);
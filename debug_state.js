const fs = require('fs');
const state = JSON.parse(fs.readFileSync('kalshi_state.json', 'utf8'));
console.log('isRunning:', state.isRunning);
console.log('autoExecuteEnabled:', state.autoExecuteEnabled);
console.log('AUTO_HIT_CYCLE in state:', 'AUTO_HIT_CYCLE' in state);
console.log('Keys in state:', Object.keys(state));
if (state.AUTO_HIT_CYCLE) {
  console.log('AUTO_HIT_CYCLE:', JSON.stringify(state.AUTO_HIT_CYCLE, null, 2));
} else {
  console.log('AUTO_HIT_CYCLE is undefined');
}
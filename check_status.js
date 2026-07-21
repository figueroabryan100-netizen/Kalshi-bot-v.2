const fs = require('fs');
const state = JSON.parse(fs.readFileSync('kalshi_state.json', 'utf8'));
console.log('isRunning:', state.isRunning);
console.log('scanCount:', state.scanCount);
console.log('tradeCount:', state.tradeCount);
console.log('balance:', state.stats?.totalProfit);
console.log('AUTO_HIT_CYCLE:', state.AUTO_HIT_CYCLE ? {enabled: state.AUTO_HIT_CYCLE.enabled, attemptCount: state.AUTO_HIT_CYCLE.attemptCount, totalFired: state.AUTO_HIT_CYCLE.totalFired} : 'undefined');
console.log('openBets:', state.openBets?.length || 0);
console.log('pendingBets:', state.pendingBets?.length || 0);
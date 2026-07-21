const fs = require('fs');
const state = JSON.parse(fs.readFileSync('kalshi_state.json', 'utf8'));
console.log('openBets:', state.openBets.map(b => ({asset: b.asset, side: b.side, amount: b.amount, ticker: b.ticker, entryPrice: b.entryPrice})));
console.log('pendingBets:', state.pendingBets.length);
console.log('balance:', state.stats?.totalProfit);
console.log('tradeCount:', state.tradeCount);
console.log('AUTO_HIT_CYCLE totalFired:', state.AUTO_HIT_CYCLE?.totalFired);
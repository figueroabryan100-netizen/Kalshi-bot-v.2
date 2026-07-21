const code = require('fs').readFileSync('index.js', 'utf8');
const checks = [
  ['No eval()', !code.includes('eval(')],
  ['Auto-hit stop loss', code.includes('maxConsecutiveLosses')],
  ['Kelly cap at 2%', code.includes('maxFraction = 0.02')],
  ['Stake clamp 0.25-0.75', code.includes('Math.max(0.25') && code.includes('Math.min(0.75')],
  ['Momentum stake smaller', code.includes("typeMult = signalType.startsWith")],
  ['Regime detection', code.includes('detectRegime')],
  ['Signal history', code.includes('SIGNAL_HISTORY')],
  ['Kelly cap 2%', code.includes('maxFraction = 0.02')],
  ['5-loss stop loss', code.includes('maxConsecutiveLosses')],
  ['Shadow tracking deny', code.includes("trackShadowPlay(pending, 'denied')")],
  ['Shadow tracking approve', code.includes("trackShadowPlay(pending, 'approved')")],
  ['Cycle history in reasoning', code.includes('cycleHistorySummary')],
  ['Pyth WS price feed', code.includes('startPythPriceStream')],
  ['Weather disabled', code.includes('Weather completely disabled')],
  ['Deny deletes message', code.includes('deleteMessage')],
];
console.log('=== CODE HEALTH CHECK ===');
checks.forEach(([name, pass]) => console.log((pass ? 'OK' : 'FAIL') + ' ' + name));
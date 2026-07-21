const fs = require('fs');
const state = JSON.parse(fs.readFileSync('kalshi_state.json', 'utf8'));

state.scanCount = 0;
state.tradeCount = 0;
state.stats = { totalProfit: 0, wins: 0, losses: 0, totalBets: 0 };
state.settlementHistory = [];
state.closedBets = [];
state.openBets = [];
state.pendingBets = [];

state.risk = { 
  dayKey: new Date().toDateString(), 
  dayStartEquity: 1.62, 
  dayPnl: 0, 
  peakEquity: 1.62, 
  emergencyHalt: false, 
  haltReason: null 
};

state.AUTO_HIT_CYCLE = { 
  enabled: true, 
  maxPlaysPerCycle: 10, 
  minEdge: 0.01, 
  minWinProb: 0.50, 
  minMemoryBits: 0, 
  mode: 'hybrid', 
  maxSettleMinsStrict: 17, 
  maxSettleMinsFallback: 1440, 
  allowedCategories: ['CRYPTO','COMMODITY','NICHE','QUANT_NICHE','LONGSHOT'], 
  cooldownSec: 30, 
  dailyMaxLoss: 5.00, 
  dailyLoss: 0, 
  dailyLossDate: new Date().toDateString(), 
  maxConsecutiveLosses: 20, 
  consecutiveLosses: 0, 
  lastFire: {}, 
  attemptCount: 0, 
  lastAttempt: 0, 
  totalFired: 0, 
  lastFired: 0, 
  adaptiveThresholds: { 
    enabled: true, 
    minEdgeRange: [0.01, 0.10], 
    minWinProbRange: [0.40, 0.65], 
    maxPlaysRange: [1, 30] 
  } 
};

state.stats = { totalProfit: 0, wins: 0, losses: 0, totalBets: 0 };
state.settlementHistory = [];
state.closedBets = [];
state.openBets = [];
state.pendingBets = [];

state.risk = { 
  dayKey: new Date().toDateString(), 
  dayStartEquity: 1.62, 
  dayPnl: 0, 
  peakEquity: 1.62, 
  emergencyHalt: false, 
  haltReason: null 
};

fs.writeFileSync('kalshi_state.json', JSON.stringify(state, null, 2));
console.log('State fully reset');
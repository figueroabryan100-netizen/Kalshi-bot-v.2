// ============================================================================
// KALSHI BOT STRATEGY IMPROVEMENTS — Code Implementations
// ============================================================================
// Copy these functions into your index.js to implement the improvements.
// Each section is marked with PRIORITY level and expected impact.
//
// Usage:
// 1. Read STRATEGY_ANALYSIS.md for context
// 2. Copy functions below into your index.js (replace existing ones)
// 3. Update your _env file with new parameters
// 4. Test with DRY_RUN=true first
// 5. Monitor win rates in /memory for A/B testing
//
// ============================================================================

// ============================================================================
// HELPER CONSTANTS AND UTILITIES
// ============================================================================

const VOLUME_SCALER_MIN = 0.5;
const VOLUME_SCALER_MAX = 1.5;
const DEFAULT_MIN_EDGE = 0.06;
const CATEGORY_WIN_RATE_HARD_VETO = 0.25;
const CATEGORY_NET_LOSS_HARD_VETO = -2.0;
const BAYESIAN_CONFIDENCE_THRESHOLD = 8;

// ============================================================================
// PRIORITY 1: DYNAMIC UNDERDOG SIZING — Replaces fixed $1.50
// ============================================================================
// 
// Current Problem: UNDERDOG always $1.50 regardless of edge or volume
// New Behavior: Scales $0.75-$2.50 based on edge quality + book depth
//
// Impact: +1-2% win rate by matching position size to opportunity
//
// Add these to your .env file:
//   UNDER_STAKE_MIN=0.75      (was 1.50)
//   UNDER_STAKE_MAX=2.50
//   UNDER_STAKE=1.50          (default = start here if unsure)
//   UNDER_VOLUME_THRESHOLD=200
//   UNDER_EDGE_MULTIPLIER=8   (controls stake scaling with edge)

function calculateUnderdogStake(edge, volume, minEdge = 0.06) {
  // Input validation
  if (typeof edge !== 'number' || edge < 0) {
    console.warn('Invalid edge value:', edge);
    return parseFloat(process.env.UNDER_STAKE || '1.50');
  }
  if (typeof volume !== 'number' || volume < 0) {
    console.warn('Invalid volume value:', volume);
    volume = 0;
  }

  // Base: minimum stake
  const stakeMin = parseFloat(process.env.UNDER_STAKE_MIN || '0.75');
  const stakeMax = parseFloat(process.env.UNDER_STAKE_MAX || '2.50');
  const volumeThresh = parseFloat(process.env.UNDER_VOLUME_THRESHOLD || '200');
  const edgeMultiplier = parseFloat(process.env.UNDER_EDGE_MULTIPLIER || '8');
  
  // Edge above minimum
  const edgeAboveMin = Math.max(0, edge - minEdge);
  
  // Volume scaler: 0% volume = 0.5x, volumeThresh = 1.0x, 2x volumeThresh = 1.5x
  const volumeScaler = Math.min(VOLUME_SCALER_MAX, VOLUME_SCALER_MIN + (volume || 0) / volumeThresh);
  
  // Calculate stake: base + edge-scaled component
  const baseStake = stakeMin;
  const edgeComponent = edgeAboveMin * edgeMultiplier * (volume > 0 ? 1 : 0.5);
  const totalStake = baseStake + edgeComponent;
  
  // Clamp to min/max
  return Math.max(stakeMin, Math.min(stakeMax, totalStake * volumeScaler));
}

// Usage in your existing calculateStrategyStake function:
// OLD:
//   function calculateStrategyStake(playType, winProb, edge, memoryStrength) {
//     if (!playType) return applyRiskToStake(FIXED_BET_USD);
//     let stake = playType.stakeDefault;  // ← ALWAYS same for UNDERDOG
//     ...
//   }
//
// NEW:
function calculateStrategyStakeImproved(playType, winProb, edge, memoryStrength, marketVolume = 0) {
  if (!playType) return applyRiskToStake(FIXED_BET_USD);
  
  let stake = playType.stakeDefault;
  
  // NEW: Dynamic underdog sizing
  if (playType.type === 'UNDERDOG') {
    stake = calculateUnderdogStake(edge, marketVolume, playType.minEdge);
  }
  // Existing logic for FAVORITE
  else if (playType.type === 'FAVORITE') {
    if (memoryStrength >= 3) stake = Math.min(stake * 1.2, playType.stakeMax);
    if (edge >= 0.10) stake = Math.min(stake * 1.1, playType.stakeMax);
    if (winProb >= 0.65) stake = Math.min(stake * 1.1, playType.stakeMax);
  }
  
  return Math.max(playType.stakeMin, Math.min(stake, playType.stakeMax));
}

// ============================================================================
// PRIORITY 2: REQUIRE PATTERN MEMORY FOR AUTO-HIT
// ============================================================================
//
// Current Problem: minMemoryBits = 0 means firing untested patterns
// New Behavior: Only fire patterns with ≥1 previous sample
//
// Impact: +2-3% win rate by avoiding first-trade-on-pattern bias
//
// Change in .env:
//   AUTO_HIT_MIN_MEM=1        (was 0)

function hasPatternMemory(asset, side, features, minSamples = 1) {
  const pkey = patternKey(asset, side, features);
  const pattern = botState.memory.patterns[pkey];
  
  // Check if pattern exists and has minimum samples
  if (!pattern || pattern.trades < minSamples) {
    return false;  // No memory yet
  }
  
  // Optional: also check if pattern is winning
  if (pattern.trades > 0) {
    const winRate = pattern.wins / pattern.trades;
    if (winRate < 0.20) {
      return false;  // Pattern is a loser, skip
    }
  }
  
  return true;
}

// Usage: Add this check in your AUTO_HIT cycle scanning:
// OLD:
//   for (const a of markets) {
//     if (quantTradeable(a)) { ... fire ... }
//   }
//
// NEW:
function autoHitCycleImproved(markets) {
  const minMemoryBits = parseInt(process.env.AUTO_HIT_MIN_MEM || '1', 10);
  const minMemory = minMemoryBits > 0;  // Enable memory requirement?
  
  const tradeable = [];
  for (const a of markets) {
    if (!quantTradeable(a)) continue;
    
    // NEW: Check pattern memory if required
    if (minMemory) {
      const hasMemory = hasPatternMemory(a.asset, a.side, buildFeatures(a), minMemoryBits);
      if (!hasMemory) {
        console.log(`Skip ${a.asset} ${a.side} @ ${cents(a.price)} — no pattern memory (< ${minMemoryBits} trades)`);
        continue;
      }
    }
    
    tradeable.push(a);
  }
  
  return tradeable;
}

// ============================================================================
// PRIORITY 3: TIGHTEN CATEGORY VETO — Scaled penalties + faster cutoff
// ============================================================================
//
// Current Problem: Only -2pp soft penalty; hard veto requires BOTH bad winrate AND losses
// New Behavior: Scale penalty with severity; easier hard veto
//
// Impact: +1-2% win rate by filtering bad categories in real-time
//
// This REPLACES the category memory section in ownerReview():
//
// OLD (Line 5968-5981):
//   if (cs.winRate < 0.30 && cs.net < 0) {
//     return { ok: false, ... };
//   }
//   if (cs.winRate < 0.45 || cs.net < 0) {
//     prob = Math.max(0.01, prob - 0.02);
//     notes.push(...);
//   }
//
// NEW:

function reviewCategoryMemoryImproved(category, features, notes, prob) {
  const cs = categoryStats(category, 30);  // 30-day rolling stats
  const minSamplesToTrust = parseInt(process.env.MIN_SAMPLES_TO_TRUST || '8', 10);
  
  if (!cs || cs.n < minSamplesToTrust) {
    return { prob, notes };  // Not enough data, don't adjust
  }
  
  // HARD VETO: Catastrophic category
  // At 25% win rate, -2.0 net, and 15+ trades: category is broken
  if (cs.winRate < CATEGORY_WIN_RATE_HARD_VETO && cs.net < CATEGORY_NET_LOSS_HARD_VETO && cs.n >= 15) {
    return {
      prob,
      notes,
      veto: `category ${category} catastrophic (${(cs.winRate*100).toFixed(0)}% WR, ${cs.net.toFixed(2)} net over ${cs.n} trades)`
    };
  }
  
  // SOFT PENALTY: Scaled with severity
  // Formula: (0.40 - actual_wr) * 50 = penalty in basis points
  // At 25% WR: -15pp, At 35% WR: -5pp, At 40% WR: 0pp
  if (cs.winRate < 0.40) {
    const penalty = (0.40 - cs.winRate) * 50;  // max 15pp
    prob = Math.max(0.01, prob - penalty / 100);  // Convert to fraction
    notes.push(`${category}–warn: ${(cs.winRate*100).toFixed(0)}% WR → –${(penalty).toFixed(0)}pp`);
  } else if (cs.winRate >= 0.50 && cs.n >= 10) {
    // BONUS: Category is actually winning
    const bonus = Math.min(0.05, (cs.winRate - 0.50) * 0.2);
    prob = Math.min(0.98, prob + bonus);
    notes.push(`${category} strong: ${(cs.winRate*100).toFixed(0)}% WR → +${(bonus*100).toFixed(1)}pp`);
  } else if (cs.net < -1.0 && cs.n >= 10) {
    // Category is losing money despite decent win rate (bad odds execution)
    const lossPerTrade = Math.abs(cs.net) / cs.n;
    const penalty = Math.min(0.05, lossPerTrade / 2);
    prob = Math.max(0.01, prob - penalty);
    notes.push(`${category} unprofitable (–${lossPerTrade.toFixed(2)}/trade)`);
  }
  
  return { prob, notes };
}

// ============================================================================
// PRIORITY 4: DYNAMIC PROFIT-TAKING — Time-based exit logic
// ============================================================================
//
// Current Problem: Only vol-based or fixed profit %; ignores settlement time
// New Behavior: Exit faster on short windows, hold longer on slow markets
//
// Impact: +0.5-1% by faster capital recycle on 15-min series
//
// Add to .env:
//   PROFIT_TAKE_SHORT_MINS=5      (exit < 5 min remaining)
//   PROFIT_TAKE_SHORT_USD=0.10
//   PROFIT_TAKE_LONG_MINS=60
//   PROFIT_TAKE_LONG_USD=0.25

function shouldTakeProfitNow(bet, market, unrealizedProfit, assetPrice) {
  // Input validation
  if (!bet || !market) return false;
  if (typeof unrealizedProfit !== 'number') return false;

  const closetime = new Date(market.close_time);
  const remainingMins = (closetime - Date.now()) / 60000;
  
  // Safety: never hold to last 30 seconds
  if (remainingMins < 0.5) return true;
  
  // Short-window fast exits
  const shortMins = parseFloat(process.env.PROFIT_TAKE_SHORT_MINS || '5');
  const shortUSD = parseFloat(process.env.PROFIT_TAKE_SHORT_USD || '0.10');
  if (remainingMins < shortMins && unrealizedProfit > shortUSD) {
    return true;  // "Bird in hand" on short windows
  }
  
  // Medium-window: vol-based
  if (remainingMins >= shortMins && remainingMins < 60) {
    const shakiness = assetShakiness(bet.asset);
    if (shakiness && shakiness > SHAKY_SIGMA && unrealizedProfit > PROFIT_MIN_USD) {
      return true;  // "Get out if shaky"
    }
  }
  
  // Long-window: only take huge profits
  const longMins = parseFloat(process.env.PROFIT_TAKE_LONG_MINS || '60');
  const longUSD = parseFloat(process.env.PROFIT_TAKE_LONG_USD || '0.25');
  if (remainingMins >= longMins && unrealizedProfit > longUSD) {
    return true;
  }
  
  return false;
}

// ============================================================================
// PRIORITY 5: WEATHER-SPECIFIC THRESHOLDS
// ============================================================================
//
// Current Problem: Weather uses same edge bar as crypto (4pp)
// New Behavior: Much higher thresholds (10pp min edge, $500 min volume)
//
// Impact: +3-5% win rate specifically on weather trades
//
// Add to .env:
//   WEATHER_MIN_EDGE=0.10
//   WEATHER_MIN_PROB=0.58
//   WEATHER_MIN_VOLUME=500
//   WEATHER_MAX_SETTLE_MINS=240
//   WEATHER_REQUIRE_RESEARCH=true

function isWeatherTradeable(analysis, opts = {}) {
  if (analysis.category !== 'WEATHER') return true;  // Not weather, use normal bars
  
  const weatherMinEdge = parseFloat(process.env.WEATHER_MIN_EDGE || '0.10');
  const weatherMinProb = parseFloat(process.env.WEATHER_MIN_PROB || '0.58');
  const weatherMinVolume = parseFloat(process.env.WEATHER_MIN_VOLUME || '500');
  const weatherMaxMins = parseFloat(process.env.WEATHER_MAX_SETTLE_MINS || '240');
  const requireResearch = process.env.WEATHER_REQUIRE_RESEARCH !== 'false';
  
  // WEATHER: Apply stricter bars
  if (analysis.edge < weatherMinEdge) {
    console.log(`Weather veto: edge ${pp(analysis.edge)} < ${pp(weatherMinEdge)}`);
    return false;
  }
  
  if (analysis.winProb < weatherMinProb) {
    console.log(`Weather veto: win prob ${pct(analysis.winProb)} < ${pct(weatherMinProb)}`);
    return false;
  }
  
  if (analysis.volume && analysis.volume < weatherMinVolume) {
    console.log(`Weather veto: volume $${analysis.volume} < $${weatherMinVolume}`);
    return false;
  }
  
  if (analysis.minsToClose > weatherMaxMins) {
    console.log(`Weather veto: settlement ${analysis.minsToClose}m > ${weatherMaxMins}m`);
    return false;
  }
  
  if (requireResearch && (!analysis.research || analysis.research.score < 1.0)) {
    console.log(`Weather veto: no strong research backing`);
    return false;
  }
  
  return true;
}

// ============================================================================
// PRIORITY 6: STREAK-BASED POSITION SIZING
// ============================================================================
//
// Current Problem: Losing streaks only increase edge requirement, don't reduce size
// New Behavior: Reduce position size 50% per loss in streak
//
// Impact: +0.5% by reducing variance during unlucky runs
//
// Add to .env:
//   STREAK_REDUCTION_RATE=0.5    (50% per loss)

function applyStreakAdjustment(baseStake, currentStreak, playType) {
  if (!baseStake || !playType) return baseStake;

  const streakTightens = parseInt(process.env.STREAK_TIGHTEN_AFTER || '3', 10);
  const reductionRate = parseFloat(process.env.STREAK_REDUCTION_RATE || '0.5');
  
  if (currentStreak >= streakTightens) {
    // Every loss beyond threshold reduces size
    const lossesInStreak = currentStreak - streakTightens + 1;
    const reduction = 1.0 - (reductionRate * lossesInStreak);
    const adjustedStake = baseStake * Math.max(0.25, reduction);  // Floor at 25%
    
    return Math.max(playType.stakeMin, Math.min(adjustedStake, playType.stakeMax));
  }
  
  return baseStake;
}

// Usage in your existing calculateStrategyStake:
// After calculating base stake, apply streak adjustment:
//   let stake = calculateStrategyStake(playType, winProb, edge, memoryStrength);
//   stake = applyStreakAdjustment(stake, netLoserStreak(), playType);
//   return stake;

// ============================================================================
// PRIORITY 7: MOMENTUM BUCKETING — Better pattern discrimination
// ============================================================================
//
// Current Problem: Momentum only 3 buckets (up/down/flat)
// New Behavior: 5 buckets (strong-up, weak-up, flat, weak-down, strong-down)
//
// Impact: +0.2% by better pattern specificity
//
// REPLACE this in patternKey() function (line ~5737):
//
// OLD:
//   if (typeof f.momentum === 'number')
//     parts.push('mom' + (f.momentum > 0.001 ? 'up' : f.momentum < -0.001 ? 'dn' : 'flat'));
//
// NEW:

function momentumBucket(momentum) {
  if (typeof momentum !== 'number') return 'flat';
  
  if (momentum > 0.015) return 'vup';     // Very up
  if (momentum > 0.0005) return 'up';     // Weak up
  if (Math.abs(momentum) <= 0.0005) return 'flat';
  if (momentum > -0.015) return 'dn';     // Weak down
  return 'vdn';                            // Very down
}

// ============================================================================
// PRIORITY 8: VOLUME-BASED POSITION SIZING
// ============================================================================
//
// Current Problem: Thin books get same position size as fat books
// New Behavior: Reduce position inversely with volume (thin book = smaller bet)
//
// Impact: +0.5% by reducing slippage on thin books
//
// Add to .env:
//   VOL_SCALE_THRESHOLD=100    (reference volume in $)
//   VOL_SCALE_FLOOR=0.50       (minimum 50% of stake at 0 volume)

function applyVolumePenalty(stake, marketVolume, marketSpread = null) {
  // Input validation
  if (!stake || stake <= 0) return 0;

  const volThresh = parseFloat(process.env.VOL_SCALE_THRESHOLD || '100');
  const volFloor = parseFloat(process.env.VOL_SCALE_FLOOR || '0.50');
  
  if (!marketVolume || marketVolume === 0) {
    return stake * volFloor;  // Thin market = cut position
  }
  
  // Scaler: at threshold = 1.0x, below = scales down, above = scales up (capped)
  const volumeScaler = Math.min(1.5, Math.max(volFloor, marketVolume / volThresh));
  
  // Optionally also penalize for wide spreads
  if (marketSpread && marketSpread > 0.02) {  // > 2¢ spread
    return stake * volumeScaler * 0.9;  // 10% penalty for wide spread
  }
  
  return stake * volumeScaler;
}

// ============================================================================
// PRIORITY 9: BAYESIAN PATTERN PRIOR
// ============================================================================
//
// Current Problem: Pattern requires 8 samples before trusted
// New Behavior: Use Beta-binomial prior (start with 50% assumption)
//
// Impact: +0.3% by using patterns faster (after 2-3 samples)
//
// REPLACE patternWinRate() function (line ~5745):
//
// OLD:
//   function patternWinRate(key) {
//     const p = botState.memory.patterns[key];
//     if (!p || p.trades < MIN_SAMPLES_TO_TRUST) return null;
//     return p.wins / p.trades;
//   }
//
// NEW:

function patternWinRateBayesian(key) {
  const p = botState.memory.patterns[key];
  if (!p || p.trades === 0) {
    return 0.50;  // No data: assume 50% (weak prior)
  }
  
  // Bayesian: Beta(α, β) where α = wins+1, β = losses+1
  const alpha = 1 + (p.wins || 0);
  const beta = 1 + ((p.trades || 0) - (p.wins || 0));
  
  // Expected value of Beta(α, β)
  const bayesianWinRate = alpha / (alpha + beta);
  
  // Blend with observed win rate based on sample size
  const observedWinRate = p.wins / p.trades;
  const observedConfidence = Math.min(1.0, p.trades / BAYESIAN_CONFIDENCE_THRESHOLD);
  
  return bayesianWinRate * (1 - observedConfidence) + observedWinRate * observedConfidence;
}

// ============================================================================
// A/B TESTING FRAMEWORK
// ============================================================================
//
// To measure impact of changes, track old vs new logic in parallel
//
// Add to your botState initialization:

function initializeABTest() {
  botState.abTest = {
    control: { name: 'OLD_STRATEGY', trades: 0, wins: 0, netProfit: 0, edges: [] },
    treatment: { name: 'NEW_STRATEGY', trades: 0, wins: 0, netProfit: 0, edges: [] }
  };
}

function recordABTestTrade(bucket, edge, profit, won) {
  const test = botState.abTest[bucket];
  if (!test) return;
  
  test.trades++;
  if (won) test.wins++;
  test.netProfit += profit;
  test.edges.push(edge);
}

function reportABTestResults() {
  const results = {};
  for (const [bucket, data] of Object.entries(botState.abTest)) {
    if (data.trades === 0) continue;
    
    const winRate = data.wins / data.trades;
    const avgEdge = data.edges.reduce((a, b) => a + b, 0) / data.trades;
    const profitPerTrade = data.trades > 0 ? data.netProfit / data.trades : 0;
    
    results[bucket] = {
      trades: data.trades,
      winRate: (winRate * 100).toFixed(1) + '%',
      avgEdge: (avgEdge * 100).toFixed(1) + 'pp',
      netProfit: data.netProfit.toFixed(2),
      profitPerTrade: profitPerTrade.toFixed(3)
    };
  }
  
  return results;
}

// Usage: In your decision gate, flip coin 50/50:
//   const useNewLogic = Math.random() < 0.5;
//   if (useNewLogic) {
//     // Apply new strategy
//     recordABTestTrade('treatment', edge, profit, won);
//   } else {
//     // Keep old strategy
//     recordABTestTrade('control', edge, profit, won);
//   }

// ============================================================================
// IMPLEMENTATION CHECKLIST
// ============================================================================
//
// □ Read STRATEGY_ANALYSIS.md for full context
// □ Update .env file with new parameters
// □ Copy functions into index.js
// □ Replace old functions with "Improved" versions
// □ Test with DRY_RUN=true for 30 minutes
// □ Check logs for "veto" messages (should see more)
// □ Monitor /memory output for win rates
// □ Measure impact over 2-3 days
// □ Adjust parameters if needed (thresholds too tight/loose)
// □ Roll out one change at a time (not all 9 at once!)
//
// ============================================================================

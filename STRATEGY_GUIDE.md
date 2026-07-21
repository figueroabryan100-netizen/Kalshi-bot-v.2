# 🎯 Strategy Improvements — Quick Implementation Guide

## 📋 What You Have

3 files to upgrade your bot's strategy:

1. **STRATEGY_ANALYSIS.md** — Full audit of current strategy + issues
2. **STRATEGY_IMPROVEMENTS.js** — Code implementations (copy-paste ready)
3. **This guide** — How to roll out changes safely

---

## 🚀 What to Implement (Recommended Order)

### Phase 1: Easy Wins (Do First)
These are simple, low-risk changes that immediately improve results.

#### Change 1: Dynamic Underdog Sizing (30 minutes) ⭐⭐⭐
**Current:** UNDERDOG always bets $1.50  
**New:** Scales $0.75 - $2.50 based on edge + volume  
**Impact:** +1-2% win rate

**Steps:**
1. Add to _env:
   ```
   UNDER_STAKE_MIN=0.75
   UNDER_STAKE_MAX=2.50
   UNDER_VOLUME_THRESHOLD=200
   UNDER_EDGE_MULTIPLIER=8
   ```

2. Copy `calculateUnderdogStake()` from STRATEGY_IMPROVEMENTS.js
   
3. Find your existing `calculateStrategyStake()` function (line ~2615)
   
4. Replace this line:
   ```javascript
   // OLD:
   let stake = playType.stakeDefault;  // Always $1.50 for UNDERDOG
   
   // NEW:
   if (playType.type === 'UNDERDOG') {
     stake = calculateUnderdogStake(edge, market.volume, playType.minEdge);
   } else {
     stake = playType.stakeDefault;
   }
   ```

5. Test: `DRY_RUN=true node index.js`
   - Watch for UNDERDOG plays in logs
   - Sizes should vary (not all $1.50)
   - Verify: "edge 0.12pp + vol $500 → stake $2.10"

---

#### Change 2: Require Pattern Memory (5 minutes) ⭐⭐⭐
**Current:** minMemoryBits = 0 (fire untested patterns)  
**New:** minMemoryBits = 1 (only fire patterns you've seen before)  
**Impact:** +2-3% win rate

**Steps:**
1. Change in _env:
   ```
   AUTO_HIT_MIN_MEM=1    (was 0)
   ```

2. That's it! The code already supports this.

3. Test: `DRY_RUN=true node index.js`
   - You'll see fewer "AUTO-FIRE" logs (more conservative)
   - Only patterns with ≥1 prior trade fire

---

#### Change 3: Tighten Weather (20 minutes) ⭐⭐⭐
**Current:** Weather uses same edge bar as crypto (4pp)  
**New:** Weather min edge 10pp + $500 volume + research backing  
**Impact:** +3-5% on weather trades

**Steps:**
1. Add to _env:
   ```
   WEATHER_MIN_EDGE=0.10
   WEATHER_MIN_PROB=0.58
   WEATHER_MIN_VOLUME=500
   WEATHER_MAX_SETTLE_MINS=240
   WEATHER_REQUIRE_RESEARCH=true
   ```

2. Copy `isWeatherTradeable()` from STRATEGY_IMPROVEMENTS.js

3. Find where weather trades are proposed/fired
   - Add: `if (!isWeatherTradeable(analysis)) return null;`

4. Test: `DRY_RUN=true node index.js`
   - Far fewer weather trades (only high-confidence ones)
   - Should see "Weather veto" messages in logs

---

### Phase 2: Medium Complexity (Week 2)
Once Phase 1 is stable, roll these out.

#### Change 4: Tighten Category Veto (20 minutes) ⭐⭐
**Current:** Only -2pp soft penalty; hard veto requires BOTH conditions  
**New:** Scale penalty with severity; easier hard veto  
**Impact:** +1-2% win rate

**Steps:**
1. Copy `reviewCategoryMemoryImproved()` from STRATEGY_IMPROVEMENTS.js

2. Find `ownerReview()` function around line 5931

3. Replace the category memory section (lines 5968-5981):
   ```javascript
   // OLD:
   const cs = categoryStats(cat, 30);
   if (cs && cs.n >= MIN_SAMPLES_TO_TRUST) {
     if (cs.winRate < 0.30 && cs.net < 0) {
       return { ok: false, ... };
     }
     if (cs.winRate < 0.45 || cs.net < 0) {
       prob = Math.max(0.01, prob - 0.02);
       notes.push(...);
     }
   }
   
   // NEW:
   const catReview = reviewCategoryMemoryImproved(cat, features, notes, prob);
   if (catReview.veto) {
     return { ok: false, prob: catReview.prob, note: catReview.veto };
   }
   prob = catReview.prob;
   notes = catReview.notes;
   ```

4. Test: `DRY_RUN=true node index.js`
   - Watch /memory output
   - If a category is losing, penalty should be higher
   - E.g., "CRYPTO 35% WR → -5pp" instead of "-2pp"

---

#### Change 5: Dynamic Profit-Taking (30 minutes) ⭐⭐
**Current:** Only vol-based or fixed profit %  
**New:** Time-based exit (fast on short windows, hold on long)  
**Impact:** +0.5-1% from faster capital recycle

**Steps:**
1. Add to _env:
   ```
   PROFIT_TAKE_SHORT_MINS=5
   PROFIT_TAKE_SHORT_USD=0.10
   PROFIT_TAKE_LONG_MINS=60
   PROFIT_TAKE_LONG_USD=0.25
   ```

2. Copy `shouldTakeProfitNow()` from STRATEGY_IMPROVEMENTS.js

3. Find your existing profit-taking logic (line ~6046)

4. Replace old logic with the new function

5. Test: Monitor trade settlement logs
   - Short-window trades should close faster
   - Check: did you recycle capital more efficiently?

---

### Phase 3: Advanced (Week 3+)
These are harder but add polish.

#### Change 6: Streak-Based Position Sizing (15 minutes)
- Reduce stake 50% per loss in streak
- +0.5% from reduced variance during unlucky runs
- Copy `applyStreakAdjustment()` + call after stake calculation

#### Change 7: Momentum Bucketing (5 minutes)
- Expand from 3 buckets to 5
- +0.2% from better pattern discrimination
- Copy `momentumBucket()` + replace line in `patternKey()`

#### Change 8: Volume-Based Position Sizing (10 minutes)
- Reduce position inversely with volume
- +0.5% from reducing slippage on thin books
- Copy `applyVolumePenalty()` + call before firing trade

#### Change 9: Bayesian Pattern Prior (20 minutes)
- Use Beta-binomial prior instead of requiring 8 samples
- +0.3% from using patterns faster
- Copy `patternWinRateBayesian()` + replace `patternWinRate()`

---

## 📊 Testing Strategy

### Before Going Live
```bash
# Step 1: Run 1 hour in dry mode with Phase 1 changes
DRY_RUN=true node index.js
# Watch logs for "UNDERDOG stake", "Pattern memory check", "Weather veto"

# Step 2: Run 2-3 hours with real trades (small bankroll)
BANKROLL=1.95 node index.js
# Monitor win rates in /memory

# Step 3: Measure impact vs baseline
# Check: /status command
#   Old strategy: X trades, Y% win rate
#   New strategy: X trades, Z% win rate
#   Improvement: (Z - Y)% ← this is your edge gain
```

### Monitor These Metrics
After each change, watch for:
- **Trade frequency** — Should decrease (more filters)
- **Win rate** — Should increase (better selection)
- **Average edge** — Should increase (higher thresholds)
- **Net profit/trade** — Should increase (quality > quantity)

### Example: Good Results
```
Before (7 days):
  200 trades, 52% win rate, $127 net (+0.64/trade)

After Phase 1 (7 days):
  160 trades, 56% win rate, $165 net (+1.03/trade)

Result: -20% volume, +4% win rate, +60% edge = ✅ WIN
```

### Example: Red Flag
```
Before: 200 trades, 52% win rate, $127 net
After: 100 trades, 51% win rate, $89 net

Result: -50% volume, -1% win rate = ❌ BACKTRACK
```

---

## ⚙️ Environment Variables Reference

### Phase 1 Settings
```env
# Underdog Sizing
UNDER_STAKE_MIN=0.75
UNDER_STAKE_MAX=2.50
UNDER_VOLUME_THRESHOLD=200
UNDER_EDGE_MULTIPLIER=8

# Pattern Memory
AUTO_HIT_MIN_MEM=1

# Weather
WEATHER_MIN_EDGE=0.10
WEATHER_MIN_PROB=0.58
WEATHER_MIN_VOLUME=500
WEATHER_MAX_SETTLE_MINS=240
WEATHER_REQUIRE_RESEARCH=true
```

### Phase 2 Settings
```env
# Profit Taking
PROFIT_TAKE_SHORT_MINS=5
PROFIT_TAKE_SHORT_USD=0.10
PROFIT_TAKE_LONG_MINS=60
PROFIT_TAKE_LONG_USD=0.25

# Streak Sizing
STREAK_REDUCTION_RATE=0.5
```

### Phase 3 Settings
```env
# Volume Scaling
VOL_SCALE_THRESHOLD=100
VOL_SCALE_FLOOR=0.50
```

---

## 🔍 Troubleshooting

### "Too many vetoes — barely any trades"
**Problem:** Thresholds too tight  
**Solution:**
- Reduce WEATHER_MIN_EDGE from 0.10 → 0.08
- Reduce UNDER_EDGE_MULTIPLIER from 8 → 5
- Increase UNDER_VOLUME_THRESHOLD from 200 → 500

### "Win rate dropped after changes"
**Problem:** Filters are screening out winners  
**Solution:**
- Review /memory logs for veto reasons
- Count: how many "pattern memory" vetoes? (should be < 30%)
- Revert 1-2 changes, test individually

### "Getting crushed on weather"
**Problem:** Weather still too aggressive  
**Solution:**
- Increase WEATHER_MIN_EDGE from 0.10 → 0.12
- Increase WEATHER_MIN_PROB from 0.58 → 0.60
- Require WEATHER_MIN_VOLUME=750

### "Underdog stakes all still $1.50"
**Problem:** `calculateUnderdogStake()` not being called  
**Solution:**
- Check: is playType.type === 'UNDERDOG'?
- Verify: volume is being passed to function
- Add debug log: `console.log('UNDERDOG stake calc:', edge, volume, result);`

---

## 📈 Expected Results by Phase

| Phase | Changes | Expected Edge | Volatility | Implementation |
|-------|---------|----------------|------------|-----------------|
| 0 | Baseline | - | Baseline | - |
| 1 | Underdog + Memory + Weather | +5-9% | -0% | 1-2 hours |
| 1+2 | +Category veto + Profit-taking | +6-11% | -5% | 5 hours total |
| 1+2+3 | +Streak + Momentum + Volume + Bayes | +7-12% | -10% | 10 hours total |

Note: "Edge" means % win rate improvement, "Volatility" means drawdown reduction.

---

## ✅ Rollout Checklist

- [ ] **Read** STRATEGY_ANALYSIS.md (understand issues)
- [ ] **Phase 1: Easy Wins**
  - [ ] Update _env file with Phase 1 settings
  - [ ] Implement Change 1: Underdog sizing
  - [ ] Implement Change 2: Pattern memory
  - [ ] Implement Change 3: Weather thresholds
  - [ ] Test 1 hour DRY_RUN, verify veto messages
  - [ ] Run 24 hours live, measure win rate
  - [ ] If positive, proceed to Phase 2
  
- [ ] **Phase 2: Medium Changes**
  - [ ] Implement Change 4: Category veto
  - [ ] Implement Change 5: Profit-taking
  - [ ] Test 24 hours, measure improvement
  - [ ] If positive, proceed to Phase 3
  
- [ ] **Phase 3: Polish**
  - [ ] Implement remaining changes one at a time
  - [ ] Test each individually
  - [ ] Measure cumulative impact
  
- [ ] **Optimize**
  - [ ] Fine-tune thresholds based on live results
  - [ ] Disable changes that aren't working
  - [ ] Document your final settings

---

## Questions?

**Q: Should I do all 9 changes at once?**  
A: NO! Do Phase 1 first (3 changes), measure for 2 days, then Phase 2. Each change has different risk.

**Q: What if I don't see +5% edge?**  
A: Normal! +2-3% is realistic. You might be in a bad period. Run 1 week minimum.

**Q: Can I revert a change?**  
A: Yes! Just remove the function calls or revert _env. Test again to confirm it was the culprit.

**Q: How long to measure results?**  
A: 
- 50 trades minimum to see signal
- 100+ trades for statistical confidence
- At current volume: ~3-7 days per phase

---

Good luck! Start with Phase 1 today. 🚀

# 🚀 Kalshi Bot Fix — Quick Start

## The Problem
Your bot **keeps stalling & failing** because:
- API requests hang indefinitely (no timeout wrappers)
- Prices fetched sequentially = 20-40 second waits
- One bad API crashes the entire bot (no circuit breaker)
- Engine locks never release (no watchdog)

## The Solution (Pick One)

### Option 1: AUTOMATIC FIX (Recommended)
```bash
# Download the fixer
wget -O apply_kalshi_fix.js https://... # or copy from provided file

# Run it
node apply_kalshi_fix.js ./index.js

# Start bot
pkill -f "node.*index"
node index.js
```

**What it does:**
✅ Backs up your file  
✅ Injects timeout wrappers  
✅ Parallelizes price APIs  
✅ Adds circuit breaker  
✅ Tests syntax  

---

### Option 2: MANUAL FIX
If you prefer to edit by hand, see `KALSHI_BOT_FIX.md` for the 3 exact changes needed.

---

## Verify It Worked

Watch for these logs after restart:

```
✅ "Bot initialized. Auto-started scanning."
💓 "Heartbeat: healthy | Uptime: 5m | Bal: $X.XX | Scans: 12 | Trades: 2"
🚀 "Price scan complete. Engine will enter when final 5-min windows open."
```

If you see:
```
⚠️ Scan stalled → WATCHDOG: force-releasing
🔧 Circuit breaker OPEN
```

That means the fixes are working — the bot caught a hang and auto-recovered.

---

## Environment Checklist

Make sure your `_env` file has:
```
DRY_RUN=false              ← THIS IS CRITICAL
BANKROLL=1.95
FIXED_BET=0.25
KALSHI_API_KEY=<your-key>
KALSHI_KEY_PATH=./kalshi_key.pem
TELEGRAM_TOKEN=<your-token>
YOUR_TELEGRAM_ID=<your-id>
```

---

## If It Still Stalls

1. **Check which API is slow:**
   ```bash
   node index.js 2>&1 | grep -E "timeout|failed|error"
   ```

2. **Increase Kalshi timeout:**
   - Find: `timeout: 8000` in kalshiRequest
   - Change to: `timeout: 10000`

3. **Disable slow price sources:**
   - Find: `_binanceBlocked = false` at top
   - Temporarily set to `true` to skip Binance

4. **Run in dry mode first:**
   ```bash
   DRY_RUN=true node index.js
   # No real trades, just scanning for 5 min
   ```

---

## Files Provided

- **KALSHI_BOT_FIX.md** — Detailed manual fix guide
- **apply_kalshi_fix.js** — Automatic patcher
- **index.js.fixed** — Example of what fixed code looks like

---

## Deploy

```bash
# 1. Stop old bot
pkill -f "node.*index"

# 2. Apply fix
node apply_kalshi_fix.js ./index.js

# 3. Start fresh
rm -f .bot.pid state.json  # Optional: clear old state
node index.js

# 4. Monitor
# Let it run for 5 minutes
# You should see "Heartbeat: healthy" at least once
```

---

## What Changed

| Before | After |
|--------|-------|
| API calls: no timeout | All calls wrap in `timeoutPromise()` |
| Price fetch: 20-40s sequential | Parallel `Promise.all()` — max 20s |
| Kalshi failure: crashes bot | Circuit breaker + auto-recovery |
| Engine stall: forever hang | Watchdog releases lock after 60s |
| Silent crashes | Health monitor + alerts |

---

## Still Stuck?

1. Share your full error logs:
   ```bash
   node index.js 2>&1 | tee bot.log
   # Run for 2 minutes, stop with Ctrl+C
   # Upload bot.log
   ```

2. Check if kalshi_key.pem exists:
   ```bash
   ls -la kalshi_key.pem
   # Should show the file with your key
   ```

3. Test Kalshi API manually:
   ```bash
   curl -X GET https://external-api.kalshi.com/trade-api/v2/markets
   # Should get JSON response (not 403/401)
   ```

---

Good luck! 🤝

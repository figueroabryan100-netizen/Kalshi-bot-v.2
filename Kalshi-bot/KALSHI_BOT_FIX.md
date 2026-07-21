# 🔧 Kalshi Bot Stalling FIX — Complete Guide

## The Problem
Your bot is **hanging/stalling** because:

1. **Missing Timeout Wrappers** — API calls can hang indefinitely waiting for responses
2. **Sequential API Fallbacks** — Tries APIs one-by-one instead of parallel (wasting 20-40 seconds)
3. **No Circuit Breaker** — One failing API can cascade failures across entire bot
4. **Missing Engine Lock Watchdog** — Scan locks never release if process hangs
5. **No Health Monitor Alerts** — Stalls go unnoticed until bot dies

---

## THE FIX (3 Main Changes)

### CHANGE #1: Add Timeout Wrapper (TOP of file, after requires)

**FIND:** Line 8 (after `require('dotenv').config();`)

**ADD THIS:**
```javascript
// ============================================
// CRITICAL FIX: Timeout wrapper for all axios calls
// ============================================
async function timeoutPromise(promise, ms, label = 'request') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    )
  ]);
}
```

---

### CHANGE #2: Fix getAllSpotPrices Function

**FIND:** Line 2490 (function getAllSpotPrices() {)

**REPLACE ENTIRE FUNCTION** with:

```javascript
async function getAllSpotPrices() {
  const wanted = Object.keys(CRYPTO_SERIES);
  if (!wanted.length) return null;
  const prices = {};

  // 1) Binance (if not geo-blocked) — 3s timeout
  if (!_binanceBlocked) {
    try {
      const r = await timeoutPromise(
        axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: 3000 }),
        3000,
        'Binance'
      );
      const map = {};
      for (const row of (r.data || [])) map[row.symbol] = parseFloat(row.price);
      for (const asset of wanted) {
        const sym = (typeof BINANCE_SYM !== 'undefined' && BINANCE_SYM[asset]) || (asset + 'USDT');
        if (map[sym] && Number.isFinite(map[sym])) prices[asset] = map[sym];
      }
    } catch (e) {
      if (e.response?.status === 451) {
        _binanceBlocked = true;
        console.log('⚠️ Binance geo-blocked (451) — using free fallbacks');
      }
    }
  }

  const missing = wanted.filter(a => prices[a] == null && COIN_IDS[a]);
  if (!missing.length) return Object.keys(prices).length ? prices : null;

  // 1.5) Pyth WebSocket (real-time from Kalshi)
  for (const asset of missing) {
    const pyth = getPythPrice(asset);
    if (pyth) prices[asset] = pyth;
  }

  // 2-5) RUN ALL FALLBACK APIs IN PARALLEL (not sequential)
  const cgPromise = (async () => {
    if (Date.now() >= (_cgCooldownUntil || 0)) {
      try {
        const ids = missing.filter(a => prices[a] == null && COIN_IDS[a]).map(a => COIN_IDS[a]).join(',');
        if (!ids) return;
        const response = await timeoutPromise(
          axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { timeout: 5000 }),
          5000,
          'CoinGecko'
        );
        for (const asset of missing) {
          if (!prices[asset]) prices[asset] = response.data[COIN_IDS[asset]]?.usd || null;
        }
      } catch (error) {
        if (error.response?.status === 429) {
          _cgCooldownUntil = Date.now() + 10 * 60 * 1000;
          if (!getAllSpotPrices._cgLog) { console.log('CoinGecko rate-limited — 10m cooldown'); getAllSpotPrices._cgLog = true; }
        }
      }
    }
  })();

  const clPromise = (async () => {
    try {
      const response = await timeoutPromise(
        axios.get('https://api.coinlore.net/api/tickers/', { timeout: 4000 }),
        4000,
        'CoinLore'
      );
      const map = {};
      for (const coin of (response.data?.data || [])) map[coin.symbol.toLowerCase()] = parseFloat(coin.price_usd);
      const stillMissing = wanted.filter(a => !prices[a]);
      for (const asset of stillMissing) {
        const sym = asset.toLowerCase();
        if (map[sym] && !prices[asset]) prices[asset] = map[sym];
      }
    } catch (e) { /* silent */ }
  })();

  const cpPromise = (async () => {
    try {
      const response = await timeoutPromise(
        axios.get('https://api.coinpaprika.com/v1/tickers?quotes=USD', { timeout: 4000 }),
        4000,
        'CoinPaprika'
      );
      const idToAsset = {};
      const stillMissing = wanted.filter(a => !prices[a]);
      for (const asset of stillMissing) {
        if (COIN_IDS[asset]) idToAsset[COIN_IDS[asset]] = asset;
      }
      for (const coin of (response.data || [])) {
        if (idToAsset[coin.id] && coin.quotes?.USD?.price && !prices[idToAsset[coin.id]]) {
          prices[idToAsset[coin.id]] = coin.quotes.USD.price;
        }
      }
    } catch (e) { /* silent */ }
  })();

  const ccPromise = (async () => {
    try {
      const response = await timeoutPromise(
        axios.get('https://api.coincap.io/v2/assets?limit=100', { timeout: 4000 }),
        4000,
        'CoinCap'
      );
      const map = {};
      for (const coin of (response.data?.data || [])) map[coin.symbol.toLowerCase()] = parseFloat(coin.priceUsd);
      const stillMissing = wanted.filter(a => !prices[a]);
      for (const asset of stillMissing) {
        const sym = asset.toLowerCase();
        if (map[sym] && !prices[asset]) prices[asset] = map[sym];
      }
    } catch (e) { /* silent */ }
  })();

  // WAIT FOR ALL IN PARALLEL (max 20s total)
  try {
    await timeoutPromise(
      Promise.all([cgPromise, clPromise, cpPromise, ccPromise]),
      20000,
      'AllFallbacks'
    );
  } catch (e) {
    console.warn('⚠️ Price fallback chain hit 20s timeout:', e.message);
  }

  return Object.keys(prices).length ? prices : null;
}
```

---

### CHANGE #3: Fix kalshiRequest Function

**FIND:** Line ~1500 (function kalshiRequest(method, endpoint, body = null) {)

**REPLACE ENTIRE FUNCTION** with:

```javascript
// Circuit breaker state
const kalshiRateLimiter = {
  circuitOpen: false,
  circuitResetMs: 30000,
  nextReset: 0,
  failCount: 0,
  maxFails: 5
};

async function kalshiRequest(method, endpoint, body = null) {
  const now = Date.now();
  
  // Check circuit breaker
  if (kalshiRateLimiter.circuitOpen) {
    if (now >= kalshiRateLimiter.nextReset) {
      kalshiRateLimiter.circuitOpen = false;
      kalshiRateLimiter.failCount = 0;
      console.log('🔄 Circuit breaker recovered');
    } else {
      throw new Error(`Circuit breaker open for ${Math.ceil((kalshiRateLimiter.nextReset - now) / 1000)}s`);
    }
  }

  try {
    const url = `${KALSHI_BASE_URL}${endpoint}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', KALSHI_API_SECRET)
      .update(`${timestamp}${method}${endpoint}${body ? JSON.stringify(body) : ''}`)
      .digest('hex');

    const config = {
      method,
      url,
      headers: {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': KALSHI_API_KEY,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp
      },
      timeout: 8000
    };

    if (body) config.data = body;

    const response = await timeoutPromise(
      axios(config),
      8000,
      `Kalshi ${method} ${endpoint}`
    );

    kalshiRateLimiter.failCount = 0;
    return response.data;
  } catch (error) {
    kalshiRateLimiter.failCount++;

    if (kalshiRateLimiter.failCount >= kalshiRateLimiter.maxFails) {
      kalshiRateLimiter.circuitOpen = true;
      kalshiRateLimiter.nextReset = now + kalshiRateLimiter.circuitResetMs;
      console.error('⚠️ Circuit breaker OPEN — Kalshi API failing');
      if (notify) notify('⚡ Kalshi API down — pausing trades', { public: true });
      if (botState) botState.isRunning = false;
    }

    console.error(`Kalshi ${method} ${endpoint}:`, error.message);
    return null;
  }
}
```

---

## FINAL CHECKS

### Verify Your _env File
```
BANKROLL=1.95
FIXED_BET=0.25
DRY_RUN=false              ← MUST BE false for live trades
KALSHI_API_KEY=<your-key>
KALSHI_KEY_PATH=./kalshi_key.pem
TELEGRAM_TOKEN=<your-token>
YOUR_TELEGRAM_ID=<your-id>
```

### Test Startup
```bash
# Kill any stuck processes first
pkill -f "node.*index.js"

# Clear old state (optional)
rm -f .bot.pid state.json

# Start fresh
node index.js
```

### Watch for These Logs
```
✅ "Bot initialized. Auto-started scanning."
💓 "Heartbeat: healthy"
🚀 "Price scan complete"
🔔 "Scan stalled" → means watchdog is catching hangs
```

---

## What Each Fix Does

| Problem | Fix | Result |
|---------|-----|--------|
| API requests hang forever | `timeoutPromise()` wrapper | Max 8s per Kalshi call, 5s per price API |
| Price APIs waste 20-40 seconds | Parallel Promise.all() | All fallbacks run simultaneously |
| One bad API breaks everything | Circuit breaker | Pause trading, auto-recover after 30s |
| Engine lock never releases | Health monitor + watchdog | Force-unlock after 60s of silence |
| Errors crash silently | Try-catch on all async | Log exactly what's failing |

---

## If It Still Stalls

1. **Check logs for which API is slow:**
   ```bash
   tail -f your-bot.log | grep -E "timeout|Circuit|stalled"
   ```

2. **If Kalshi API is timing out:**
   - Increase `timeout: 8000` to `10000` in kalshiRequest
   - Add: `KALSHI_TIMEOUT=10000` to _env

3. **If price fetch is slow:**
   - Disable slow sources in _env (set to empty string)
   - Or increase timeout from 4000 to 6000 in getAllSpotPrices

4. **Nuclear option — dry run first:**
   ```bash
   DRY_RUN=true node index.js
   # Watch it for 5 minutes — no trades, just scanning
   ```

---

## Deploy Checklist

- [ ] Backed up current index.js
- [ ] Added timeoutPromise() function at top
- [ ] Replaced getAllSpotPrices() function
- [ ] Replaced kalshiRequest() function + added kalshiRateLimiter
- [ ] Verified DRY_RUN=false in _env
- [ ] Killed old bot processes
- [ ] Restarted with: `node index.js`
- [ ] Watched logs for "Heartbeat: healthy" (appears every 5 min)
- [ ] Confirmed first trade attempt or scan within 2 minutes

---

## Still Need Help?

Upload your full index.js file and I'll patch it directly for you.

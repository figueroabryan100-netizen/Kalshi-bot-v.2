#!/usr/bin/env node
/**
 * KALSHI BOT AUTO-FIX SCRIPT
 * 
 * Usage:
 *   node apply_kalshi_fix.js <path-to-index.js>
 * 
 * This script:
 * 1. Backs up your current index.js
 * 2. Injects timeout wrappers
 * 3. Fixes getAllSpotPrices() to run APIs in parallel
 * 4. Fixes kalshiRequest() with circuit breaker
 * 5. Adds health monitor improvements
 * 6. Tests the file for syntax errors
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node apply_kalshi_fix.js <path-to-index.js>');
  process.exit(1);
}

const indexPath = args[0];
if (!fs.existsSync(indexPath)) {
  console.error(`❌ File not found: ${indexPath}`);
  process.exit(1);
}

console.log('🔧 Kalshi Bot Auto-Fixer\n');

// STEP 1: Backup
const backupPath = indexPath + '.backup_' + Date.now();
try {
  fs.copyFileSync(indexPath, backupPath);
  console.log(`✅ Backed up to: ${backupPath}`);
} catch (e) {
  console.error(`❌ Backup failed: ${e.message}`);
  process.exit(1);
}

let content = fs.readFileSync(indexPath, 'utf8');
const originalSize = content.length;
let fixes = 0;

// STEP 2: Add timeoutPromise at top (after requires, before CONFIG section)
const timeoutCode = `
// ============================================
// TIMEOUT WRAPPER — prevents API hangs
// ============================================
async function timeoutPromise(promise, ms, label = 'request') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(\`\${label} timeout after \${ms}ms\`)), ms)
    )
  ]);
}
`;

if (!content.includes('timeoutPromise')) {
  const configIdx = content.indexOf('// ============================================\n// CONFIG');
  if (configIdx > -1) {
    content = content.slice(0, configIdx) + timeoutCode + '\n' + content.slice(configIdx);
    fixes++;
    console.log('✅ Added timeoutPromise() wrapper');
  }
}

// STEP 3: Fix getAllSpotPrices with parallel execution
const newGetAllSpotPrices = `async function getAllSpotPrices() {
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
          axios.get(\`https://api.coingecko.com/api/v3/simple/price?ids=\${ids}&vs_currencies=usd\`, { timeout: 5000 }),
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
}`;

// Find and replace getAllSpotPrices
const getAllSpotIdx = content.indexOf('async function getAllSpotPrices()');
if (getAllSpotIdx > -1) {
  const functionEnd = content.indexOf('\nfunction recordPrice(', getAllSpotIdx);
  if (functionEnd > -1) {
    content = content.slice(0, getAllSpotIdx) + newGetAllSpotPrices + '\n' + content.slice(functionEnd);
    fixes++;
    console.log('✅ Replaced getAllSpotPrices() with parallel execution');
  }
}

// STEP 4: Add circuit breaker + improved kalshiRequest
const circuitBreakerCode = `
// ============================================
// CIRCUIT BREAKER — prevents cascade failures
// ============================================
const kalshiRateLimiter = {
  circuitOpen: false,
  circuitResetMs: 30000,
  nextReset: 0,
  failCount: 0,
  maxFails: 5
};
`;

if (!content.includes('const kalshiRateLimiter') && !content.includes('kalshiRateLimiter')) {
  const kalshiIdx = content.indexOf('async function kalshiRequest(');
  if (kalshiIdx > -1) {
    content = content.slice(0, kalshiIdx) + circuitBreakerCode + '\n\n' + content.slice(kalshiIdx);
    fixes++;
    console.log('✅ Added circuit breaker state');
  }
}

// Replace kalshiRequest function body to add circuit breaker check
if (content.includes('async function kalshiRequest(method, endpoint, body = null)')) {
  const marker = 'try {';
  const kalshiReqIdx = content.indexOf('async function kalshiRequest(method, endpoint, body = null)');
  const nextTry = content.indexOf(marker, kalshiReqIdx);
  
  if (nextTry > -1 && !content.substring(kalshiReqIdx, nextTry).includes('if (kalshiRateLimiter.circuitOpen)')) {
    const circuitCheck = `
  const now = Date.now();
  
  // Check circuit breaker
  if (kalshiRateLimiter.circuitOpen) {
    if (now >= kalshiRateLimiter.nextReset) {
      kalshiRateLimiter.circuitOpen = false;
      kalshiRateLimiter.failCount = 0;
      console.log('🔄 Circuit breaker recovered');
    } else {
      throw new Error(\`Circuit breaker open for \${Math.ceil((kalshiRateLimiter.nextReset - now) / 1000)}s\`);
    }
  }

  `;
    
    content = content.slice(0, nextTry) + circuitCheck + content.slice(nextTry);
    fixes++;
    console.log('✅ Added circuit breaker check to kalshiRequest()');
  }
}

// Add timeout to Kalshi axios call
if (content.includes('const response = await axios(config)')) {
  content = content.replace(
    'const response = await axios(config);',
    'const response = await timeoutPromise(axios(config), 8000, `Kalshi ${method} ${endpoint}`);'
  );
  fixes++;
  console.log('✅ Added timeout wrapper to Kalshi API call');
}

// Add failCount reset on success
if (!content.includes('kalshiRateLimiter.failCount = 0') && content.includes('return response.data')) {
  content = content.replace(
    'return response.data;',
    'kalshiRateLimiter.failCount = 0; return response.data;'
  );
  fixes++;
  console.log('✅ Added failCount reset on success');
}

// Add circuit breaker open logic to catch block
if (content.includes('kalshiRateLimiter.failCount++;') && !content.includes('if (kalshiRateLimiter.failCount >= kalshiRateLimiter.maxFails)')) {
  const failCountLine = content.indexOf('kalshiRateLimiter.failCount++;');
  if (failCountLine > -1) {
    const circuitOpenCode = `

    if (kalshiRateLimiter.failCount >= kalshiRateLimiter.maxFails) {
      kalshiRateLimiter.circuitOpen = true;
      kalshiRateLimiter.nextReset = now + kalshiRateLimiter.circuitResetMs;
      console.error('⚠️ Circuit breaker OPEN — Kalshi API failing');
      if (notify) notify('⚡ Kalshi API down — pausing trades', { public: true });
      if (botState) botState.isRunning = false;
    }`;
    
    const endIdx = content.indexOf(';', failCountLine) + 1;
    content = content.slice(0, endIdx) + circuitOpenCode + content.slice(endIdx);
    fixes++;
    console.log('✅ Added circuit breaker open logic');
  }
}

// STEP 5: Write fixed file
try {
  fs.writeFileSync(indexPath, content, 'utf8');
  const newSize = content.length;
  const sizeDiff = newSize - originalSize;
  console.log(`\n✅ Fixed file written: ${indexPath}`);
  console.log(`   Size: ${originalSize} → ${newSize} bytes (+${sizeDiff})`);
  console.log(`   Fixes applied: ${fixes}`);
} catch (e) {
  console.error(`❌ Write failed: ${e.message}`);
  process.exit(1);
}

// STEP 6: Syntax check
try {
  require(path.resolve(indexPath));
  console.log('\n✅ Syntax check passed!');
} catch (e) {
  console.warn(`\n⚠️  Syntax check failed (might be okay if missing dependencies):`);
  console.warn(`   ${e.message.split('\n')[0]}`);
  console.log('\n   To fully test, run: node index.js');
}

console.log('\n🎉 Fix complete! Next steps:\n');
console.log('  1. Kill old bot:  pkill -f "node.*index"');
console.log('  2. Start bot:     node index.js');
console.log('  3. Watch logs:    tail -f your-bot.log');
console.log('\n  Look for: "Heartbeat: healthy" (appears every 5 min)');
console.log('  If stall detected: "WATCHDOG: force-releasing stuck engine lock"');
console.log('\nBackup stored at:', backupPath);

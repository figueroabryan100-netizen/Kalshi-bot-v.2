require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

// ============================================
// CONFIG
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const KALSHI_API_KEY = process.env.KALSHI_API_KEY;
const YOUR_TELEGRAM_ID = process.env.YOUR_TELEGRAM_ID;
const KALSHI_BASE_URL = 'https://external-api.kalshi.com/trade-api/v2';

// Private key is read from its own .pem file rather than the .env file.
// Multi-line PEM keys are unreliable inside .env files (line breaks get
// mangled), so this avoids that entirely.
const KALSHI_KEY_PATH = process.env.KALSHI_KEY_PATH || './kalshi_key.pem';
let KALSHI_API_SECRET = null;
try {
  let rawKey = fs.readFileSync(KALSHI_KEY_PATH, 'utf8');
  // Strip a UTF-8 BOM if present (common when saved from Notepad) — this
  // invisible character breaks PEM parsing with a cryptic "unsupported" error.
  if (rawKey.charCodeAt(0) === 0xFEFF) {
    rawKey = rawKey.slice(1);
  }
  KALSHI_API_SECRET = rawKey.trim() + '\n';
} catch (err) {
  console.error(`❌ Could not read private key file at ${KALSHI_KEY_PATH}. Make sure kalshi_key.pem exists in this folder.`);
}

if (!TELEGRAM_TOKEN || !KALSHI_API_KEY || !KALSHI_API_SECRET || !YOUR_TELEGRAM_ID) {
  console.error('❌ Missing required environment variables. Check TELEGRAM_TOKEN, KALSHI_API_KEY, kalshi_key.pem file, YOUR_TELEGRAM_ID');
  process.exit(1);
}

// ============================================
// BANKROLL & RISK MANAGEMENT
// ============================================
// This is the MOST important setting. Change this to match your actual
// Kalshi account balance. The bot NEVER risks more than a fraction of this
// per trade (Kelly Criterion).
const BANKROLL = parseFloat(process.env.BANKROLL || '50'); // Set your real balance here

const RISK_RULES = {
  maxPerTradePercent: 0.05,      // Never risk more than 5% of bankroll on one trade
  kellyFraction: 0.4,            // Use 40% of full Kelly (fractional Kelly - reduces variance a lot)
  minConfidenceToTrade: 0.55     // Only trade if our estimated probability edge clears this bar
  // NOTE: dailyLossLimit and maxConcurrentBets removed per request —
  // the bot now fires off offers as it sees fit with no daily or count cap.
};

// Optional anti-spam guard. With no per-asset dedup, the 30s scanner would
// otherwise re-propose the exact same live signal every cycle and flood
// Telegram. Set REPROPOSE_COOLDOWN_MIN in your .env to the minimum minutes
// between re-proposing the SAME asset/market. Defaults to 0 = fully free,
// no cooldown (fires every time it sees a signal).
const REPROPOSE_COOLDOWN_MIN = parseFloat(process.env.REPROPOSE_COOLDOWN_MIN || '0');
const lastProposalAt = {};
function withinCooldown(key) {
  if (REPROPOSE_COOLDOWN_MIN <= 0) return false;
  const last = lastProposalAt[key];
  if (!last) return false;
  return (Date.now() - last) < REPROPOSE_COOLDOWN_MIN * 60 * 1000;
}
function markProposed(key) { lastProposalAt[key] = Date.now(); }

// ============================================
// ASSET-SPECIFIC THRESHOLDS (from volatility research)
// ============================================
const THRESHOLDS = {
  BTC:  { buyDrop: 0.18, sellGain: 0.70, stopLoss: 1.0, name: 'Bitcoin' },
  ETH:  { buyDrop: 0.20, sellGain: 0.75, stopLoss: 1.0, name: 'Ethereum' },
  SOL:  { buyDrop: 0.28, sellGain: 1.10, stopLoss: 1.2, name: 'Solana' },
  DOGE: { buyDrop: 0.35, sellGain: 1.40, stopLoss: 1.5, name: 'Dogecoin' }
};

// ============================================
// WEATHER CONFIG — multiple cities, cross-verified series tickers only
// ============================================
// Each series ticker below was confirmed against at least one independent
// source (Kalshi's own docs, live market URLs, or third-party projects)
// before being added — the crypto ticker debugging earlier showed guessing
// these is unreliable, so this list stays deliberately conservative.
// Use /find_weather_city [CODE] to safely verify a new city before adding it here.
const WEATHER_CITIES = {
  DAL: {
    name: 'Dallas',
    kalshiSeriesTicker: 'KXHIGHTDAL', // Dallas is a naming exception — has a "T" the others don't
    lat: 32.8998, lon: -97.0403 // DFW airport
  },
  NYC: {
    name: 'New York City',
    kalshiSeriesTicker: 'KXHIGHNY',
    lat: 40.7812, lon: -73.9665 // Central Park station
  },
  CHI: {
    name: 'Chicago',
    kalshiSeriesTicker: 'KXHIGHCHI',
    lat: 41.7868, lon: -87.7522 // Midway airport
  },
  MIA: {
    name: 'Miami',
    kalshiSeriesTicker: 'KXHIGHMIA',
    lat: 25.7959, lon: -80.2870 // Miami airport
  },
  LAX: {
    name: 'Los Angeles',
    kalshiSeriesTicker: 'KXHIGHLAX',
    lat: 33.9425, lon: -118.4081 // LAX airport
  },
  DEN: {
    name: 'Denver',
    kalshiSeriesTicker: 'KXHIGHDEN',
    lat: 39.8561, lon: -104.6737 // Denver airport
  }
};

const WEATHER_SETTINGS = {
  // NWS day-1 high forecasts are accurate to within ~3-4°F about 80% of the time.
  // We use this as the standard deviation for a normal-distribution probability model.
  forecastStdDevF: 3.5,
  minEdgeToTrade: 0.05 // only propose if model probability differs from market price by 5+ percentage points
};

// ============================================
// STATE
// ============================================
let botState = {
  isRunning: false,
  prices: { BTC: null, ETH: null, SOL: null, DOGE: null },
  priceHistory: { BTC: [], ETH: [], SOL: [], DOGE: [] },
  openBets: [],
  pendingBets: [],
  closedBets: [],
  stats: { totalBets: 0, wins: 0, losses: 0, totalProfit: 0 },
  settlementHistory: [] // { time, result: 'win'|'loss', profit, cumulativeProfit, asset }
};

const STATE_FILE = './kalshi_state.json';

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState, null, 2));
  } catch (err) {
    console.error('Error saving state:', err.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      botState = { ...botState, ...JSON.parse(data) };
    }
  } catch (err) {
    console.log('Starting fresh state');
  }
}

// ============================================
// TELEGRAM BOT
// ============================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function notify(message) {
  bot.sendMessage(YOUR_TELEGRAM_ID, message).catch(err => {
    console.error('Telegram send error:', err.message);
  });
}

bot.onText(/\/start$/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '🤖 Kalshi Trading Bot\n\n' +
    `Bankroll (set): $${BANKROLL.toFixed(2)}\n` +
    `Max per trade: ${(RISK_RULES.maxPerTradePercent * 100).toFixed(0)}% ($${(BANKROLL * RISK_RULES.maxPerTradePercent).toFixed(2)})\n` +
    `Mode: ${DRY_RUN ? '🧪 DRY RUN (no real orders)' : '🔴 LIVE (real money)'}\n\n` +
    'The bot scans, sizes, and scores opportunities automatically and fires ' +
    'off offers as it sees fit (no daily or concurrency cap) — but still ' +
    'waits for your approval before placing any trade.\n\n' +
    'Commands:\n' +
    '/start_bot - Begin scanning\n' +
    '/stop_bot - Pause immediately\n' +
    '/check_now - Force an immediate scan (don\'t wait 30s)\n' +
    '/gomakemoney - Search crypto + weather right now, propose the single best play\n' +
    '/buy [ASSET] [amount] - Manually buy right now on your own call, e.g. /buy BTC 5\n' +
    '/find_market [ASSET] - Verify live Kalshi market lookup works\n' +
    '/find_weather [CITY] - Verify NWS + Kalshi lookup (city optional, e.g. NYC — checks all cities if omitted)\n' +
    '/status - Current prices & open positions\n' +
    '/stats - Performance summary\n' +
    '/pending - List all pending (awaiting-approval) trades\n' +
    '/chart - Visual chart of your trading progress\n' +
    '/check_settlements - Manually check if open positions have resolved\n' +
    '/discover_sports [NBA|WNBA|NHL|MLB] - Find real Kalshi sports series tickers\n' +
    '/approve [id] - Approve a pending trade\n' +
    '/deny [id] - Reject a pending trade\n'
  );
});

bot.onText(/\/start_bot/, (msg) => {
  if (botState.isRunning) {
    bot.sendMessage(msg.chat.id, '⚠️ Already running!');
    return;
  }
  botState.isRunning = true;
  saveState();
  bot.sendMessage(msg.chat.id,
    `🟢 Bot started — scanning mode.\n\n` +
    `Bankroll: $${BANKROLL}, max $${(BANKROLL * RISK_RULES.maxPerTradePercent).toFixed(2)}/trade.\n` +
    `When confidence ≥ ${(RISK_RULES.minConfidenceToTrade * 100).toFixed(0)}%, I'll send you the opportunity ` +
    `with full analysis. Reply /approve [id] or /deny [id] — nothing executes without your say-so.`
  );
});

bot.onText(/\/check_now/, async (msg) => {
  bot.sendMessage(msg.chat.id, '🔍 Scanning all assets now...');
  await checkAndScan();
  bot.sendMessage(msg.chat.id, '✅ Scan complete. If nothing was flagged, no asset met the confidence threshold right now.');
});

bot.onText(/\/gomakemoney/, async (msg) => {
  bot.sendMessage(msg.chat.id, '🔎 Searching crypto (15-min) and weather markets for the single best play right now...');

  const candidates = [];

  // --- Crypto candidates ---
  const prices = await getAllSpotPrices();
  if (prices) {
    for (const asset of Object.keys(THRESHOLDS)) {
      const price = prices[asset];
      if (!price) continue;
      botState.prices[asset] = price;
      botState.priceHistory[asset].push({ time: Date.now(), price });
      if (botState.priceHistory[asset].length > 100) botState.priceHistory[asset].shift();

      const analysis = analyzeAsset(asset, price);
      if (!analysis || !analysis.buySignal) continue;

      candidates.push({
        kind: 'crypto',
        asset,
        analysis,
        score: analysis.estimatedWinProbability - 0.5 // edge over a coinflip, comparable to weather's edge
      });
    }
  }

  // --- Weather candidates ---
  try {
    const weatherOpps = await scanWeatherEdge();
    for (const opp of weatherOpps) {
      candidates.push({
        kind: 'weather',
        opportunity: opp,
        score: Math.abs(opp.edge)
      });
    }
  } catch (err) {
    console.error('gomakemoney weather scan error:', err.message);
  }

  if (candidates.length === 0) {
    const hasHistory = Object.values(botState.priceHistory).some(h => h.length >= 5);
    bot.sendMessage(msg.chat.id,
      `📭 Nothing worth proposing right now — no crypto asset has a live buy signal, ` +
      `and no weather bracket clears the edge threshold. This is normal; not every moment has a good play.\n\n` +
      (hasHistory ? '' : `Note: crypto needs a couple minutes of /start_bot running first to build enough price history to detect a signal — if you just started, that's likely why.\n\n`) +
      `Try again in a few minutes, or the scanners will surface something automatically when the numbers line up.`
    );
    return;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (best.kind === 'crypto') {
    bot.sendMessage(msg.chat.id, `🏆 Best play found: ${THRESHOLDS[best.asset].name} (quick 15-min turnaround)`);
    await proposeTrade(best.asset, best.analysis);
  } else {
    bot.sendMessage(msg.chat.id, `🏆 Best play found: ${best.opportunity.cityName} weather (settles next day, not a quick flip)`);
    await proposeWeatherTrade(best.opportunity);
  }
});

bot.onText(/\/buy (BTC|ETH|SOL|DOGE)(?:\s+([\d.]+))?/i, async (msg, match) => {
  const asset = match[1].toUpperCase();
  const customAmount = match[2] ? parseFloat(match[2]) : null;
  const price = botState.prices[asset];

  if (!price) {
    bot.sendMessage(msg.chat.id, `❌ No current price data for ${asset} yet. Run /start_bot first and wait a few seconds.`);
    return;
  }

  const amount = customAmount || (BANKROLL * RISK_RULES.maxPerTradePercent);
  const capped = Math.min(amount, BANKROLL * RISK_RULES.maxPerTradePercent);

  if (customAmount && customAmount > capped) {
    bot.sendMessage(msg.chat.id,
      `⚠️ $${customAmount} exceeds your max-per-trade limit ($${capped.toFixed(2)}). Using $${capped.toFixed(2)} instead.`
    );
  }

  bot.sendMessage(msg.chat.id, `⏳ Looking up live ${asset} market and placing order...`);

  reservedExposure += capped;
  let orderResult;
  try {
    orderResult = await placeKalshiOrder(asset, 'yes', capped);
  } finally {
    reservedExposure -= capped;
  }

  if (!orderResult.success) {
    bot.sendMessage(msg.chat.id, `❌ Order failed: ${orderResult.reason}`);
    return;
  }

  const bet = {
    id: Date.now(),
    asset,
    entryPrice: price,
    amount: capped,
    manual: true,
    ticker: orderResult.ticker,
    contractCount: orderResult.contractCount,
    side: 'yes', // /buy always buys YES currently
    timestamp: Date.now(),
    status: 'open'
  };
  if (!orderResult.dryRun) {
    botState.openBets.push(bet);
    botState.stats.totalBets++;
  }
  saveState();

  if (orderResult.dryRun) {
    console.log('Dry-run order body that WOULD be sent:', JSON.stringify(orderResult.orderBodyPreview, null, 2));
    bot.sendMessage(msg.chat.id,
      `🧪 DRY RUN — no real order sent\n\n` +
      `Would buy: ${orderResult.contractCount} contracts on ${orderResult.ticker}\n` +
      `Est. cost: $${capped.toFixed(2)} (${orderResult.priceInCents}¢/contract)\n` +
      `Order body logged to console for review.\n\n` +
      `To place real orders, set DRY RUN to false in your .env file.`
    );
  } else {
    bot.sendMessage(msg.chat.id,
      `✅ REAL ORDER PLACED\n\n` +
      `Market: ${orderResult.ticker}\n` +
      `Contracts: ${orderResult.contractCount}\n` +
      `Cost: ~$${capped.toFixed(2)}\n` +
      `Bet ID: ${bet.id}`
    );
  }
});

bot.onText(/\/find_market (BTC|ETH|SOL|DOGE)/i, async (msg, match) => {
  const asset = match[1].toUpperCase();
  bot.sendMessage(msg.chat.id, `🔍 Looking up live Kalshi market for ${asset}...`);
  const market = await findLiveMarketTicker(asset);
  if (!market) {
    bot.sendMessage(msg.chat.id,
      `❌ No market found. This could mean:\n` +
      `1. The series ticker guess is wrong for ${asset}\n` +
      `2. No 15-min market is currently open for this asset\n` +
      `3. API auth failed — check console for error details\n\n` +
      `Check console output on your desktop for the exact error.`
    );
    return;
  }
  const hoursToClose = ((new Date(market.close_time) - new Date()) / (1000 * 60 * 60)).toFixed(1);
  bot.sendMessage(msg.chat.id,
    `✅ Found market:\n\n` +
    `Ticker: ${market.ticker}\n` +
    `Title: ${market.title}\n` +
    `Closes in: ${hoursToClose} hours\n` +
    `Yes ask: $${market.yes_ask_dollars}\n` +
    `No ask: $${market.no_ask_dollars}\n\n` +
    `${parseFloat(hoursToClose) > 1 ? '⚠️ This is NOT a 15-min market — it closes in ' + hoursToClose + ' hours. Your bot\'s short-term thresholds may not fit this contract type.' : ''}`
  );
  console.log('Full market object:', JSON.stringify(market, null, 2));
});

bot.onText(/\/discover_sports(?:\s+(\w+))?/i, async (msg, match) => {
  const filter = match[1] ? match[1].toUpperCase() : null;
  bot.sendMessage(msg.chat.id, `🔍 Asking Kalshi directly for its sports series (this avoids guessing tickers)...`);

  // Try the Sports category first; if nothing comes back, fall back to
  // fetching all series and filtering client-side by title text.
  let data = await kalshiRequest('GET', `/series?category=Sports`);
  if (!data || !data.series || data.series.length === 0) {
    data = await kalshiRequest('GET', `/series`);
  }

  if (!data || !data.series) {
    bot.sendMessage(msg.chat.id, `❌ Could not fetch series list. Check console for the error.`);
    return;
  }

  const keywords = {
    NBA: ['nba', 'basketball'],
    WNBA: ['wnba'],
    NHL: ['nhl', 'hockey'],
    MLB: ['mlb', 'baseball']
  };
  const wantedSports = filter && keywords[filter] ? { [filter]: keywords[filter] } : keywords;

  let text = `📋 Found ${data.series.length} total series. Matches:\n\n`;
  let anyMatch = false;

  for (const [sport, terms] of Object.entries(wantedSports)) {
    const matches = data.series.filter(s =>
      terms.some(term => s.title.toLowerCase().includes(term) || s.ticker.toLowerCase().includes(term))
    );
    if (matches.length > 0) {
      anyMatch = true;
      text += `${sport}:\n`;
      for (const m of matches.slice(0, 5)) {
        text += `  ${m.ticker} — ${m.title} (${m.frequency})\n`;
      }
      text += '\n';
    } else {
      text += `${sport}: no matches found\n\n`;
    }
  }

  if (!anyMatch) {
    text += `\nNo sports series matched at all — this could mean single-game moneylines aren't in the general series list, or use a different category name. Check console for raw series list sample.`;
    console.log('Sample of series returned:', JSON.stringify(data.series.slice(0, 10), null, 2));
  }

  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/find_weather(?:\s+([A-Za-z]{3}))?/, async (msg, match) => {
  const requestedCode = match[1] ? match[1].toUpperCase() : null;

  if (requestedCode && !WEATHER_CITIES[requestedCode]) {
    bot.sendMessage(msg.chat.id,
      `❌ Unknown city code "${requestedCode}". Configured cities: ${Object.keys(WEATHER_CITIES).join(', ')}`
    );
    return;
  }

  const codesToCheck = requestedCode ? [requestedCode] : Object.keys(WEATHER_CITIES);
  bot.sendMessage(msg.chat.id, `🌤️ Checking ${codesToCheck.length} city/cities: ${codesToCheck.join(', ')}...`);

  for (const code of codesToCheck) {
    const city = WEATHER_CITIES[code];
    const forecast = await getNWSForecastHighF(city.lat, city.lon);
    if (!forecast) {
      bot.sendMessage(msg.chat.id, `❌ ${city.name} (${code}): Could not fetch NWS forecast. Check console.`);
      continue;
    }

    const markets = await findWeatherMarkets(city.kalshiSeriesTicker);
    if (!markets) {
      bot.sendMessage(msg.chat.id,
        `❌ ${city.name} (${code}): No Kalshi markets found for series ${city.kalshiSeriesTicker}. ` +
        `Ticker may be wrong, or there's no open market right now. Check console for the raw error.`
      );
      continue;
    }

    let text = `🌡️ ${city.name}: NWS forecast ${forecast.tempF}°F (${forecast.name})\n`;
    text += `Found ${markets.length} open bracket(s):\n`;
    for (const m of markets.slice(0, 6)) {
      const modelProb = modelProbabilityAboveThreshold(forecast.tempF, m.floor_strike);
      const marketPrice = parseFloat(m.yes_ask_dollars);
      const edge = (modelProb - marketPrice) * 100;
      text += `  Strike ${m.floor_strike}°F: market ${(marketPrice*100).toFixed(0)}¢ vs model ${(modelProb*100).toFixed(0)}% (edge: ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pp)\n`;
    }
    bot.sendMessage(msg.chat.id, text);
    console.log(`Weather markets [${code}]:`, JSON.stringify(markets.slice(0, 3), null, 2));
  }
});

bot.onText(/\/pending/, (msg) => {
  if (botState.pendingBets.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 No pending trades awaiting approval right now.');
    return;
  }

  let text = `📋 ${botState.pendingBets.length} pending trade(s) awaiting approval:\n\n`;
  for (const p of botState.pendingBets) {
    if (p.type === 'weather') {
      const o = p.opportunity || {};
      text += `🌤️ #${p.id} — ${o.cityName || 'Weather'} ${p.ticker}\n` +
        `   Side ${p.side.toUpperCase()}, size $${p.betAmount.toFixed(2)}\n`;
    } else {
      text += `📈 #${p.id} — ${THRESHOLDS[p.asset] ? THRESHOLDS[p.asset].name : p.asset}\n` +
        `   Drop ${p.analysis.dropPercent.toFixed(2)}%, win prob ${(p.analysis.estimatedWinProbability * 100).toFixed(0)}%, size $${p.betAmount.toFixed(2)}\n`;
    }
    text += `   /approve ${p.id}  |  /deny ${p.id}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/approve (\d+)/, async (msg, match) => {
  const betId = parseInt(match[1]);
  const pending = botState.pendingBets.find(b => b.id === betId);
  if (!pending) {
    bot.sendMessage(msg.chat.id, '❌ No pending trade with that ID.');
    return;
  }
  botState.pendingBets = botState.pendingBets.filter(b => b.id !== betId);
  saveState();

  if (pending.type === 'weather') {
    bot.sendMessage(msg.chat.id, `✅ Approved. Placing weather trade...`);
    await executeWeatherTrade(pending);
  } else {
    bot.sendMessage(msg.chat.id, `✅ Approved. Placing trade on ${pending.asset}...`);
    await executeTrade(pending.asset, pending.analysis, pending.betAmount);
  }
});

bot.onText(/\/deny (\d+)/, (msg, match) => {
  const betId = parseInt(match[1]);
  const existed = botState.pendingBets.some(b => b.id === betId);
  botState.pendingBets = botState.pendingBets.filter(b => b.id !== betId);
  saveState();
  bot.sendMessage(msg.chat.id, existed ? '❌ Trade rejected.' : '❌ No pending trade with that ID.');
});

bot.onText(/\/stop_bot/, (msg) => {
  botState.isRunning = false;
  saveState();
  bot.sendMessage(msg.chat.id, '⛔ Bot stopped. No new trades will be placed.');
});

bot.onText(/\/setbankroll (.+)/, (msg, match) => {
  const amount = parseFloat(match[1]);
  if (isNaN(amount) || amount <= 0) {
    bot.sendMessage(msg.chat.id, '❌ Invalid amount. Usage: /setbankroll 50');
    return;
  }
  bot.sendMessage(msg.chat.id,
    `⚠️ Bankroll is set via environment variable BANKROLL, not this command.\n` +
    `To change it: update BANKROLL=${amount} in your environment and restart the bot.\n` +
    `Current bankroll: $${BANKROLL}`
  );
});

bot.onText(/\/status/, (msg) => {
  const status = botState.isRunning ? '🟢 RUNNING' : '🔴 STOPPED';
  const exposure = botState.openBets.reduce((sum, b) => sum + b.amount, 0);

  let text = `${status}\n\n📊 Current Prices:\n`;
  text += `BTC: $${botState.prices.BTC?.toFixed(2) || 'N/A'}\n`;
  text += `ETH: $${botState.prices.ETH?.toFixed(2) || 'N/A'}\n`;
  text += `SOL: $${botState.prices.SOL?.toFixed(2) || 'N/A'}\n`;
  text += `DOGE: $${botState.prices.DOGE?.toFixed(4) || 'N/A'}\n\n`;
  text += `📋 Open Positions: ${botState.openBets.length} (no cap)\n`;
  text += `📨 Pending Approval: ${botState.pendingBets.length}\n`;
  text += `💰 Current Exposure: $${exposure.toFixed(2)} (no cap set)`;
  text += reservedExposure > 0 ? ` (+ $${reservedExposure.toFixed(2)} in-flight)\n` : '\n';

  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/stats/, (msg) => {
  const winRate = botState.stats.totalBets > 0
    ? ((botState.stats.wins / botState.stats.totalBets) * 100).toFixed(1)
    : '0.0';

  bot.sendMessage(msg.chat.id,
    `💰 Performance Summary\n\n` +
    `Total Bets: ${botState.stats.totalBets}\n` +
    `Wins: ${botState.stats.wins}\n` +
    `Losses: ${botState.stats.losses}\n` +
    `Win Rate: ${winRate}%\n` +
    `Total P&L: $${botState.stats.totalProfit.toFixed(2)}\n\n` +
    `(${botState.openBets.length} still open, not yet settled)`
  );
});

bot.onText(/\/check_settlements/, async (msg) => {
  bot.sendMessage(msg.chat.id, `🔍 Checking ${botState.openBets.length} open position(s) for settlement...`);
  const beforeCount = botState.settlementHistory.length;
  await checkAllSettlements();
  const newlySettled = botState.settlementHistory.length - beforeCount;
  bot.sendMessage(msg.chat.id, newlySettled > 0
    ? `✅ ${newlySettled} position(s) settled — see the results above.`
    : `📭 Nothing settled yet. ${botState.openBets.length} still open.`
  );
});

bot.onText(/\/chart/, async (msg) => {
  if (botState.settlementHistory.length === 0) {
    bot.sendMessage(msg.chat.id,
      `📭 No settled trades yet, so there's nothing to chart. ` +
      `Once positions resolve (win or lose), they'll show up here. ` +
      `Try /check_settlements to check if any are ready.`
    );
    return;
  }

  // Build a simple line chart of cumulative P&L over time using QuickChart.io —
  // free, no API key, just a URL that returns a PNG image.
  const labels = botState.settlementHistory.map((_, i) => `#${i + 1}`);
  const data = botState.settlementHistory.map(h => h.cumulativeProfit.toFixed(2));

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative P&L ($)',
        data,
        borderColor: 'rgb(75, 192, 100)',
        fill: false
      }]
    },
    options: {
      title: { display: true, text: 'Trading Progress' }
    }
  };

  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

  const winRate = botState.stats.totalBets > 0
    ? ((botState.stats.wins / (botState.stats.wins + botState.stats.losses)) * 100).toFixed(1)
    : '0.0';

  try {
    await bot.sendPhoto(msg.chat.id, chartUrl, {
      caption: `📈 ${botState.stats.wins}W / ${botState.stats.losses}L (${winRate}%) — Total P&L: $${botState.stats.totalProfit.toFixed(2)}`
    });
  } catch (err) {
    console.error('Chart send failed:', err.message);
    bot.sendMessage(msg.chat.id, `❌ Could not generate chart image. Check console for the error.`);
  }
});

// ============================================
// KALSHI API AUTH (RSA-PSS signing)
// ============================================
// Kalshi signs requests using your RSA private key with PSS padding,
// NOT a simple HMAC secret. KALSHI_API_SECRET must be your full private
// key (the -----BEGIN RSA PRIVATE KEY----- block).
function signKalshiRequest(method, path, timestamp) {
  const message = timestamp + method + path;
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: KALSHI_API_SECRET,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  });
  return signature.toString('base64');
}

async function kalshiRequest(method, path, body = null) {
  const timestamp = Date.now().toString();
  // Kalshi requires the SIGNED path to include the /trade-api/v2 prefix,
  // even though KALSHI_BASE_URL already has it baked into the actual request URL.
  const signedPath = '/trade-api/v2' + path;
  let signature;
  try {
    signature = signKalshiRequest(method, signedPath, timestamp);
  } catch (err) {
    console.error('Kalshi signing failed — check that KALSHI_API_SECRET is your full private key:', err.message);
    return null;
  }

  const headers = {
    'KALSHI-ACCESS-KEY': KALSHI_API_KEY,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'Content-Type': 'application/json'
  };

  try {
    const response = await axios({
      method,
      url: `${KALSHI_BASE_URL}${path}`,
      headers,
      data: body
    });
    return response.data;
  } catch (error) {
    console.error(`Kalshi API error (${path}):`, error.response?.data || error.message);
    return null;
  }
}

// DRY_RUN defaults to true — real orders only fire if you explicitly set
// DRY_RUN=false in your .env file. This is intentional friction.
const DRY_RUN = process.env.DRY_RUN !== 'false';

// Looks up the live 15-min market ticker for an asset right before placing
// an order, since these tickers rotate every 15 minutes.
async function findLiveMarketTicker(asset) {
  const seriesMap = {
    BTC: 'KXBTC15M',
    ETH: 'KXETH15M',
    SOL: 'KXSOL15M',
    DOGE: 'KXDOGE15M'
  };
  const seriesTicker = seriesMap[asset];
  if (!seriesTicker) return null;

  const data = await kalshiRequest('GET', `/markets?series_ticker=${seriesTicker}&status=open&limit=5`);
  if (!data || !data.markets || data.markets.length === 0) {
    return null;
  }
  // Return the soonest-closing open market (the current 15-min window)
  const sorted = data.markets.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
  return sorted[0];
}

// ============================================
// WEATHER MODULE (daily high temperature)
// ============================================

// NWS's public API is free, no key required. Two-step: get the forecast
// office/gridpoint for our coordinates, then fetch the actual forecast.
async function getNWSForecastHighF(lat, lon) {
  try {
    const pointRes = await axios.get(`https://api.weather.gov/points/${lat},${lon}`, {
      headers: { 'User-Agent': '(kalshi-weather-bot, contact-not-provided)' }
    });
    const forecastUrl = pointRes.data.properties.forecast;

    const forecastRes = await axios.get(forecastUrl, {
      headers: { 'User-Agent': '(kalshi-weather-bot, contact-not-provided)' }
    });
    const periods = forecastRes.data.properties.periods;
    // Find today's daytime period (isDaytime true, first one)
    const todayHigh = periods.find(p => p.isDaytime);
    if (!todayHigh) return null;
    return { tempF: todayHigh.temperature, name: todayHigh.name, detailedForecast: todayHigh.detailedForecast };
  } catch (error) {
    console.error('NWS forecast fetch failed:', error.message);
    return null;
  }
}

// Standard normal CDF approximation (Abramowitz & Stegun) — no external stats library needed.
function normalCDF(x, mean, stdDev) {
  const z = (x - mean) / (stdDev * Math.sqrt(2));
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

// Probability that actual high temp is >= threshold, given our forecast + uncertainty
function modelProbabilityAboveThreshold(forecastHighF, thresholdF) {
  return 1 - normalCDF(thresholdF, forecastHighF, WEATHER_SETTINGS.forecastStdDevF);
}

async function findWeatherMarkets(seriesTicker) {
  const data = await kalshiRequest('GET', `/markets?series_ticker=${seriesTicker}&status=open&limit=20`);
  if (!data || !data.markets || data.markets.length === 0) {
    return null;
  }
  return data.markets;
}

async function scanWeatherEdgeForCity(cityCode) {
  const city = WEATHER_CITIES[cityCode];
  if (!city) return [];

  const forecast = await getNWSForecastHighF(city.lat, city.lon);
  if (!forecast) return [];

  const markets = await findWeatherMarkets(city.kalshiSeriesTicker);
  if (!markets) return [];

  const opportunities = [];
  for (const market of markets) {
    // Kalshi temperature brackets use floor_strike as the threshold (e.g. "above 85°F")
    if (market.floor_strike === undefined || market.floor_strike === null) continue;

    const modelProb = modelProbabilityAboveThreshold(forecast.tempF, market.floor_strike);
    const marketYesPrice = parseFloat(market.yes_ask_dollars);
    if (isNaN(marketYesPrice)) continue;

    const edge = modelProb - marketYesPrice;

    if (Math.abs(edge) >= WEATHER_SETTINGS.minEdgeToTrade) {
      opportunities.push({
        cityCode,
        cityName: city.name,
        market,
        forecast,
        modelProb,
        marketYesPrice,
        edge,
        side: edge > 0 ? 'yes' : 'no' // buy Yes if we think it's underpriced, No if overpriced
      });
    }
  }

  opportunities.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
  return opportunities;
}

// Scans every configured city, returns the top opportunities across all of them combined
async function scanWeatherEdge() {
  const allOpportunities = [];
  for (const cityCode of Object.keys(WEATHER_CITIES)) {
    try {
      const cityOpps = await scanWeatherEdgeForCity(cityCode);
      allOpportunities.push(...cityOpps);
    } catch (err) {
      console.error(`Weather scan failed for ${cityCode}:`, err.message);
    }
  }
  // Return the best 2 across ALL cities, not per-city — avoid spamming
  // multiple brackets on the same underlying forecast
  allOpportunities.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
  return allOpportunities.slice(0, 2);
}

async function placeKalshiOrderOnMarket(market, side, dollarAmount) {
  // side here is our app's concept: 'yes' or 'no'. Kalshi's V2 API only
  // speaks in bid/ask on the YES book, so we convert:
  //   buy YES  -> bookSide 'bid', priced at the current yes ask
  //   buy NO   -> bookSide 'ask' (economically = buying NO), priced at (1 - no ask)
  const priceInDollars = parseFloat(side === 'yes' ? market.yes_ask_dollars : market.no_ask_dollars);
  if (!priceInDollars || priceInDollars <= 0) {
    return { success: false, reason: 'Could not read a valid price from the market data.' };
  }
  const contractCount = Math.max(1, Math.floor(dollarAmount / priceInDollars));
  const priceInCents = Math.round(priceInDollars * 100);

  const bookSide = side === 'yes' ? 'bid' : 'ask';

  let priceStr;
  if (side === 'yes') {
    priceStr = market.yes_ask_dollars; // trust Kalshi's exact string
  } else {
    const decimals = (market.no_ask_dollars.split('.')[1] || '').length || 2;
    let converted = 1 - parseFloat(market.no_ask_dollars);
    converted = Math.min(0.99, Math.max(0.01, converted)); // never bid at exactly 0 or 1
    priceStr = converted.toFixed(decimals);
  }

  const orderBody = {
    ticker: market.ticker,
    client_order_id: `bot-${Date.now()}`,
    side: bookSide,
    count: contractCount.toFixed(2),           // FixedPointCount: string, up to 2 decimals
    price: priceStr,                            // FixedPointDollars: string, grid-aligned
    time_in_force: 'immediate_or_cancel',       // fills what it can now, cancels rest — our "market order" equivalent
    self_trade_prevention_type: 'taker_at_cross'
  };

  if (DRY_RUN) {
    return {
      success: true,
      dryRun: true,
      ticker: market.ticker,
      contractCount,
      priceInCents,
      orderBodyPreview: orderBody,
      reason: 'DRY_RUN is on — no real order was sent.'
    };
  }

  const result = await kalshiRequest('POST', '/portfolio/events/orders', orderBody);
  if (!result) {
    return { success: false, reason: 'Kalshi API rejected the order — check console for details.' };
  }
  return { success: true, dryRun: false, ticker: market.ticker, contractCount, priceInCents, orderResult: result };
}

async function placeKalshiOrder(asset, side, dollarAmount) {
  const market = await findLiveMarketTicker(asset);
  if (!market) {
    return { success: false, reason: `No live Kalshi market found for ${asset}. Series ticker may be wrong — verify on kalshi.com.` };
  }
  return placeKalshiOrderOnMarket(market, side, dollarAmount);
}

// ============================================
// PRICE FEED (public, no auth needed)
// ============================================
const COIN_IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', DOGE: 'dogecoin' };

// Fetch all 4 prices in ONE request instead of 4 separate ones.
// This avoids CoinGecko's free-tier rate limit (429 errors).
async function getAllSpotPrices() {
  const ids = Object.values(COIN_IDS).join(',');
  try {
    const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const prices = {};
    for (const [asset, coinId] of Object.entries(COIN_IDS)) {
      prices[asset] = response.data[coinId]?.usd || null;
    }
    return prices;
  } catch (error) {
    if (error.response?.status === 429) {
      console.error('Rate limited by CoinGecko — will retry next cycle');
    } else {
      console.error('Failed to get prices:', error.message);
    }
    return null;
  }
}

// ============================================
// KELLY CRITERION POSITION SIZING
// ============================================
// Kelly fraction = (p*b - q) / b
// p = probability of winning, q = 1-p, b = net payout ratio
function calculateKellyBetSize(winProbability, payoutRatio) {
  const p = winProbability;
  const q = 1 - p;
  const b = payoutRatio;

  const fullKelly = (p * b - q) / b;
  const fractionalKelly = Math.max(0, fullKelly * RISK_RULES.kellyFraction);

  let betSize = BANKROLL * fractionalKelly;

  // Hard cap: never exceed max per trade regardless of what Kelly says
  const maxAllowed = BANKROLL * RISK_RULES.maxPerTradePercent;
  betSize = Math.min(betSize, maxAllowed);

  // Round to 2 decimals, minimum $1
  return Math.max(1, Math.round(betSize * 100) / 100);
}

// ============================================
// ANALYSIS ENGINE
// ============================================
function analyzeAsset(asset, price) {
  const history = botState.priceHistory[asset];
  if (history.length < 5) return null;

  const threshold = THRESHOLDS[asset];
  const recent = history.slice(-10).map(h => h.price);
  const high = Math.max(...recent);
  const low = Math.min(...recent);

  const dropPercent = ((high - price) / high) * 100;
  const volatility = ((high - low) / low) * 100;

  const buySignal = dropPercent >= threshold.buyDrop;

  const divergenceRatio = dropPercent / threshold.buyDrop;
  const estimatedWinProbability = Math.min(0.75, 0.50 + (divergenceRatio - 1) * 0.08);

  return {
    price, high, low, dropPercent, volatility,
    buySignal, estimatedWinProbability, threshold
  };
}

// Tracks exposure that's "in flight" — no longer enforced as a hard limit
// (exposure cap was removed per request), but still shown in /status so
// you can see how much is currently committed to trades being placed.
let reservedExposure = 0;

// Daily loss limit and max concurrent bets removed per request. Kept as a
// thin pass-through so callers don't need changing and future guards can
// slot back in here if ever wanted.
function checkRiskLimits() {
  return { ok: true };
}

async function executeTrade(asset, analysis, betAmount) {
  reservedExposure += betAmount; // reserve BEFORE the slow network call
  let orderResult;
  try {
    orderResult = await placeKalshiOrder(asset, 'yes', betAmount);
  } finally {
    reservedExposure -= betAmount; // release the moment we have a real answer, success or fail
  }

  if (!orderResult.success) {
    notify(`❌ Order failed for ${asset}: ${orderResult.reason}`);
    return null;
  }

  const bet = {
    id: Date.now(),
    asset,
    entryPrice: analysis.price,
    amount: betAmount,
    estimatedWinProbability: analysis.estimatedWinProbability,
    ticker: orderResult.ticker,
    contractCount: orderResult.contractCount,
    side: 'yes', // all automated crypto trades buy YES
    timestamp: Date.now(),
    status: 'open'
  };

  if (!orderResult.dryRun) {
    botState.openBets.push(bet);
    botState.stats.totalBets++;
  }
  saveState();

  if (orderResult.dryRun) {
    notify(
      `🧪 DRY RUN — no real order sent\n\n` +
      `Asset: ${THRESHOLDS[asset].name} (${asset})\n` +
      `Would buy: ${orderResult.contractCount} contracts on ${orderResult.ticker}\n` +
      `Est. cost: $${betAmount.toFixed(2)}`
    );
  } else {
    notify(
      `✅ REAL TRADE PLACED\n\n` +
      `Asset: ${THRESHOLDS[asset].name} (${asset})\n` +
      `Market: ${orderResult.ticker}\n` +
      `Contracts: ${orderResult.contractCount}\n` +
      `Cost: ~$${betAmount.toFixed(2)}\n` +
      `Bet ID: ${bet.id}`
    );
  }

  return bet;
}

async function executeWeatherTrade(pending) {
  const { ticker, side, betAmount, opportunity } = pending;
  reservedExposure += betAmount;
  let orderResult;
  try {
    orderResult = await placeKalshiOrderOnMarket(opportunity.market, side, betAmount);
  } finally {
    reservedExposure -= betAmount;
  }

  if (!orderResult.success) {
    notify(`❌ Weather order failed: ${orderResult.reason}`);
    return null;
  }

  const bet = {
    id: Date.now(),
    asset: 'WEATHER',
    ticker,
    side,
    amount: betAmount,
    contractCount: orderResult.contractCount,
    timestamp: Date.now(),
    status: 'open'
  };
  if (!orderResult.dryRun) {
    botState.openBets.push(bet);
    botState.stats.totalBets++;
  }
  saveState();

  if (orderResult.dryRun) {
    notify(
      `🧪 DRY RUN — no real order sent\n\n` +
      `Weather: ${ticker}\n` +
      `Would buy: ${orderResult.contractCount} contracts (${side.toUpperCase()})\n` +
      `Est. cost: $${betAmount.toFixed(2)}`
    );
  } else {
    notify(
      `✅ REAL WEATHER TRADE PLACED\n\n` +
      `Market: ${ticker}\n` +
      `Side: ${side.toUpperCase()}\n` +
      `Contracts: ${orderResult.contractCount}\n` +
      `Cost: ~$${betAmount.toFixed(2)}\n` +
      `Bet ID: ${bet.id}`
    );
  }

  return bet;
}

async function proposeTrade(asset, analysis) {
  // Kelly sizing: assume ~0.9x payout ratio typical for near-the-money Kalshi contracts
  const betAmount = calculateKellyBetSize(analysis.estimatedWinProbability, 0.9);

  const pending = {
    id: Date.now(),
    type: 'crypto',
    asset,
    analysis,
    betAmount,
    timestamp: Date.now()
  };

  botState.pendingBets.push(pending);
  saveState();

  notify(
    `📊 Opportunity: ${THRESHOLDS[asset].name}\n\n` +
    `Price: $${analysis.price.toFixed(asset === 'DOGE' ? 4 : 2)}\n` +
    `Drop from recent high: ${analysis.dropPercent.toFixed(2)}% (trigger: ${THRESHOLDS[asset].buyDrop}%)\n` +
    `Volatility (10 samples): ${analysis.volatility.toFixed(2)}%\n` +
    `Estimated win probability: ${(analysis.estimatedWinProbability * 100).toFixed(0)}%\n` +
    `Suggested size (Kelly, 40% fractional): $${betAmount.toFixed(2)}\n\n` +
    `Bet ID: ${pending.id}\n` +
    `/approve ${pending.id}  or  /deny ${pending.id}`
  );
}

async function proposeWeatherTrade(opportunity) {
  const { market, forecast, modelProb, marketYesPrice, edge, side } = opportunity;
  const winProbability = side === 'yes' ? modelProb : (1 - modelProb);
  const betAmount = calculateKellyBetSize(winProbability, 0.9);

  const pending = {
    id: Date.now(),
    type: 'weather',
    ticker: market.ticker,
    side,
    betAmount,
    opportunity,
    timestamp: Date.now()
  };

  botState.pendingBets.push(pending);
  saveState();

  notify(
    `🌤️ Weather Opportunity: ${opportunity.cityName}\n\n` +
    `Market: ${market.title || market.ticker}\n` +
    `NWS forecast: ${forecast.tempF}°F\n` +
    `Model probability (Yes): ${(modelProb * 100).toFixed(0)}%\n` +
    `Market price (Yes): ${(marketYesPrice * 100).toFixed(0)}¢\n` +
    `Edge: ${(edge * 100).toFixed(1)}pp — buying ${side.toUpperCase()}\n` +
    `Suggested size (Kelly): $${betAmount.toFixed(2)}\n\n` +
    `Bet ID: ${pending.id}\n` +
    `/approve ${pending.id}  or  /deny ${pending.id}`
  );
}

async function checkAndScan() {
  const prices = await getAllSpotPrices();
  if (!prices) return; // rate limited or fetch failed — try again next cycle

  for (const asset of Object.keys(THRESHOLDS)) {
    const price = prices[asset];
    if (!price) continue;

    botState.prices[asset] = price;
    botState.priceHistory[asset].push({ time: Date.now(), price });
    if (botState.priceHistory[asset].length > 100) {
      botState.priceHistory[asset].shift();
    }

    const analysis = analyzeAsset(asset, price);
    if (!analysis || !analysis.buySignal) continue;
    if (analysis.estimatedWinProbability < RISK_RULES.minConfidenceToTrade) continue;

    // Per-asset dedup removed per request — the bot fires off offers as it
    // sees fit. Optional cooldown (REPROPOSE_COOLDOWN_MIN, default 0/off)
    // only exists to stop literal duplicate spam every 30s if you want it.
    const key = `crypto_${asset}`;
    if (withinCooldown(key)) continue;

    await proposeTrade(asset, analysis);
    markProposed(key);
  }

  saveState();
}

async function checkWeatherOnce() {
  if (!botState.isRunning) return;

  try {
    const opportunities = await scanWeatherEdge();
    for (const opp of opportunities) {
      // Dedup removed per request — fires as it sees fit. Optional cooldown
      // (default off) only guards against literal duplicate spam.
      const key = `weather_${opp.market.ticker}`;
      if (withinCooldown(key)) continue;
      await proposeWeatherTrade(opp);
      markProposed(key);
    }
  } catch (err) {
    console.error('Weather scan error:', err.message);
  }
}

// ============================================
// SETTLEMENT CHECKING
// ============================================
// Polls each open bet's market to see if it has resolved, and if so,
// computes real profit/loss and records it.
async function checkOneSettlement(bet) {
  const data = await kalshiRequest('GET', `/markets/${bet.ticker}`);
  if (!data || !data.market) return null; // couldn't check right now, try again later

  const market = data.market;
  const isSettled = market.status === 'finalized' || market.status === 'settled' || (market.result && market.result !== '');
  if (!isSettled) return null; // still active, nothing to do yet

  const won = market.result === bet.side;
  // Each contract pays exactly $1 if it resolved the way you bought, $0 otherwise.
  const profit = won
    ? (bet.contractCount || 0) - bet.amount  // payout minus what you paid
    : -bet.amount;                            // lost the full stake

  return { won, profit, settledResult: market.result };
}

async function checkAllSettlements() {
  if (botState.openBets.length === 0) return;

  const stillOpen = [];
  for (const bet of botState.openBets) {
    let settlement;
    try {
      settlement = await checkOneSettlement(bet);
    } catch (err) {
      console.error(`Settlement check failed for bet ${bet.id}:`, err.message);
      settlement = null;
    }

    if (!settlement) {
      stillOpen.push(bet);
      continue;
    }

    // Update stats
    botState.stats.totalProfit += settlement.profit;
    if (settlement.won) {
      botState.stats.wins++;
    } else {
      botState.stats.losses++;
    }

    // Log to history for the chart
    const prevCumulative = botState.settlementHistory.length > 0
      ? botState.settlementHistory[botState.settlementHistory.length - 1].cumulativeProfit
      : 0;
    botState.settlementHistory.push({
      time: Date.now(),
      result: settlement.won ? 'win' : 'loss',
      profit: settlement.profit,
      cumulativeProfit: prevCumulative + settlement.profit,
      asset: bet.asset
    });

    botState.closedBets.push({ ...bet, ...settlement, closedAt: Date.now() });

    notify(
      `${settlement.won ? '✅ WIN' : '❌ LOSS'}: ${bet.asset} ${bet.ticker}\n` +
      `Profit: ${settlement.profit >= 0 ? '+' : ''}$${settlement.profit.toFixed(2)}\n` +
      `Running total: $${botState.stats.totalProfit.toFixed(2)}`
    );
  }

  botState.openBets = stillOpen;
  saveState();
}

function startMonitoring() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   KALSHI TRADING BOT                    ║');
  console.log('║   Kelly-Sized, Approval-Gated           ║');
  console.log('║   No daily/concurrency cap              ║');
  console.log('╚════════════════════════════════════════╝\n');
  console.log(`Bankroll: $${BANKROLL}`);
  console.log(`Max per trade: $${(BANKROLL * RISK_RULES.maxPerTradePercent).toFixed(2)}`);
  console.log(`Min confidence to trade: ${(RISK_RULES.minConfidenceToTrade * 100).toFixed(0)}%`);
  console.log(`Re-propose cooldown: ${REPROPOSE_COOLDOWN_MIN > 0 ? REPROPOSE_COOLDOWN_MIN + ' min' : 'off (fires freely)'}\n`);
  console.log(`Weather: tracking ${Object.values(WEATHER_CITIES).map(c => c.name).join(', ')}\n`);

  setInterval(async () => {
    if (botState.isRunning) {
      await checkAndScan();
    }
  }, 30000); // 30s — stays comfortably under CoinGecko's free-tier rate limit

  setInterval(checkWeatherOnce, 10 * 60 * 1000); // 10 min

  setInterval(async () => {
    if (botState.isRunning) {
      await checkAllSettlements();
    }
  }, 90 * 1000); // 90s — crypto 15-min markets resolve fast, check often
}

loadState();
console.log('✅ Bot initialized. Send /start_bot in Telegram to begin scanning.\n');
if (KALSHI_API_SECRET) {
  const firstLine = KALSHI_API_SECRET.split('\n')[0];
  const looksValid = firstLine.includes('BEGIN') && firstLine.includes('PRIVATE KEY');
  console.log(`🔑 Private key loaded: ${KALSHI_API_SECRET.length} chars, first line: "${firstLine}" — ${looksValid ? 'looks valid ✅' : 'DOES NOT LOOK RIGHT ❌'}`);
}
startMonitoring();

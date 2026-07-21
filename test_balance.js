const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const KALSHI_API_SECRET = fs.readFileSync('./kalshi_key.pem', 'utf8').trim() + '\n';
const KALSHI_API_KEY = process.env.KALSHI_API_KEY;
const KALSHI_BASE_URL = 'https://external-api.kalshi.com/trade-api/v2';

function sign(method, path, timestamp) {
  return crypto.sign('sha256', Buffer.from(timestamp + method + path), { key: fs.readFileSync('./kalshi_key.pem', 'utf8').trim() + '\n', padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }).toString('base64');
}

async function test() {
  const path = '/portfolio/balance';
  const timestamp = Date.now().toString();
  const signedPath = '/trade-api/v2' + '/portfolio/balance';
  const signature = sign('GET', signedPath, timestamp);
  
  const headers = {
    'KALSHI-ACCESS-KEY': process.env.KALSHI_API_KEY,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'Content-Type': 'application/json'
  };

  try {
    const res = await require('axios').get('https://external-api.kalshi.com/trade-api/v2/portfolio/balance', { headers, timeout: 15000 });
    console.log('Balance:', res.data);
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
  }
}

(async () => { await test(); })();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

const KALSHI_KEY_PATH = './kalshi_key.pem';
let KALSHI_API_SECRET = fs.readFileSync('./kalshi_key.pem', 'utf8').trim() + '\n';
const KALSHI_API_KEY = process.env.KALSHI_API_KEY;
const KALSHI_BASE_URL = 'https://external-api.kalshi.com/trade-api/v2';

function sign(method, path, timestamp) {
  return crypto.sign('sha256', Buffer.from(timestamp + method + path), { key: fs.readFileSync('./kalshi_key.pem', 'utf8').trim() + '\n', padding: crypto.constants.RSA_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }).toString('base64');
}

async function checkBalance() {
  const ts = Date.now().toString();
  const signedPath = '/trade-api/v2' + '/portfolio/balance'.split('?')[0];
  const sig = sign('GET', signedPath, ts);
  const headers = {
    'KALSHI-ACCESS-KEY': process.env.KALSHI_API_KEY,
    'KALSHI-ACCESS-SIGNATURE': sig,
    'KALSHI-ACCESS-TIMESTAMP': Date.now().toString(),
    'Content-Type': 'application/json'
  };
  try {
    const res = await axios.get('https://external-api.kalshi.com/trade-api/v2/portfolio/balance', { headers, timeout: 15000 });
    console.log('Real Kalshi balance:', JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
  }
}

async function checkBalance() {
  const ts = Date.now().toString();
  const signedPath = '/trade-api/v2' + '/portfolio/balance'.split('?')[0];
  const sig = sign('GET', signedPath, ts);
  const headers = { 'KALSHI-ACCESS-KEY': process.env.KALSHI_API_KEY, 'KALSHI-ACCESS-SIGNATURE': sig, 'KALSHI-ACCESS-TIMESTAMP': ts, 'Content-Type': 'application/json' };
  try {
    const res = await axios.get('https://external-api.kalshi.com/trade-api/v2/portfolio/balance', { headers, timeout: 15000 });
    console.log('Real Kalshi balance:', JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
  }
}

checkBalance().catch(e => console.error(e.response?.data || e.message));
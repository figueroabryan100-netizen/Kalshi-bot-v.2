const axios = require('axios');

async function getAllSeries() {
  try {
    const data = await axios.get('https://external-api.kalshi.com/trade-api/v2/series?category=Crypto&status=open&limit=200');
    const series = data.data?.series || [];
    console.log('Total crypto series:', series.length);
    const shortSeries = series.filter(s => s.ticker.includes('15M') || s.ticker.includes('30M') || s.ticker.includes('1H') || s.ticker.includes('1H') || s.ticker.includes('H'));
    console.log('Short-term series:', shortSeries.map(s => s.ticker).join(', '));
  } catch(e) { console.error(e.message); }
}

getAllSeries().catch(e => console.error(e.message));
const axios = require('axios');

async function checkAllMarkets() {
  const series = ['KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M', 'KXBTC30M', 'KXETH30M', 'KXSOL30M', 'KXXRP30M', 'KXDOGE30M', 'KXBTC1H', 'KXETH1H', 'KXSOL1H', 'KXXRP1H', 'KXDOGE1H', 'KXBTC4H', 'KXETH4H', 'KXSOL4H', 'KXXRP4H', 'KXDOGE4H'];
  
  for (const s of series) {
    try {
      const data = await axios.get('https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=' + s + '&status=open&limit=10');
      const markets = data.data?.markets || [];
      for (const m of markets) {
        const yes = parseFloat(m.yes_ask_dollars);
        const no = parseFloat(m.no_ask_dollars);
        if ((yes > 0.05 && yes < 0.95) || (no > 0.05 && no < 0.95)) {
          console.log('TRADEABLE:', m.ticker, 'yes:', yes, 'no:', no, 'vol:', m.volume_24h_fp);
        }
      }
    } catch(e) { console.error(s, e.message); }
  }
}

checkAllMarkets().catch(e => console.error(e.message));
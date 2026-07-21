const axios = require('axios');
require('dotenv').config();

async function testChannel() {
  try {
    const url = 'https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/sendMessage';
    const res = await axios.post(url, {
      chat_id: process.env.PUBLIC_TELEGRAM_ID,
      text: '🧪 Test from Alpha Hound - channel connectivity test',
      parse_mode: 'HTML'
    });
    console.log('✅ Success:', res.data.ok);
    console.log('Message ID:', res.data.result?.message_id);
  } catch (e) {
    console.error('❌ Error:', e.response?.data || e.message);
  }
}

testChannel();
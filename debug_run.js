const fs = require('fs');
const { spawn } = require('child_process');

// Start bot and capture output
const bot = spawn('node', ['index.js'], { 
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe']
});

const out = fs.createWriteStream('debug_output.log');
bot.stdout.pipe(out);
bot.stderr.pipe(out);

console.log('Bot PID:', bot.pid);

// Check state every 10s for 90s
let checks = 0;
const interval = setInterval(() => {
  checks++;
  try {
    const state = JSON.parse(fs.readFileSync('kalshi_state.json', 'utf8'));
    console.log(`[${checks * 10}s] scanCount=${state.scanCount} attemptCount=${state.AUTO_HIT_CYCLE?.attemptCount} totalFired=${state.AUTO_HIT_CYCLE?.totalFired} pending=${state.pendingBets?.length || 0}`);
  } catch(e) { console.log(`[${checks * 10}s] state read failed`); }
  if (checks >= 9) {
    clearInterval(interval);
    // Read last 50 lines of log
    const log = fs.readFileSync('debug_output.log', 'utf8').split('\n');
    console.log('\n--- LAST 50 LINES OF OUTPUT ---');
    log.slice(-50).forEach(l => console.log(l));
    bot.kill();
    process.exit(0);
  }
}, 10000);

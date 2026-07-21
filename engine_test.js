const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'engine_test.log');
fs.writeFileSync(logFile, '=== ENGINE TEST START ===\n');

const child = spawn('node', ['index.js'], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', d => {
  const msg = d.toString();
  fs.appendFileSync(logFile, msg);
  process.stdout.write(msg);
});
child.stderr.on('data', d => {
  const msg = d.toString();
  fs.appendFileSync(logFile, '[ERR] ' + msg);
  process.stderr.write(msg);
});

// Poll state file every 5s
let polls = 0;
const poll = setInterval(() => {
  polls++;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'kalshi_state.json'), 'utf8'));
    const line = `[${polls*5}s] scan=${s.scanCount} fired=${s?.AUTO_HIT_CYCLE?.totalFired} pending=${s?.pendingBets?.length||0} bal=$${s.liveBalance||0} scanCount_written=${s.scanCount}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
  } catch(e) {
    console.log(`[${polls*5}s] state read error: ${e.message}`);
  }
  if (polls >= 12) { // 60s
    clearInterval(poll);
    child.kill();
    const tail = fs.readFileSync(logFile, 'utf8').split('\n');
    console.log('\n=== LAST 80 LINES ===');
    tail.slice(-80).forEach(l => console.log(l));
    process.exit(0);
  }
}, 5000);

const { spawn } = require('child_process');
const fs = require('fs');
const child = spawn('node', ['index.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
const logStream = fs.createWriteStream('debug_output.log');
child.stdout.pipe(logStream);
child.stderr.pipe(logStream);
console.log('Bot started with PID:', child.pid);

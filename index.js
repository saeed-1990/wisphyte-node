const { spawn } = require('child_process');

console.log('Starting Xray with existing config...');

const xray = spawn('./xray', ['run', '-c', 'config.json']);

xray.stdout.on('data', (data) => console.log(`Xray: ${data}`));
xray.stderr.on('data', (data) => console.error(`Xray Error: ${data}`));

xray.on('close', (code) => {
    console.log(`Xray process exited with code ${code}`);
});

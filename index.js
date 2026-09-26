const { execSync, spawn } = require('child_process');
const fs = require('fs');

console.log('Starting Xray setup...');

try {
    console.log('Downloading Xray...');
    execSync('curl -L -o xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip');
    execSync('unzip -o xray.zip -d .');
    execSync('chmod +x xray');
    console.log('Xray downloaded successfully.');
} catch (e) {
    console.error('Failed to download Xray:', e.message);
    process.exit(1);
}

const config = {
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "port": 10903,
      "protocol": "vless",
      "settings": {
        "clients": [{ "id": "de04add9-5c68-8bab-950c-08cd5320df18" }],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "xhttp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "www.microsoft.com:443",
          "xver": 0,
          "serverNames": ["www.microsoft.com"],
          "privateKey": "REPLACE_WITH_YOUR_PRIVATE_KEY",
          "shortIds": ["0123456789abcdef"]
        },
        "xhttpSettings": {
          "path": "/xhttp",
          "mode": "stream-one"
        }
      }
    }
  ],
  "outbounds": [{ "protocol": "freedom" }]
};

fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
console.log('Config created.');

console.log('Starting Xray...');
const xray = spawn('./xray', ['run', '-c', 'config.json']);
xray.stdout.on('data', (data) => console.log(`Xray: ${data}`));
xray.stderr.on('data', (data) => console.error(`Xray Error: ${data}`));

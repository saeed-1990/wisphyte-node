const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn, execFileSync } = require("child_process");

const PORT = 10903;
const UUID = "de04add9-5c68-8bab-950c-08cd5320df18";

const ROOT = __dirname;
const RUNTIME = path.join(ROOT, "runtime");
const XRAY = path.join(RUNTIME, "xray");
const ZIP = path.join(RUNTIME, "xray.zip");
const CONFIG = path.join(RUNTIME, "config.json");

fs.mkdirSync(RUNTIME, { recursive: true });

function download(url, output) {
  return new Promise((resolve, reject) => {
    const get = (target) => {
      https.get(
        target,
        { headers: { "User-Agent": "xray" } },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            return get(
              new URL(res.headers.location, target).toString()
            );
          }

          if (res.statusCode !== 200) {
            return reject(
              new Error(`Download failed: HTTP ${res.statusCode}`)
            );
          }

          const file = fs.createWriteStream(output);
          res.pipe(file);

          file.on("finish", () => {
            file.close(resolve);
          });

          file.on("error", reject);
        }
      ).on("error", reject);
    };

    get(url);
  });
}

async function installXray() {
  if (fs.existsSync(XRAY)) {
    fs.chmodSync(XRAY, 0o755);
    return;
  }

  let asset;

  if (process.arch === "x64") {
    asset = "Xray-linux-64.zip";
  } else if (process.arch === "arm64") {
    asset = "Xray-linux-arm64-v8a.zip";
  } else {
    throw new Error(
      `Unsupported architecture: ${process.arch}`
    );
  }

  const url =
    `https://github.com/XTLS/Xray-core/releases/latest/download/${asset}`;

  console.log("Downloading Xray...");

  await download(url, ZIP);

  execFileSync(
    "unzip",
    ["-o", ZIP, "-d", RUNTIME],
    { stdio: "inherit" }
  );

  fs.chmodSync(XRAY, 0o755);
  fs.rmSync(ZIP, { force: true });
}

function createConfig() {
  const config = {
    log: {
      loglevel: "info"
    },

    inbounds: [
      {
        listen: "0.0.0.0",
        port: PORT,
        protocol: "vless",

        settings: {
          clients: [
            {
              id: UUID
            }
          ],

          decryption: "none"
        },

        streamSettings: {
          network: "xhttp",
          security: "none",

          xhttpSettings: {
            path: "/xhttp/",
            mode: "packet-up"
          }
        }
      }
    ],

    outbounds: [
      {
        protocol: "freedom",
        tag: "direct"
      }
    ]
  };

  fs.writeFileSync(
    CONFIG,
    JSON.stringify(config, null, 2)
  );
}

async function main() {
  await installXray();

  createConfig();

  console.log(`
=================================
WISPBYTE XHTTP
=================================

Address:
project-s.wispbyte.app

Port:
443

UUID:
${UUID}

Network:
xhttp

Mode:
packet-up

Path:
/xhttp/

TLS:
tls

SNI:
project-s.wispbyte.app

=================================
`);

  const xray = spawn(
    XRAY,
    ["run", "-config", CONFIG],
    { stdio: "inherit" }
  );

  xray.on("exit", (code) => {
    console.log(`Xray exited: ${code}`);
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

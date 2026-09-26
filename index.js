const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn, execFileSync } = require("child_process");

const PORT = Number(process.env.PORT || 10903);
const UUID =
  process.env.VLESS_UUID ||
  "de04add9-5c68-8bab-950c-08cd5320df18";

const REALITY_DEST =
  process.env.REALITY_DEST || "www.microsoft.com:443";

const REALITY_SNI =
  process.env.REALITY_SNI || "www.microsoft.com";

const DIR = path.join(__dirname, "runtime");
const XRAY = path.join(DIR, "xray");
const ZIP = path.join(DIR, "xray.zip");
const CONFIG = path.join(__dirname, "config.json");

fs.mkdirSync(DIR, { recursive: true });

function run(cmd, args, options = {}) {
  console.log("+", cmd, ...args);
  execFileSync(cmd, args, {
    stdio: "inherit",
    ...options
  });
}

function download(url, output) {
  return new Promise((resolve, reject) => {
    const get = u => {
      https.get(u, {
        headers: {
          "User-Agent": "wisphyte-xray"
        }
      }, res => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          return get(new URL(res.headers.location, u).toString());
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`Download failed: HTTP ${res.statusCode}`)
          );
        }

        const file = fs.createWriteStream(output);

        res.pipe(file);

        file.on("finish", () => {
          file.close(resolve);
        });
      }).on("error", reject);
    };

    get(url);
  });
}

async function installXray() {
  if (fs.existsSync(XRAY)) return;

  const arch = process.arch;

  let asset;

  if (arch === "x64") {
    asset = "Xray-linux-64.zip";
  } else if (arch === "arm64") {
    asset = "Xray-linux-arm64-v8a.zip";
  } else {
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  const url =
    `https://github.com/XTLS/Xray-core/releases/latest/download/${asset}`;

  console.log("Downloading Xray:", url);

  await download(url, ZIP);

  run("unzip", ["-o", ZIP, "-d", DIR]);

  fs.chmodSync(XRAY, 0o755);
  fs.rmSync(ZIP, { force: true });
}

function generateKeys() {
  const output = execFileSync(
    XRAY,
    ["x25519"],
    { encoding: "utf8" }
  );

  console.log(output);

  const privateKey =
    output.match(/PrivateKey:\s*(\S+)/i)?.[1] ||
    output.match(/Private key:\s*(\S+)/i)?.[1];

  const publicKey =
    output.match(/Password:\s*(\S+)/i)?.[1] ||
    output.match(/PublicKey:\s*(\S+)/i)?.[1] ||
    output.match(/Public key:\s*(\S+)/i)?.[1];

  if (!privateKey || !publicKey) {
    throw new Error(
      "Could not parse x25519 output:\n" + output
    );
  }

  return { privateKey, publicKey };
}

function randomShortId() {
  return require("crypto")
    .randomBytes(8)
    .toString("hex");
}

async function main() {
  await installXray();

  console.log("\n=== XRAY VERSION ===");
  run(XRAY, ["version"]);

  const {
    privateKey,
    publicKey
  } = generateKeys();

  const shortId = randomShortId();

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
              id: UUID,
              flow: "xtls-rprx-vision"
            }
          ],
          decryption: "none"
        },

        streamSettings: {
          network: "raw",

          security: "reality",

          realitySettings: {
            show: false,
            dest: REALITY_DEST,

            xver: 0,

            serverNames: [
              REALITY_SNI
            ],

            privateKey: privateKey,

            shortIds: [
              shortId
            ]
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

  console.log(`
========================================
REALITY CLIENT PARAMETERS
========================================

Address:
78.154.103.43

Port:
${PORT}

UUID:
${UUID}

Flow:
xtls-rprx-vision

Security:
reality

Network:
raw / tcp

SNI:
${REALITY_SNI}

Public Key:
${publicKey}

Short ID:
${shortId}

Fingerprint:
chrome

SpiderX:
/

========================================
`);

  const child = spawn(
    XRAY,
    ["run", "-config", CONFIG],
    {
      stdio: "inherit"
    }
  );

  child.on("exit", (code, signal) => {
    console.error(
      `Xray stopped: code=${code}, signal=${signal}`
    );

    process.exit(code ?? 1);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

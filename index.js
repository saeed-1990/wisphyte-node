const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const PORT = Number(process.env.XRAY_PORT || 10903);
const UUID = process.env.VLESS_UUID || "de04add9-5c68-8bab-950c-08cd5320df18";

const REALITY_DEST = process.env.REALITY_DEST || "www.cloudflare.com:443";
const REALITY_SNI = process.env.REALITY_SNI || "www.cloudflare.com";

const ROOT = __dirname;
const RUNTIME = path.join(ROOT, "runtime");
const XRAY = path.join(RUNTIME, "xray");
const ZIP = path.join(RUNTIME, "xray.zip");
const CONFIG = path.join(RUNTIME, "config.json");
const KEYS = path.join(RUNTIME, "reality.json");

fs.mkdirSync(RUNTIME, { recursive: true });

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = (target) => {
      https.get(
        target,
        { headers: { "User-Agent": "wisphyte-xray" } },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();

            return request(
              new URL(res.headers.location, target).toString()
            );
          }

          if (res.statusCode !== 200) {
            res.resume();

            return reject(
              new Error(`Download failed: HTTP ${res.statusCode}`)
            );
          }

          const file = fs.createWriteStream(destination);

          res.pipe(file);

          file.on("finish", () => file.close(resolve));
          file.on("error", reject);
        }
      ).on("error", reject);
    };

    request(url);
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
    throw new Error(`Unsupported architecture: ${process.arch}`);
  }

  const url =
    `https://github.com/XTLS/Xray-core/releases/latest/download/${asset}`;

  console.log("Downloading:", url);

  await download(url, ZIP);

  execFileSync(
    "unzip",
    ["-o", ZIP, "-d", RUNTIME],
    { stdio: "inherit" }
  );

  fs.chmodSync(XRAY, 0o755);
  fs.rmSync(ZIP, { force: true });
}

function getRealityKeys() {
  if (fs.existsSync(KEYS)) {
    return JSON.parse(
      fs.readFileSync(KEYS, "utf8")
    );
  }

  const output = execFileSync(
    XRAY,
    ["x25519"],
    { encoding: "utf8" }
  );

  const privateKey =
    output.match(/PrivateKey:\s*(\S+)/i)?.[1];

  const publicKey =
    output.match(/Password\s*\(PublicKey\):\s*(\S+)/i)?.[1] ||
    output.match(/PublicKey:\s*(\S+)/i)?.[1];

  if (!privateKey || !publicKey) {
    throw new Error(
      `Could not parse x25519 output:\n${output}`
    );
  }

  const data = {
    privateKey,
    publicKey,
    shortId: crypto.randomBytes(8).toString("hex")
  };

  fs.writeFileSync(
    KEYS,
    JSON.stringify(data, null, 2)
  );

  return data;
}

function createConfig(keys) {
  const config = {
    log: {
      loglevel: "debug"
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
            show: true,
            dest: REALITY_DEST,
            xver: 0,

            serverNames: [
              REALITY_SNI
            ],

            privateKey: keys.privateKey,

            shortIds: [
              keys.shortId
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
}

async function main() {
  await installXray();

  console.log(
    execFileSync(
      XRAY,
      ["version"],
      { encoding: "utf8" }
    )
  );

  const keys = getRealityKeys();

  createConfig(keys);

  console.log(`
========== V2RAYN ==========
Address: 78.154.103.43
Port: ${PORT}
UUID: ${UUID}
Encryption: none
Flow: xtls-rprx-vision
Network: raw
Security: reality
SNI: ${REALITY_SNI}
Fingerprint: chrome
PublicKey: ${keys.publicKey}
ShortID: ${keys.shortId}
SpiderX: /
=============================
`);

  const xray = spawn(
    XRAY,
    ["run", "-config", CONFIG],
    { stdio: "inherit" }
  );

  xray.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

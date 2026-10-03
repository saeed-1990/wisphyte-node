"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const net = require("net");
const { spawn, execFileSync } = require("child_process");

const ROOT = __dirname;
const RUNTIME = path.join(ROOT, "runtime");

const XRAY = path.join(RUNTIME, "xray");
const ZIP = path.join(RUNTIME, "xray.zip");
const CONFIG = path.join(RUNTIME, "config.json");

const PORT = 10903;

const UUID =
  process.env.VLESS_UUID ||
  "de04add9-5c68-8bab-950c-08cd5320df18";

const WS_PATH =
  process.env.WS_PATH ||
  "/ws";

const HEALTH_INTERVAL = 30000;

fs.mkdirSync(RUNTIME, {
  recursive: true
});

let xray = null;
let stopping = false;

function log(text) {
  console.log(
    `[SUPERVISOR ${new Date().toISOString()}] ${text}`
  );
}

function download(url, output) {
  return new Promise((resolve, reject) => {
    const get = target => {
      https.get(
        target,
        {
          headers: {
            "User-Agent": "wispbyte-xray"
          }
        },
        res => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();

            return get(
              new URL(
                res.headers.location,
                target
              ).toString()
            );
          }

          if (res.statusCode !== 200) {
            res.resume();

            return reject(
              new Error(
                `HTTP ${res.statusCode}`
              )
            );
          }

          const file =
            fs.createWriteStream(output);

          res.pipe(file);

          file.on(
            "finish",
            () => file.close(resolve)
          );

          file.on(
            "error",
            reject
          );
        }
      ).on(
        "error",
        reject
      );
    };

    get(url);
  });
}

async function installXray() {
  if (fs.existsSync(XRAY)) {
    fs.chmodSync(
      XRAY,
      0o755
    );

    return;
  }

  let asset;

  if (process.arch === "x64") {
    asset =
      "Xray-linux-64.zip";
  } else if (
    process.arch === "arm64"
  ) {
    asset =
      "Xray-linux-arm64-v8a.zip";
  } else {
    throw new Error(
      `Unsupported architecture: ${process.arch}`
    );
  }

  await download(
    `https://github.com/XTLS/Xray-core/releases/latest/download/${asset}`,
    ZIP
  );

  execFileSync(
    "unzip",
    [
      "-o",
      ZIP,
      "-d",
      RUNTIME
    ],
    {
      stdio: "inherit"
    }
  );

  fs.chmodSync(
    XRAY,
    0o755
  );

  fs.rmSync(
    ZIP,
    {
      force: true
    }
  );
}

function writeConfig() {
  const config = {
    log: {
      loglevel: "warning"
    },

    inbounds: [
      {
        tag: "vless-ws",

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
          network: "ws",
          security: "none",

          wsSettings: {
            path: WS_PATH
          }
        }
      }
    ],

    outbounds: [
      {
        tag: "direct",
        protocol: "freedom"
      }
    ]
  };

  fs.writeFileSync(
    CONFIG,
    JSON.stringify(
      config,
      null,
      2
    )
  );
}

function validate() {
  execFileSync(
    XRAY,
    [
      "run",
      "-test",
      "-config",
      CONFIG
    ],
    {
      stdio: "inherit"
    }
  );
}

function startXray() {
  log(
    "Starting Xray..."
  );

  xray = spawn(
    XRAY,
    [
      "run",
      "-config",
      CONFIG
    ],
    {
      stdio: "inherit"
    }
  );

  xray.on(
    "exit",
    (code, signal) => {
      log(
        `Xray exited ${code}/${signal}`
      );

      xray = null;

      if (!stopping) {
        setTimeout(
          startXray,
          3000
        );
      }
    }
  );
}

function healthCheck() {
  if (
    !xray ||
    xray.exitCode !== null
  ) {
    log(
      "HEALTH FAIL: process down"
    );

    return;
  }

  const socket =
    net.createConnection({
      host: "127.0.0.1",
      port: PORT
    });

  socket.setTimeout(3000);

  socket.on(
    "connect",
    () => {
      log(
        `HEALTH OK: TCP ${PORT}`
      );

      socket.destroy();
    }
  );

  socket.on(
    "timeout",
    () => {
      log(
        "HEALTH FAIL: timeout"
      );

      socket.destroy();
    }
  );

  socket.on(
    "error",
    () => {
      log(
        "HEALTH FAIL: listener"
      );
    }
  );
}

async function main() {
  await installXray();

  writeConfig();

  validate();

  console.log(`
========================================
WISPBYTE VLESS WEBSOCKET
========================================

Domain:
project-s.wispbyte.app

Public Port:
443

UUID:
${UUID}

Protocol:
VLESS

Transport:
WebSocket

Path:
${WS_PATH}

TLS:
YES - terminated by Wispbyte/Cloudflare

Origin TLS:
NONE

========================================
`);

  startXray();

  setInterval(
    healthCheck,
    HEALTH_INTERVAL
  );
}

process.on(
  "SIGTERM",
  () => {
    stopping = true;

    if (xray) {
      xray.kill("SIGTERM");
    }

    setTimeout(
      () => process.exit(0),
      3000
    );
  }
);

main().catch(error => {
  console.error(error);
  process.exit(1);
});

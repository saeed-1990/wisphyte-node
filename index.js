"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const net = require("net");
const { spawn, execFileSync } = require("child_process");

//
// ============================================================
// WISPBYTE SERVICE
// ============================================================
//

const SERVER_IP =
  process.env.SERVER_IP ||
  "78.154.103.44";

const PORT =
  Number(
    process.env.XRAY_PORT ||
    process.env.SERVER_PORT ||
    10544
  );

const DOMAIN =
  process.env.PUBLIC_DOMAIN ||
  "maria.wispbyte.app";

const UUID =
  process.env.VLESS_UUID ||
  "de04add9-5c68-8bab-950c-08cd5320df18";

const WS_PATH_RAW =
  process.env.WS_PATH ||
  "/ws";

const WS_PATH =
  WS_PATH_RAW.startsWith("/")
    ? WS_PATH_RAW
    : `/${WS_PATH_RAW}`;

//
// ============================================================
// PATHS
// ============================================================
//

const ROOT = __dirname;

const RUNTIME =
  path.join(
    ROOT,
    "runtime"
  );

const XRAY =
  path.join(
    RUNTIME,
    "xray"
  );

const ZIP =
  path.join(
    RUNTIME,
    "xray.zip"
  );

const CONFIG =
  path.join(
    RUNTIME,
    "config.json"
  );

const STATE_FILE =
  path.join(
    RUNTIME,
    "supervisor-state.json"
  );

fs.mkdirSync(
  RUNTIME,
  {
    recursive: true
  }
);

//
// ============================================================
// SUPERVISOR SETTINGS
// ============================================================
//

const HEALTH_INTERVAL =
  Number(
    process.env.HEALTH_INTERVAL ||
    30000
  );

const HEALTH_TIMEOUT =
  Number(
    process.env.HEALTH_TIMEOUT ||
    3000
  );

const FAILURE_LIMIT =
  Number(
    process.env.HEALTH_FAILURE_LIMIT ||
    3
  );

const STARTUP_GRACE =
  Number(
    process.env.STARTUP_GRACE ||
    10000
  );

const BASE_RESTART_DELAY =
  Number(
    process.env.RESTART_DELAY ||
    3000
  );

const MAX_RESTART_DELAY =
  60000;

const STABLE_RUNTIME =
  120000;

//
// ============================================================
// STATE
// ============================================================
//

let xray = null;

let shuttingDown = false;
let healthRunning = false;

let healthFailures = 0;

let restartStreak = 0;
let restartTimer = null;

let xrayStartedAt = 0;

const supervisorStartedAt =
  Date.now();

let state = {
  totalRestarts: 0,

  lastHealthy: null,

  lastFailure: null,

  lastStart: null
};

//
// ============================================================
// LOGGING
// ============================================================
//

function now() {
  return new Date()
    .toISOString();
}

function log(message) {
  console.log(
    `[SUPERVISOR ${now()}] ${message}`
  );
}

//
// ============================================================
// PERSISTENT STATE
// ============================================================
//

function loadState() {
  try {

    if (
      !fs.existsSync(
        STATE_FILE
      )
    ) {
      return;
    }

    const saved =
      JSON.parse(
        fs.readFileSync(
          STATE_FILE,
          "utf8"
        )
      );

    state = {
      ...state,
      ...saved
    };

  } catch (error) {

    log(
      `State load warning: ${error.message}`
    );
  }
}

function saveState() {
  try {

    fs.writeFileSync(
      STATE_FILE,

      JSON.stringify(
        state,
        null,
        2
      )
    );

  } catch (error) {

    log(
      `State save warning: ${error.message}`
    );
  }
}

//
// ============================================================
// DOWNLOAD
// ============================================================
//

function download(
  url,
  output
) {

  return new Promise(
    (resolve, reject) => {

      const request =
        target => {

          https.get(
            target,

            {
              headers: {
                "User-Agent":
                  "wispbyte-vless-ws"
              }
            },

            response => {

              if (
                response.statusCode >= 300 &&
                response.statusCode < 400 &&
                response.headers.location
              ) {

                response.resume();

                return request(
                  new URL(
                    response.headers.location,
                    target
                  ).toString()
                );
              }

              if (
                response.statusCode !== 200
              ) {

                response.resume();

                return reject(
                  new Error(
                    `Download HTTP ${response.statusCode}`
                  )
                );
              }

              const file =
                fs.createWriteStream(
                  output
                );

              response.pipe(
                file
              );

              file.on(
                "finish",

                () => {
                  file.close(
                    resolve
                  );
                }
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

      request(url);
    }
  );
}

//
// ============================================================
// INSTALL XRAY
// ============================================================
//

async function installXray() {

  if (
    fs.existsSync(XRAY)
  ) {

    fs.chmodSync(
      XRAY,
      0o755
    );

    return;
  }

  let asset;

  if (
    process.arch === "x64"
  ) {

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

  const url =
    "https://github.com/XTLS/" +
    "Xray-core/releases/latest/download/" +
    asset;

  log(
    `Downloading Xray: ${asset}`
  );

  await download(
    url,
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

//
// ============================================================
// XRAY CONFIG
// ============================================================
//

function buildConfig() {

  return {

    log: {
      loglevel: "warning"
    },

    inbounds: [

      {
        tag:
          "vless-ws",

        listen:
          "0.0.0.0",

        port:
          PORT,

        protocol:
          "vless",

        settings: {

          clients: [
            {
              id:
                UUID
            }
          ],

          decryption:
            "none"
        },

        streamSettings: {

          network:
            "ws",

          security:
            "none",

          wsSettings: {

            path:
              WS_PATH
          }
        }
      }
    ],

    outbounds: [

      {
        tag:
          "direct",

        protocol:
          "freedom"
      }
    ]
  };
}

function writeConfig() {

  fs.writeFileSync(
    CONFIG,

    JSON.stringify(
      buildConfig(),
      null,
      2
    )
  );
}

//
// ============================================================
// CONFIG VALIDATION
// ============================================================
//

function validateConfig() {

  log(
    "Validating Xray configuration..."
  );

  try {

    execFileSync(
      XRAY,

      [
        "run",
        "-test",
        "-config",
        CONFIG
      ],

      {
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

    log(
      "Config validation: OK"
    );

  } catch (error) {

    const output = [

      error.stdout
        ?.toString() || "",

      error.stderr
        ?.toString() || ""

    ].join("\n");

    throw new Error(
      `Xray config invalid:\n${output}`
    );
  }
}

//
// ============================================================
// PROCESS STATUS
// ============================================================
//

function processAlive() {

  return Boolean(

    xray &&

    xray.exitCode === null &&

    !xray.killed
  );
}

//
// ============================================================
// TCP HEALTH
// ============================================================
//

function tcpHealthCheck() {

  return new Promise(
    resolve => {

      let finished =
        false;

      const socket =
        net.createConnection({

          host:
            "127.0.0.1",

          port:
            PORT
        });

      function finish(
        result
      ) {

        if (finished) {
          return;
        }

        finished =
          true;

        socket.destroy();

        resolve(result);
      }

      socket.setTimeout(

        HEALTH_TIMEOUT,

        () => finish(false)
      );

      socket.once(

        "connect",

        () => finish(true)
      );

      socket.once(

        "error",

        () => finish(false)
      );
    }
  );
}

//
// ============================================================
// RESTART POLICY
// ============================================================
//

function restartDelay() {

  return Math.min(

    BASE_RESTART_DELAY *

      Math.pow(
        2,

        Math.min(
          restartStreak,
          4
        )
      ),

    MAX_RESTART_DELAY
  );
}

function scheduleStart(
  reason
) {

  if (
    shuttingDown ||
    restartTimer ||
    processAlive()
  ) {
    return;
  }

  const delay =
    restartDelay();

  log(
    `Start scheduled in ${delay}ms | ${reason}`
  );

  restartTimer =
    setTimeout(
      () => {

        restartTimer =
          null;

        startXray();

      },

      delay
    );
}

//
// ============================================================
// START XRAY
// ============================================================
//

function startXray() {

  if (
    shuttingDown ||
    processAlive()
  ) {
    return;
  }

  healthFailures =
    0;

  xrayStartedAt =
    Date.now();

  state.lastStart =
    now();

  saveState();

  log(
    "Starting Xray..."
  );

  const proc =
    spawn(

      XRAY,

      [
        "run",
        "-config",
        CONFIG
      ],

      {
        stdio:
          "inherit"
      }
    );

  xray =
    proc;

  proc.once(

    "spawn",

    () => {

      log(
        `Xray started | PID=${proc.pid}`
      );
    }
  );

  proc.once(

    "error",

    error => {

      state.lastFailure =
        {
          time:
            now(),

          reason:
            `spawn ${error.message}`
        };

      saveState();

      log(
        `Xray process error: ${error.message}`
      );
    }
  );

  proc.once(

    "exit",

    (
      code,
      signal
    ) => {

      const runtime =
        Date.now() -
        xrayStartedAt;

      if (
        xray === proc
      ) {
        xray =
          null;
      }

      log(
        `Xray exited | code=${code} signal=${signal} runtime=${Math.round(runtime / 1000)}s`
      );

      if (
        shuttingDown
      ) {
        return;
      }

      state.totalRestarts++;

      state.lastFailure =
        {
          time:
            now(),

          reason:
            `process exit ${code}/${signal}`
        };

      saveState();

      if (
        runtime >=
        STABLE_RUNTIME
      ) {

        restartStreak =
          0;

      } else {

        restartStreak++;
      }

      scheduleStart(
        "process exit"
      );
    }
  );
}

//
// ============================================================
// FORCE RESTART
// ============================================================
//

function restartXray(
  reason
) {

  if (
    shuttingDown
  ) {
    return;
  }

  state.lastFailure =
    {
      time:
        now(),

      reason
    };

  saveState();

  log(
    `Restart requested | ${reason}`
  );

  const proc =
    xray;

  xray =
    null;

  if (
    proc &&
    proc.exitCode === null
  ) {

    proc.kill(
      "SIGTERM"
    );

    setTimeout(
      () => {

        if (
          proc.exitCode === null
        ) {

          log(
            "Graceful shutdown timed out; using SIGKILL."
          );

          proc.kill(
            "SIGKILL"
          );
        }
      },

      5000
    );
  }

  scheduleStart(
    reason
  );
}

//
// ============================================================
// HEALTH LOOP
// ============================================================
//

async function healthCheck() {

  if (
    shuttingDown ||
    healthRunning
  ) {
    return;
  }

  healthRunning =
    true;

  try {

    if (
      !processAlive()
    ) {

      log(
        "HEALTH FAIL | process down"
      );

      scheduleStart(
        "health process down"
      );

      return;
    }

    const age =
      Date.now() -
      xrayStartedAt;

    if (
      age <
      STARTUP_GRACE
    ) {
      return;
    }

    const tcpOK =
      await tcpHealthCheck();

    if (tcpOK) {

      healthFailures =
        0;

      state.lastHealthy =
        now();

      saveState();

      const uptime =
        Math.floor(
          (
            Date.now() -
            supervisorStartedAt
          ) /
          1000
        );

      const ram =
        Math.round(
          process
            .memoryUsage()
            .rss /
          1024 /
          1024
        );

      log(
        `HEALTH OK | PID=${xray.pid} | TCP=${PORT} OK | NodeRAM=${ram}MB | uptime=${uptime}s | restarts=${state.totalRestarts}`
      );

      return;
    }

    healthFailures++;

    log(
      `HEALTH FAIL | TCP=${PORT} | ${healthFailures}/${FAILURE_LIMIT}`
    );

    if (
      healthFailures >=
      FAILURE_LIMIT
    ) {

      healthFailures =
        0;

      restartXray(
        "TCP health failure"
      );
    }

  } finally {

    healthRunning =
      false;
  }
}

//
// ============================================================
// VLESS SHARE LINK
// ============================================================
//

function makeLink() {

  const query =
    new URLSearchParams({

      encryption:
        "none",

      security:
        "tls",

      sni:
        DOMAIN,

      fp:
        "chrome",

      type:
        "ws",

      host:
        DOMAIN,

      path:
        WS_PATH
    });

  return (
    `vless://${UUID}` +
    `@${DOMAIN}:443` +
    `?${query.toString()}` +
    "#Wispbyte-WS-Mobile"
  );
}

//
// ============================================================
// SHUTDOWN
// ============================================================
//

function shutdown(
  signal
) {

  if (
    shuttingDown
  ) {
    return;
  }

  shuttingDown =
    true;

  log(
    `Shutdown requested | ${signal}`
  );

  if (
    restartTimer
  ) {

    clearTimeout(
      restartTimer
    );

    restartTimer =
      null;
  }

  const proc =
    xray;

  xray =
    null;

  if (
    proc &&
    proc.exitCode === null
  ) {

    proc.kill(
      "SIGTERM"
    );

    setTimeout(
      () =>
        process.exit(0),

      5000
    );

  } else {

    process.exit(0);
  }
}

//
// ============================================================
// MAIN
// ============================================================
//

async function main() {

  loadState();

  await installXray();

  writeConfig();

  validateConfig();

  console.log(`
================================================
WISPBYTE MOBILE GATEWAY
================================================

Origin IP:
${SERVER_IP}

Origin Port:
${PORT}

Public Domain:
${DOMAIN}

Public Port:
443

Protocol:
VLESS

Transport:
WebSocket

Path:
${WS_PATH}

Client TLS:
YES

Origin TLS:
NO

Mux:
OFF

Config Validation:
ENABLED

Process Monitoring:
ENABLED

Health Monitoring:
ENABLED

Crash Recovery:
ENABLED

Crash-loop Backoff:
ENABLED

Persistent Supervisor State:
ENABLED

External Keep-alive:
DISABLED

================================================
V2RAYN / MOBILE IMPORT
================================================

${makeLink()}

================================================
`);

  startXray();

  setTimeout(
    healthCheck,
    STARTUP_GRACE
  );

  setInterval(
    healthCheck,
    HEALTH_INTERVAL
  );
}

//
// ============================================================
// SIGNALS
// ============================================================
//

process.on(
  "SIGTERM",

  () =>
    shutdown(
      "SIGTERM"
    )
);

process.on(
  "SIGINT",

  () =>
    shutdown(
      "SIGINT"
    )
);

process.on(
  "uncaughtException",

  error => {

    console.error(
      "[FATAL uncaughtException]",
      error
    );

    process.exit(1);
  }
);

process.on(
  "unhandledRejection",

  error => {

    console.error(
      "[FATAL unhandledRejection]",
      error
    );

    process.exit(1);
  }
);

main().catch(
  error => {

    console.error(
      "[FATAL]",
      error
    );

    process.exit(1);
  }
);

"use strict";

/**
 * NTQQ Pure JS Entrypoint Wrapper (/opt/QQ/resources/app/app_launcher/index.js)
 *
 * Replaces the default unhooked launcher by initializing `bridge_main.js`
 * BEFORE `major.node` loads `internal_index` (908.background.js), without
 * any C++ `.so` / `LD_PRELOAD` memory hooks.
 *
 * All O3 telemetry (`nodeIO3MiscService/*`), `UserBehaviorReportService`,
 * `PerformanceApi`, and `LoggerApi` remain 100% untouched.
 */

const path = require("path");
const { isBridgeDisabledFromEnv, isTestModeFromEnv } = require("./core/env");

function bootBridgeMain() {
  if (isBridgeDisabledFromEnv()) {
    return null;
  }
  try {
    const bridgeMainPath = path.join(__dirname, "bridge_main.js");
    const bridgeMain = require(bridgeMainPath);
    if (bridgeMain && typeof bridgeMain.installMainBridge === "function") {
      return bridgeMain.installMainBridge();
    }
    return bridgeMain;
  } catch (err) {
    try {
      process.stderr.write(
        `[rosmontis] Pre-boot bridge_main initialization error (non-fatal): ${
          err && err.stack ? err.stack : String(err)
        }\n`
      );
    } catch (_) {}
    return null;
  }
}

function loadOfficialInternalIndex(targetModule, majorNodeLoader) {
  const loader =
    majorNodeLoader ||
    (() => {
      const majorPath = path.resolve(__dirname, "..", "major.node");
      return require(majorPath);
    })();
  return loader.load("internal_index", targetModule || module);
}

if (!isTestModeFromEnv()) {
  bootBridgeMain();
  loadOfficialInternalIndex(module);
}

module.exports = {
  bootBridgeMain,
  loadOfficialInternalIndex,
};

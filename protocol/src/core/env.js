"use strict";

const os = require("os");
const path = require("path");

const BRIDGE_ENV_PREFIXES = Object.freeze(["ROSMONTIS", "ONEBOT", "XIAO_BRIDGE"]);

function _getEnv() {
  return (typeof process !== "undefined" && process && process.env) || {};
}

function _flattenKeyList(keys, moreKeys = []) {
  const out = [];
  const append = (item) => {
    if (Array.isArray(item)) {
      for (const sub of item) append(sub);
    } else if (typeof item === "string" && item.trim() !== "") {
      out.push(item.trim());
    }
  };
  if (keys !== undefined && keys !== null) {
    append(keys);
  }
  for (const extra of moreKeys) {
    if (extra !== undefined && extra !== null) {
      append(extra);
    }
  }
  return out;
}

function buildPrefixedEnvKeys(suffix, extraKeys = [], ...moreKeys) {
  const cleanSuffix = String(suffix || "")
    .trim()
    .replace(/^_+/, "");
  const prefixed = cleanSuffix
    ? BRIDGE_ENV_PREFIXES.map((prefix) => `${prefix}_${cleanSuffix}`)
    : [];
  const extras = _flattenKeyList(extraKeys, moreKeys);
  return [...prefixed, ...extras];
}

function pickEnv(...keys) {
  const env = _getEnv();
  const flatKeys = _flattenKeyList(keys);
  for (const key of flatKeys) {
    const val = env[key];
    if (val !== undefined && val !== null) {
      const trimmed = String(val).trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }
  }
  return "";
}

function pickPrefixedEnv(suffix, extraKeys = [], ...moreKeys) {
  return pickEnv(...buildPrefixedEnvKeys(suffix, extraKeys, ...moreKeys));
}

function collectPrefixedEnvValues(suffix, extraKeys = [], ...moreKeys) {
  const env = _getEnv();
  const keys = buildPrefixedEnvKeys(suffix, extraKeys, ...moreKeys);
  const values = [];
  for (const key of keys) {
    const val = env[key];
    if (val !== undefined && val !== null) {
      const trimmed = String(val).trim();
      if (trimmed !== "") {
        values.push(trimmed);
      }
    }
  }
  return values;
}

function parseBoolString(str) {
  if (str === undefined || str === null) return undefined;
  const lower = String(str).trim().toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes") return true;
  if (lower === "0" || lower === "false" || lower === "no") return false;
  return undefined;
}

function parsePrefixedEnvBool(suffix, extraKeys = [], ...moreKeys) {
  const env = _getEnv();
  const keys = buildPrefixedEnvKeys(suffix, extraKeys, ...moreKeys);
  for (const key of keys) {
    const parsed = parseBoolString(env[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function isPrefixedEnvTruthy(suffix, extraKeys = [], ...moreKeys) {
  return parsePrefixedEnvBool(suffix, extraKeys, ...moreKeys) === true;
}

function isEnvFlagOne(keys, ...moreKeys) {
  const env = _getEnv();
  const flatKeys = _flattenKeyList(keys, moreKeys);
  for (const key of flatKeys) {
    if (env[key] === "1") {
      return true;
    }
  }
  return false;
}

function isPrefixedEnvFlagOne(suffix, extraKeys = [], ...moreKeys) {
  return isEnvFlagOne(buildPrefixedEnvKeys(suffix, extraKeys, ...moreKeys));
}

function isBridgeDisabledFromEnv() {
  return isEnvFlagOne([
    "ROSMONTIS_DISABLE",
    "ROSMONTIS_BRIDGE_DISABLE",
    "XIAO_BRIDGE_DISABLE",
  ]);
}

function isAutoInstallDisabledFromEnv() {
  return isEnvFlagOne([
    "ROSMONTIS_NO_AUTOINSTALL",
    "ROSMONTIS_BRIDGE_NO_AUTOINSTALL",
    "XIAO_BRIDGE_NO_AUTOINSTALL",
  ]);
}

function isTestModeFromEnv() {
  return isEnvFlagOne(["ROSMONTIS_TEST_MODE", "XIAO_BRIDGE_TEST_MODE"]);
}

function isQuietLogsEnabled(config) {
  return Boolean(config?.quietLogs) || isPrefixedEnvTruthy("QUIET");
}

function isDebugLogsEnabled(config) {
  return Boolean(config?.debugLogs) || isPrefixedEnvTruthy("DEBUG");
}

function getHomeDir() {
  const env = _getEnv();
  return env.HOME || os.homedir();
}

function getTempBaseDir() {
  const env = _getEnv();
  return env.HOME || os.tmpdir();
}

function getXdgConfigHome() {
  const env = _getEnv();
  return env.XDG_CONFIG_HOME || "";
}

function resolveTempDirFromEnv(explicitTempDir) {
  if (typeof explicitTempDir === "string" && explicitTempDir.trim() !== "") {
    return explicitTempDir.trim();
  }
  return pickPrefixedEnv("TEMP_DIR") || path.join(getTempBaseDir(), ".rosmontis_tmp");
}

function resolveConfigDirsFromEnv() {
  const env = _getEnv();
  return [
    env.ROSMONTIS_CONFIG_DIR,
    env.ONEBOT_CONFIG_DIR,
    env.XIAO_BRIDGE_CONFIG_DIR,
  ].filter(Boolean);
}

module.exports = {
  BRIDGE_ENV_PREFIXES,
  buildPrefixedEnvKeys,
  pickEnv,
  pickPrefixedEnv,
  collectPrefixedEnvValues,
  parseBoolString,
  parsePrefixedEnvBool,
  isPrefixedEnvTruthy,
  isEnvFlagOne,
  isPrefixedEnvFlagOne,
  isBridgeDisabledFromEnv,
  isAutoInstallDisabledFromEnv,
  isTestModeFromEnv,
  isQuietLogsEnabled,
  isDebugLogsEnabled,
  getHomeDir,
  getTempBaseDir,
  getXdgConfigHome,
  resolveTempDirFromEnv,
  resolveConfigDirsFromEnv,
};

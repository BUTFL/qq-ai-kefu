"use strict";

const fs = require("fs");
const path = require("path");

const envHelpers = require("./env");
const {
  pickPrefixedEnv,
  parseBoolString,
  parsePrefixedEnvBool,
  resolveConfigDirsFromEnv,
} = envHelpers;

const {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
} = require("./transport_security");
const { DEFAULT_MAX_WS_SEND_BUFFER_BYTES } = require("./ws_rfc6455");

function filterEnabledEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (item) => item && typeof item === "object" && item.enable !== false && item.enabled !== false
    )
    .map((item) => ({ ...item }));
}

function _resolveBoolWithDefault(rawVal, defaultVal, suffix, extraKeys = []) {
  const parsedEnv = parsePrefixedEnvBool(suffix, extraKeys);
  if (parsedEnv !== undefined) return parsedEnv;
  if (rawVal !== undefined && rawVal !== null) {
    if (typeof rawVal === "string") {
      const parsedRaw = parseBoolString(rawVal);
      if (parsedRaw !== undefined) return parsedRaw;
    }
    return Boolean(rawVal);
  }
  return defaultVal;
}

function _resolvePositiveIntWithDefault(rawVal, defaultVal, suffix, extraKeys = []) {
  const envRaw = pickPrefixedEnv(suffix, extraKeys);
  if (envRaw !== "") {
    const envNum = Number(envRaw);
    if (Number.isFinite(envNum) && envNum > 0) return Math.floor(envNum);
  }
  if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
    const rawNum = Number(rawVal);
    if (Number.isFinite(rawNum) && rawNum > 0) return Math.floor(rawNum);
  }
  return defaultVal;
}

function _resolveNonNegativeNumberWithDefault(rawVal, defaultVal, suffix, extraKeys = []) {
  const envRaw = pickPrefixedEnv(suffix, extraKeys);
  if (envRaw !== "") {
    const envNum = Number(envRaw);
    if (Number.isFinite(envNum) && envNum >= 0) return envNum;
  }
  if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
    const rawNum = Number(rawVal);
    if (Number.isFinite(rawNum) && rawNum >= 0) return rawNum;
  }
  return defaultVal;
}

function _normalizeDelaySpec(candidate) {
  if (Array.isArray(candidate) && candidate.length >= 2) {
    const min = Number(candidate[0]);
    const max = Number(candidate[1]);
    if (Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= 0) {
      return min <= max ? [min, max] : [max, min];
    }
    return undefined;
  }
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
    return candidate;
  }
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      const norm = _normalizeDelaySpec(parsed);
      if (norm !== undefined) return norm;
    } catch (_) {}
    const rangeMatch = /^(\d+(?:\.\d+)?)\s*[,-]\s*(\d+(?:\.\d+)?)$/.exec(trimmed);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      return a <= b ? [a, b] : [b, a];
    }
    const single = Number(trimmed);
    if (Number.isFinite(single) && single >= 0) return single;
  }
  return undefined;
}

function _resolveDelaySpecWithDefault(rawVal, defaultVal, suffix, extraKeys = []) {
  const envRaw = pickPrefixedEnv(suffix, extraKeys);
  if (envRaw !== "") {
    const fromEnv = _normalizeDelaySpec(envRaw);
    if (fromEnv !== undefined) return fromEnv;
  }
  if (rawVal !== undefined && rawVal !== null) {
    const fromRaw = _normalizeDelaySpec(rawVal);
    if (fromRaw !== undefined) return fromRaw;
  }
  return Array.isArray(defaultVal) ? [...defaultVal] : defaultVal;
}

function _applyOptionalBoolOverride(target, key, rawObj, suffix, extraKeys = []) {
  const parsed = parsePrefixedEnvBool(suffix, extraKeys);
  if (parsed !== undefined) {
    target[key] = parsed;
    return;
  }
  if (rawObj && rawObj[key] !== undefined) {
    if (typeof rawObj[key] === "string") {
      const parsedRaw = parseBoolString(rawObj[key]);
      if (parsedRaw !== undefined) {
        target[key] = parsedRaw;
        return;
      }
    }
    target[key] = Boolean(rawObj[key]);
  }
}

function _applyOptionalNumberOverride(target, key, rawObj, suffix, extraKeys = []) {
  const envRaw = pickPrefixedEnv(suffix, extraKeys);
  if (envRaw !== "") {
    const num = Number(envRaw);
    if (Number.isFinite(num) && num >= 0) {
      target[key] = num;
      return;
    }
  }
  if (rawObj && rawObj[key] !== undefined) {
    const num = Number(rawObj[key]);
    if (Number.isFinite(num) && num >= 0) {
      target[key] = num;
    }
  }
}

function loadBridgeConfig(customConfigDir) {
  const envSelfUin = pickPrefixedEnv("SELF_ID");
  const envHeartbeatRaw = pickPrefixedEnv("HEARTBEAT_MS");
  const envMessageFormatRaw = pickPrefixedEnv("MESSAGE_FORMAT").toLowerCase();

  const defaultConfig = {
    selfUin: envSelfUin,
    selfNickname: pickPrefixedEnv("SELF_NICKNAME") || "Rosmontis",
    httpServers: [],
    wsServers: [],
    wsClients: [],
    heartbeatIntervalMs: envHeartbeatRaw !== "" ? Number(envHeartbeatRaw) : 5000,
  };

  const searchDirs = customConfigDir
    ? [customConfigDir]
    : [
        ...resolveConfigDirsFromEnv(),
        "/etc/rosmontis",
        "/app/data/config",
        "/app/config",
        "/opt/QQ/config",
        path.resolve(process.cwd(), "config"),
      ].filter(Boolean);

  let loadedFromFile = false;
  let hasExplicitHttpServersKey = false;
  let hasExplicitWsServersKey = false;
  let loadedRaw = {};

  for (const dir of searchDirs) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const cfgPattern = /^(?:rosmontis|onebot|xiao_bridge)(?:_([a-zA-Z0-9_-]+))?\.json$/;
      const files = fs
        .readdirSync(dir)
        .filter((f) => cfgPattern.test(f) && !f.endsWith(".example.json"));
      if (files.length === 0) continue;

      const parsedEntries = [];
      for (const file of files) {
        try {
          const fullPath = path.join(dir, file);
          const m = cfgPattern.exec(file);
          const suffix = m && m[1] ? m[1] : "";
          const uin = /^\d+$/.test(suffix) ? suffix : "";
          const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          const stat = fs.statSync(fullPath);
          const nets = raw?.networks || {};
          const enabledWsClients = filterEnabledEntries(nets.wsClients);
          const hasWsClients = enabledWsClients.length > 0;
          parsedEntries.push({
            file,
            uin,
            raw: raw && typeof raw === "object" ? raw : {},
            nets,
            hasWsClients,
            mtimeMs: Number(stat?.mtimeMs || 0),
          });
        } catch (_) {}
      }
      if (parsedEntries.length === 0) continue;

      parsedEntries.sort((a, b) => {
        if (envSelfUin) {
          if (a.uin === envSelfUin && b.uin !== envSelfUin) return -1;
          if (b.uin === envSelfUin && a.uin !== envSelfUin) return 1;
        }
        if (a.hasWsClients !== b.hasWsClients) {
          return a.hasWsClients ? -1 : 1;
        }
        if (Boolean(a.uin) !== Boolean(b.uin)) {
          return a.uin ? -1 : 1;
        }
        if (b.mtimeMs !== a.mtimeMs) {
          return b.mtimeMs - a.mtimeMs;
        }
        return a.file.localeCompare(b.file);
      });

      const bestEntry = parsedEntries[0];
      if (bestEntry) {
        const { uin, raw, nets } = bestEntry;
        loadedRaw = raw;
        if (!defaultConfig.selfUin && uin) {
          defaultConfig.selfUin = uin;
        }
        if (envHeartbeatRaw === "" && raw.heartbeatIntervalMs !== undefined) {
          const fileHb = Number(raw.heartbeatIntervalMs);
          if (Number.isFinite(fileHb) && fileHb >= 0) {
            defaultConfig.heartbeatIntervalMs = fileHb;
          }
        }
        for (const optKey of [
          "humanSimulation",
          "aioIdleExitMs",
          "focusIdleBlurMs",
          "sendEchoTimeoutMs",
          "richMediaEchoTimeoutMs",
          "dedupeWindowMs",
          "autoQuickLogin",
          "maxMediaBytes",
          "allowPrivateMediaUrls",
          "allowPrivateUrls",
          "allowArbitraryLocalFiles",
          "allowedFileDirs",
        ]) {
          if (raw && raw[optKey] !== undefined) {
            defaultConfig[optKey] = raw[optKey];
          }
        }
        hasExplicitHttpServersKey = Array.isArray(nets.httpServers);
        hasExplicitWsServersKey = Array.isArray(nets.wsServers);
        defaultConfig.httpServers.push(...filterEnabledEntries(nets.httpServers));
        defaultConfig.wsServers.push(...filterEnabledEntries(nets.wsServers));
        defaultConfig.wsClients.push(...filterEnabledEntries(nets.wsClients));
        loadedFromFile = true;
      }
      if (loadedFromFile) break;
    } catch (_) {}
  }

  // Logging, diagnostics & runtime flags (JSON + env overrides)
  defaultConfig.debugLogs = _resolveBoolWithDefault(loadedRaw.debugLogs, false, "DEBUG");
  defaultConfig.quietLogs = _resolveBoolWithDefault(loadedRaw.quietLogs, false, "QUIET");
  defaultConfig.keepMapHook = _resolveBoolWithDefault(
    loadedRaw.keepMapHook,
    false,
    "KEEP_MAP_HOOK"
  );

  const envTempDir = pickPrefixedEnv("TEMP_DIR");
  const rawTempDir = typeof loadedRaw.tempDir === "string" ? loadedRaw.tempDir.trim() : "";
  if (envTempDir || rawTempDir) {
    defaultConfig.tempDir = envTempDir || rawTempDir;
  }

  // Security & transport configuration keys (JSON + env overrides)
  defaultConfig.enableWebCredentialApi = _resolveBoolWithDefault(
    loadedRaw.enableWebCredentialApi,
    false,
    "ENABLE_WEB_CREDENTIAL_API"
  );

  defaultConfig.allowUnauthenticatedPublicBind = _resolveBoolWithDefault(
    loadedRaw.allowUnauthenticatedPublicBind,
    false,
    "ALLOW_UNAUTHENTICATED_PUBLIC"
  );

  defaultConfig.allowQueryAccessToken = _resolveBoolWithDefault(
    loadedRaw.allowQueryAccessToken,
    true,
    "ALLOW_QUERY_TOKEN"
  );

  const envAllowedOrigins = pickPrefixedEnv("ALLOWED_ORIGINS");
  if (envAllowedOrigins !== "") {
    defaultConfig.allowedOrigins = envAllowedOrigins
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(loadedRaw.allowedOrigins)) {
    defaultConfig.allowedOrigins = loadedRaw.allowedOrigins
      .map((s) => String(s ?? "").trim())
      .filter(Boolean);
  } else {
    defaultConfig.allowedOrigins = [];
  }

  defaultConfig.maxHttpBodyBytes = _resolvePositiveIntWithDefault(
    loadedRaw.maxHttpBodyBytes,
    DEFAULT_MAX_HTTP_BODY_BYTES,
    "MAX_HTTP_BODY_BYTES"
  );

  defaultConfig.maxWsPayloadBytes = _resolvePositiveIntWithDefault(
    loadedRaw.maxWsPayloadBytes,
    DEFAULT_MAX_WS_PAYLOAD_BYTES,
    "MAX_WS_PAYLOAD_BYTES"
  );

  defaultConfig.maxWsSendBufferBytes = _resolvePositiveIntWithDefault(
    loadedRaw.maxWsSendBufferBytes,
    DEFAULT_MAX_WS_SEND_BUFFER_BYTES,
    "MAX_WS_SEND_BUFFER_BYTES"
  );

  defaultConfig.wsPingIntervalMs = _resolveNonNegativeNumberWithDefault(
    loadedRaw.wsPingIntervalMs,
    30000,
    "WS_PING_INTERVAL_MS"
  );

  defaultConfig.wsPongTimeoutMs = _resolvePositiveIntWithDefault(
    loadedRaw.wsPongTimeoutMs,
    90000,
    "WS_PONG_TIMEOUT_MS"
  );

  defaultConfig.forwardEchoTimeoutMs = _resolveNonNegativeNumberWithDefault(
    loadedRaw.forwardEchoTimeoutMs,
    0,
    "FORWARD_ECHO_TIMEOUT_MS"
  );

  _applyOptionalBoolOverride(
    defaultConfig,
    "allowPtloginJump",
    loadedRaw,
    "ALLOW_PTLOGIN_JUMP"
  );

  _applyOptionalBoolOverride(
    defaultConfig,
    "allowExternalHttp",
    loadedRaw,
    "ALLOW_EXTERNAL_HTTP"
  );

  // Causal timeline & runtime lifecycle keys
  defaultConfig.autoReadAndTypeOnPrivateRecv = _resolveBoolWithDefault(
    loadedRaw.autoReadAndTypeOnPrivateRecv,
    false,
    "AUTO_READ_AND_TYPE_ON_PRIVATE_RECV"
  );

  defaultConfig.autoReadReactionDelayMs = _resolveDelaySpecWithDefault(
    loadedRaw.autoReadReactionDelayMs,
    [500, 1800],
    "AUTO_READ_REACTION_DELAY_MS"
  );

  defaultConfig.aioSwitchCooldownMs = _resolveNonNegativeNumberWithDefault(
    loadedRaw.aioSwitchCooldownMs,
    800,
    "AIO_SWITCH_COOLDOWN_MS"
  );

  defaultConfig.humanReadToTypingDelayMs = _resolveDelaySpecWithDefault(
    loadedRaw.humanReadToTypingDelayMs,
    0,
    "HUMAN_READ_TO_TYPING_DELAY_MS"
  );

  _applyOptionalBoolOverride(
    defaultConfig,
    "cleanupTempImmediately",
    loadedRaw,
    "CLEANUP_TEMP_IMMEDIATELY"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "maxTempCleanupRing",
    loadedRaw,
    "MAX_TEMP_CLEANUP_RING"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "tempCleanupDelayMs",
    loadedRaw,
    "TEMP_CLEANUP_DELAY_MS"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "mapHookMaxLifetimeMs",
    loadedRaw,
    "MAP_HOOK_MAX_LIFETIME_MS"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "mapHookReleaseDelayMs",
    loadedRaw,
    "MAP_HOOK_RELEASE_DELAY_MS"
  );

  _applyOptionalNumberOverride(
    defaultConfig,
    "maxSendEchoTimeoutMs",
    loadedRaw,
    "MAX_SEND_ECHO_TIMEOUT_MS"
  );

  defaultConfig.messageFormat =
    (envMessageFormatRaw ||
      loadedRaw.messageFormat ||
      loadedRaw.post_message_format ||
      "array") === "string"
      ? "string"
      : "array";

  const envCompatProfile = pickPrefixedEnv("COMPAT_PROFILE").toLowerCase();
  const rawCompatProfile = String(
    envCompatProfile || loadedRaw.compatProfile || loadedRaw.compat_profile || "rosmontis"
  )
    .trim()
    .toLowerCase();
  defaultConfig.compatProfile =
    rawCompatProfile === "snowluma" || rawCompatProfile === "napcat"
      ? rawCompatProfile
      : "rosmontis";

  const envCompatAppName = pickPrefixedEnv("COMPAT_APP_NAME");
  const rawCompatAppName = String(
    envCompatAppName || loadedRaw.compatAppName || loadedRaw.compat_app_name || ""
  ).trim();
  if (rawCompatAppName) {
    defaultConfig.compatAppName = rawCompatAppName;
  }
  if (loadedRaw.compatAppVersion || loadedRaw.compat_app_version) {
    defaultConfig.compatAppVersion = String(
      loadedRaw.compatAppVersion || loadedRaw.compat_app_version
    ).trim();
  }

  const envHttpPort = Number(pickPrefixedEnv("HTTP_PORT") || 0);
  const envWsPort = Number(pickPrefixedEnv("WS_PORT") || 0);
  const envRevWsUrl = pickPrefixedEnv("REVERSE_WS_URL");
  const envToken = pickPrefixedEnv("ACCESS_TOKEN");
  const listenHost = pickPrefixedEnv("HOST") || "0.0.0.0";

  if (
    defaultConfig.httpServers.length === 0 &&
    (!loadedFromFile || !hasExplicitHttpServersKey || envHttpPort > 0)
  ) {
    defaultConfig.httpServers.push({
      name: "http-default",
      host: listenHost,
      port: envHttpPort || 3000,
      accessToken: envToken,
      reportSelfMessage: false,
    });
  } else if (envHttpPort > 0 && defaultConfig.httpServers.length > 0) {
    defaultConfig.httpServers[0].port = envHttpPort;
  }

  if (
    defaultConfig.wsServers.length === 0 &&
    (!loadedFromFile || !hasExplicitWsServersKey || envWsPort > 0)
  ) {
    defaultConfig.wsServers.push({
      name: "ws-default",
      host: listenHost,
      port: envWsPort || 3001,
      accessToken: envToken,
      reportSelfMessage: false,
    });
  } else if (envWsPort > 0 && defaultConfig.wsServers.length > 0) {
    defaultConfig.wsServers[0].port = envWsPort;
  }

  if (envRevWsUrl) {
    defaultConfig.wsClients = [
      {
        name: "wsclient-env",
        url: envRevWsUrl,
        accessToken: envToken,
        reportSelfMessage: false,
        reconnectIntervalMs: 5000,
      },
    ];
  }

  for (const entry of [
    ...defaultConfig.httpServers,
    ...defaultConfig.wsServers,
    ...defaultConfig.wsClients,
  ]) {
    entry.messageFormat =
      (entry.messageFormat ||
        entry.post_message_format ||
        loadedRaw.messageFormat ||
        loadedRaw.post_message_format ||
        envMessageFormatRaw ||
        "array") === "string"
        ? "string"
        : "array";
  }

  if (envToken) {
    for (const s of defaultConfig.httpServers) s.accessToken = envToken;
    for (const s of defaultConfig.wsServers) s.accessToken = envToken;
    for (const c of defaultConfig.wsClients) c.accessToken = envToken;
  }

  return defaultConfig;
}

function resolveCompatVersionInfo(config = {}, context = {}) {
  const appNameOverride = String(
    context?.compatAppName ?? config?.compatAppName ?? ""
  ).trim();
  const profileRaw = String(
    context?.compatProfile ?? config?.compatProfile ?? "rosmontis"
  )
    .trim()
    .toLowerCase();

  let appName = "Rosmontis";
  if (appNameOverride) {
    appName = appNameOverride;
  } else if (profileRaw === "snowluma") {
    appName = "SnowLuma";
  } else if (profileRaw === "napcat") {
    appName = "NapCat.Onebot";
  }

  const appVersion =
    String(context?.compatAppVersion ?? config?.compatAppVersion ?? "1.0.0").trim() ||
    "1.0.0";

  return {
    app_name: appName,
    app_version: appVersion,
    protocol_version: "v11",
    ...(appName !== "Rosmontis"
      ? { bridge_name: "Rosmontis", bridge_version: "1.0.0" }
      : {}),
  };
}

module.exports = {
  ...envHelpers,
  filterEnabledEntries,
  loadBridgeConfig,
  resolveCompatVersionInfo,
};

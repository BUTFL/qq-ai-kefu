"use strict";

const crypto = require("crypto");
const { isPrefixedEnvFlagOne } = require("./env");

const DEFAULT_MAX_HTTP_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024; // 16 MiB

const VALID_HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
  "::ffff:127.0.0.1",
]);

function sanitizeHeaderValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\r\n\0]+/g, "");
}

function isValidHttpHeaderName(name) {
  return typeof name === "string" && name.length > 0 && VALID_HTTP_HEADER_NAME_RE.test(name);
}

function verifyAccessTokenConstantTime(providedToken, expectedToken) {
  if (!expectedToken) return true;
  if (typeof providedToken !== "string" || providedToken.length === 0) return false;
  const hashA = crypto
    .createHash("sha256")
    .update(Buffer.from(providedToken, "utf8"))
    .digest();
  const hashB = crypto
    .createHash("sha256")
    .update(Buffer.from(String(expectedToken), "utf8"))
    .digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function extractAccessTokenFromRequest(req, parsedUrl, { allowQueryToken = true } = {}) {
  const headers = req && req.headers ? req.headers : null;
  if (headers) {
    const rawAuth =
      typeof headers.authorization === "string"
        ? headers.authorization
        : typeof headers.Authorization === "string"
        ? headers.Authorization
        : "";
    const trimmedAuth = rawAuth.trim();
    if (trimmedAuth.length > 0) {
      const schemeMatch = /^(?:Bearer|Token)\s+([\s\S]+)$/i.exec(trimmedAuth);
      return schemeMatch ? schemeMatch[1].trim() : trimmedAuth;
    }
  }

  if (allowQueryToken !== false) {
    let urlObj = parsedUrl;
    if (!urlObj && req && typeof req.url === "string") {
      try {
        urlObj = new URL(req.url || "/", "http://127.0.0.1");
      } catch (_) {}
    }
    const queryToken = urlObj?.searchParams?.get("access_token");
    if (typeof queryToken === "string" && queryToken.length > 0) {
      return queryToken;
    }
  }

  return "";
}

function checkRequestAuth(req, expectedToken, { allowQueryToken = true, parsedUrl = null } = {}) {
  if (!expectedToken) return true;
  const providedToken = extractAccessTokenFromRequest(req, parsedUrl, { allowQueryToken });
  return verifyAccessTokenConstantTime(providedToken, expectedToken);
}

function checkOriginHeader(req, { allowedOrigins = [] } = {}) {
  const headers = req && req.headers ? req.headers : null;
  const rawOrigin = headers
    ? headers.origin !== undefined
      ? headers.origin
      : headers.Origin
    : undefined;

  if (rawOrigin === undefined) {
    return { allowed: true, origin: null };
  }

  const originStr = String(rawOrigin);
  const normalizedOrigin = originStr.trim().toLowerCase();
  const normalizedAllowed = Array.isArray(allowedOrigins)
    ? allowedOrigins.map((o) => String(o ?? "").trim()).filter(Boolean)
    : [];

  if (
    normalizedAllowed.includes("*") ||
    normalizedAllowed.some((o) => o.toLowerCase() === normalizedOrigin)
  ) {
    return { allowed: true, origin: originStr };
  }

  return {
    allowed: false,
    origin: originStr,
    reason: "Cross-origin browser request blocked by Rosmontis Origin guard",
  };
}

function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  return LOOPBACK_HOSTS.has(normalized);
}

function enforceProtectedModeOnServers(serverEntries, globalConfig = {}, onWarn = null) {
  const cfg = globalConfig && typeof globalConfig === "object" ? globalConfig : {};
  const allowUnauthenticatedPublic =
    cfg.allowUnauthenticatedPublicBind === true ||
    isPrefixedEnvFlagOne("ALLOW_UNAUTHENTICATED_PUBLIC");

  if (!Array.isArray(serverEntries) || serverEntries.length === 0 || allowUnauthenticatedPublic) {
    return { protectedCount: 0, generatedToken: cfg._generatedProtectedToken || null };
  }

  let protectedCount = 0;
  for (const entry of serverEntries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.enable === false || entry.enabled === false) continue;

    const host = String(entry.host || "0.0.0.0").trim() || "0.0.0.0";
    const existingToken =
      typeof entry.accessToken === "string" ? entry.accessToken.trim() : entry.accessToken;

    if (!isLoopbackHost(host) && !existingToken) {
      if (!cfg._generatedProtectedToken || typeof cfg._generatedProtectedToken !== "string") {
        cfg._generatedProtectedToken = crypto.randomBytes(32).toString("hex");
      }
      entry.accessToken = cfg._generatedProtectedToken;
      entry.protectedModeAutoToken = true;
      protectedCount += 1;
    }
  }

  if (protectedCount > 0 && typeof onWarn === "function" && !cfg._protectedModeWarned) {
    Object.defineProperty(cfg, "_protectedModeWarned", {
      value: true,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    const token = cfg._generatedProtectedToken;
    onWarn(
      `[Rosmontis Security] Protected Mode engaged: ${protectedCount} server listener(s) bound to non-loopback address without an accessToken. ` +
        `Generated ephemeral access token: ${token} — Configure ROSMONTIS_ACCESS_TOKEN (or accessToken in rosmontis.json), ` +
        `or bind host: "127.0.0.1" for local-only access.`
    );
  }

  return {
    protectedCount,
    generatedToken: protectedCount > 0 ? cfg._generatedProtectedToken : cfg._generatedProtectedToken || null,
  };
}

function _createBodyTooLargeError(limit) {
  const err = new Error(`HTTP request body exceeds maximum limit (${limit} bytes)`);
  err.statusCode = 413;
  err.code = "ERR_HTTP_BODY_TOO_LARGE";
  return err;
}

function readHttpJsonBody(req, { maxBodyBytes = DEFAULT_MAX_HTTP_BODY_BYTES } = {}) {
  const parsedMax = Number(maxBodyBytes);
  const limit =
    Number.isFinite(parsedMax) && parsedMax > 0
      ? Math.floor(parsedMax)
      : DEFAULT_MAX_HTTP_BODY_BYTES;

  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== "function") {
      return resolve({});
    }

    let settled = false;
    const chunks = [];
    let totalBytes = 0;

    const cleanup = () => {
      if (typeof req.removeListener === "function") {
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
      }
    };

    const abortTooLarge = () => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      try {
        if (typeof req.pause === "function") req.pause();
        if (req.socket && !req.socket.destroyed) {
          const destroyTimer = setTimeout(() => {
            try {
              if (!req.complete && typeof req.destroy === "function") {
                req.destroy();
              }
            } catch (_) {}
          }, 1000);
          if (typeof destroyTimer.unref === "function") destroyTimer.unref();
        }
      } catch (_) {}
      reject(_createBodyTooLargeError(limit));
    };

    const headers = req.headers || {};
    const contentLengthRaw =
      headers["content-length"] !== undefined
        ? headers["content-length"]
        : headers["Content-Length"];
    if (contentLengthRaw !== undefined && String(contentLengthRaw).trim() !== "") {
      const declaredLength = Number(contentLengthRaw);
      if (Number.isFinite(declaredLength) && declaredLength > limit) {
        abortTooLarge();
        return;
      }
    }

    function onData(chunk) {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      totalBytes += buf.length;
      if (totalBytes > limit) {
        abortTooLarge();
        return;
      }
      chunks.push(buf);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      if (totalBytes === 0 || chunks.length === 0) {
        return resolve({});
      }
      try {
        const rawStr = Buffer.concat(chunks, totalBytes).toString("utf8").trim();
        chunks.length = 0;
        if (!rawStr) return resolve({});
        const parsed = JSON.parse(rawStr);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return resolve(parsed);
        }
        return resolve({});
      } catch (_) {
        return resolve({});
      }
    }

    function onError(err) {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      reject(err);
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

module.exports = {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
  sanitizeHeaderValue,
  isValidHttpHeaderName,
  verifyAccessTokenConstantTime,
  extractAccessTokenFromRequest,
  checkRequestAuth,
  checkOriginHeader,
  isLoopbackHost,
  enforceProtectedModeOnServers,
  readHttpJsonBody,
};

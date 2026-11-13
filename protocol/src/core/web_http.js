"use strict";

const http = require("http");
const https = require("https");
const net = require("net");

const {
  buildNtqqUserAgent,
  isPrivateOrReservedIp,
  createSsrfSafeLookup,
} = require("./media_security");
const { sanitizeHeaderValue, isValidHttpHeaderName } = require("./transport_security");
const { pickEnv, isPrefixedEnvTruthy } = require("./env");

const DEFAULT_MAX_WEB_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MiB

const TRUSTED_TENCENT_ROOT_DOMAINS = Object.freeze([
  "qq.com",
  "tenpay.com",
  "gtimg.cn",
  "gtimg.com",
  "weiyun.com",
  "tencent.com",
  "qlogo.cn",
  "qpic.cn",
  "myqcloud.com",
  "qcloud.com",
]);

const WEB_CREDENTIAL_ACTIONS = new Set([
  "get_clientkey",
  "get_cookies",
  "get_csrf_token",
  "get_credentials",
  "get_qzone_msg_list",
  "get_qzone_feeds",
  "send_qzone_msg",
  "delete_qzone_msg",
  "like_qzone",
  "unlike_qzone",
  "comment_qzone",
]);

const REQUEST_OPTION_KEYS = new Set([
  "allowPrivateUrls",
  "timeoutMs",
  "maxResponseBytes",
  "redirectsLeft",
  "maxRedirects",
  "lookup",
  "dnsLookup",
  "agent",
  "allowedDomains",
  "trustedRedirectDomains",
  "allowAnyRedirectHost",
  "rejectUnauthorized",
  "ca",
  "servername",
  "headers",
]);

function isWebCredentialApiEnabled(config) {
  return (
    config?.enableWebCredentialApi === true ||
    isPrefixedEnvTruthy("ENABLE_WEB_CREDENTIAL_API")
  );
}

function assertWebCredentialApiEnabled(config, actionName = "") {
  if (!isWebCredentialApiEnabled(config)) {
    const label = actionName ? `Action "${actionName}"` : "Web credential API";
    const err = new Error(
      `${label} is disabled by default to protect account credentials (clientkey/skey/p_skey). ` +
        `Set "enableWebCredentialApi": true in rosmontis.json or ROSMONTIS_ENABLE_WEB_CREDENTIAL_API=1 to enable.`
    );
    err.code = "ERR_WEB_CREDENTIAL_API_DISABLED";
    throw err;
  }
  return true;
}

function computeBkn(skey) {
  const str = String(skey || "");
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash += (hash << 5) + str.charCodeAt(i);
  }
  return hash & 2147483647;
}

function cookieObjToString(cookieObj) {
  if (!cookieObj || typeof cookieObj !== "object") return "";
  return Object.entries(cookieObj)
    .filter(([k, v]) => k && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${sanitizeHeaderValue(k)}=${sanitizeHeaderValue(v)}`)
    .join("; ");
}

function _normalizeDomainEntries(list) {
  const arr = list instanceof Set ? Array.from(list) : list;
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr
    .map((d) => String(d || "").trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

function isTrustedTencentHost(hostname, extraDomains = null) {
  if (typeof hostname !== "string") return false;
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  const extra = _normalizeDomainEntries(extraDomains);
  const domains =
    extra.length > 0 ? [...TRUSTED_TENCENT_ROOT_DOMAINS, ...extra] : TRUSTED_TENCENT_ROOT_DOMAINS;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isAllowedRedirectHost(hostname, allowedDomains = null) {
  if (typeof hostname !== "string") return false;
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  const custom = _normalizeDomainEntries(allowedDomains);
  const domains = custom.length > 0 ? custom : TRUSTED_TENCENT_ROOT_DOMAINS;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function assertSafeTencentRedirect(nextUrl, allowedDomains = null) {
  const parsed = nextUrl instanceof URL ? nextUrl : new URL(String(nextUrl));
  const proto = parsed.protocol.toLowerCase();
  if (proto !== "https:" && proto !== "http:") {
    const err = new Error(`Blocked redirect to unsupported protocol: ${parsed.protocol}`);
    err.code = "ERR_UNSUPPORTED_PROTOCOL";
    throw err;
  }
  if (!isAllowedRedirectHost(parsed.hostname, allowedDomains)) {
    const err = new Error(`Blocked redirect to untrusted host: ${parsed.hostname}`);
    err.code = "ERR_UNSAFE_REDIRECT";
    throw err;
  }
  return parsed;
}

function _resolveAllowPrivateUrls(options = {}) {
  if (options && options.allowPrivateUrls !== undefined) {
    return Boolean(options.allowPrivateUrls);
  }
  const envVal = pickEnv("ROSMONTIS_ALLOW_PRIVATE_URLS").toLowerCase();
  return envVal === "1" || envVal === "true";
}

function _stripBracketsAndDecodeHost(hostname) {
  const rawHost = String(hostname || "").trim().replace(/^\[|\]$/g, "");
  let decodedHost = rawHost;
  try {
    decodedHost = decodeURIComponent(rawHost);
  } catch (_) {}
  const bareHost = decodedHost.replace(/%.*$/, "");
  return { rawHost, decodedHost, bareHost };
}

function _isLocalOrPrivateHost(hostname) {
  const { decodedHost, bareHost } = _stripBracketsAndDecodeHost(hostname);
  const lower = bareHost.toLowerCase().replace(/\.$/, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  return net.isIP(bareHost) !== 0 && isPrivateOrReservedIp(decodedHost);
}

function _parseAndValidateOutboundUrl(urlStr, allowPrivateUrls) {
  const u = new URL(String(urlStr));
  const proto = u.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:") {
    const err = new Error(`Unsupported HTTP protocol: ${u.protocol}`);
    err.code = "ERR_UNSUPPORTED_PROTOCOL";
    throw err;
  }
  const { rawHost, decodedHost, bareHost } = _stripBracketsAndDecodeHost(u.hostname);
  if (net.isIP(bareHost) !== 0 && !allowPrivateUrls && isPrivateOrReservedIp(decodedHost)) {
    const err = new Error(`Blocked outbound request to private or reserved IP: ${rawHost}`);
    err.code = "ERR_SSRF_BLOCKED";
    throw err;
  }
  return { u, proto, connectHostname: rawHost };
}

function _resolveEffectiveAllowedDomains(options = {}) {
  if (options && options.allowedDomains) {
    return _normalizeDomainEntries(options.allowedDomains);
  }
  if (options && options.trustedRedirectDomains) {
    return [
      ...TRUSTED_TENCENT_ROOT_DOMAINS,
      ..._normalizeDomainEntries(options.trustedRedirectDomains),
    ];
  }
  return null;
}

function _validateRedirectTarget(
  currentUrlObj,
  locationHeader,
  options,
  allowPrivateUrls,
  { forbidHttpsDowngrade = false } = {}
) {
  const nextParsed = new URL(locationHeader, currentUrlObj.toString());
  const currentProto = currentUrlObj.protocol.toLowerCase();
  const nextProto = nextParsed.protocol.toLowerCase();
  if (nextProto !== "https:" && nextProto !== "http:") {
    const err = new Error(`Blocked redirect to unsupported protocol: ${nextParsed.protocol}`);
    err.code = "ERR_UNSUPPORTED_PROTOCOL";
    throw err;
  }

  const isDowngrade = currentProto === "https:" && nextProto === "http:";
  if (isDowngrade && forbidHttpsDowngrade) {
    const err = new Error(
      `Blocked insecure HTTPS-to-HTTP cookie redirect downgrade: ${nextParsed.origin}`
    );
    err.code = "ERR_INSECURE_REDIRECT_DOWNGRADE";
    throw err;
  }

  const isCrossHost =
    nextParsed.hostname.toLowerCase() !== currentUrlObj.hostname.toLowerCase();
  const nextAllowPrivateUrls = isCrossHost ? false : allowPrivateUrls;

  _parseAndValidateOutboundUrl(nextParsed.toString(), nextAllowPrivateUrls);

  const effectiveAllowedDomains = _resolveEffectiveAllowedDomains(options);
  const allowSameLocalTestHost =
    !isCrossHost &&
    nextAllowPrivateUrls &&
    !effectiveAllowedDomains &&
    _isLocalOrPrivateHost(currentUrlObj.hostname);

  if (options?.allowAnyRedirectHost !== true && !allowSameLocalTestHost) {
    assertSafeTencentRedirect(nextParsed, effectiveAllowedDomains);
  }

  return {
    nextParsed,
    isDowngrade,
    isCrossHost,
    nextAllowPrivateUrls,
  };
}

function _buildTransportSafetyOptions(options, allowPrivateUrls) {
  const lookup =
    typeof options?.lookup === "function"
      ? options.lookup
      : createSsrfSafeLookup(
          { dnsLookup: options?.dnsLookup, allowPrivateUrls },
          allowPrivateUrls
        );
  const out = {
    lookup,
    agent: options && options.agent !== undefined ? options.agent : false,
  };
  if (options && options.rejectUnauthorized !== undefined) {
    out.rejectUnauthorized = Boolean(options.rejectUnauthorized);
  }
  if (options && options.ca !== undefined) {
    out.ca = options.ca;
  }
  if (options && options.servername !== undefined) {
    out.servername = options.servername;
  }
  return out;
}

function _sanitizeHeadersObject(rawHeaders = {}, includeDefaultUa = false) {
  const out = {};
  if (includeDefaultUa) {
    out["User-Agent"] = sanitizeHeaderValue(buildNtqqUserAgent());
  }
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (v === undefined || v === null) continue;
      if (!isValidHttpHeaderName(k)) continue;
      if (includeDefaultUa && k.toLowerCase() === "user-agent") {
        delete out["User-Agent"];
      }
      out[k] = sanitizeHeaderValue(v);
    }
  }
  return out;
}

function _stripSensitiveHeaders(headersObj) {
  const copy = { ...(headersObj && typeof headersObj === "object" ? headersObj : {}) };
  for (const key of Object.keys(copy)) {
    const lower = key.toLowerCase();
    if (
      lower === "cookie" ||
      lower === "authorization" ||
      lower === "proxy-authorization"
    ) {
      delete copy[key];
    }
  }
  return copy;
}

function _stripBodyEntityHeaders(headersObj) {
  const copy = { ...(headersObj && typeof headersObj === "object" ? headersObj : {}) };
  for (const key of Object.keys(copy)) {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "content-type") {
      delete copy[key];
    }
  }
  return copy;
}

function httpsGetCookies(urlStr, depthOrOptions = 0, maybeOptions = {}) {
  let depth = 0;
  let options = maybeOptions && typeof maybeOptions === "object" ? maybeOptions : {};
  if (depthOrOptions && typeof depthOrOptions === "object") {
    options = depthOrOptions;
    depth = Number(options.depth || 0);
  } else {
    depth = Number(depthOrOptions || 0);
  }
  const maxRedirects =
    Number.isFinite(Number(options.maxRedirects)) && Number(options.maxRedirects) >= 0
      ? Math.floor(Number(options.maxRedirects))
      : 5;
  const timeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : 8000;
  const allowPrivateUrls = _resolveAllowPrivateUrls(options);

  return new Promise((resolve, reject) => {
    const cookies = {};
    let settled = false;
    const settleResolve = (extra) => {
      if (settled) return;
      settled = true;
      resolve(extra ? { ...cookies, ...extra } : cookies);
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    let validated;
    try {
      validated = _parseAndValidateOutboundUrl(urlStr, allowPrivateUrls);
    } catch (err) {
      return settleReject(err);
    }
    const { u, proto, connectHostname } = validated;

    const mod = proto === "https:" ? https : http;
    const reqHeaders = _sanitizeHeadersObject(options.headers, true);
    const transportOpts = _buildTransportSafetyOptions(options, allowPrivateUrls);

    const req = mod.request(
      {
        hostname: connectHostname,
        port: u.port || (proto === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: reqHeaders,
        timeout: timeoutMs,
        ...transportOpts,
      },
      (res) => {
        const setCookie = res.headers["set-cookie"];
        if (Array.isArray(setCookie)) {
          for (const item of setCookie) {
            const firstPair = String(item).split(";")[0];
            const eqIdx = firstPair ? firstPair.indexOf("=") : -1;
            if (eqIdx > 0) {
              const cKey = sanitizeHeaderValue(firstPair.slice(0, eqIdx).trim());
              const cVal = sanitizeHeaderValue(firstPair.slice(eqIdx + 1).trim());
              if (cKey && cVal) {
                cookies[cKey] = cVal;
              }
            }
          }
        }

        let drainedBytes = 0;
        res.on("data", (chunk) => {
          drainedBytes += chunk ? chunk.length : 0;
          if (drainedBytes > 1024 * 1024) {
            try {
              res.destroy();
            } catch (_) {}
          }
        });

        let redirectOrFinishHandled = false;
        const handleRedirectOrFinish = () => {
          if (redirectOrFinishHandled || settled) return;
          redirectOrFinishHandled = true;

          const loc = res.headers.location;
          if (
            res.statusCode &&
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
            loc &&
            depth < maxRedirects
          ) {
            let redirectCheck;
            try {
              redirectCheck = _validateRedirectTarget(u, loc, options, allowPrivateUrls, {
                forbidHttpsDowngrade: true,
              });
            } catch (err) {
              return settleReject(err);
            }

            const { nextParsed, isCrossHost } = redirectCheck;
            const mergedForwardCookies = cookieObjToString(cookies);
            let nextHeaders = options.headers ? { ...options.headers } : {};
            if (mergedForwardCookies) {
              const existingKey = Object.keys(nextHeaders).find(
                (k) => k.toLowerCase() === "cookie"
              );
              if (existingKey && nextHeaders[existingKey]) {
                nextHeaders[existingKey] = `${nextHeaders[existingKey]}; ${mergedForwardCookies}`;
              } else {
                nextHeaders.Cookie = mergedForwardCookies;
              }
            }
            const nextOptions = {
              ...options,
              headers: nextHeaders,
              ...(isCrossHost ? { allowPrivateUrls: false } : {}),
            };

            httpsGetCookies(nextParsed.toString(), depth + 1, nextOptions).then(
              (rc) => settleResolve(rc),
              settleReject
            );
          } else {
            settleResolve();
          }
        };

        res.on("end", handleRedirectOrFinish);
        res.on("close", handleRedirectOrFinish);
        res.on("error", settleReject);
      }
    );

    req.on("timeout", () => {
      const err = new Error(`HTTPS cookie timeout: ${urlStr}`);
      err.code = "ETIMEDOUT";
      req.destroy(err);
    });
    req.on("error", settleReject);
    req.end();
  });
}

function _createResponseTooLargeError(limit, urlStr) {
  const err = new Error(
    `HTTP response body exceeded maximum limit (${limit} bytes) for ${urlStr}`
  );
  err.code = "ERR_HTTP_RESPONSE_TOO_LARGE";
  return err;
}

function httpRequestText(
  urlStr,
  method = "GET",
  body = "",
  headers = {},
  redirectsLeft = 4,
  options = {}
) {
  let remainingRedirects = 4;
  let opts = options && typeof options === "object" ? options : {};
  if (redirectsLeft && typeof redirectsLeft === "object") {
    opts = redirectsLeft;
    const rawLimit = opts.redirectsLeft ?? opts.maxRedirects;
    remainingRedirects =
      Number.isFinite(Number(rawLimit)) && Number(rawLimit) >= 0
        ? Math.floor(Number(rawLimit))
        : 4;
  } else if (Number.isFinite(Number(redirectsLeft)) && Number(redirectsLeft) >= 0) {
    remainingRedirects = Math.floor(Number(redirectsLeft));
  } else {
    const rawLimit = opts.redirectsLeft ?? opts.maxRedirects;
    if (Number.isFinite(Number(rawLimit)) && Number(rawLimit) >= 0) {
      remainingRedirects = Math.floor(Number(rawLimit));
    }
  }

  const parsedMaxBytes = Number(opts.maxResponseBytes);
  const maxResponseBytes =
    Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
      ? Math.floor(parsedMaxBytes)
      : DEFAULT_MAX_WEB_RESPONSE_BYTES;
  const timeoutMs =
    Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
      ? Math.floor(Number(opts.timeoutMs))
      : 12000;
  const allowPrivateUrls = _resolveAllowPrivateUrls(opts);

  return new Promise((resolve, reject) => {
    let settleDone = false;
    const settleResolve = (val) => {
      if (settleDone) return;
      settleDone = true;
      resolve(val);
    };
    const settleReject = (err) => {
      if (settleDone) return;
      settleDone = true;
      reject(err);
    };

    let validated;
    try {
      validated = _parseAndValidateOutboundUrl(urlStr, allowPrivateUrls);
    } catch (err) {
      return settleReject(err);
    }
    const { u, proto, connectHostname } = validated;

    const upperMethod = String(method || "GET").toUpperCase();
    const mod = proto === "https:" ? https : http;
    const mergedRawHeaders =
      opts.headers && typeof opts.headers === "object"
        ? { ...opts.headers, ...(headers && typeof headers === "object" ? headers : {}) }
        : headers;
    const reqHeaders = _sanitizeHeadersObject(mergedRawHeaders, true);
    const bodyBuf =
      body && (upperMethod === "POST" || upperMethod === "PUT" || upperMethod === "PATCH")
        ? Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8")
        : null;

    const hasContentLength = Object.keys(reqHeaders).some(
      (k) => k.toLowerCase() === "content-length"
    );
    if (bodyBuf && !hasContentLength) {
      reqHeaders["Content-Length"] = String(bodyBuf.length);
    }

    const transportOpts = _buildTransportSafetyOptions(opts, allowPrivateUrls);

    const req = mod.request(
      {
        hostname: connectHostname,
        port: u.port || (proto === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: upperMethod,
        headers: reqHeaders,
        timeout: timeoutMs,
        ...transportOpts,
      },
      (res) => {
        if (
          res.statusCode &&
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          remainingRedirects > 0
        ) {
          res.resume();
          let redirectCheck;
          try {
            redirectCheck = _validateRedirectTarget(
              u,
              res.headers.location,
              opts,
              allowPrivateUrls,
              { forbidHttpsDowngrade: false }
            );
          } catch (err) {
            return settleReject(err);
          }

          const { nextParsed, isDowngrade, isCrossHost } = redirectCheck;
          let forwardedHeaders = {
            ...(headers && typeof headers === "object" ? headers : {}),
          };
          const isUntrustedCrossOrigin =
            nextParsed.origin !== u.origin && !isTrustedTencentHost(nextParsed.hostname);

          if (isDowngrade || isUntrustedCrossOrigin) {
            forwardedHeaders = _stripSensitiveHeaders(forwardedHeaders);
          }

          const shouldSwitchToGet =
            res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303;
          const nextMethod = shouldSwitchToGet
            ? upperMethod === "HEAD"
              ? "HEAD"
              : "GET"
            : upperMethod;
          const nextBody = shouldSwitchToGet ? "" : body;
          if (shouldSwitchToGet) {
            forwardedHeaders = _stripBodyEntityHeaders(forwardedHeaders);
          }

          const nextOpts = {
            ...opts,
            ...(opts.headers && (isDowngrade || isUntrustedCrossOrigin)
              ? { headers: _stripSensitiveHeaders(opts.headers) }
              : {}),
            ...(isCrossHost ? { allowPrivateUrls: false } : {}),
          };

          httpRequestText(
            nextParsed.toString(),
            nextMethod,
            nextBody,
            forwardedHeaders,
            remainingRedirects - 1,
            nextOpts
          ).then(settleResolve, settleReject);
          return;
        }

        const clHeader = res.headers["content-length"];
        if (clHeader !== undefined && String(clHeader).trim() !== "") {
          const declaredLen = Number(clHeader);
          if (Number.isFinite(declaredLen) && declaredLen > maxResponseBytes) {
            const err = _createResponseTooLargeError(maxResponseBytes, urlStr);
            try {
              res.destroy();
              req.destroy();
            } catch (_) {}
            return settleReject(err);
          }
        }

        const chunks = [];
        let totalBytes = 0;
        res.on("data", (chunk) => {
          if (settleDone) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > maxResponseBytes) {
            chunks.length = 0;
            const err = _createResponseTooLargeError(maxResponseBytes, urlStr);
            try {
              res.destroy();
              req.destroy();
            } catch (_) {}
            settleReject(err);
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          if (settleDone) return;
          settleResolve(Buffer.concat(chunks, totalBytes).toString("utf8"));
        });
        res.on("error", settleReject);
      }
    );

    req.on("timeout", () => {
      const err = new Error(`HTTP timeout: ${urlStr}`);
      err.code = "ETIMEDOUT";
      req.destroy(err);
    });
    req.on("error", settleReject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function _splitHeadersAndOptions(headersOrOptions = {}, maybeOptions = undefined) {
  if (maybeOptions !== undefined) {
    return {
      headers: headersOrOptions && typeof headersOrOptions === "object" ? headersOrOptions : {},
      options: maybeOptions && typeof maybeOptions === "object" ? maybeOptions : {},
    };
  }
  if (!headersOrOptions || typeof headersOrOptions !== "object") {
    return { headers: {}, options: {} };
  }
  const keys = Object.keys(headersOrOptions);
  const looksLikeOptions = keys.some((k) => REQUEST_OPTION_KEYS.has(k));
  if (!looksLikeOptions) {
    return { headers: headersOrOptions, options: {} };
  }
  const extractedHeaders =
    headersOrOptions.headers && typeof headersOrOptions.headers === "object"
      ? { ...headersOrOptions.headers }
      : {};
  for (const [k, v] of Object.entries(headersOrOptions)) {
    if (!REQUEST_OPTION_KEYS.has(k)) {
      extractedHeaders[k] = v;
    }
  }
  return { headers: extractedHeaders, options: headersOrOptions };
}

async function httpGetJson(urlStr, headersOrOptions = {}, maybeOptions = undefined) {
  const { headers, options } = _splitHeadersAndOptions(headersOrOptions, maybeOptions);
  const text = await httpRequestText(urlStr, "GET", "", headers, undefined, options);
  return parseJsonpOrJson(text);
}

async function httpPostFormJson(
  urlStr,
  formParams = {},
  headersOrOptions = {},
  maybeOptions = undefined
) {
  const { headers, options } = _splitHeadersAndOptions(headersOrOptions, maybeOptions);
  let encodedBody = "";
  if (Buffer.isBuffer(formParams) || typeof formParams === "string") {
    encodedBody = formParams;
  } else if (formParams instanceof URLSearchParams) {
    encodedBody = formParams.toString();
  } else if (formParams && typeof formParams === "object") {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(formParams)) {
      if (v !== undefined && v !== null) {
        sp.append(k, String(v));
      }
    }
    encodedBody = sp.toString();
  }
  const hasContentType = Object.keys(headers).some(
    (k) => k.toLowerCase() === "content-type"
  );
  const reqHeaders = hasContentType
    ? headers
    : { ...headers, "Content-Type": "application/x-www-form-urlencoded" };
  const text = await httpRequestText(urlStr, "POST", encodedBody, reqHeaders, undefined, options);
  return parseJsonpOrJson(text);
}

function parseJsonpOrJson(raw) {
  if (raw && typeof raw === "object") return raw;
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  const noSemi = trimmed.replace(/;+\s*$/, "").trim();
  if (!noSemi) return {};
  if (noSemi !== trimmed) {
    try {
      return JSON.parse(noSemi);
    } catch (_) {}
  }

  const jsonpMatch = /^(?:[$_\w.[\]]+\s*)?\(([\s\S]*)\)$/.exec(noSemi);
  if (jsonpMatch) {
    const inner = jsonpMatch[1].trim();
    if (inner) {
      try {
        return JSON.parse(inner);
      } catch (_) {}
    }
  }

  const embeddedCallMatch =
    /(?:^|[^\w$])[$_\w.]+\s*\(\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*\)\s*;?/.exec(noSemi);
  if (embeddedCallMatch) {
    try {
      return JSON.parse(embeddedCallMatch[1]);
    } catch (_) {}
  }

  const firstParen = noSemi.indexOf("(");
  const lastParen = noSemi.lastIndexOf(")");
  if (firstParen !== -1 && lastParen > firstParen) {
    const innerParen = noSemi.slice(firstParen + 1, lastParen).trim();
    if (innerParen) {
      try {
        return JSON.parse(innerParen);
      } catch (_) {}
    }
  }

  const firstBrace = noSemi.indexOf("{");
  const lastBrace = noSemi.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(noSemi.slice(firstBrace, lastBrace + 1));
    } catch (_) {}
  }

  return {};
}

module.exports = {
  DEFAULT_MAX_WEB_RESPONSE_BYTES,
  TRUSTED_TENCENT_ROOT_DOMAINS,
  WEB_CREDENTIAL_ACTIONS,
  isWebCredentialApiEnabled,
  assertWebCredentialApiEnabled,
  computeBkn,
  cookieObjToString,
  isTrustedTencentHost,
  isAllowedRedirectHost,
  assertSafeTencentRedirect,
  httpsGetCookies,
  httpRequestText,
  httpGetJson,
  httpPostFormJson,
  parseJsonpOrJson,
};

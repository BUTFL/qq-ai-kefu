"use strict";

const crypto = require("crypto");
const dns = require("dns");
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const { fileURLToPath } = require("url");
const {
  pickEnv,
  pickPrefixedEnv,
  collectPrefixedEnvValues,
  isPrefixedEnvFlagOne,
  getHomeDir,
  getXdgConfigHome,
  resolveTempDirFromEnv,
  resolveConfigDirsFromEnv,
} = require("./env");

const DEFAULT_MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const HEADER_PEEK_BYTES = 65536;

function inspectImageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) {
    return { width: 512, height: 512, isGif: false, ext: ".jpg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16) || 512;
    const height = buf.readUInt32BE(20) || 512;
    return { width, height, isGif: false, ext: ".png" };
  }
  // GIF: "GIF87a" or "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const width = buf.readUInt16LE(6) || 256;
    const height = buf.readUInt16LE(8) || 256;
    return { width, height, isGif: true, ext: ".gif" };
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    let width = 512;
    let height = 512;
    const chunkHeader = buf.slice(12, 16).toString("ascii");
    if (chunkHeader === "VP8 " && buf.length >= 30) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunkHeader === "VP8L" && buf.length >= 25) {
      const b0 = buf[21];
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    } else if (chunkHeader === "VP8X" && buf.length >= 30) {
      width = 1 + buf.readUIntLE(24, 3);
      height = 1 + buf.readUIntLE(27, 3);
    }
    return { width: width || 512, height: height || 512, isGif: false, ext: ".webp" };
  }
  // JPEG: FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buf.readUInt16BE(offset + 5) || 512;
        const width = buf.readUInt16BE(offset + 7) || 512;
        return { width, height, isGif: false, ext: ".jpg" };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
    return { width: 512, height: 512, isGif: false, ext: ".jpg" };
  }
  return { width: 512, height: 512, isGif: false, ext: ".jpg" };
}

let _cachedVersionMeta = null;

function getNtqqVersionMetadata(options = {}) {
  if (_cachedVersionMeta && !options.forceRefresh && !options.packagePaths && !options.chromeVersion) {
    return _cachedVersionMeta;
  }
  const candidatePaths = options.packagePaths || [
    "/opt/QQ/resources/app/package.orig.json",
    "/opt/QQ/resources/app/package.json",
    path.resolve(__dirname, "..", "package_patch.json"),
    path.join(__dirname, "package_patch.json"),
  ];
  let qqVersion = "3.2.32-52194";
  let buildVersion = "52194";
  for (const pkgPath of candidatePaths) {
    try {
      if (pkgPath && fs.existsSync(pkgPath)) {
        const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (raw && typeof raw.version === "string" && raw.version.trim()) {
          qqVersion = raw.version.trim();
          buildVersion = String(raw.buildVersion || qqVersion.split("-")[1] || buildVersion);
          break;
        }
      }
    } catch (_) {}
  }
  const chromeVersion = String(
    options.chromeVersion || (process && process.versions && process.versions.chrome) || "138.0.0.0"
  );
  const meta = {
    qqVersion,
    buildVersion,
    chromeVersion,
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36 QQ/${qqVersion}`,
  };
  if (!options.packagePaths && !options.chromeVersion) {
    _cachedVersionMeta = meta;
  }
  return meta;
}

function buildNtqqUserAgent(options = {}) {
  return getNtqqVersionMetadata(options).userAgent;
}

function resolveMaxMediaBytes(options = {}) {
  const candidate =
    options &&
    options.maxMediaBytes !== undefined &&
    options.maxMediaBytes !== null &&
    options.maxMediaBytes !== ""
      ? options.maxMediaBytes
      : pickPrefixedEnv("MAX_MEDIA_BYTES");
  const num = Number(candidate);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : DEFAULT_MAX_MEDIA_BYTES;
}

function _isPrivateOrReservedIpv4Octets(a, b, c = -1) {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && (b & 0xc0) === 64) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && (b & 0xf0) === 16) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 & 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 (6to4 relay anycast)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved/broadcast
  return false;
}

function _parseIpv6Groups(ipv6Str) {
  let addr = ipv6Str.toLowerCase();
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.indexOf(".", lastColon) !== -1) {
    const ipv4Part = addr.slice(lastColon + 1);
    if (net.isIP(ipv4Part) !== 4) return null;
    const octets = ipv4Part.split(".").map((x) => Number(x));
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const dblIdx = addr.indexOf("::");
  let groups;
  if (dblIdx !== -1) {
    if (addr.indexOf("::", dblIdx + 2) !== -1) return null;
    const leftStr = addr.slice(0, dblIdx);
    const rightStr = addr.slice(dblIdx + 2);
    const left = leftStr ? leftStr.split(":") : [];
    const right = rightStr ? rightStr.split(":") : [];
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array(fill).fill("0"), ...right];
  } else {
    groups = addr.split(":");
    if (groups.length !== 8) return null;
  }
  const nums = new Array(8);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i], 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
    nums[i] = v;
  }
  return nums;
}

function isPrivateOrReservedIp(ip) {
  if (typeof ip !== "string") return false;
  const cleaned = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").replace(/^\[|\]$/g, "");
  if (!cleaned) return false;
  const family = net.isIP(cleaned);
  if (family === 4) {
    const parts = cleaned.split(".").map((x) => Number(x));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    return _isPrivateOrReservedIpv4Octets(parts[0], parts[1], parts[2]);
  }
  if (family === 6) {
    const g = _parseIpv6Groups(cleaned);
    if (!g) return true;
    const first5Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
    if (first5Zero && g[5] === 0) {
      // :: (unspecified), ::1 (loopback), and deprecated IPv4-compatible ::x.x.x.x (::/96)
      return true;
    }
    if (first5Zero && g[5] === 0xffff) {
      // IPv4-mapped ::ffff:0:0/96 (dotted-quad & hex forms) — delegate embedded IPv4
      return _isPrivateOrReservedIpv4Octets((g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff);
    }
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
      // SIIT IPv4-translated ::ffff:0:0:0/96
      return true;
    }
    if (
      g[0] === 0x0064 &&
      g[1] === 0xff9b &&
      ((g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) || g[2] === 0x0001)
    ) {
      // NAT64 well-known 64:ff9b::/96 & local-use 64:ff9b:1::/48
      return true;
    }
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) {
      // Discard-only 100::/64 (RFC 6666)
      return true;
    }
    if (g[0] === 0x2001) {
      if (g[1] === 0x0000) return true; // Teredo 2001:0000::/32
      if (g[1] === 0x0002 && g[2] === 0x0000) return true; // Benchmarking 2001:2::/48
      if (g[1] === 0x0db8) return true; // Documentation 2001:db8::/32
      if ((g[1] & 0xfff0) === 0x0010 || (g[1] & 0xfff0) === 0x0020) return true; // ORCHID / ORCHIDv2
    }
    if (g[0] === 0x2002) {
      // 6to4 relay 2002::/16
      return true;
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7 (fc00::..fdff::)
    if ((g[0] & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10 (fe80::..febf::)
    if ((g[0] & 0xffc0) === 0xfec0) return true; // Deprecated site-local fec0::/10
    if ((g[0] & 0xff00) === 0xff00) return true; // Multicast ff00::/8
    return false;
  }
  return false;
}

function pruneTempDir(tempDir, maxFiles = 128) {
  try {
    if (!tempDir || !fs.existsSync(tempDir)) return 0;
    const entries = fs
      .readdirSync(tempDir)
      .filter((name) => !name.endsWith(".part"))
      .map((name) => {
        const fullPath = path.join(tempDir, name);
        try {
          const st = fs.statSync(fullPath);
          if (st.isFile()) {
            return { fullPath, mtimeMs: Number(st.mtimeMs || 0) };
          }
        } catch (_) {}
        return null;
      })
      .filter(Boolean);
    if (entries.length <= maxFiles) return 0;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toRemove = entries.slice(0, entries.length - maxFiles);
    let removed = 0;
    for (const item of toRemove) {
      try {
        fs.unlinkSync(item.fullPath);
        removed++;
      } catch (_) {}
    }
    return removed;
  } catch (_) {
    return 0;
  }
}

const _pruneTempDirStates = new Map();

async function _runPruneTempDirOnce(tempDir, maxFiles) {
  try {
    if (!tempDir) return 0;
    let names;
    try {
      names = await fs.promises.readdir(tempDir);
    } catch (_) {
      return 0;
    }
    const candidateNames = names.filter((name) => !name.endsWith(".part"));
    if (candidateNames.length <= maxFiles) return 0;
    const stats = await Promise.all(
      candidateNames.map(async (name) => {
        const fullPath = path.join(tempDir, name);
        try {
          const st = await fs.promises.stat(fullPath);
          if (st.isFile()) {
            return { fullPath, mtimeMs: Number(st.mtimeMs || 0) };
          }
        } catch (_) {}
        return null;
      })
    );
    const entries = stats.filter(Boolean);
    if (entries.length <= maxFiles) return 0;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toRemove = entries.slice(0, entries.length - maxFiles);
    let removed = 0;
    await Promise.all(
      toRemove.map(async (item) => {
        try {
          await fs.promises.unlink(item.fullPath);
          removed++;
        } catch (_) {}
      })
    );
    return removed;
  } catch (_) {
    return 0;
  }
}

function pruneTempDirAsync(tempDir, maxFiles = 128) {
  if (!tempDir) return Promise.resolve(0);
  const lockKey =
    process.platform === "win32" ? path.resolve(tempDir).toLowerCase() : path.resolve(tempDir);
  let state = _pruneTempDirStates.get(lockKey);
  if (state) {
    state.queuedMaxFiles =
      state.queuedMaxFiles === null ? maxFiles : Math.min(state.queuedMaxFiles, maxFiles);
    return state.promise;
  }
  state = { queuedMaxFiles: null, promise: null };
  state.promise = (async () => {
    let totalRemoved = 0;
    let currentMax = maxFiles;
    try {
      while (true) {
        totalRemoved += await _runPruneTempDirOnce(tempDir, currentMax);
        if (state.queuedMaxFiles === null) break;
        currentMax = state.queuedMaxFiles;
        state.queuedMaxFiles = null;
      }
    } finally {
      _pruneTempDirStates.delete(lockKey);
    }
    return totalRemoved;
  })();
  _pruneTempDirStates.set(lockKey, state);
  return state.promise;
}

function _resolveAllowPrivateUrls(options = {}) {
  if (options && (options.allowPrivateUrls === true || options.allowPrivateMediaUrls === true)) {
    return true;
  }
  if (options && (options.allowPrivateUrls === false || options.allowPrivateMediaUrls === false)) {
    return false;
  }
  const envVal = pickEnv(
    "ROSMONTIS_ALLOW_PRIVATE_MEDIA_URLS",
    "ROSMONTIS_ALLOW_PRIVATE_URLS",
    "ONEBOT_ALLOW_PRIVATE_MEDIA_URLS",
    "XIAO_BRIDGE_ALLOW_PRIVATE_MEDIA_URLS"
  ).toLowerCase();
  return envVal === "1" || envVal === "true";
}

function createSsrfSafeLookup(options = {}, allowPrivateUrls = undefined) {
  const allowPrivate =
    allowPrivateUrls !== undefined ? Boolean(allowPrivateUrls) : _resolveAllowPrivateUrls(options);
  const rawLookup =
    typeof options.lookup === "function"
      ? options.lookup
      : typeof options.dnsLookup === "function"
      ? options.dnsLookup
      : dns.lookup;

  return (hostname, lookupOpts, cb) => {
    let opts = lookupOpts;
    let callback = cb;
    if (typeof lookupOpts === "function") {
      callback = lookupOpts;
      opts = {};
    }
    const wantAll = Boolean(opts && typeof opts === "object" && opts.all === true);
    const cleanHost = String(hostname || "")
      .trim()
      .replace(/^\[|\]$/g, "")
      .replace(/%.*$/, "")
      .replace(/^\[|\]$/g, "");
    if (!allowPrivate && net.isIP(cleanHost) !== 0 && isPrivateOrReservedIp(cleanHost)) {
      const blockErr = new Error(`Blocked private or reserved IP address: ${cleanHost}`);
      blockErr.code = "ERR_SSRF_BLOCKED";
      return callback(blockErr);
    }

    rawLookup.call(dns, hostname, opts, (err, address, family) => {
      if (err) return callback(err);
      if (!allowPrivate) {
        if (Array.isArray(address)) {
          if (address.length === 0) {
            const emptyErr = new Error(`Blocked empty DNS resolution for ${hostname}`);
            emptyErr.code = "ERR_SSRF_BLOCKED";
            return callback(emptyErr);
          }
          for (const entry of address) {
            const addrStr = entry && typeof entry === "object" ? String(entry.address || "") : String(entry || "");
            const bareAddr = addrStr.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
            if (!bareAddr || net.isIP(bareAddr) === 0 || isPrivateOrReservedIp(addrStr)) {
              const blockErr = new Error(
                `Blocked DNS resolution to private or reserved IP (${addrStr}) for ${hostname}`
              );
              blockErr.code = "ERR_SSRF_BLOCKED";
              return callback(blockErr);
            }
          }
          return callback(null, address);
        }
        const addrStr = String(address || "");
        const bareAddr = addrStr.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
        if (!bareAddr || net.isIP(bareAddr) === 0 || isPrivateOrReservedIp(addrStr)) {
          const blockErr = new Error(
            `Blocked DNS resolution to private or reserved IP (${addrStr}) for ${hostname}`
          );
          blockErr.code = "ERR_SSRF_BLOCKED";
          return callback(blockErr);
        }
      }
      if (wantAll && !Array.isArray(address) && typeof address === "string") {
        return callback(null, [{ address, family: family || net.isIP(address) || 4 }]);
      }
      if (!wantAll && Array.isArray(address)) {
        const first = address[0];
        if (!first) return callback(new Error(`No DNS records resolved for ${hostname}`));
        const addrStr = typeof first === "object" ? first.address : String(first);
        const fam = (typeof first === "object" && first.family) || net.isIP(addrStr) || 4;
        return callback(null, addrStr, fam);
      }
      return Array.isArray(address)
        ? callback(null, address)
        : callback(null, address, family || net.isIP(String(address || "")) || 4);
    });
  };
}

function _normalizeDownloadArgs(timeoutOrOptions = 20000, redirectsLeftArg = 4, extraOptions = {}) {
  let options;
  let timeoutMs;
  let redirectsLeft;
  if (timeoutOrOptions && typeof timeoutOrOptions === "object") {
    options = timeoutOrOptions;
    timeoutMs = Number(options.timeoutMs) || 20000;
    redirectsLeft = options.redirectsLeft !== undefined ? Number(options.redirectsLeft) : 4;
  } else {
    options =
      extraOptions && typeof extraOptions === "object"
        ? extraOptions
        : redirectsLeftArg && typeof redirectsLeftArg === "object"
        ? redirectsLeftArg
        : {};
    timeoutMs = Number(timeoutOrOptions) || Number(options.timeoutMs) || 20000;
    redirectsLeft = typeof redirectsLeftArg === "number" ? redirectsLeftArg : 4;
  }
  const maxMediaBytes = resolveMaxMediaBytes(options);
  const allowPrivateUrls = _resolveAllowPrivateUrls(options);
  return { options, timeoutMs, redirectsLeft, maxMediaBytes, allowPrivateUrls };
}

function _openMediaHttpStream(urlStr, timeoutMs, redirectsLeft, options, maxMediaBytes, allowPrivateUrls) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleResolve = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return settleReject(e);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      const protoErr = new Error(`Blocked unsupported media URL protocol: ${parsed.protocol}`);
      protoErr.code = "ERR_SSRF_BLOCKED";
      return settleReject(protoErr);
    }

    const hostNoBrackets = String(parsed.hostname || "").replace(/^\[|\]$/g, "");
    let hostDecoded = hostNoBrackets;
    try {
      hostDecoded = decodeURIComponent(hostNoBrackets);
    } catch (_) {}
    const hostNoZone = hostDecoded.replace(/%.*$/, "");
    if (!allowPrivateUrls && net.isIP(hostNoZone) !== 0 && isPrivateOrReservedIp(hostDecoded)) {
      const ipErr = new Error(`Blocked private or reserved media URL IP: ${hostNoBrackets}`);
      ipErr.code = "ERR_SSRF_BLOCKED";
      return settleReject(ipErr);
    }

    const mod = parsed.protocol === "https:" ? https : http;
    const reqOpts = {
      headers: {
        "User-Agent": buildNtqqUserAgent(),
      },
      timeout: timeoutMs,
      agent: options.agent !== undefined ? options.agent : false,
    };
    if (!allowPrivateUrls || typeof options.lookup === "function" || typeof options.dnsLookup === "function") {
      reqOpts.lookup = createSsrfSafeLookup(options, allowPrivateUrls);
    }

    const req = mod.get(urlStr, reqOpts, (res) => {
      if (
        res.statusCode &&
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        res.resume();
        if (redirectsLeft <= 0) {
          return settleReject(new Error(`Too many redirects fetching ${urlStr}`));
        }
        let nextUrl;
        try {
          nextUrl = new URL(res.headers.location, urlStr).toString();
        } catch (e) {
          return settleReject(e);
        }
        return _openMediaHttpStream(
          nextUrl,
          timeoutMs,
          redirectsLeft - 1,
          options,
          maxMediaBytes,
          allowPrivateUrls
        ).then(settleResolve, settleReject);
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return settleReject(new Error(`HTTP ${res.statusCode} fetching ${urlStr}`));
      }

      const contentLength = Number(res.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxMediaBytes) {
        const sizeErr = new Error(
          `Media Content-Length (${contentLength} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`
        );
        sizeErr.code = "ERR_MEDIA_TOO_LARGE";
        res.destroy();
        req.destroy();
        return settleReject(sizeErr);
      }

      settleResolve({ req, res });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Timeout fetching ${urlStr}`));
    });
    req.on("error", settleReject);
  });
}

async function downloadBufferFromUrl(urlStr, timeoutOrOptions = 20000, redirectsLeftArg = 4, extraOptions = {}) {
  const { options, timeoutMs, redirectsLeft, maxMediaBytes, allowPrivateUrls } = _normalizeDownloadArgs(
    timeoutOrOptions,
    redirectsLeftArg,
    extraOptions
  );
  const { req, res } = await _openMediaHttpStream(
    urlStr,
    timeoutMs,
    redirectsLeft,
    options,
    maxMediaBytes,
    allowPrivateUrls
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const doneReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const chunks = [];
    let totalBytes = 0;

    req.on("error", doneReject);
    res.on("error", doneReject);
    res.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxMediaBytes) {
        chunks.length = 0;
        const sizeErr = new Error(
          `Media stream (${totalBytes} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`
        );
        sizeErr.code = "ERR_MEDIA_TOO_LARGE";
        res.destroy();
        req.destroy();
        doneReject(sizeErr);
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });
  });
}

async function downloadMediaStreamToTempDir(urlStr, tempDir, options = {}) {
  const targetTempDir = resolveTempDirFromEnv(tempDir || options?.tempDir);
  await fs.promises.mkdir(targetTempDir, { recursive: true, mode: 0o700 });

  const { timeoutMs, redirectsLeft, maxMediaBytes, allowPrivateUrls } = _normalizeDownloadArgs(options);
  const { req, res } = await _openMediaHttpStream(
    urlStr,
    timeoutMs,
    redirectsLeft,
    options,
    maxMediaBytes,
    allowPrivateUrls
  );

  const tmpPart = path.join(
    targetTempDir,
    `.dl.${process.pid}.${crypto.randomBytes(6).toString("hex")}.part`
  );

  const { fileSize, md5HexStr, dim } = await new Promise((resolve, reject) => {
    let settled = false;
    const hash = crypto.createHash("md5");
    const headerChunks = [];
    let headerCollected = 0;
    let totalBytes = 0;

    const outStream = fs.createWriteStream(tmpPart, { mode: 0o600 });

    const abortAndCleanup = (err) => {
      if (settled) return;
      settled = true;
      try {
        res.destroy();
      } catch (_) {}
      try {
        req.destroy();
      } catch (_) {}
      const finalizeReject = () => {
        fs.promises
          .unlink(tmpPart)
          .catch(() => {})
          .finally(() => {
            reject(err);
          });
      };
      if (outStream.closed) {
        finalizeReject();
      } else {
        let cleaned = false;
        const onClosed = () => {
          if (cleaned) return;
          cleaned = true;
          clearTimeout(fallbackTimer);
          finalizeReject();
        };
        const fallbackTimer = setTimeout(onClosed, 250);
        if (typeof fallbackTimer.unref === "function") fallbackTimer.unref();
        outStream.once("close", onClosed);
        try {
          outStream.destroy();
        } catch (_) {
          onClosed();
        }
      }
    };

    req.on("error", abortAndCleanup);
    res.on("error", abortAndCleanup);
    outStream.on("error", abortAndCleanup);
    res.on("aborted", () => {
      abortAndCleanup(new Error(`Media HTTP stream aborted prematurely for ${urlStr}`));
    });
    res.on("close", () => {
      if (!settled && res.complete === false) {
        abortAndCleanup(new Error(`Media HTTP stream closed before completion for ${urlStr}`));
      }
    });

    res.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxMediaBytes) {
        const sizeErr = new Error(
          `Media stream (${totalBytes} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`
        );
        sizeErr.code = "ERR_MEDIA_TOO_LARGE";
        abortAndCleanup(sizeErr);
        return;
      }
      hash.update(chunk);
      if (headerCollected < HEADER_PEEK_BYTES) {
        const slice =
          headerCollected + chunk.length <= HEADER_PEEK_BYTES
            ? chunk
            : chunk.subarray(0, HEADER_PEEK_BYTES - headerCollected);
        headerChunks.push(Buffer.from(slice));
        headerCollected += slice.length;
      }
      if (!outStream.write(chunk)) {
        res.pause();
        outStream.once("drain", () => {
          if (!settled) res.resume();
        });
      }
    });

    res.on("end", () => {
      if (settled) return;
      outStream.end(() => {
        if (settled) return;
        const finishResolve = () => {
          if (settled) return;
          settled = true;
          const md5HexStr = hash.digest("hex");
          const headerBuf = Buffer.concat(headerChunks, headerCollected);
          const dim = inspectImageDimensions(headerBuf);
          resolve({ fileSize: totalBytes, md5HexStr, dim });
        };
        if (outStream.closed) {
          finishResolve();
        } else {
          outStream.once("close", finishResolve);
        }
      });
    });
  });

  const ext = options.preferredExt || dim.ext || ".bin";
  const fileName = options.preferredName || `${md5HexStr}${ext}`;
  const safeFileName = path.basename(fileName);
  const localPath = path.join(targetTempDir, safeFileName);
  await _finalizePartFile(tmpPart, localPath, Boolean(options.preferredName), fileSize);

  return {
    localPath,
    fileName: safeFileName,
    fileSize,
    md5HexStr,
    width: dim.width,
    height: dim.height,
    isGif: dim.isGif,
    dim,
  };
}

async function _finalizePartFile(tmpPart, localPath, hasExplicitPreferredName = false, expectedSize = undefined) {
  const matchesSize = (st) =>
    st.isFile() && (expectedSize !== undefined ? st.size === expectedSize : st.size > 0);

  if (!hasExplicitPreferredName) {
    try {
      const existing = await fs.promises.stat(localPath);
      if (matchesSize(existing)) {
        await fs.promises.unlink(tmpPart).catch(() => {});
        return;
      }
    } catch (_) {}
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.promises.rename(tmpPart, localPath);
      return;
    } catch (err) {
      const code = err && err.code ? String(err.code) : "";
      if (code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY") {
        if (!hasExplicitPreferredName) {
          try {
            const afterStat = await fs.promises.stat(localPath);
            if (matchesSize(afterStat)) {
              await fs.promises.unlink(tmpPart).catch(() => {});
              return;
            }
          } catch (_) {}
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
          continue;
        }
        try {
          const afterStat = await fs.promises.stat(localPath);
          if (matchesSize(afterStat)) {
            await fs.promises.unlink(tmpPart).catch(() => {});
            return;
          }
        } catch (_) {}
      }
      await fs.promises.unlink(tmpPart).catch(() => {});
      throw err;
    }
  }
}

async function writeTempMediaAtomically(localPath, buf, hasExplicitPreferredName = false) {
  if (!hasExplicitPreferredName) {
    try {
      const existing = await fs.promises.stat(localPath);
      if (existing.isFile() && existing.size === buf.length && existing.size > 0) {
        return;
      }
    } catch (_) {}
  }

  const tmpPart = `${localPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
  await fs.promises.writeFile(tmpPart, buf, { mode: 0o600 });
  await _finalizePartFile(tmpPart, localPath, hasExplicitPreferredName, buf.length);
}

async function _inspectLocalFileStream(filePath, maxMediaBytes) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const headerChunks = [];
    let headerCollected = 0;
    let totalBytes = 0;
    let settled = false;

    const stream = fs.createReadStream(filePath);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(err);
    };

    stream.on("error", fail);
    stream.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxMediaBytes) {
        const err = new Error(
          `Local media file (${totalBytes} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`
        );
        err.code = "ERR_MEDIA_TOO_LARGE";
        fail(err);
        return;
      }
      hash.update(chunk);
      if (headerCollected < HEADER_PEEK_BYTES) {
        const slice =
          headerCollected + chunk.length <= HEADER_PEEK_BYTES
            ? chunk
            : chunk.subarray(0, HEADER_PEEK_BYTES - headerCollected);
        headerChunks.push(Buffer.from(slice));
        headerCollected += slice.length;
      }
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      const md5HexStr = hash.digest("hex");
      const headerBuf = Buffer.concat(headerChunks, headerCollected);
      const dim = inspectImageDimensions(headerBuf);
      resolve({ fileSize: totalBytes, md5HexStr, dim });
    });
  });
}

function _isSubPathOrEqual(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false;
  const normTarget =
    process.platform === "win32" ? path.resolve(targetPath).toLowerCase() : path.resolve(targetPath);
  const normRoot =
    process.platform === "win32" ? path.resolve(rootPath).toLowerCase() : path.resolve(rootPath);
  const rel = path.relative(normRoot, normTarget);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function _expandDirCandidates(rawDirs, preferRealOnly = false) {
  const seen = new Set();
  const result = [];
  const add = (p) => {
    if (!p) return;
    const key = process.platform === "win32" ? p.toLowerCase() : p;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  };
  await Promise.all(
    rawDirs.map(async (rawDir) => {
      const trimmed = String(rawDir || "").trim();
      if (!trimmed) return;
      const resolved = path.resolve(trimmed);
      if (!preferRealOnly) {
        add(resolved);
      }
      try {
        const real = await fs.promises.realpath(resolved);
        add(real);
      } catch (_) {
        if (preferRealOnly) {
          add(resolved);
        }
      }
    })
  );
  return result;
}

function _getConfiguredConfigDirs() {
  return resolveConfigDirsFromEnv();
}

function _getBlacklistedLocalDirs() {
  const homeDir = getHomeDir();
  const sysHome = os.homedir();
  const configuredCfgDirs = _getConfiguredConfigDirs();
  return [
    ...configuredCfgDirs,
    "/app/data/config",
    "/etc",
    "/proc",
    "/sys",
    "/tmp/.vnc",
    path.join(os.tmpdir(), ".vnc"),
    homeDir ? path.join(homeDir, ".ssh") : "",
    homeDir ? path.join(homeDir, ".vnc") : "",
    homeDir ? path.join(homeDir, ".gnupg") : "",
    sysHome && sysHome !== homeDir ? path.join(sysHome, ".ssh") : "",
    sysHome && sysHome !== homeDir ? path.join(sysHome, ".vnc") : "",
    sysHome && sysHome !== homeDir ? path.join(sysHome, ".gnupg") : "",
  ].filter(Boolean);
}

const SENSITIVE_DIR_SEGMENTS = new Set([
  "nt_db",
  "login",
  "databases",
  "local storage",
  "session storage",
  "indexeddb",
  ".ssh",
  ".vnc",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
]);

const SENSITIVE_FILENAMES = new Set([
  "cookies",
  "cookies-journal",
  "login data",
  "login data-journal",
  "local state",
  "web data",
  "passwd",
  "shadow",
  "gshadow",
  "master.passwd",
  "sudoers",
  ".rosmontis_auto_token",
  ".xiao_bridge_auto_token",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "authorized_keys",
  "known_hosts",
  ".env",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".db",
  ".db-wal",
  ".db-shm",
  ".db-journal",
  ".sqlite",
  ".sqlite-wal",
  ".sqlite-shm",
  ".sqlite3",
  ".ldb",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
]);

function _isSensitiveCredentialOrDbPath(targetPath) {
  if (!targetPath) return false;
  const normalized = path.resolve(targetPath);
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (SENSITIVE_DIR_SEGMENTS.has(parts[i].toLowerCase())) {
      return true;
    }
  }
  const base = (parts[parts.length - 1] || "").toLowerCase();
  if (!base) return false;
  if (SENSITIVE_FILENAMES.has(base) || base.startsWith(".env.")) return true;
  if (/^(?:rosmontis|onebot|xiao_bridge).*\.json$/i.test(base)) return true;
  const ext = path.extname(base);
  if (ext && SENSITIVE_EXTENSIONS.has(ext)) return true;
  return false;
}

function _splitAllowedDirsList(rawInput) {
  if (!rawInput) return [];
  const rawItems = Array.isArray(rawInput) ? rawInput : [rawInput];
  const chunks = [];
  for (const item of rawItems) {
    if (!item) continue;
    for (const piece of String(item).split(/[;,]+/)) {
      if (piece) chunks.push(piece);
    }
  }
  const dirs = [];
  for (const rawChunk of chunks) {
    const part = rawChunk.trim();
    if (!part) continue;
    let current = "";
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      if (ch === ":") {
        const trimmedCurrent = current.trim();
        const isWinDrive =
          trimmedCurrent.length === 1 &&
          /[a-zA-Z]/.test(trimmedCurrent) &&
          (i + 1 === part.length ||
            part[i + 1] === "\\" ||
            (process.platform === "win32" && part[i + 1] === "/"));
        if (isWinDrive) {
          current = `${trimmedCurrent}:`;
          continue;
        }
        if (trimmedCurrent) dirs.push(trimmedCurrent);
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) dirs.push(current.trim());
  }
  return dirs;
}

function _getWhitelistedLocalDirs(tempDir, options = {}) {
  const envAllowed = _splitAllowedDirsList(collectPrefixedEnvValues("ALLOWED_FILE_DIRS"));
  const optAllowed = _splitAllowedDirsList(options.allowedFileDirs);
  // Note: raw os.tmpdir() and root ~/.config/QQ are intentionally NOT blanket-whitelisted;
  // ~/.config/QQ only permits RichMedia cache subdirectories via _isAllowedQqMediaCachePath().
  return [tempDir, "/opt/xiao-data", ...envAllowed, ...optAllowed].filter(Boolean);
}

function _getQqProfileRoots() {
  const homeDir = getHomeDir();
  const sysHome = os.homedir();
  const xdgConfig = getXdgConfigHome();
  return [
    xdgConfig ? path.join(xdgConfig, "QQ") : "",
    homeDir ? path.join(homeDir, ".config/QQ") : "",
    sysHome && sysHome !== homeDir ? path.join(sysHome, ".config/QQ") : "",
    "/app/.config/QQ",
  ].filter(Boolean);
}

const ALLOWED_QQ_MEDIA_SUBDIRS = new Set([
  "pic",
  "video",
  "file",
  "ptt",
  "emoji",
  "marketface",
  "thumb",
]);

function _isAllowedQqMediaCachePath(realPath, qqRoots) {
  for (const root of qqRoots) {
    if (!_isSubPathOrEqual(realPath, root)) continue;
    const rel = path.relative(root, realPath);
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    // Expected layout: [nt_qq_<hash>, "nt_data", "Pic"|"Video"|"File"|"Ptt"|..., ...file]
    const ntDataIdx = segments.findIndex((seg) => seg.toLowerCase() === "nt_data");
    if (ntDataIdx >= 0 && ntDataIdx <= 2 && ntDataIdx + 2 < segments.length) {
      const mediaCategory = segments[ntDataIdx + 1].toLowerCase();
      if (ALLOWED_QQ_MEDIA_SUBDIRS.has(mediaCategory)) {
        return true;
      }
    }
  }
  return false;
}

async function resolveMediaSource(sourceStr, options = {}) {
  const raw = String(sourceStr || "").trim();
  if (!raw) {
    throw new Error("Empty media source");
  }
  const maxMediaBytes = resolveMaxMediaBytes(options);
  const tempDir = resolveTempDirFromEnv(options?.tempDir);
  await fs.promises.mkdir(tempDir, { recursive: true, mode: 0o700 });
  const maxTempFiles = Math.max(8, Number(options.maxTempFiles || 128));

  // 1. base64:// or data:...;base64,...
  if (raw.startsWith("base64://") || /^data:[^;]+;base64,/i.test(raw)) {
    const b64 = (
      raw.startsWith("base64://")
        ? raw.slice("base64://".length)
        : raw.replace(/^data:[^;]+;base64,/i, "")
    ).replace(/\s+/g, "");
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const estimatedBytes = Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
    if (estimatedBytes > maxMediaBytes) {
      const err = new Error(
        `Base64 media payload (~${estimatedBytes} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`
      );
      err.code = "ERR_MEDIA_TOO_LARGE";
      throw err;
    }
    const buf = Buffer.from(b64, "base64");
    if (buf.length > maxMediaBytes) {
      const err = new Error(
        `Decoded base64 media (${buf.length} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`
      );
      err.code = "ERR_MEDIA_TOO_LARGE";
      throw err;
    }
    const md5HexStr = crypto.createHash("md5").update(buf).digest("hex");
    const dim = inspectImageDimensions(buf);
    const ext = options.preferredExt || dim.ext || ".bin";
    const fileName = options.preferredName || `${md5HexStr}${ext}`;
    const safeFileName = path.basename(fileName);
    const localPath = path.join(tempDir, safeFileName);
    await writeTempMediaAtomically(localPath, buf, Boolean(options.preferredName));
    await pruneTempDirAsync(tempDir, maxTempFiles);
    return {
      localPath,
      fileName: safeFileName,
      fileSize: buf.length,
      md5HexStr,
      width: dim.width,
      height: dim.height,
      isGif: dim.isGif,
      isTempFile: true,
    };
  }

  // 2. http:// or https:// (streamed directly to disk without buffering up to 256 MiB in RAM)
  if (/^https?:\/\//i.test(raw)) {
    const dl = await downloadMediaStreamToTempDir(raw, tempDir, {
      ...options,
      timeoutMs: options.timeoutMs || 25000,
      maxMediaBytes,
    });
    await pruneTempDirAsync(tempDir, maxTempFiles);
    return {
      localPath: dl.localPath,
      fileName: dl.fileName,
      fileSize: dl.fileSize,
      md5HexStr: dl.md5HexStr,
      width: dl.width,
      height: dl.height,
      isGif: dl.isGif,
      isTempFile: true,
    };
  }

  // Reject non-file URL schemes explicitly (e.g. ftp://, gopher://)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) && !/^file:\/\//i.test(raw)) {
    throw new Error(`Media source not found or unsupported: ${raw.slice(0, 120)}`);
  }

  // 3. file:// or local path
  let localPath = raw;
  if (/^file:\/\//i.test(raw)) {
    try {
      localPath = fileURLToPath(raw);
    } catch (_) {
      try {
        const u = new URL(raw);
        localPath = decodeURIComponent(u.pathname);
        if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(localPath)) {
          localPath = localPath.slice(1);
        }
      } catch (_2) {
        localPath = raw.replace(/^file:\/+/i, "/");
      }
    }
  }

  const allowArbitraryLocalFiles =
    options.allowArbitraryLocalFiles === true ||
    isPrefixedEnvFlagOne("ALLOW_ARBITRARY_LOCAL_FILES");

  const resolvedInput = path.resolve(localPath);
  const configuredCfgDirs =
    options.allowSensitiveConfigFiles === true
      ? []
      : await _expandDirCandidates(_getConfiguredConfigDirs());
  if (configuredCfgDirs.some((dir) => _isSubPathOrEqual(resolvedInput, dir))) {
    const err = new Error(`Blocked access to restricted local config path: ${localPath}`);
    err.code = "ERR_LFI_BLOCKED";
    throw err;
  }

  let blacklistedDirs = [];
  if (!allowArbitraryLocalFiles) {
    blacklistedDirs = await _expandDirCandidates(_getBlacklistedLocalDirs());
    if (
      blacklistedDirs.some((dir) => _isSubPathOrEqual(resolvedInput, dir)) ||
      _isSensitiveCredentialOrDbPath(resolvedInput)
    ) {
      const err = new Error(`Blocked access to restricted local path: ${localPath}`);
      err.code = "ERR_LFI_BLOCKED";
      throw err;
    }
  }

  let realPath;
  try {
    realPath = await fs.promises.realpath(localPath);
  } catch (_) {
    if (!allowArbitraryLocalFiles) {
      let symlinkTarget = "";
      try {
        const lst = await fs.promises.lstat(localPath);
        if (lst.isSymbolicLink()) {
          const linkRaw = await fs.promises.readlink(localPath);
          symlinkTarget = path.resolve(path.dirname(resolvedInput), linkRaw);
        }
      } catch (_2) {}
      if (symlinkTarget) {
        if (
          blacklistedDirs.some((dir) => _isSubPathOrEqual(symlinkTarget, dir)) ||
          _isSensitiveCredentialOrDbPath(symlinkTarget)
        ) {
          const err = new Error(`Blocked access to restricted local path: ${symlinkTarget}`);
          err.code = "ERR_LFI_BLOCKED";
          throw err;
        }
        const [whitelistedDirs, qqRoots] = await Promise.all([
          _expandDirCandidates(_getWhitelistedLocalDirs(tempDir, options), true),
          _expandDirCandidates(_getQqProfileRoots(), true),
        ]);
        const inWhitelist = whitelistedDirs.some((dir) => _isSubPathOrEqual(symlinkTarget, dir));
        const inQqCache = _isAllowedQqMediaCachePath(symlinkTarget, qqRoots);
        if (!inWhitelist && !inQqCache) {
          const err = new Error(
            `Blocked local media symlink outside allowed directories: ${symlinkTarget}`
          );
          err.code = "ERR_LFI_BLOCKED";
          throw err;
        }
      }
    }
    throw new Error(`Media source not found or unsupported: ${raw.slice(0, 120)}`);
  }

  if (configuredCfgDirs.some((dir) => _isSubPathOrEqual(realPath, dir))) {
    const err = new Error(`Blocked access to restricted local config path: ${realPath}`);
    err.code = "ERR_LFI_BLOCKED";
    throw err;
  }

  if (!allowArbitraryLocalFiles) {
    if (
      blacklistedDirs.some((dir) => _isSubPathOrEqual(realPath, dir)) ||
      _isSensitiveCredentialOrDbPath(realPath)
    ) {
      const err = new Error(`Blocked access to restricted local path: ${realPath}`);
      err.code = "ERR_LFI_BLOCKED";
      throw err;
    }
    const [whitelistedDirs, qqRoots] = await Promise.all([
      _expandDirCandidates(_getWhitelistedLocalDirs(tempDir, options), true),
      _expandDirCandidates(_getQqProfileRoots(), true),
    ]);
    const inExplicitWhitelist = whitelistedDirs.some((dir) => _isSubPathOrEqual(realPath, dir));
    const inQqMediaCache = _isAllowedQqMediaCachePath(realPath, qqRoots);
    if (!inExplicitWhitelist && !inQqMediaCache) {
      const err = new Error(
        `Blocked local media file outside allowed directories: ${realPath}`
      );
      err.code = "ERR_LFI_BLOCKED";
      throw err;
    }
  }

  let st;
  try {
    st = await fs.promises.stat(realPath);
  } catch (_) {
    throw new Error(`Media source not found or unsupported: ${raw.slice(0, 120)}`);
  }
  if (!st.isFile()) {
    throw new Error(`Media source not found or unsupported: ${raw.slice(0, 120)}`);
  }
  if (st.size > maxMediaBytes) {
    const err = new Error(
      `Local media file (${st.size} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`
    );
    err.code = "ERR_MEDIA_TOO_LARGE";
    throw err;
  }

  const { fileSize, md5HexStr, dim } = await _inspectLocalFileStream(realPath, maxMediaBytes);
  const fileName = options.preferredName || path.basename(realPath) || `${md5HexStr}${dim.ext}`;
  return {
    localPath: realPath,
    fileName: path.basename(fileName),
    fileSize,
    md5HexStr,
    width: dim.width,
    height: dim.height,
    isGif: dim.isGif,
    isTempFile: false,
  };
}

module.exports = {
  DEFAULT_MAX_MEDIA_BYTES,
  inspectImageDimensions,
  getNtqqVersionMetadata,
  buildNtqqUserAgent,
  resolveMaxMediaBytes,
  isPrivateOrReservedIp,
  createSsrfSafeLookup,
  pruneTempDir,
  pruneTempDirAsync,
  downloadBufferFromUrl,
  downloadMediaStreamToTempDir,
  resolveMediaSource,
};

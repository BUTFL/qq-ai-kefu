"use strict";

const assert = require("assert");
const crypto = require("crypto");
const dns = require("dns");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const onebot = require("../src/bridge_onebot.js");
const mediaSecurity = require("../src/core/media_security.js");

const ONE_BY_ONE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const ONE_BY_ONE_PNG_BUF = Buffer.from(ONE_BY_ONE_PNG_B64, "base64");

function saveEnvVars(keys) {
  const snapshot = new Map();
  for (const k of keys) {
    snapshot.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
  }
  return () => {
    for (const [k, v] of snapshot.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function runMediaSecurityTests() {
  let passed = 0;
  async function check(name, fn) {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  }

  console.log("=== Media Security, Tight LFI Whitelist, Comprehensive IPv4/IPv6 SSRF & Streaming Quota Tests ===");

  await check("DEFAULT_MAX_MEDIA_BYTES equals 256 MiB and isPrivateOrReservedIp classifies all IPv4 & IPv6 ranges accurately", () => {
    assert.strictEqual(onebot.DEFAULT_MAX_MEDIA_BYTES, 256 * 1024 * 1024);
    assert.strictEqual(onebot.DEFAULT_MAX_MEDIA_BYTES, 268435456);
    assert.strictEqual(mediaSecurity.isPrivateOrReservedIp, onebot.isPrivateOrReservedIp);
    assert.strictEqual(mediaSecurity.downloadMediaStreamToTempDir, onebot.downloadMediaStreamToTempDir);

    const privateOrReservedIpv4 = [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.254",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "127.0.53.53",
      "169.254.169.254",
      "169.254.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "192.168.255.254",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "198.18.0.1",
      "198.19.255.254",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "239.255.255.250",
      "255.255.255.255",
    ];
    for (const ip of privateOrReservedIpv4) {
      assert.strictEqual(
        onebot.isPrivateOrReservedIp(ip),
        true,
        `Expected IPv4 ${ip} to be classified as private/reserved`
      );
    }

    const publicIpv4 = [
      "8.8.8.8",
      "1.1.1.1",
      "172.15.255.254",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "93.184.216.34",
      "192.169.0.1",
    ];
    for (const ip of publicIpv4) {
      assert.strictEqual(
        onebot.isPrivateOrReservedIp(ip),
        false,
        `Expected IPv4 ${ip} to be classified as public`
      );
    }

    const privateOrReservedIpv6 = [
      "::",
      "::1",
      "[::1]",
      "fe80::1",
      "fe80::1%eth0",
      "[fe80::1%25eth0]",
      "febf::abcd",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:0001",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "::ffff:10.0.0.1",
      "::ffff:192.168.1.10",
      "64:ff9b::127.0.0.1",
      "64:ff9b:1::1",
      "100::1",
      "2001::1",
      "2001:2::1",
      "2001:db8::1",
      "2002:7f00:0001::1",
      "fec0::1",
    ];
    for (const ip of privateOrReservedIpv6) {
      assert.strictEqual(
        onebot.isPrivateOrReservedIp(ip),
        true,
        `Expected IPv6 ${ip} to be classified as private/reserved`
      );
    }

    const publicIpv6 = [
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8",
      "::ffff:0808:0808",
    ];
    for (const ip of publicIpv6) {
      assert.strictEqual(
        onebot.isPrivateOrReservedIp(ip),
        false,
        `Expected IPv6 ${ip} to be classified as public`
      );
    }
  });

  await check("Live HTTP SSRF guard blocks loopback, IPv6, 302 redirects to 127.0.0.1 & file:///etc/passwd, and DNS rebinding; allowPrivateMediaUrls: true succeeds", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_ssrf_test_"));
    let okHits = 0;

    const targetSrv = http.createServer((req, res) => {
      if (req.url === "/ok.png") {
        okHits += 1;
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(ONE_BY_ONE_PNG_BUF.length),
        });
        res.end(ONE_BY_ONE_PNG_BUF);
        return;
      }
      if (req.url === "/redirect-file") {
        res.writeHead(302, { Location: "file:///etc/passwd" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    await new Promise((resolve) => targetSrv.listen(0, "127.0.0.1", resolve));
    const targetPort = targetSrv.address().port;

    const redirectSrv = http.createServer((req, res) => {
      if (req.url === "/to-loopback") {
        res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/ok.png` });
        res.end();
        return;
      }
      if (req.url === "/to-ipv6-loopback") {
        res.writeHead(302, { Location: `http://[::1]:${targetPort}/ok.png` });
        res.end();
        return;
      }
      if (req.url === "/to-file-passwd") {
        res.writeHead(302, { Location: "file:///etc/passwd" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => redirectSrv.listen(0, "127.0.0.1", resolve));
    const redirectPort = redirectSrv.address().port;

    // Route public-cdn.example.com over real TCP to redirectSrv while keeping SSRF guard active
    const publicRedirectAgent = new http.Agent({ keepAlive: false });
    publicRedirectAgent.createConnection = (opts, cb) => {
      if (opts.host === "public-cdn.example.com") {
        return net.createConnection({ host: "127.0.0.1", port: redirectPort }, cb);
      }
      return net.createConnection(opts, cb);
    };

    try {
      // 1. Direct literal private/reserved IPs blocked before TCP socket reaches targetSrv
      for (const blockedUrl of [
        `http://127.0.0.1:${targetPort}/ok.png`,
        "http://169.254.169.254/latest/meta-data/",
        `http://[::1]:${targetPort}/ok.png`,
        `http://[::ffff:127.0.0.1]:${targetPort}/ok.png`,
      ]) {
        await assert.rejects(
          () => onebot.resolveMediaSource(blockedUrl, { tempDir: tmpDir }),
          (err) => err && err.code === "ERR_SSRF_BLOCKED",
          `Expected ERR_SSRF_BLOCKED for ${blockedUrl}`
        );
      }
      assert.strictEqual(okHits, 0, "Loopback HTTP server must not receive blocked SSRF requests");

      // 2. Live HTTP 302 redirects from public URL to 127.0.0.1, [::1], and file:///etc/passwd
      for (const redirectPath of ["/to-loopback", "/to-ipv6-loopback", "/to-file-passwd"]) {
        await assert.rejects(
          () =>
            onebot.resolveMediaSource(`http://public-cdn.example.com${redirectPath}`, {
              tempDir: tmpDir,
              agent: publicRedirectAgent,
            }),
          (err) => err && err.code === "ERR_SSRF_BLOCKED",
          `Expected ERR_SSRF_BLOCKED on 302 redirect ${redirectPath}`
        );
      }
      assert.strictEqual(okHits, 0, "302 redirect target on 127.0.0.1 must never be contacted");

      // Even with allowPrivateMediaUrls: true, 302 redirect to file:///etc/passwd is blocked
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(`http://127.0.0.1:${targetPort}/redirect-file`, {
            tempDir: tmpDir,
            allowPrivateMediaUrls: true,
          }),
        (err) => err && err.code === "ERR_SSRF_BLOCKED"
      );

      // 3. DNS rebinding to private IPv4/IPv6 blocked in both single & { all: true } lookup modes
      const origDnsLookup = dns.lookup;
      dns.lookup = function mockedDnsLookup(hostname, opts, callback) {
        const cb = typeof opts === "function" ? opts : callback;
        const wantAll = Boolean(opts && typeof opts === "object" && opts.all === true);
        if (hostname === "rebind-loopback.example.com") {
          return process.nextTick(() =>
            wantAll ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)
          );
        }
        if (hostname === "rebind-meta.example.com") {
          return process.nextTick(() =>
            wantAll
              ? cb(null, [{ address: "169.254.169.254", family: 4 }])
              : cb(null, "169.254.169.254", 4)
          );
        }
        if (hostname === "rebind-v6.example.com") {
          return process.nextTick(() =>
            wantAll
              ? cb(null, [
                  { address: "2606:4700:4700::1111", family: 6 },
                  { address: "::ffff:127.0.0.1", family: 6 },
                ])
              : cb(null, "::ffff:127.0.0.1", 6)
          );
        }
        return origDnsLookup.apply(this, arguments);
      };
      try {
        for (const host of [
          `http://rebind-loopback.example.com:${targetPort}/ok.png`,
          "http://rebind-meta.example.com/latest/meta-data/",
          `http://rebind-v6.example.com:${targetPort}/ok.png`,
        ]) {
          await assert.rejects(
            () => onebot.resolveMediaSource(host, { tempDir: tmpDir }),
            (err) => err && err.code === "ERR_SSRF_BLOCKED"
          );
        }
        assert.strictEqual(okHits, 0, "DNS rebinding to private IP must abort before TCP connect");
      } finally {
        dns.lookup = origDnsLookup;
      }

      // 4. Explicit allowPrivateMediaUrls: true cleanly downloads from local HTTP server
      const media = await onebot.resolveMediaSource(`http://127.0.0.1:${targetPort}/ok.png`, {
        tempDir: tmpDir,
        allowPrivateMediaUrls: true,
      });
      assert.strictEqual(okHits, 1);
      assert.strictEqual(media.fileSize, ONE_BY_ONE_PNG_BUF.length);
      assert.strictEqual(media.width, 1);
      assert.strictEqual(media.height, 1);
      assert.strictEqual(media.isTempFile, true);
      const savedBytes = await fs.promises.readFile(media.localPath);
      assert.ok(savedBytes.equals(ONE_BY_ONE_PNG_BUF));
    } finally {
      publicRedirectAgent.destroy();
      await new Promise((resolve) => redirectSrv.close(resolve));
      await new Promise((resolve) => targetSrv.close(resolve));
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await check("Streaming media download & quota enforcement aborts oversized Content-Length and chunked transfers cleanly with zero leftover .part files", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_quota_test_"));
    let chunkedHits = 0;
    let streamChunksSent = 0;

    const exact1KbBuf = Buffer.concat([
      ONE_BY_ONE_PNG_BUF,
      Buffer.alloc(1024 - ONE_BY_ONE_PNG_BUF.length, 0x33),
    ]);

    const srv = http.createServer((req, res) => {
      if (req.url === "/oversize-header") {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": "4096",
        });
        res.end(Buffer.alloc(4096, 0x41));
        return;
      }
      if (req.url === "/oversize-chunked") {
        chunkedHits += 1;
        streamChunksSent = 0;
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Transfer-Encoding": "chunked",
        });
        const sendNext = () => {
          if (res.destroyed || streamChunksSent >= 20) {
            if (!res.destroyed) res.end();
            return;
          }
          streamChunksSent += 1;
          res.write(Buffer.alloc(512, 0x42), () => {
            setTimeout(sendNext, 10);
          });
        };
        sendNext();
        return;
      }
      if (req.url === "/exact-1kb.png") {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(exact1KbBuf.length),
        });
        res.end(exact1KbBuf);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;

    try {
      // 1. Immediate abort when Content-Length > maxMediaBytes (both downloadMediaStreamToTempDir & resolveMediaSource)
      await assert.rejects(
        () =>
          onebot.downloadMediaStreamToTempDir(`http://127.0.0.1:${port}/oversize-header`, tmpDir, {
            allowPrivateMediaUrls: true,
            maxMediaBytes: 1024,
          }),
        (err) => err && err.code === "ERR_MEDIA_TOO_LARGE"
      );
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(`http://127.0.0.1:${port}/oversize-header`, {
            tempDir: tmpDir,
            allowPrivateMediaUrls: true,
            maxMediaBytes: 1024,
          }),
        (err) => err && err.code === "ERR_MEDIA_TOO_LARGE"
      );
      assert.deepStrictEqual(
        (await fs.promises.readdir(tmpDir)).filter((n) => n.endsWith(".part")),
        [],
        "Zero .part files may exist after Content-Length rejection"
      );

      // 2. Mid-stream abort on chunked transfer exceeding maxMediaBytes with zero leftover .part files
      await assert.rejects(
        () =>
          onebot.downloadMediaStreamToTempDir(`http://127.0.0.1:${port}/oversize-chunked`, tmpDir, {
            allowPrivateMediaUrls: true,
            maxMediaBytes: 1024,
          }),
        (err) => err && err.code === "ERR_MEDIA_TOO_LARGE"
      );
      assert.ok(
        streamChunksSent >= 3 && streamChunksSent < 20,
        `Expected downloadMediaStreamToTempDir to abort chunked stream early, sent ${streamChunksSent} chunks`
      );
      assert.deepStrictEqual(
        await fs.promises.readdir(tmpDir),
        [],
        "Zero leftover .part or partial files may remain in tempDir after downloadMediaStreamToTempDir abort"
      );

      await assert.rejects(
        () =>
          onebot.resolveMediaSource(`http://127.0.0.1:${port}/oversize-chunked`, {
            tempDir: tmpDir,
            allowPrivateMediaUrls: true,
            maxMediaBytes: 1024,
          }),
        (err) => err && err.code === "ERR_MEDIA_TOO_LARGE"
      );
      assert.strictEqual(chunkedHits, 2);
      assert.ok(
        streamChunksSent >= 3 && streamChunksSent < 20,
        `Expected resolveMediaSource to abort chunked stream early, sent ${streamChunksSent} chunks`
      );
      assert.deepStrictEqual(
        await fs.promises.readdir(tmpDir),
        [],
        "Zero leftover .part or partial files may remain in tempDir after resolveMediaSource abort"
      );

      // 3. Exact 1024-byte streaming download succeeds cleanly
      const streamedExact = await onebot.downloadMediaStreamToTempDir(
        `http://127.0.0.1:${port}/exact-1kb.png`,
        tmpDir,
        { allowPrivateMediaUrls: true, maxMediaBytes: 1024 }
      );
      assert.strictEqual(streamedExact.fileSize, 1024);
      assert.strictEqual(
        streamedExact.md5HexStr,
        crypto.createHash("md5").update(exact1KbBuf).digest("hex")
      );
      assert.deepStrictEqual(
        (await fs.promises.readdir(tmpDir)).filter((n) => n.endsWith(".part")),
        []
      );

      // 4. Oversized base64:// & data:...;base64, rejected pre-allocation; exact 1024-byte boundary succeeds
      const oversizeB64 = Buffer.alloc(2048, 0x5a).toString("base64");
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(`base64://${oversizeB64}`, {
            tempDir: tmpDir,
            maxMediaBytes: 1024,
          }),
        (err) => err && err.code === "ERR_MEDIA_TOO_LARGE"
      );
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(`data:application/octet-stream;base64,${oversizeB64}`, {
            tempDir: tmpDir,
            maxMediaBytes: 1024,
          }),
        (err) => err && err.code === "ERR_MEDIA_TOO_LARGE"
      );

      const exactB64Media = await onebot.resolveMediaSource(
        `base64://${Buffer.alloc(1024, 0x33).toString("base64")}`,
        { tempDir: tmpDir, maxMediaBytes: 1024 }
      );
      assert.strictEqual(exactB64Media.fileSize, 1024);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await check("Tightened LFI boundary allows tempDir, rejects sibling os.tmpdir() subdirs, rejects outside symlinks/junctions, and protects ROSMONTIS_CONFIG_DIR", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_lfi_tmp_"));
    const osTmpSiblingDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_lfi_ostmp_"));
    const cfgDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_lfi_cfg_"));
    const outsideDir = await fs.promises.mkdtemp(path.join(__dirname, ".tmp_outside_lfi_"));

    const restoreEnv = saveEnvVars([
      "ROSMONTIS_CONFIG_DIR",
      "ONEBOT_CONFIG_DIR",
      "XIAO_BRIDGE_CONFIG_DIR",
      "ROSMONTIS_ALLOWED_FILE_DIRS",
      "ONEBOT_ALLOWED_FILE_DIRS",
      "XIAO_BRIDGE_ALLOWED_FILE_DIRS",
      "ROSMONTIS_ALLOW_ARBITRARY_LOCAL_FILES",
      "ONEBOT_ALLOW_ARBITRARY_LOCAL_FILES",
      "XIAO_BRIDGE_ALLOW_ARBITRARY_LOCAL_FILES",
    ]);
    process.env.ROSMONTIS_CONFIG_DIR = cfgDir;
    delete process.env.ONEBOT_CONFIG_DIR;
    delete process.env.XIAO_BRIDGE_CONFIG_DIR;
    delete process.env.ROSMONTIS_ALLOWED_FILE_DIRS;
    delete process.env.ONEBOT_ALLOWED_FILE_DIRS;
    delete process.env.XIAO_BRIDGE_ALLOWED_FILE_DIRS;
    delete process.env.ROSMONTIS_ALLOW_ARBITRARY_LOCAL_FILES;
    delete process.env.ONEBOT_ALLOW_ARBITRARY_LOCAL_FILES;
    delete process.env.XIAO_BRIDGE_ALLOW_ARBITRARY_LOCAL_FILES;

    try {
      const allowedInTemp = path.join(tmpDir, "valid_temp.png");
      const disallowedInOsTmp = path.join(osTmpSiblingDir, "sibling_ostmp.png");
      const secretCfgJson = path.join(cfgDir, "onebot.json");
      const secretCfgPng = path.join(cfgDir, "cfg_asset.png");
      const outsideSecretFile = path.join(outsideDir, "outside_secret.png");

      await fs.promises.writeFile(allowedInTemp, ONE_BY_ONE_PNG_BUF);
      await fs.promises.writeFile(disallowedInOsTmp, ONE_BY_ONE_PNG_BUF);
      await fs.promises.writeFile(secretCfgJson, '{"accessToken":"super_secret_token"}', "utf8");
      await fs.promises.writeFile(secretCfgPng, ONE_BY_ONE_PNG_BUF);
      await fs.promises.writeFile(outsideSecretFile, ONE_BY_ONE_PNG_BUF);

      // 1. File inside configured tempDir succeeds (both direct path & file:// URL)
      const m1 = await onebot.resolveMediaSource(allowedInTemp, { tempDir: tmpDir });
      assert.strictEqual(m1.fileSize, ONE_BY_ONE_PNG_BUF.length);
      assert.strictEqual(m1.isTempFile, false);
      assert.strictEqual(m1.localPath, await fs.promises.realpath(allowedInTemp));

      const m1Url = await onebot.resolveMediaSource(pathToFileURL(allowedInTemp).toString(), {
        tempDir: tmpDir,
      });
      assert.strictEqual(m1Url.fileSize, ONE_BY_ONE_PNG_BUF.length);

      // 2. Unrelated os.tmpdir() sibling directory outside tempDir is strictly REJECTED
      await assert.rejects(
        () => onebot.resolveMediaSource(disallowedInOsTmp, { tempDir: tmpDir }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(pathToFileURL(disallowedInOsTmp).toString(), {
            tempDir: tmpDir,
          }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );

      // 3. Arbitrary outside directory is rejected
      await assert.rejects(
        () => onebot.resolveMediaSource(outsideSecretFile, { tempDir: tmpDir }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );

      // 4. Symlink / junction inside tempDir pointing to outside file is rejected via canonical realpath
      const symlinkDir = path.join(tmpDir, "escaped_dir_link");
      await fs.promises.symlink(
        outsideDir,
        symlinkDir,
        process.platform === "win32" ? "junction" : "dir"
      );
      await assert.rejects(
        () => onebot.resolveMediaSource(path.join(symlinkDir, "outside_secret.png"), { tempDir: tmpDir }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );

      // Direct file symlink (skip gracefully on Windows if EPERM without Developer Mode)
      const symlinkFile = path.join(tmpDir, "escaped_file_link.png");
      let fileSymlinkCreated = false;
      try {
        fs.symlinkSync(outsideSecretFile, symlinkFile, "file");
        fileSymlinkCreated = true;
      } catch (symErr) {
        if (!symErr || (symErr.code !== "EPERM" && symErr.code !== "ENOSYS")) {
          throw symErr;
        }
      }
      if (fileSymlinkCreated) {
        await assert.rejects(
          () => onebot.resolveMediaSource(symlinkFile, { tempDir: tmpDir }),
          (err) => err && err.code === "ERR_LFI_BLOCKED"
        );
      }

      // 5. ROSMONTIS_CONFIG_DIR files remain blocked even when allowArbitraryLocalFiles: true
      await assert.rejects(
        () => onebot.resolveMediaSource(secretCfgJson, { tempDir: tmpDir }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(secretCfgJson, {
            tempDir: tmpDir,
            allowArbitraryLocalFiles: true,
          }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(secretCfgPng, {
            tempDir: tmpDir,
            allowArbitraryLocalFiles: true,
          }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );

      // Symlink/junction pointing into ROSMONTIS_CONFIG_DIR is also blocked under allowArbitraryLocalFiles: true
      const cfgLinkDir = path.join(outsideDir, "cfg_junction");
      await fs.promises.symlink(
        cfgDir,
        cfgLinkDir,
        process.platform === "win32" ? "junction" : "dir"
      );
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(path.join(cfgLinkDir, "cfg_asset.png"), {
            tempDir: tmpDir,
            allowArbitraryLocalFiles: true,
          }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );

      // Only explicit allowSensitiveConfigFiles: true alongside allowArbitraryLocalFiles: true permits it
      const allowedCfgAsset = await onebot.resolveMediaSource(secretCfgPng, {
        tempDir: tmpDir,
        allowArbitraryLocalFiles: true,
        allowSensitiveConfigFiles: true,
      });
      assert.strictEqual(allowedCfgAsset.fileSize, ONE_BY_ONE_PNG_BUF.length);

      // 6. System /etc/passwd is strictly blocked
      await assert.rejects(
        () => onebot.resolveMediaSource("/etc/passwd", { tempDir: tmpDir }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );
    } finally {
      restoreEnv();
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
      await fs.promises.rm(osTmpSiblingDir, { recursive: true, force: true });
      await fs.promises.rm(cfgDir, { recursive: true, force: true });
      await fs.promises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  await check("Narrow QQ NT RichMedia cache paths are allowed while sibling QQ DBs, Cookies, .ldb, and bridge config JSONs are blocked", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_qq_tmp_"));
    const fakeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_fake_home_"));

    const restoreEnv = saveEnvVars([
      "HOME",
      "XDG_CONFIG_HOME",
      "ROSMONTIS_ALLOWED_FILE_DIRS",
      "ONEBOT_ALLOWED_FILE_DIRS",
      "XIAO_BRIDGE_ALLOWED_FILE_DIRS",
    ]);
    process.env.HOME = fakeHome;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.ROSMONTIS_ALLOWED_FILE_DIRS;
    delete process.env.ONEBOT_ALLOWED_FILE_DIRS;
    delete process.env.XIAO_BRIDGE_ALLOWED_FILE_DIRS;

    try {
      const qqRoot = path.join(fakeHome, ".config", "QQ");
      const allowedMediaPaths = [
        path.join(qqRoot, "nt_qq_abc123", "nt_data", "Pic", "2026-11", "Ori", "test.png"),
        path.join(qqRoot, "nt_qq_abc123", "nt_data", "Video", "2026-11", "clip.mp4"),
        path.join(qqRoot, "nt_qq_abc123", "nt_data", "File", "doc.pdf"),
        path.join(qqRoot, "nt_qq_abc123", "nt_data", "Ptt", "voice.amr"),
        path.join(qqRoot, "nt_qq_abc123", "nt_data", "Emoji", "sticker.png"),
        path.join(qqRoot, "nt_qq_abc123", "nt_data", "MarketFace", "mface.png"),
        path.join(qqRoot, "nt_qq_abc123", "nt_data", "Thumb", "thumb.png"),
      ];

      for (const p of allowedMediaPaths) {
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await fs.promises.writeFile(p, ONE_BY_ONE_PNG_BUF);
        const resolved = await onebot.resolveMediaSource(p, { tempDir: tmpDir });
        assert.strictEqual(resolved.fileSize, ONE_BY_ONE_PNG_BUF.length);
        assert.strictEqual(resolved.isTempFile, false);
      }

      // Sensitive QQ DBs, Cookies, LevelDB .ldb, non-media QQ dirs, and config JSON filenames must be blocked
      const blockedPaths = [
        path.join(qqRoot, "nt_qq_abc123", "nt_db", "nt_msg.db"),
        path.join(qqRoot, "nt_qq_abc123", "nt_db", "nt_msg.db-wal"),
        path.join(qqRoot, "Cookies"),
        path.join(qqRoot, "Local Storage", "leveldb", "000005.ldb"),
        path.join(qqRoot, "nt_qq_abc123", "nt_data", "Log", "client.log"),
        path.join(qqRoot, "nt_qq_abc123", "profile_root.png"),
        path.join(qqRoot, "rosmontis.json"),
        path.join(qqRoot, "onebot.json"),
        path.join(qqRoot, "xiao_bridge.json"),
        // Even inside whitelisted tempDir or Pic cache, sensitive filenames/extensions are blocked!
        path.join(tmpDir, "rosmontis.json"),
        path.join(tmpDir, "onebot.json"),
        path.join(tmpDir, "xiao_bridge.json"),
        path.join(tmpDir, "session_tokens.ldb"),
        path.join(qqRoot, "nt_qq_abc123", "nt_data", "Pic", "2026-11", "sneaky.ldb"),
      ];

      for (const bp of blockedPaths) {
        await fs.promises.mkdir(path.dirname(bp), { recursive: true });
        await fs.promises.writeFile(bp, ONE_BY_ONE_PNG_BUF);
        await assert.rejects(
          () => onebot.resolveMediaSource(bp, { tempDir: tmpDir }),
          (err) => err && err.code === "ERR_LFI_BLOCKED",
          `Expected ERR_LFI_BLOCKED for sensitive or non-whitelisted path: ${bp}`
        );
      }
    } finally {
      restoreEnv();
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
      await fs.promises.rm(fakeHome, { recursive: true, force: true });
    }
  });

  await check("ROSMONTIS_ALLOWED_FILE_DIRS & XIAO_BRIDGE_ALLOWED_FILE_DIRS parse multi-directory lists across platforms", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_allowlist_tmp_"));
    const dirA = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_allow_a_"));
    const dirB = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_allow_b_"));
    const dirC = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_allow_c_"));
    const dirD = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_allow_d_"));
    const dirUnlisted = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_unlisted_"));

    const restoreEnv = saveEnvVars([
      "ROSMONTIS_ALLOWED_FILE_DIRS",
      "ONEBOT_ALLOWED_FILE_DIRS",
      "XIAO_BRIDGE_ALLOWED_FILE_DIRS",
    ]);

    try {
      const fileA = path.join(dirA, "a.png");
      const fileB = path.join(dirB, "b.png");
      const fileC = path.join(dirC, "c.png");
      const fileD = path.join(dirD, "d.png");
      const fileUnlisted = path.join(dirUnlisted, "unlisted.png");
      const sensitiveInAllowed = path.join(dirA, "rosmontis.json");

      for (const f of [fileA, fileB, fileC, fileD, fileUnlisted, sensitiveInAllowed]) {
        await fs.promises.writeFile(f, ONE_BY_ONE_PNG_BUF);
      }

      // path.delimiter (; on Windows, : on POSIX) in ROSMONTIS_ALLOWED_FILE_DIRS, comma in ONEBOT_ALLOWED_FILE_DIRS, and colon in XIAO_BRIDGE_ALLOWED_FILE_DIRS
      process.env.ROSMONTIS_ALLOWED_FILE_DIRS = `${dirA}${path.delimiter}${dirB}`;
      process.env.ONEBOT_ALLOWED_FILE_DIRS = `${dirB}, ${dirC}`;
      process.env.XIAO_BRIDGE_ALLOWED_FILE_DIRS = `${dirC}:${dirD}`;

      for (const allowedFile of [fileA, fileB, fileC, fileD]) {
        const res = await onebot.resolveMediaSource(allowedFile, { tempDir: tmpDir });
        assert.strictEqual(res.fileSize, ONE_BY_ONE_PNG_BUF.length);
      }

      // Unlisted sibling directory remains blocked
      await assert.rejects(
        () => onebot.resolveMediaSource(fileUnlisted, { tempDir: tmpDir }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );

      // Sensitive config/credential filenames inside an allowed directory remain blocked
      await assert.rejects(
        () => onebot.resolveMediaSource(sensitiveInAllowed, { tempDir: tmpDir }),
        (err) => err && err.code === "ERR_LFI_BLOCKED"
      );

      // options.allowedFileDirs (comma-separated string or array) also grants scoped access
      const viaOpts = await onebot.resolveMediaSource(fileUnlisted, {
        tempDir: tmpDir,
        allowedFileDirs: `${dirUnlisted} , ${dirA}`,
      });
      assert.strictEqual(viaOpts.fileSize, ONE_BY_ONE_PNG_BUF.length);

      const viaOptsArray = await onebot.resolveMediaSource(fileUnlisted, {
        tempDir: tmpDir,
        allowedFileDirs: [`${dirUnlisted};${dirA}`, dirB],
      });
      assert.strictEqual(viaOptsArray.fileSize, ONE_BY_ONE_PNG_BUF.length);
    } finally {
      restoreEnv();
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
      await fs.promises.rm(dirA, { recursive: true, force: true });
      await fs.promises.rm(dirB, { recursive: true, force: true });
      await fs.promises.rm(dirC, { recursive: true, force: true });
      await fs.promises.rm(dirD, { recursive: true, force: true });
      await fs.promises.rm(dirUnlisted, { recursive: true, force: true });
    }
  });

  await check("Concurrent Promise.all HTTP streaming downloads & base64:// writes (identical + distinct) complete without ENOENT or race corruption", async () => {
    const httpTmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_http_conc_"));
    const b64TmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_b64_conc_"));

    const distinctPayloads = Array.from({ length: 10 }, (_, i) =>
      Buffer.concat([ONE_BY_ONE_PNG_BUF, Buffer.from(`http-stream-tail-${i}-${"z".repeat(512)}`)])
    );

    const srv = http.createServer((req, res) => {
      if (req.url === "/shared.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.write(ONE_BY_ONE_PNG_BUF.subarray(0, 32));
        setTimeout(() => res.end(ONE_BY_ONE_PNG_BUF.subarray(32)), 5);
        return;
      }
      const match = /^\/distinct\/(\d+)\.png$/.exec(req.url || "");
      if (match) {
        const idx = Number(match[1]);
        const buf = distinctPayloads[idx];
        if (buf) {
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Content-Length": String(buf.length),
          });
          res.end(buf);
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;

    try {
      // 1. 20 concurrent HTTP streaming downloads (10 identical URLs + 10 distinct URLs, mixing resolveMediaSource & downloadMediaStreamToTempDir)
      const httpTasks = [];
      const expectedHttpBuffers = [];
      for (let i = 0; i < 10; i++) {
        expectedHttpBuffers.push(ONE_BY_ONE_PNG_BUF);
        const url = `http://127.0.0.1:${port}/shared.png`;
        httpTasks.push(
          i % 2 === 0
            ? onebot.resolveMediaSource(url, { tempDir: httpTmpDir, allowPrivateMediaUrls: true })
            : onebot.downloadMediaStreamToTempDir(url, httpTmpDir, { allowPrivateMediaUrls: true })
        );
      }
      for (let i = 0; i < 10; i++) {
        expectedHttpBuffers.push(distinctPayloads[i]);
        const url = `http://127.0.0.1:${port}/distinct/${i}.png`;
        httpTasks.push(
          i % 2 === 0
            ? onebot.resolveMediaSource(url, { tempDir: httpTmpDir, allowPrivateMediaUrls: true })
            : onebot.downloadMediaStreamToTempDir(url, httpTmpDir, { allowPrivateMediaUrls: true })
        );
      }

      const httpResults = await Promise.all(httpTasks);
      assert.strictEqual(httpResults.length, 20);
      for (let i = 0; i < 20; i++) {
        const expectedBuf = expectedHttpBuffers[i];
        const expectedMd5 = crypto.createHash("md5").update(expectedBuf).digest("hex");
        const media = httpResults[i];
        assert.strictEqual(media.md5HexStr, expectedMd5);
        assert.strictEqual(media.fileSize, expectedBuf.length);

        const diskBytes = await fs.promises.readFile(media.localPath);
        assert.strictEqual(diskBytes.length, expectedBuf.length);
        assert.ok(diskBytes.equals(expectedBuf));
      }

      const httpRemaining = await fs.promises.readdir(httpTmpDir);
      assert.strictEqual(
        httpRemaining.filter((n) => n.endsWith(".part")).length,
        0,
        "Zero temporary .part files may remain after concurrent HTTP stream downloads"
      );
      assert.strictEqual(httpRemaining.length, 11, "Expected 1 shared + 10 distinct = 11 files");

      // 2. 20 concurrent base64:// writes (10 identical + 10 distinct)
      const b64Payloads = [
        ...Array.from({ length: 10 }, () => ONE_BY_ONE_PNG_BUF),
        ...distinctPayloads,
      ];
      const b64Results = await Promise.all(
        b64Payloads.map((buf) =>
          onebot.resolveMediaSource(`base64://${buf.toString("base64")}`, {
            tempDir: b64TmpDir,
          })
        )
      );
      assert.strictEqual(b64Results.length, 20);
      for (let i = 0; i < 20; i++) {
        const expectedBuf = b64Payloads[i];
        const expectedMd5 = crypto.createHash("md5").update(expectedBuf).digest("hex");
        assert.strictEqual(b64Results[i].md5HexStr, expectedMd5);
        const diskBytes = await fs.promises.readFile(b64Results[i].localPath);
        assert.ok(diskBytes.equals(expectedBuf));
      }

      const b64Remaining = await fs.promises.readdir(b64TmpDir);
      assert.strictEqual(b64Remaining.filter((n) => n.endsWith(".part")).length, 0);
      assert.strictEqual(b64Remaining.length, 11);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      await fs.promises.rm(httpTmpDir, { recursive: true, force: true });
      await fs.promises.rm(b64TmpDir, { recursive: true, force: true });
    }
  });

  await check("Suite 8: get_image / get_record / get_file enforce LFI & SSRF blocks without leaking paths to downloadRichMedia, and resolve standard OneBot tokens via lookupMedia", async () => {
    const { NtqqOneBotBridge, loadBridgeConfig } = require("../src/bridge_main.js");
    const restoreEnv = saveEnvVars([
      "ROSMONTIS_TEMP_DIR",
      "ONEBOT_TEMP_DIR",
      "XIAO_BRIDGE_TEMP_DIR",
      "ROSMONTIS_ALLOW_ARBITRARY_LOCAL_FILES",
      "ONEBOT_ALLOW_ARBITRARY_LOCAL_FILES",
      "XIAO_BRIDGE_ALLOW_ARBITRARY_LOCAL_FILES",
      "ROSMONTIS_ALLOW_PRIVATE_URLS",
      "ROSMONTIS_ALLOWED_FILE_DIRS",
      "ONEBOT_ALLOWED_FILE_DIRS",
      "XIAO_BRIDGE_ALLOWED_FILE_DIRS",
    ]);
    const suiteTmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_s8_bridge_"));

    const buf1 = ONE_BY_ONE_PNG_BUF;
    const md5_1 = crypto.createHash("md5").update(buf1).digest("hex");
    const kernelSourcePath1 = path.join(suiteTmpDir, "kernel_pic_1.png");

    const buf2 = Buffer.concat([ONE_BY_ONE_PNG_BUF, Buffer.from("ntqq-uri-pic-2")]);
    const md5_2 = crypto.createHash("md5").update(buf2).digest("hex");
    const kernelDestPath2 = path.join(suiteTmpDir, "kernel_pic_2.png");

    const downloadRichMediaCalls = [];
    const downloadElementCalls = [];
    let bridge = null;

    try {
      process.env.ROSMONTIS_TEMP_DIR = suiteTmpDir;
      delete process.env.ONEBOT_TEMP_DIR;
      delete process.env.XIAO_BRIDGE_TEMP_DIR;
      delete process.env.ROSMONTIS_ALLOW_ARBITRARY_LOCAL_FILES;
      delete process.env.ONEBOT_ALLOW_ARBITRARY_LOCAL_FILES;
      delete process.env.XIAO_BRIDGE_ALLOW_ARBITRARY_LOCAL_FILES;
      delete process.env.ROSMONTIS_ALLOW_PRIVATE_URLS;
      delete process.env.ROSMONTIS_ALLOWED_FILE_DIRS;
      delete process.env.ONEBOT_ALLOWED_FILE_DIRS;
      delete process.env.XIAO_BRIDGE_ALLOWED_FILE_DIRS;

      bridge = new NtqqOneBotBridge({
        config: {
          ...loadBridgeConfig(suiteTmpDir),
          tempDir: suiteTmpDir,
          allowPrivateMediaUrls: false,
          allowPrivateUrls: false,
          allowArbitraryLocalFiles: false,
          cleanupTempImmediately: true,
        },
        rendererExecute: async (cmd, args) => {
          const payload = Array.isArray(args) ? args[0] : args;
          if (cmd === "nodeIKernelMsgService/downloadRichMedia") {
            const getReq = payload?.getReq || {};
            downloadRichMediaCalls.push(getReq);
            if (getReq.msgId === "740001") {
              await fs.promises.writeFile(kernelSourcePath1, buf1);
              return { filePath: kernelSourcePath1 };
            }
            if (getReq.msgId === "740002") {
              await fs.promises.writeFile(kernelDestPath2, buf2);
              return { filePath: kernelDestPath2 };
            }
          }
          return {};
        },
      });

      const origDownloadElement = bridge._downloadRichMediaElement.bind(bridge);
      bridge._downloadRichMediaElement = async (opts) => {
        downloadElementCalls.push(opts);
        return origDownloadElement(opts);
      };

      // 1. LFI blocking across get_image, get_record, and get_file
      const pkgJsonFileUrl = pathToFileURL(path.resolve(__dirname, "..", "package.json")).href;
      const lfiPayloads = [
        "package.json",
        "./README.md",
        path.resolve(__filename),
        "/etc/passwd",
        pkgJsonFileUrl,
      ];
      for (const action of ["get_image", "get_record", "get_file"]) {
        for (const badFile of lfiPayloads) {
          await assert.rejects(
            () => bridge._dispatchAction(action, { file: badFile }),
            (err) => err && err.code === "ERR_LFI_BLOCKED",
            `Expected ${action} to reject LFI payload ${badFile} with ERR_LFI_BLOCKED`
          );
          const res = await bridge.handleOneBotAction(action, { file: badFile });
          assert.strictEqual(res.status, "failed");
          assert.notStrictEqual(res.retcode, 0);
          assert.match(res.message, /Blocked/i);
        }
      }
      assert.strictEqual(
        downloadRichMediaCalls.length,
        0,
        "downloadRichMedia must NEVER be called with caller-supplied LFI paths"
      );
      assert.strictEqual(downloadElementCalls.length, 0);

      // 2. SSRF blocking on get_image with loopback URL (default allowPrivateMediaUrls: false)
      const ssrfUrl = "http://127.0.0.1:65500/secret.png";
      await assert.rejects(
        () => bridge._dispatchAction("get_image", { file: ssrfUrl }),
        (err) => err && err.code === "ERR_SSRF_BLOCKED"
      );
      const ssrfRes = await bridge.handleOneBotAction("get_image", { file: ssrfUrl });
      assert.strictEqual(ssrfRes.status, "failed");
      assert.notStrictEqual(ssrfRes.retcode, 0);
      assert.match(ssrfRes.message, /Blocked|private|reserved|SSRF/i);
      assert.strictEqual(downloadRichMediaCalls.length, 0);

      // 3. Legitimate standard OneBot token lookup (<md5>.jpg and ntqq://pic?...) without msg_id
      bridge.messageIdStore.register(
        "740001",
        { chatType: 2, peerUid: "880001", guildId: "" },
        "101",
        {
          rawMsg: {
            msgId: "740001",
            chatType: 2,
            peerUid: "880001",
            elements: [
              {
                elementId: "el_pic_1",
                elementType: 2,
                picElement: {
                  md5HexStr: md5_1,
                  fileUuid: "uuid_pic_1",
                  fileName: `${md5_1}.png`,
                  sourcePath: kernelSourcePath1,
                  originImageUrl: "",
                  fileSize: buf1.length,
                },
              },
            ],
          },
        }
      );
      bridge.messageIdStore.register(
        "740002",
        { chatType: 1, peerUid: "u_friend_2", guildId: "" },
        "102",
        {
          rawMsg: {
            msgId: "740002",
            chatType: 1,
            peerUid: "u_friend_2",
            elements: [
              {
                elementId: "el_pic_2",
                elementType: 2,
                picElement: {
                  md5HexStr: md5_2,
                  fileUuid: "uuid_pic_2",
                  fileName: `${md5_2}.png`,
                  sourcePath: "",
                  originImageUrl: "",
                  fileSize: buf2.length,
                },
              },
            ],
          },
        }
      );

      const callerToken1 = `${md5_1}.jpg`;
      const callerToken2 = `ntqq://pic?md5=${md5_2}&uuid=uuid_pic_2`;
      assert.ok(bridge.messageIdStore.lookupMedia(callerToken1));
      assert.ok(bridge.messageIdStore.lookupMedia(callerToken2));
      assert.strictEqual(fs.existsSync(kernelSourcePath1), false);
      assert.strictEqual(fs.existsSync(kernelDestPath2), false);

      const okRes1 = await bridge.handleOneBotAction("get_image", {
        file: callerToken1,
        base64: true,
      });
      assert.strictEqual(okRes1.retcode, 0);
      assert.strictEqual(downloadElementCalls.length, 1);
      assert.strictEqual(downloadElementCalls[0].filePath, kernelSourcePath1);
      assert.notStrictEqual(downloadElementCalls[0].filePath, callerToken1);
      assert.strictEqual(downloadRichMediaCalls.length, 1);
      assert.strictEqual(downloadRichMediaCalls[0].filePath, kernelSourcePath1);
      assert.strictEqual(okRes1.data.file, kernelSourcePath1);
      assert.strictEqual(okRes1.data.url, pathToFileURL(kernelSourcePath1).href);
      assert.ok(okRes1.data.url.startsWith("file:///"));
      assert.strictEqual(okRes1.data.file_size, String(buf1.length));
      assert.strictEqual(okRes1.data.base64, buf1.toString("base64"));

      const okRes2 = await bridge.handleOneBotAction("get_image", {
        file: callerToken2,
        base64: true,
      });
      assert.strictEqual(okRes2.retcode, 0);
      assert.strictEqual(downloadElementCalls.length, 2);
      assert.strictEqual(downloadElementCalls[1].filePath, "");
      assert.notStrictEqual(downloadElementCalls[1].filePath, callerToken2);
      assert.strictEqual(downloadRichMediaCalls.length, 2);
      assert.strictEqual(downloadRichMediaCalls[1].filePath, "");
      assert.strictEqual(okRes2.data.file, kernelDestPath2);
      assert.strictEqual(okRes2.data.url, pathToFileURL(kernelDestPath2).href);
      assert.ok(okRes2.data.url.startsWith("file:///"));
      assert.strictEqual(okRes2.data.file_size, String(buf2.length));
      assert.strictEqual(okRes2.data.base64, buf2.toString("base64"));

      const okResNoB64 = await bridge.handleOneBotAction("get_image", { file: callerToken1 });
      assert.strictEqual(okResNoB64.retcode, 0);
      assert.strictEqual(okResNoB64.data.base64, undefined);
    } finally {
      if (bridge && typeof bridge.stopServers === "function") {
        await bridge.stopServers();
      }
      restoreEnv();
      await fs.promises.rm(suiteTmpDir, { recursive: true, force: true });
    }
  });

  await check("Suite 9: web_http.js & qzone_actions.js enforce SSRF defense, redirect allowPrivateUrls/protocol downgrade protection, linear cookie redirects, and JSONP/gate helpers", async () => {
    const https = require("https");
    const { EventEmitter } = require("events");
    const webHttp = require("../src/core/web_http.js");
    const qzoneActions = require("../src/core/qzone_actions.js");

    const restoreEnv = saveEnvVars([
      "ROSMONTIS_ALLOW_PRIVATE_URLS",
      "ROSMONTIS_ENABLE_WEB_CREDENTIAL_API",
      "ONEBOT_ENABLE_WEB_CREDENTIAL_API",
      "XIAO_BRIDGE_ENABLE_WEB_CREDENTIAL_API",
    ]);
    const servers = [];
    const listenLocal = async (handler) => {
      const s = http.createServer(handler);
      servers.push(s);
      await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
      return s.address().port;
    };

    try {
      delete process.env.ROSMONTIS_ALLOW_PRIVATE_URLS;
      delete process.env.ROSMONTIS_ENABLE_WEB_CREDENTIAL_API;
      delete process.env.ONEBOT_ENABLE_WEB_CREDENTIAL_API;
      delete process.env.XIAO_BRIDGE_ENABLE_WEB_CREDENTIAL_API;

      // 1. Literal private / loopback / cloud metadata IPs blocked with ERR_SSRF_BLOCKED
      const blockedLiteralUrls = [
        "http://127.0.0.1:12345/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]:12345/",
      ];
      for (const u of blockedLiteralUrls) {
        await assert.rejects(
          () => webHttp.httpRequestText(u),
          (err) => err && err.code === "ERR_SSRF_BLOCKED"
        );
        await assert.rejects(
          () => webHttp.httpGetJson(u),
          (err) => err && err.code === "ERR_SSRF_BLOCKED"
        );
        await assert.rejects(
          () => webHttp.httpsGetCookies(u),
          (err) => err && err.code === "ERR_SSRF_BLOCKED"
        );
      }

      // 2. DNS rebinding protection via custom dnsLookup returning 127.0.0.1 for qzone.qq.com
      let rebindLookups = 0;
      const rebindDnsLookup = (_hostname, opts, cb) => {
        rebindLookups += 1;
        const done = typeof opts === "function" ? opts : cb;
        process.nextTick(() => done(null, "127.0.0.1", 4));
      };
      await assert.rejects(
        () =>
          webHttp.httpRequestText("https://qzone.qq.com/cgi-bin/rebind", "GET", "", {}, 4, {
            dnsLookup: rebindDnsLookup,
          }),
        (err) => err && err.code === "ERR_SSRF_BLOCKED"
      );
      await assert.rejects(
        () => webHttp.httpGetJson("https://qzone.qq.com/cgi-bin/rebind", { dnsLookup: rebindDnsLookup }),
        (err) => err && err.code === "ERR_SSRF_BLOCKED"
      );
      await assert.rejects(
        () => webHttp.httpsGetCookies("https://qzone.qq.com/cgi-bin/rebind", { dnsLookup: rebindDnsLookup }),
        (err) => err && err.code === "ERR_SSRF_BLOCKED"
      );
      assert.strictEqual(rebindLookups, 3);

      // 3. Cross-host redirect drops allowPrivateUrls (127.0.0.1 -> localhost blocked with ERR_SSRF_BLOCKED)
      let srvBHits = 0;
      const portB = await listenLocal((_req, res) => {
        srvBHits += 1;
        res.writeHead(200);
        res.end("secret");
      });
      const portA = await listenLocal((_req, res) => {
        res.writeHead(302, { Location: `http://localhost:${portB}/secret` });
        res.end();
      });
      const localLookup = (_host, opts, cb) => {
        const done = typeof opts === "function" ? opts : cb;
        process.nextTick(() => done(null, "127.0.0.1", 4));
      };
      await assert.rejects(
        () =>
          webHttp.httpRequestText(`http://127.0.0.1:${portA}/start`, "GET", "", {}, 4, {
            allowPrivateUrls: true,
            allowAnyRedirectHost: true,
            dnsLookup: localLookup,
          }),
        (err) => err && err.code === "ERR_SSRF_BLOCKED"
      );
      await assert.rejects(
        () =>
          webHttp.httpsGetCookies(`http://127.0.0.1:${portA}/start`, {
            allowPrivateUrls: true,
            allowAnyRedirectHost: true,
            dnsLookup: localLookup,
          }),
        (err) => err && err.code === "ERR_SSRF_BLOCKED"
      );
      assert.strictEqual(srvBHits, 0, "Cross-host redirect target must never be reached");

      // 4a. Untrusted cross-origin redirect strips Cookie and Authorization headers
      let hop1Headers = null;
      let hop2Headers = null;
      const portOrigin2 = await listenLocal((req, res) => {
        hop2Headers = req.headers;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok-origin-2");
      });
      const portOrigin1 = await listenLocal((req, res) => {
        hop1Headers = req.headers;
        res.writeHead(302, { Location: `http://127.0.0.1:${portOrigin2}/landed` });
        res.end();
      });
      const crossOriginBody = await webHttp.httpRequestText(
        `http://127.0.0.1:${portOrigin1}/start`,
        "GET",
        "",
        {
          Cookie: "skey=@secret; p_skey=topsecret",
          Authorization: "Bearer secret-token",
          "X-Trace-Id": "preserve-123",
        },
        4,
        { allowPrivateUrls: true }
      );
      assert.strictEqual(crossOriginBody, "ok-origin-2");
      assert.strictEqual(hop1Headers.cookie, "skey=@secret; p_skey=topsecret");
      assert.strictEqual(hop1Headers.authorization, "Bearer secret-token");
      assert.strictEqual(hop2Headers.cookie, undefined);
      assert.strictEqual(hop2Headers.authorization, undefined);
      assert.strictEqual(hop2Headers["x-trace-id"], "preserve-123");

      // 4b. https: -> http: protocol downgrade rejected in httpsGetCookies & strips credentials in httpRequestText
      const origHttpsRequest = https.request;
      try {
        https.request = (_reqOpts, onResponse) => {
          const fakeReq = new EventEmitter();
          fakeReq.write = () => {};
          fakeReq.destroy = () => {};
          fakeReq.end = () => {
            process.nextTick(() => {
              const fakeRes = new EventEmitter();
              fakeRes.statusCode = 302;
              fakeRes.headers = {
                location: `http://127.0.0.1:${portOrigin2}/downgraded`,
                "set-cookie": ["skey=@https_secret; Path=/"],
              };
              fakeRes.resume = () => {};
              fakeRes.destroy = () => {};
              onResponse(fakeRes);
              fakeRes.emit("end");
              fakeRes.emit("close");
            });
          };
          return fakeReq;
        };

        await assert.rejects(
          () =>
            webHttp.httpsGetCookies(`https://127.0.0.1:${portOrigin2}/secure`, {
              allowPrivateUrls: true,
            }),
          (err) => err && err.code === "ERR_INSECURE_REDIRECT_DOWNGRADE"
        );

        hop2Headers = null;
        const downgradedBody = await webHttp.httpRequestText(
          `https://127.0.0.1:${portOrigin2}/secure`,
          "GET",
          "",
          {
            Cookie: "skey=@https_only",
            Authorization: "Bearer https-secret",
            "X-Keep-Header": "yes",
          },
          4,
          { allowPrivateUrls: true }
        );
        assert.strictEqual(downgradedBody, "ok-origin-2");
        assert.strictEqual(hop2Headers.cookie, undefined);
        assert.strictEqual(hop2Headers.authorization, undefined);
        assert.strictEqual(hop2Headers["x-keep-header"], "yes");
      } finally {
        https.request = origHttpsRequest;
      }

      // 4c. httpsGetCookies 2^N redirect bug fix: 3 chained 302 hops => exact request count === 4 (not 15)
      let cookieChainHits = 0;
      const cookieChainPort = await listenLocal((req, res) => {
        cookieChainHits += 1;
        if (req.url === "/hop0") {
          res.writeHead(302, { Location: "/hop1", "Set-Cookie": ["c0=v0; Path=/"] });
          res.end();
          return;
        }
        if (req.url === "/hop1") {
          res.writeHead(302, { Location: "/hop2", "Set-Cookie": ["c1=v1; Path=/"] });
          res.end();
          return;
        }
        if (req.url === "/hop2") {
          res.writeHead(302, { Location: "/final", "Set-Cookie": ["c2=v2; Path=/"] });
          res.end();
          return;
        }
        res.writeHead(200, { "Set-Cookie": ["c3=v3; Path=/"] });
        res.end("done");
      });
      const mergedCookies = await webHttp.httpsGetCookies(
        `http://127.0.0.1:${cookieChainPort}/hop0`,
        { allowPrivateUrls: true }
      );
      assert.strictEqual(
        cookieChainHits,
        4,
        `Expected linear 4 requests across 3 chained redirects, got ${cookieChainHits}`
      );
      assert.deepStrictEqual(mergedCookies, { c0: "v0", c1: "v1", c2: "v2", c3: "v3" });

      // 5. parseJsonpOrJson formats & unified qzone_actions credential gate re-exports
      assert.deepStrictEqual(webHttp.parseJsonpOrJson('{"ret":0,"msg":"ok"}'), {
        ret: 0,
        msg: "ok",
      });
      assert.deepStrictEqual(webHttp.parseJsonpOrJson('callback({"ret":0,"items":[1,2]});'), {
        ret: 0,
        items: [1, 2],
      });
      assert.deepStrictEqual(
        webHttp.parseJsonpOrJson('_Callback({"code":0,"subcode":0,"data":{"feeds":[]}})'),
        { code: 0, subcode: 0, data: { feeds: [] } }
      );
      assert.deepStrictEqual(webHttp.parseJsonpOrJson('({"ret":0})'), { ret: 0 });

      assert.strictEqual(qzoneActions.isWebCredentialApiEnabled, webHttp.isWebCredentialApiEnabled);
      assert.strictEqual(
        qzoneActions.assertWebCredentialApiEnabled,
        webHttp.assertWebCredentialApiEnabled
      );
      assert.strictEqual(qzoneActions.isWebCredentialApiEnabled({}), false);
      assert.throws(
        () => qzoneActions.assertWebCredentialApiEnabled({}, "get_cookies"),
        (err) => err && err.code === "ERR_WEB_CREDENTIAL_API_DISABLED"
      );
      assert.strictEqual(
        qzoneActions.isWebCredentialApiEnabled({ enableWebCredentialApi: true }),
        true
      );
    } finally {
      restoreEnv();
      await Promise.all(
        servers.map(
          (s) =>
            new Promise((resolve) => {
              try {
                s.close(() => resolve());
              } catch (_) {
                resolve();
              }
            })
        )
      );
    }
  });

  console.log(`\nALL ${passed} MEDIA SECURITY TEST SUITES PASSED SUCCESSFULLY!`);
}

runMediaSecurityTests().catch((err) => {
  console.error("Media security test suite failed:", err);
  process.exit(1);
});

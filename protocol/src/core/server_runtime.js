"use strict";

const http = require("http");
const crypto = require("crypto");

const { formatMetaEvent } = require("../bridge_onebot");

const {
  WS_GUID,
  DEFAULT_MAX_WS_SEND_BUFFER_BYTES,
  Rfc6455Connection,
  connectReverseWebSocket,
} = require("./ws_rfc6455");

const {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
  sanitizeHeaderValue,
  checkRequestAuth,
  checkOriginHeader,
  enforceProtectedModeOnServers,
  readHttpJsonBody,
} = require("./transport_security");

const { isQuietLogsEnabled } = require("./env");

const JSON_CONTENT_TYPE_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
});

function writeHttpJson(res, statusCode, payload) {
  if (!res || res.writableEnded) return false;
  res.writeHead(statusCode, JSON_CONTENT_TYPE_HEADERS);
  res.end(JSON.stringify(payload));
  return true;
}

function buildEndpointActionContext(endpointCfg = {}, defaultMsgFormat = "array") {
  const cfg = endpointCfg && typeof endpointCfg === "object" ? endpointCfg : {};
  return {
    messageFormat: cfg.messageFormat || defaultMsgFormat || "array",
    compatProfile: cfg.compatProfile || cfg.compat_profile,
    compatAppName: cfg.compatAppName || cfg.compat_app_name,
    compatAppVersion: cfg.compatAppVersion || cfg.compat_app_version,
  };
}

function buildFailedActionReply(retcode, message, echo = undefined) {
  const msg = message !== undefined && message !== null ? String(message) : "";
  return {
    status: "failed",
    retcode: Number.isFinite(Number(retcode)) ? Number(retcode) : 1400,
    data: null,
    message: msg,
    wording: msg,
    ...(echo !== undefined ? { echo } : {}),
  };
}

const serverRuntimeMixin = {
  _checkAuth(req, expectedToken, parsedUrl = null) {
    return checkRequestAuth(req, expectedToken, {
      allowQueryToken: this.config.allowQueryAccessToken !== false,
      parsedUrl,
    });
  },

  _recordListenError(kind, host, port, err) {
    if (!Array.isArray(this.listenErrors)) {
      this.listenErrors = [];
    }
    const entry = {
      kind: String(kind || "server"),
      host: String(host || ""),
      port: Number(port),
      code: err?.code || "ERR_LISTEN_FAILED",
      message: err?.message || String(err),
      ts: Date.now(),
    };
    const dupIdx = this.listenErrors.findIndex(
      (e) =>
        e.kind === entry.kind &&
        e.host === entry.host &&
        Object.is(e.port, entry.port) &&
        e.code === entry.code
    );
    if (dupIdx !== -1) {
      this.listenErrors[dupIdx] = entry;
    } else {
      if (this.listenErrors.length >= 16) {
        this.listenErrors.shift();
      }
      this.listenErrors.push(entry);
    }
    const warnMsg = `WARN: Failed to listen (${entry.kind} ${entry.host}:${entry.port}): [${entry.code}] ${entry.message}`;
    if (this.logger && typeof this.logger.warn === "function") {
      this.logger.warn(warnMsg);
    } else if (!isQuietLogsEnabled(this.config)) {
      try {
        process.stderr.write(`[rosmontis] ${warnMsg}\n`);
      } catch (_) {}
    }
  },

  _listenServerInstance(srv, kind, listenHost, listenPort, targetList) {
    return new Promise((resolve) => {
      let settled = false;
      const settleOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      srv.on("error", (err) => {
        this._recordListenError(kind, listenHost, listenPort, err);
        settleOnce();
      });
      try {
        srv.listen(listenPort, listenHost, () => {
          targetList.push(srv);
          settleOnce();
        });
      } catch (syncErr) {
        this._recordListenError(kind, listenHost, listenPort, syncErr);
        try {
          srv.close();
        } catch (_) {}
        settleOnce();
      }
    });
  },

  async _handleWsActionMessage(rawText, sendJsonFn, actionContext = {}) {
    if (typeof sendJsonFn !== "function") return;
    let payload;
    try {
      payload = typeof rawText === "string" ? JSON.parse(rawText) : rawText;
    } catch (_) {
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.action) {
      return;
    }
    const actParams =
      payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
        ? payload.params
        : {};
    let reply;
    try {
      reply = await this.handleOneBotAction(
        payload.action,
        actParams,
        payload.echo,
        actionContext
      );
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const retcode = Number(err?.retcode) || 1400;
      reply = buildFailedActionReply(retcode, msg, payload.echo);
    }
    try {
      sendJsonFn(reply);
    } catch (_) {}
  },

  async startServers() {
    this.listenErrors = [];

    enforceProtectedModeOnServers(
      [...(this.config.httpServers || []), ...(this.config.wsServers || [])],
      this.config,
      (msg) => {
        try {
          process.stderr.write("[rosmontis] SECURITY WARNING: " + msg + "\n");
        } catch (_) {}
      }
    );

    const globalMsgFormat = this.config.messageFormat || "array";

    // 1. Start HTTP Server(s)
    for (const httpCfg of this.config.httpServers || []) {
      const actionContext = buildEndpointActionContext(httpCfg, globalMsgFormat);
      const srv = http.createServer(async (req, res) => {
        req.on("error", () => {});
        res.on("error", () => {});

        const originRes = checkOriginHeader(req, {
          allowedOrigins: httpCfg.allowedOrigins || this.config.allowedOrigins || [],
        });
        if (!originRes.allowed) {
          writeHttpJson(res, 403, buildFailedActionReply(1403, "Forbidden: Origin not allowed"));
          return;
        }

        let u;
        try {
          u = new URL(req.url || "/", "http://127.0.0.1");
        } catch (_) {
          u = new URL("/", "http://127.0.0.1");
        }

        if (!this._checkAuth(req, httpCfg.accessToken, u)) {
          writeHttpJson(res, 401, buildFailedActionReply(1403, "Unauthorized"));
          return;
        }

        const actionName = u.pathname.replace(/^\/+/, "");
        if (req.method === "GET" && (actionName === "health" || actionName === "")) {
          writeHttpJson(res, 200, {
            status: "ok",
            retcode: 0,
            self_id: Number(this.selfUin || 0),
            online: this.online,
          });
          return;
        }

        try {
          const params = await readHttpJsonBody(req, {
            maxBodyBytes: this.config.maxHttpBodyBytes || DEFAULT_MAX_HTTP_BODY_BYTES,
          });
          for (const [k, v] of u.searchParams.entries()) {
            if (!(k in params)) params[k] = v;
          }
          const act = actionName || String(params.action || "");
          const actParams =
            params.params !== undefined
              ? params.params && typeof params.params === "object" && !Array.isArray(params.params)
                ? params.params
                : {}
              : params;
          const reply = await this.handleOneBotAction(act, actParams, params.echo, actionContext);
          writeHttpJson(res, 200, reply);
        } catch (err) {
          if (err && (err.statusCode === 413 || err.code === "ERR_HTTP_BODY_TOO_LARGE")) {
            writeHttpJson(res, 413, buildFailedActionReply(1413, err.message));
            return;
          }
          const msg = err && err.message ? err.message : String(err);
          writeHttpJson(res, 200, buildFailedActionReply(1400, msg));
        }
      });

      const listenPort = Number(httpCfg.port ?? 3000);
      const listenHost = httpCfg.host || "0.0.0.0";
      await this._listenServerInstance(srv, "http", listenHost, listenPort, this._httpServers);
    }

    // 2. Start Forward WebSocket Server(s)
    for (const wsCfg of this.config.wsServers || []) {
      const baseActionContext = buildEndpointActionContext(wsCfg, globalMsgFormat);
      const srv = http.createServer((_req, res) => {
        res.writeHead(426);
        res.end("Upgrade Required");
      });
      srv.on("upgrade", (req, socket, head) => {
        socket.on("error", () => {});

        const originRes = checkOriginHeader(req, {
          allowedOrigins: wsCfg.allowedOrigins || this.config.allowedOrigins || [],
        });
        if (!originRes.allowed) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        let u = null;
        try {
          u = new URL(req.url || "/", "http://127.0.0.1");
        } catch (_) {}

        if (!this._checkAuth(req, wsCfg.accessToken, u)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        const rawSecKey = req.headers["sec-websocket-key"];
        const secKey = sanitizeHeaderValue(rawSecKey);
        if (!secKey) {
          socket.destroy();
          return;
        }
        const accept = sanitizeHeaderValue(
          crypto
            .createHash("sha1")
            .update(secKey + WS_GUID)
            .digest("base64")
        );
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            "",
          ].join("\r\n")
        );
        const conn = new Rfc6455Connection(socket, {
          isClient: false,
          maxPayloadBytes: this.config.maxWsPayloadBytes || DEFAULT_MAX_WS_PAYLOAD_BYTES,
          maxSendBufferBytes:
            this.config?.maxWsSendBufferBytes || DEFAULT_MAX_WS_SEND_BUFFER_BYTES,
          allowUnmaskedClientFrames: Boolean(this.config.allowUnmaskedClientFrames),
        });
        conn.reportSelfMessage = Boolean(wsCfg.reportSelfMessage);
        conn._messageFormat = baseActionContext.messageFormat;
        this._wsServerClients.add(conn);

        conn.on("error", () => {
          this._wsServerClients.delete(conn);
          try {
            socket.destroy();
          } catch (_) {}
        });
        conn.on("close", () => {
          this._wsServerClients.delete(conn);
        });

        conn.sendJson(
          formatMetaEvent("lifecycle", { sub_type: "connect" }, { selfId: this.selfUin })
        );

        conn.on("message", (text) => {
          this._handleWsActionMessage(
            text,
            (reply) => conn.sendJson(reply),
            {
              ...baseActionContext,
              messageFormat: conn._messageFormat || baseActionContext.messageFormat,
            }
          );
        });
        if (head && head.length > 0) {
          conn._onData(head);
        }
      });

      const listenPort = Number(wsCfg.port ?? 3001);
      const listenHost = wsCfg.host || "0.0.0.0";
      await this._listenServerInstance(srv, "ws", listenHost, listenPort, this._wsServers);
    }

    // 3. Start Reverse WebSocket Client(s)
    for (const clientCfg of this.config.wsClients || []) {
      if (!clientCfg.url) continue;
      this._startReverseWsLoop(clientCfg);
    }

    // 4. Start Heartbeat Timer
    if (!this._heartbeatTimer && this.config.heartbeatIntervalMs > 0) {
      this._heartbeatTimer = setInterval(() => {
        this.broadcastOneBotEvent(
          formatMetaEvent(
            "heartbeat",
            {
              status: {
                online: this.online,
                good: this.online,
                time: Math.max(
                  0,
                  Math.floor((Date.now() - (this.startedAtMs || Date.now())) / 1000)
                ),
              },
              interval: this.config.heartbeatIntervalMs,
            },
            { selfId: this.selfUin }
          )
        );
      }, this.config.heartbeatIntervalMs);
      if (typeof this._heartbeatTimer.unref === "function") {
        this._heartbeatTimer.unref();
      }
    }

    // 5. Start Periodic WS Liveness Timer
    const rawPingInterval = this.config?.wsPingIntervalMs ?? 30000;
    const pingIntervalMs = Number.isFinite(Number(rawPingInterval))
      ? Number(rawPingInterval)
      : 30000;
    if (!this._wsPingTimer && pingIntervalMs > 0) {
      const rawPongTimeout = Number(this.config?.wsPongTimeoutMs ?? 90000);
      const pongTimeoutMs = Math.max(
        pingIntervalMs * 2,
        Number.isFinite(rawPongTimeout) && rawPongTimeout > 0 ? rawPongTimeout : 90000
      );
      this._wsPingTimer = setInterval(() => {
        const now = Date.now();
        const serverClients = this._wsServerClients || this.wsClients;
        if (serverClients) {
          for (const conn of Array.from(serverClients)) {
            if (!conn || conn.closed || conn._closed) {
              serverClients.delete?.(conn);
              continue;
            }
            if (conn._unansweredPingAt > 0 && now - conn._unansweredPingAt > pongTimeoutMs) {
              serverClients.delete?.(conn);
              conn.terminate("Pong timeout");
            } else {
              conn.ping();
            }
          }
        }
        const revClients = this._reverseWsClients || this.reverseWsClients;
        if (Array.isArray(revClients)) {
          for (const rc of revClients) {
            const conn = rc?.conn;
            if (!conn || conn.closed || conn._closed) continue;
            if (conn._unansweredPingAt > 0 && now - conn._unansweredPingAt > pongTimeoutMs) {
              conn.terminate("Pong timeout");
            } else {
              conn.ping();
            }
          }
        }
      }, pingIntervalMs);
      this._wsPingTimer.unref?.();
    }
  },

  _startReverseWsLoop(clientCfg) {
    const baseActionContext = buildEndpointActionContext(
      clientCfg,
      this.config.messageFormat || "array"
    );
    const entry = {
      cfg: clientCfg,
      conn: null,
      connecting: false,
      stopped: false,
      timer: null,
      handle: null,
      connectedSelfId: "0",
      immediateReconnectOnce: false,
      messageFormat: baseActionContext.messageFormat,
    };
    this._reverseWsClients.push(entry);

    const connectOnce = () => {
      if (entry.stopped || entry.connecting || (entry.conn && !entry.conn.closed)) return;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.connecting = true;
      const currentSelfId = sanitizeHeaderValue(String(this.selfUin || "0"));
      const headers = {
        "X-Self-ID": currentSelfId,
        "X-Client-Role": sanitizeHeaderValue(clientCfg.role || "Universal"),
        "User-Agent": "OneBot/11 Rosmontis/1.0.0",
      };
      if (clientCfg.accessToken) {
        headers["Authorization"] = `Bearer ${sanitizeHeaderValue(clientCfg.accessToken)}`;
      }
      entry.handle = connectReverseWebSocket(
        clientCfg.url,
        headers,
        (conn) => {
          entry.connecting = false;
          entry.conn = conn;
          entry.connectedSelfId = currentSelfId;
          conn._messageFormat = entry.messageFormat;
          conn.sendJson(
            formatMetaEvent("lifecycle", { sub_type: "connect" }, { selfId: this.selfUin })
          );
        },
        (text, conn) => {
          this._handleWsActionMessage(
            text,
            (reply) => conn.sendJson(reply),
            {
              ...baseActionContext,
              messageFormat: entry.messageFormat || baseActionContext.messageFormat,
            }
          );
        },
        () => {
          entry.connecting = false;
          entry.conn = null;
          if (!entry.stopped) {
            if (entry.timer) {
              clearTimeout(entry.timer);
              entry.timer = null;
            }
            const fastReconnect = Boolean(entry.immediateReconnectOnce);
            entry.immediateReconnectOnce = false;
            const delay = fastReconnect
              ? 50
              : Math.max(500, Number(clientCfg.reconnectIntervalMs || 5000));
            entry.timer = setTimeout(connectOnce, delay);
            if (typeof entry.timer.unref === "function") entry.timer.unref();
          }
        },
        {
          maxPayloadBytes: this.config.maxWsPayloadBytes || DEFAULT_MAX_WS_PAYLOAD_BYTES,
          maxSendBufferBytes:
            this.config?.maxWsSendBufferBytes || DEFAULT_MAX_WS_SEND_BUFFER_BYTES,
        }
      );
    };

    connectOnce();
  },

  async stopServers() {
    this._aioInteractionSeq += 1;
    this._clearIdleTimers();
    this._sessionScheduler.dispose();
    if (this.echoCorrelator && typeof this.echoCorrelator.clear === "function") {
      this.echoCorrelator.clear();
    }
    this._rejectPendingRendererCmds(null, "bridge servers stopped");
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._wsPingTimer) {
      clearInterval(this._wsPingTimer);
      this._wsPingTimer = null;
    }
    for (const rev of this._reverseWsClients) {
      rev.stopped = true;
      if (rev.timer) clearTimeout(rev.timer);
      if (rev.conn) rev.conn.close();
      if (rev.handle) rev.handle.close();
    }
    this._reverseWsClients = [];
    this._wsClientHandles = this._reverseWsClients;
    for (const client of this._wsServerClients) {
      client.close();
    }
    this._wsServerClients.clear();
    for (const srv of [...this._httpServers, ...this._wsServers]) {
      await new Promise((resolve) => srv.close(() => resolve()));
    }
    this._httpServers = [];
    this._wsServers = [];
    this.flushTempCleanup();
  },
};

module.exports = {
  serverRuntimeMixin,
  writeHttpJson,
  buildEndpointActionContext,
  buildFailedActionReply,
};

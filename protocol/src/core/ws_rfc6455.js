"use strict";

const crypto = require("crypto");
const net = require("net");
const tls = require("tls");
const { EventEmitter } = require("events");

const {
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
  sanitizeHeaderValue,
  isValidHttpHeaderName,
} = require("./transport_security");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_WS_SEND_BUFFER_BYTES = 32 * 1024 * 1024; // 32 MiB
const MAX_UPGRADE_HEADER_BYTES = 64 * 1024;
const RESERVED_HANDSHAKE_HEADERS = new Set([
  "host",
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
]);

function encodeWsFrame(opcode, payloadBuffer, mask = false) {
  const buf = Buffer.isBuffer(payloadBuffer)
    ? payloadBuffer
    : Buffer.from(String(payloadBuffer || ""), "utf8");
  const len = buf.length;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) {
    headerLen = 4;
  } else if (len > 0xffff) {
    headerLen = 10;
  }
  const maskLen = mask ? 4 : 0;
  const frame = Buffer.allocUnsafe(headerLen + maskLen + len);
  frame[0] = 0x80 | (opcode & 0x0f); // FIN=1

  const maskBit = mask ? 0x80 : 0x00;
  if (len < 126) {
    frame[1] = maskBit | len;
  } else if (len <= 0xffff) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }

  if (mask) {
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(frame, headerLen);
    for (let i = 0; i < len; i++) {
      frame[headerLen + 4 + i] = buf[i] ^ maskKey[i & 3];
    }
  } else {
    buf.copy(frame, headerLen);
  }
  return frame;
}

function _truncateUtf8Bytes(str, maxBytes) {
  const full = Buffer.from(String(str || ""), "utf8");
  if (full.length <= maxBytes) return full;
  let end = maxBytes;
  while (end > 0 && (full[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return full.subarray(0, end);
}

function encodeWsCloseFrame(code = 1000, reason = "", mask = false) {
  if (code === null || code === undefined) {
    return encodeWsFrame(0x8, Buffer.alloc(0), mask);
  }
  const statusCode = Number(code) || 1000;
  const reasonBuf = reason ? _truncateUtf8Bytes(reason, 123) : Buffer.alloc(0);
  const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
  payload.writeUInt16BE(statusCode & 0xffff, 0);
  if (reasonBuf.length > 0) {
    reasonBuf.copy(payload, 2);
  }
  return encodeWsFrame(0x8, payload, mask);
}

class Rfc6455Connection extends EventEmitter {
  constructor(socket, options = {}) {
    super();
    const opts = options && typeof options === "object" ? options : {};
    this.socket = socket;
    this.isClient = Boolean(opts.isClient);
    this.allowUnmaskedClientFrames = Boolean(opts.allowUnmaskedClientFrames);
    const parsedMax = Number(opts.maxPayloadBytes);
    this.maxPayloadBytes =
      Number.isFinite(parsedMax) && parsedMax > 0
        ? Math.floor(parsedMax)
        : DEFAULT_MAX_WS_PAYLOAD_BYTES;
    const parsedMaxSendBuf = Number(opts.maxSendBufferBytes);
    this.maxSendBufferBytes =
      Number.isFinite(parsedMaxSendBuf) && parsedMaxSendBuf > 0
        ? Math.floor(parsedMaxSendBuf)
        : DEFAULT_MAX_WS_SEND_BUFFER_BYTES;

    const now = Date.now();
    this._lastActivityAt = now;
    this._lastPongAt = now;
    this._unansweredPingAt = 0;

    this.closed = false;
    this._closing = false;
    this._closeEmitted = false;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentsBytes = 0;
    this._fragmentOpcode = 0;

    this._boundOnData = (chunk) => this._onData(chunk);
    if (socket && typeof socket.on === "function") {
      socket.on("data", this._boundOnData);
      socket.on("close", () => {
        if (!this.closed) {
          this.closed = true;
          this._closing = true;
          this._buffer = Buffer.alloc(0);
          this._fragments = [];
          this._fragmentsBytes = 0;
          this._fragmentOpcode = 0;
          this._emitCloseOnce(1006, "");
        }
      });
      socket.on("error", (err) => {
        if (this.listenerCount("error") > 0) {
          this.emit("error", err);
        }
        if (!this.closed) {
          this.closed = true;
          this._closing = true;
          this._buffer = Buffer.alloc(0);
          this._fragments = [];
          this._fragmentsBytes = 0;
          this._fragmentOpcode = 0;
          this._emitCloseOnce(1006, "");
        }
      });
    }
  }

  get _closed() {
    return Boolean(this.closed);
  }

  set _closed(val) {
    this.closed = Boolean(val);
  }

  _emitCloseOnce(code, reason) {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close", code, reason);
  }

  _terminateWithProtocolClose(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this._closing = true;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentsBytes = 0;
    this._fragmentOpcode = 0;

    const sock = this.socket;
    if (sock) {
      try {
        if (typeof sock.removeListener === "function" && this._boundOnData) {
          sock.removeListener("data", this._boundOnData);
        }
        if (typeof sock.pause === "function") {
          sock.pause();
        }
      } catch (_) {}

      try {
        if (!sock.destroyed) {
          const closeFrame = encodeWsCloseFrame(code, reason, this.isClient);
          const isRealNetSocket = sock instanceof net.Socket || sock instanceof tls.TLSSocket;
          if (isRealNetSocket && typeof sock.end === "function") {
            sock.end(closeFrame, () => {
              try {
                if (!sock.destroyed && typeof sock.destroy === "function") {
                  sock.destroy();
                }
              } catch (_) {}
            });
            const killTimer = setTimeout(() => {
              try {
                if (!sock.destroyed && typeof sock.destroy === "function") {
                  sock.destroy();
                }
              } catch (_) {}
            }, 200);
            if (typeof killTimer.unref === "function") killTimer.unref();
          } else {
            if (typeof sock.write === "function") sock.write(closeFrame);
            if (typeof sock.end === "function") sock.end();
            if (typeof sock.destroy === "function") sock.destroy();
          }
        }
      } catch (_) {
        try {
          if (sock && !sock.destroyed && typeof sock.destroy === "function") {
            sock.destroy();
          }
        } catch (_2) {}
      }
    }

    const err = new Error(reason);
    err.wsCloseCode = code;
    err.code = code === 1009 ? "ERR_WS_PAYLOAD_TOO_LARGE" : "ERR_WS_PROTOCOL_ERROR";
    this.emit("protocol_error", err, code, reason);
    this._emitCloseOnce(code, reason);
  }

  _onData(chunk) {
    if (this.closed || !chunk || chunk.length === 0) return;
    this._lastActivityAt = Date.now();
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    // Guard against pre-concat memory spike if a partial header (<14 bytes) is followed by a huge chunk
    if (
      this._buffer.length > 0 &&
      this._buffer.length < 14 &&
      this._buffer.length + incoming.length > this.maxPayloadBytes + 14
    ) {
      const peekLen = Math.min(incoming.length, 14 - this._buffer.length);
      const peek = Buffer.concat([this._buffer, incoming.subarray(0, peekLen)]);
      if (peek.length >= 2) {
        const pb0 = peek[0];
        const pb1 = peek[1];
        const pOpcode = pb0 & 0x0f;
        const pMasked = (pb1 & 0x80) !== 0;
        const pLen7 = pb1 & 0x7f;
        if ((pb0 & 0x70) !== 0) {
          this._terminateWithProtocolClose(1002, "Protocol error: non-zero RSV bits");
          return;
        }
        if (!this.isClient && !this.allowUnmaskedClientFrames && !pMasked) {
          this._terminateWithProtocolClose(1002, "Protocol error: unmasked client frame");
          return;
        }
        if (pOpcode >= 0x8 && (((pb0 & 0x80) === 0) || pLen7 > 125)) {
          this._terminateWithProtocolClose(1002, "Protocol error: invalid control frame");
          return;
        }
        if (pLen7 === 126 && peek.length >= 4 && peek.readUInt16BE(2) > this.maxPayloadBytes) {
          this._terminateWithProtocolClose(1009, "Message Too Big");
          return;
        }
        if (pLen7 === 127 && peek.length >= 10) {
          const bigPeek = peek.readBigUInt64BE(2);
          if ((bigPeek & (1n << 63n)) !== 0n) {
            this._terminateWithProtocolClose(1002, "Protocol error: invalid 64-bit payload length");
            return;
          }
          if (bigPeek > BigInt(this.maxPayloadBytes)) {
            this._terminateWithProtocolClose(1009, "Message Too Big");
            return;
          }
        }
      }
    }

    this._buffer =
      this._buffer.length === 0 ? incoming : Buffer.concat([this._buffer, incoming]);

    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        this._terminateWithProtocolClose(1002, "Protocol error: non-zero RSV bits");
        return;
      }

      if ((opcode >= 0x3 && opcode <= 0x7) || opcode >= 0x0b) {
        this._terminateWithProtocolClose(1002, "Protocol error: reserved opcode");
        return;
      }

      if (!this.isClient && !this.allowUnmaskedClientFrames && !masked) {
        this._terminateWithProtocolClose(1002, "Protocol error: unmasked client frame");
        return;
      }

      if (opcode >= 0x8 && (!fin || payloadLen > 125)) {
        this._terminateWithProtocolClose(1002, "Protocol error: invalid control frame");
        return;
      }

      if (payloadLen === 126) {
        if (this._buffer.length < 4) break;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) break;
        const bigLen = this._buffer.readBigUInt64BE(2);
        if ((bigLen & (1n << 63n)) !== 0n) {
          this._terminateWithProtocolClose(1002, "Protocol error: invalid 64-bit payload length");
          return;
        }
        if (bigLen > BigInt(this.maxPayloadBytes)) {
          this._terminateWithProtocolClose(1009, "Message Too Big");
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > this.maxPayloadBytes) {
        this._terminateWithProtocolClose(1009, "Message Too Big");
        return;
      }

      if (opcode === 0x0) {
        if (this._fragmentOpcode === 0) {
          this._terminateWithProtocolClose(1002, "Protocol error: unexpected continuation frame");
          return;
        }
        if (this._fragmentsBytes + payloadLen > this.maxPayloadBytes) {
          this._terminateWithProtocolClose(1009, "Message Too Big");
          return;
        }
      } else if (opcode < 0x8 && this._fragmentOpcode !== 0) {
        this._terminateWithProtocolClose(
          1002,
          "Protocol error: data frame received before fragmented message completed"
        );
        return;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (this._buffer.length < offset + payloadLen) break;

      const payload = Buffer.from(this._buffer.subarray(offset, offset + payloadLen));
      if (masked) {
        const maskKey = this._buffer.subarray(maskOffset, maskOffset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      const remaining = this._buffer.length - (offset + payloadLen);
      if (remaining === 0) {
        this._buffer = Buffer.alloc(0);
      } else if (this._buffer.buffer.byteLength > 65536 && remaining < 16384) {
        this._buffer = Buffer.from(this._buffer.subarray(offset + payloadLen));
      } else {
        this._buffer = this._buffer.subarray(offset + payloadLen);
      }

      if (opcode === 0x8 && payload.length === 1) {
        this._terminateWithProtocolClose(1002, "Protocol error: invalid 1-byte close payload");
        return;
      }

      const frameNow = Date.now();
      this._lastActivityAt = frameNow;
      this._lastPongAt = frameNow;
      this._unansweredPingAt = 0;

      if (opcode === 0x8) {
        let closeCode = 1005;
        let closeReason = "";
        if (payload.length >= 2) {
          closeCode = payload.readUInt16BE(0);
          closeReason = payload.subarray(2).toString("utf8");
        }
        if (!this.closed) {
          this.closed = true;
          this._closing = true;
          this._buffer = Buffer.alloc(0);
          this._fragments = [];
          this._fragmentsBytes = 0;
          this._fragmentOpcode = 0;
          try {
            if (this.socket && !this.socket.destroyed) {
              const replyFrame =
                payload.length >= 2
                  ? encodeWsCloseFrame(closeCode, closeReason, this.isClient)
                  : encodeWsFrame(0x8, Buffer.alloc(0), this.isClient);
              if (typeof this.socket.write === "function") this.socket.write(replyFrame);
              if (typeof this.socket.end === "function") this.socket.end();
            }
          } catch (_) {}
          this._emitCloseOnce(closeCode, closeReason);
        }
        return;
      }

      if (opcode === 0x9) {
        this._sendRawFrame(0x0a, payload);
        continue;
      }

      if (opcode === 0x0a) {
        this.emit("pong", payload);
        continue;
      }

      if (opcode === 0x0) {
        this._fragments.push(payload);
        this._fragmentsBytes += payload.length;
        if (this._fragmentsBytes > this.maxPayloadBytes) {
          this._terminateWithProtocolClose(1009, "Message Too Big");
          return;
        }
        if (fin) {
          const full = Buffer.concat(this._fragments, this._fragmentsBytes);
          const origOp = this._fragmentOpcode;
          this._fragments = [];
          this._fragmentsBytes = 0;
          this._fragmentOpcode = 0;
          this._emitPayload(origOp, full);
        }
        continue;
      }

      if (!fin) {
        this._fragmentOpcode = opcode;
        this._fragments = [payload];
        this._fragmentsBytes = payload.length;
      } else {
        this._emitPayload(opcode, payload);
      }
    }

    if (!this.closed && this._buffer.length > this.maxPayloadBytes + 14) {
      this._terminateWithProtocolClose(1009, "Message Too Big");
    }
  }

  _emitPayload(opcode, buf) {
    if (opcode === 0x1) {
      this.emit("message", buf.toString("utf8"));
    } else if (opcode === 0x2) {
      this.emit("binary", buf);
    }
  }

  _sendRawFrame(opcode, payload) {
    if (this.closed || !this.socket || this.socket.destroyed) return false;
    try {
      const frame = encodeWsFrame(opcode, payload, this.isClient);
      const buffered =
        typeof this.socket?.writableLength === "number" ? this.socket.writableLength : 0;
      if (
        this.maxSendBufferBytes > 0 &&
        buffered > 0 &&
        buffered + frame.length > this.maxSendBufferBytes
      ) {
        this.terminate("Send buffer overflow");
        return false;
      }
      this.socket.write(frame);
      return true;
    } catch (_) {
      return false;
    }
  }

  sendText(text) {
    return this._sendRawFrame(0x1, Buffer.from(String(text), "utf8"));
  }

  sendJson(obj) {
    return this.sendText(JSON.stringify(obj));
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.closed) return false;
    if (this._unansweredPingAt === 0) {
      this._unansweredPingAt = Date.now();
    }
    const buf = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(String(payload || ""), "utf8");
    return this._sendRawFrame(0x9, buf.length > 125 ? buf.subarray(0, 125) : buf);
  }

  terminate(reason = "terminated") {
    if (this.closed) return;
    this.closed = true;
    this._closing = true;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentsBytes = 0;
    this._fragmentOpcode = 0;
    try {
      if (typeof this.socket?.removeListener === "function" && this._boundOnData) {
        this.socket.removeListener("data", this._boundOnData);
      }
    } catch (_) {}
    try {
      if (typeof this.socket?.destroy === "function") {
        this.socket.destroy();
      } else if (typeof this.socket?.end === "function") {
        this.socket.end();
      }
    } catch (_) {}
    this._emitCloseOnce(1006, String(reason || ""));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this._closing = true;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentsBytes = 0;
    this._fragmentOpcode = 0;
    try {
      if (this.socket && !this.socket.destroyed) {
        const frame =
          code === null || code === undefined
            ? encodeWsFrame(0x8, Buffer.alloc(0), this.isClient)
            : encodeWsCloseFrame(code, reason, this.isClient);
        if (typeof this.socket.write === "function") this.socket.write(frame);
        if (typeof this.socket.end === "function") this.socket.end();
      }
    } catch (_) {}
    this._emitCloseOnce(code ?? 1005, String(reason || ""));
  }
}

function connectReverseWebSocket(urlStr, headers = {}, onOpen, onMessage, onClose, options = {}) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (err) {
    if (onClose) onClose(err);
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "ws:" && protocol !== "wss:" && protocol !== "http:" && protocol !== "https:") {
    const protoErr = new Error(`Unsupported WebSocket protocol: ${parsed.protocol}`);
    if (onClose) onClose(protoErr);
    return null;
  }

  const sanitizedHeaders = [];
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null || v === "") continue;
      if (!isValidHttpHeaderName(k)) {
        const hdrErr = new Error(`Invalid HTTP header name in WebSocket upgrade: ${JSON.stringify(k)}`);
        hdrErr.code = "ERR_INVALID_HTTP_HEADER";
        if (onClose) onClose(hdrErr);
        return null;
      }
      if (RESERVED_HANDSHAKE_HEADERS.has(k.toLowerCase())) continue;
      const cleanVal = sanitizeHeaderValue(v);
      if (cleanVal !== "") {
        sanitizedHeaders.push([k, cleanVal]);
      }
    }
  }

  const isSecure = protocol === "wss:" || protocol === "https:";
  const port = Number(parsed.port) || (isSecure ? 443 : 80);
  const host = sanitizeHeaderValue(parsed.hostname || "127.0.0.1").replace(/\s+/g, "");
  const rawPathWithQuery = (parsed.pathname || "/") + (parsed.search || "");
  const safePathWithQuery = sanitizeHeaderValue(rawPathWithQuery).replace(/\s+/g, (m) =>
    encodeURIComponent(m)
  );

  const secKey = crypto.randomBytes(16).toString("base64");
  const expectedAccept = crypto
    .createHash("sha1")
    .update(secKey + WS_GUID)
    .digest("base64");

  const opts = options && typeof options === "object" ? options : {};
  const timeoutMs =
    Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
      ? Math.floor(Number(opts.timeoutMs))
      : 15000;

  const connectOpts = { host, port, servername: host };
  const socket = isSecure ? tls.connect(connectOpts) : net.connect(connectOpts);
  let upgraded = false;
  let headerBuf = Buffer.alloc(0);
  let wsConn = null;

  socket.setTimeout(timeoutMs, () => {
    if (!upgraded) {
      socket.destroy(new Error("WebSocket upgrade timeout"));
    }
  });

  const hostHeaderValue = host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;

  socket.on("connect", () => {
    const reqLines = [
      `GET ${safePathWithQuery || "/"} HTTP/1.1`,
      `Host: ${hostHeaderValue}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${secKey}`,
      "Sec-WebSocket-Version: 13",
    ];
    for (const [k, cleanVal] of sanitizedHeaders) {
      reqLines.push(`${k}: ${cleanVal}`);
    }
    reqLines.push("", "");
    socket.write(reqLines.join("\r\n"));
  });

  let closeNotified = false;
  const notifyCloseOnce = (err) => {
    if (closeNotified) return;
    closeNotified = true;
    if (onClose) onClose(err);
  };

  const onSocketData = (chunk) => {
    if (upgraded) return;
    headerBuf = headerBuf.length === 0 ? chunk : Buffer.concat([headerBuf, chunk]);
    const sepIdx = headerBuf.indexOf("\r\n\r\n");
    if (sepIdx === -1) {
      if (headerBuf.length > MAX_UPGRADE_HEADER_BYTES) {
        headerBuf = Buffer.alloc(0);
        socket.destroy(new Error("WebSocket upgrade response headers exceeded maximum size"));
      }
      return;
    }

    const headerStr = headerBuf.subarray(0, sepIdx).toString("utf8");
    const rest = headerBuf.subarray(sepIdx + 4);
    headerBuf = Buffer.alloc(0);

    const lines = headerStr.split("\r\n");
    const statusLine = lines[0] || "";
    if (!statusLine.includes("101")) {
      socket.destroy(new Error(`Unexpected WS upgrade status: ${statusLine}`));
      return;
    }
    const respHeaders = {};
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(":");
      if (idx > 0) {
        respHeaders[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
      }
    }
    if (respHeaders["sec-websocket-accept"] !== expectedAccept) {
      socket.destroy(new Error("Invalid Sec-WebSocket-Accept header"));
      return;
    }

    upgraded = true;
    socket.setTimeout(0);
    socket.removeListener("data", onSocketData);

    wsConn = new Rfc6455Connection(socket, {
      isClient: true,
      maxPayloadBytes: opts.maxPayloadBytes,
      maxSendBufferBytes: opts.maxSendBufferBytes,
    });
    wsConn.on("message", (msg) => {
      if (onMessage) onMessage(msg, wsConn);
    });
    wsConn.on("close", () => {
      notifyCloseOnce(null);
    });
    wsConn.on("error", () => {});

    if (onOpen) onOpen(wsConn);
    if (rest.length > 0) {
      wsConn._onData(rest);
    }
  };

  socket.on("data", onSocketData);
  socket.on("error", (err) => {
    if (!upgraded) {
      notifyCloseOnce(err);
    }
  });
  socket.on("close", () => {
    if (!upgraded) {
      notifyCloseOnce(new Error("Socket closed before upgrade"));
    }
  });

  return {
    get conn() {
      return wsConn;
    },
    ping(payload) {
      return wsConn ? wsConn.ping(payload) : false;
    },
    terminate(reason = "terminated") {
      if (wsConn) {
        wsConn.terminate(reason);
      } else {
        try {
          if (typeof socket?.destroy === "function") socket.destroy();
        } catch (_) {}
        notifyCloseOnce(new Error(String(reason || "terminated")));
      }
    },
    close() {
      if (wsConn) wsConn.close();
      else socket.destroy();
    },
  };
}

module.exports = {
  WS_GUID,
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
  DEFAULT_MAX_WS_SEND_BUFFER_BYTES,
  encodeWsFrame,
  encodeWsCloseFrame,
  Rfc6455Connection,
  WsConnection: Rfc6455Connection,
  connectReverseWebSocket,
};

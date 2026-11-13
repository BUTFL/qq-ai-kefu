"use strict";

/**
 * Outbound Send-Echo Correlator (`src/core/echo_correlator.js`)
 *
 * Correlates `nodeIKernelMsgService/sendMsg` dispatches with asynchronous
 * `nodeIKernelMsgListener/onAddSendMsg` kernel echoes so outgoing OneBot v11
 * `message_id` handles map to genuine 64-bit NTQQ `msgId` values (enabling
 * `delete_msg` recall, reply referencing, and media indexing).
 */

function _ntElementsSignature(elements) {
  const parts = [];
  let text = "";
  if (Array.isArray(elements)) {
    for (const el of elements) {
      if (!el || typeof el !== "object") continue;
      const type = Number(el.elementType || 0);
      if (type === 1 && el.textElement) {
        const atType = Number(el.textElement.atType || 0);
        if (atType === 0) {
          const chunk = String(el.textElement.content || "");
          if (!chunk) continue;
          text += chunk;
          const prev = parts[parts.length - 1];
          if (prev && prev.kind === "text") {
            prev.text += chunk;
          } else {
            parts.push({ kind: "text", text: chunk });
          }
        } else {
          parts.push({
            kind: "at",
            atType,
            uid: String(el.textElement.atNtUid || ""),
            uin: String(el.textElement.atUid || ""),
          });
        }
      } else if (type === 2 && el.picElement) {
        parts.push({
          kind: "pic",
          md5: String(el.picElement.md5HexStr || "").toLowerCase(),
          subType: Number(el.picElement.picSubType || 0),
          name: String(el.picElement.fileName || ""),
        });
      } else if (type === 3 && el.fileElement) {
        parts.push({
          kind: "file",
          md5: String(el.fileElement.fileMd5 || "").toLowerCase(),
          name: String(el.fileElement.fileName || ""),
        });
      } else if (type === 4 && el.pttElement) {
        parts.push({
          kind: "ptt",
          md5: String(el.pttElement.md5HexStr || "").toLowerCase(),
          name: String(el.pttElement.fileName || ""),
        });
      } else if (type === 5 && el.videoElement) {
        parts.push({
          kind: "video",
          md5: String(el.videoElement.videoMd5 || "").toLowerCase(),
          name: String(el.videoElement.fileName || ""),
        });
      } else if (type === 6 && el.faceElement) {
        parts.push({
          kind: "face",
          faceType: Number(el.faceElement.faceType || 0),
          faceIndex: Number(el.faceElement.faceIndex || 0),
          pokeType: Number(el.faceElement.pokeType || 0),
        });
      } else if (type === 7 && el.replyElement) {
        parts.push({
          kind: "reply",
          msgId: String(el.replyElement.replayMsgId || "0"),
          msgSeq: String(el.replyElement.replayMsgSeq || "0"),
        });
      } else if (type === 10 && el.arkElement) {
        parts.push({
          kind: "ark",
          data: String(el.arkElement.bytesData || ""),
        });
      } else if (type === 11 && el.marketFaceElement) {
        parts.push({
          kind: "mface",
          emojiId: String(el.marketFaceElement.emojiId || ""),
        });
      } else if (type > 0) {
        parts.push({ kind: `el:${type}` });
      }
    }
  }
  return { text: text.trim(), parts };
}

function _elementsSignatureMatch(expectedSig, actualSig) {
  const aList = expectedSig?.parts;
  const bList = actualSig?.parts;
  if (!Array.isArray(aList) || !Array.isArray(bList)) return false;
  if (aList.length === 0 || aList.length !== bList.length) return false;
  for (let i = 0; i < aList.length; i++) {
    const a = aList[i];
    const b = bList[i];
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "text") {
      if (a.text.trim() !== b.text.trim()) return false;
      if (!a.text.trim() && a.text !== b.text) return false;
    } else if (a.kind === "at") {
      if (a.atType !== b.atType) return false;
      if (a.uid && b.uid) {
        if (a.uid !== b.uid) return false;
      } else if (a.uin && b.uin && a.uin !== b.uin) {
        return false;
      }
    } else if (a.kind === "pic" || a.kind === "file" || a.kind === "ptt" || a.kind === "video") {
      if (a.md5 && b.md5) {
        if (a.md5 !== b.md5) return false;
      } else if (a.name && b.name && a.name !== b.name) {
        return false;
      }
    } else if (a.kind === "face") {
      if (a.faceType !== b.faceType || a.faceIndex !== b.faceIndex || a.pokeType !== b.pokeType) {
        return false;
      }
    } else if (a.kind === "reply") {
      if (a.msgId !== "0" && b.msgId !== "0") {
        if (a.msgId !== b.msgId) return false;
      } else if (a.msgSeq !== "0" && b.msgSeq !== "0" && a.msgSeq !== b.msgSeq) {
        return false;
      }
    } else if (a.kind === "ark") {
      if (a.data !== b.data) return false;
    } else if (a.kind === "mface") {
      if (a.emojiId !== b.emojiId) return false;
    }
  }
  return true;
}

function hasRichMediaElements(elements) {
  if (!Array.isArray(elements)) return false;
  return elements.some((el) => {
    if (!el || typeof el !== "object") return false;
    const t = Number(el.elementType);
    return (
      t === 2 ||
      t === 3 ||
      t === 4 ||
      t === 5 ||
      Boolean(el.picElement || el.fileElement || el.pttElement || el.videoElement)
    );
  });
}

class EchoCorrelator {
  constructor({ maxQueuePerPeer = 32, getSignatureFns = null } = {}) {
    const parsedMax = Number(maxQueuePerPeer);
    this.maxQueuePerPeer =
      Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : 32;
    this._getSignatureFns = typeof getSignatureFns === "function" ? getSignatureFns : null;
    this.waiters = new Map();
    this.stats = { matched: 0, fromResult: 0, timedOut: 0 };
  }

  _resolveSignatureFns(customSigFn = null, customMatchFn = null) {
    const dynamic = typeof this._getSignatureFns === "function" ? this._getSignatureFns() : null;
    const sigFn =
      typeof customSigFn === "function"
        ? customSigFn
        : typeof dynamic?.sigFn === "function"
        ? dynamic.sigFn
        : typeof dynamic?.signatureFn === "function"
        ? dynamic.signatureFn
        : typeof dynamic?._ntElementsSignature === "function"
        ? dynamic._ntElementsSignature
        : typeof dynamic?.ntElementsSignature === "function"
        ? dynamic.ntElementsSignature
        : _ntElementsSignature;
    const matchFn =
      typeof customMatchFn === "function"
        ? customMatchFn
        : typeof dynamic?.matchFn === "function"
        ? dynamic.matchFn
        : typeof dynamic?._elementsSignatureMatch === "function"
        ? dynamic._elementsSignatureMatch
        : typeof dynamic?.elementsSignatureMatch === "function"
        ? dynamic.elementsSignatureMatch
        : _elementsSignatureMatch;
    return { sigFn, matchFn };
  }

  peerKey(peer) {
    return `${Number(peer?.chatType) || 0}:${String(peer?.peerUid || "")}`;
  }

  register(peer, elements, elementPredicate = null, customSigFn = null) {
    const key = this.peerKey(peer);
    const { sigFn } = this._resolveSignatureFns(customSigFn, null);
    const hasPredicate = typeof elementPredicate === "function";
    const waiter = {
      sig: hasPredicate ? null : sigFn(elements),
      elementPredicate: hasPredicate ? elementPredicate : null,
      echo: null,
      resolve: null,
      done: false,
    };
    const queue = this.waiters.get(key) || [];
    queue.push(waiter);
    while (queue.length > this.maxQueuePerPeer) {
      const stale = queue.shift();
      stale.done = true;
      if (stale.resolve) stale.resolve(null);
    }
    this.waiters.set(key, queue);

    const remove = () => {
      const q = this.waiters.get(key);
      if (!q) return;
      const idx = q.indexOf(waiter);
      if (idx >= 0) q.splice(idx, 1);
      if (q.length === 0) this.waiters.delete(key);
    };

    return {
      wait: (timeoutMs) => {
        if (waiter.echo || waiter.done) {
          waiter.done = true;
          remove();
          return Promise.resolve(waiter.echo);
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiter.done = true;
            waiter.resolve = null;
            remove();
            resolve(null);
          }, Math.max(0, Number(timeoutMs) || 0));
          // Intentionally NOT unref'd: the caller is awaiting this bounded timer.
          waiter.resolve = (echo) => {
            clearTimeout(timer);
            waiter.done = true;
            waiter.resolve = null;
            remove();
            resolve(echo);
          };
        });
      },
      cancel: () => {
        waiter.done = true;
        const fn = waiter.resolve;
        waiter.resolve = null;
        if (fn) {
          fn(null);
        } else {
          remove();
        }
      },
    };
  }

  match(ntMsg, customSigFn = null, customMatchFn = null) {
    if (!ntMsg || !ntMsg.msgId || String(ntMsg.msgId) === "0") return false;
    const key = this.peerKey({ chatType: ntMsg.chatType, peerUid: ntMsg.peerUid });
    const queue = this.waiters.get(key);
    if (!queue || queue.length === 0) return false;
    const { sigFn, matchFn } = this._resolveSignatureFns(customSigFn, customMatchFn);
    let sig = null;
    const waiter = queue.find((w) => {
      if (w.done || w.echo) return false;
      if (typeof w.elementPredicate === "function") {
        return Boolean(w.elementPredicate(ntMsg));
      }
      if (!sig) sig = sigFn(ntMsg.elements);
      return matchFn(w.sig, sig);
    });
    if (!waiter) return false;
    waiter.echo = {
      msgId: String(ntMsg.msgId),
      msgSeq: String(ntMsg.msgSeq || "0"),
      msgTime: ntMsg.msgTime !== undefined ? Number(ntMsg.msgTime) : undefined,
      rawMsg: ntMsg,
    };
    if (waiter.resolve) waiter.resolve(waiter.echo);
    return true;
  }

  computeTimeoutMs(elements, config = {}) {
    const cfg = config && typeof config === "object" ? config : {};
    const textTimeout = Math.max(0, Number(cfg.sendEchoTimeoutMs ?? 3000));
    if (!hasRichMediaElements(elements)) {
      return textTimeout;
    }
    const rawRich =
      cfg.richMediaEchoTimeoutMs ??
      cfg.sendRichMediaEchoTimeoutMs ??
      15000;
    const baseRich = Math.max(textTimeout, Math.max(0, Number(rawRich)));
    let totalBytes = 0;
    for (const el of elements) {
      const sub = el?.picElement || el?.fileElement || el?.pttElement || el?.videoElement;
      const sz = Number(sub?.fileSize || 0);
      if (Number.isFinite(sz) && sz > 0) totalBytes += sz;
    }
    const extraMb =
      totalBytes > 1024 * 1024 ? Math.ceil((totalBytes - 1024 * 1024) / (1024 * 1024)) : 0;
    const maxTimeout = Math.max(baseRich, Number(cfg.maxSendEchoTimeoutMs ?? 60000));
    return Math.min(maxTimeout, baseRich + extraMb * 2000);
  }

  clear() {
    for (const queue of this.waiters.values()) {
      for (const waiter of [...queue]) {
        waiter.done = true;
        const fn = waiter.resolve;
        waiter.resolve = null;
        if (fn) fn(null);
      }
    }
    this.waiters.clear();
  }
}

module.exports = {
  EchoCorrelator,
  _ntElementsSignature,
  _elementsSignatureMatch,
  hasRichMediaElements,
};

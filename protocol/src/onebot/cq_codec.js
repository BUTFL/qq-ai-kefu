"use strict";

function escapeCqText(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;");
}

function unescapeCqText(str) {
  return String(str ?? "")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

function escapeCqParam(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/,/g, "&#44;");
}

function segmentsToCqCode(segments) {
  if (!Array.isArray(segments)) return String(segments ?? "");
  const parts = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const type = String(seg.type || "");
    const data = seg.data && typeof seg.data === "object" ? seg.data : {};
    if (type === "text") {
      parts.push(escapeCqText(data.text ?? ""));
    } else if (type) {
      const kv = [];
      for (const [k, v] of Object.entries(data)) {
        if (v === undefined || v === null || v === "") continue;
        kv.push(`${k}=${escapeCqParam(typeof v === "object" ? JSON.stringify(v) : String(v))}`);
      }
      parts.push(kv.length > 0 ? `[CQ:${type},${kv.join(",")}]` : `[CQ:${type}]`);
    }
  }
  return parts.join("");
}

function parseCqCodeToSegments(raw, autoEscape = false) {
  const str = String(raw ?? "");
  if (!str) return [];
  if (autoEscape) {
    return [{ type: "text", data: { text: str } }];
  }
  const segments = [];
  const regex = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^,\]]+=[^,\]]*)*)\]/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(str)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        data: { text: unescapeCqText(str.slice(lastIndex, match.index)) },
      });
    }
    const type = match[1];
    const paramsRaw = match[2] || "";
    const data = {};
    if (paramsRaw.startsWith(",")) {
      const pairs = paramsRaw.slice(1).split(",");
      for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          const k = pair.slice(0, eqIdx).trim();
          const v = unescapeCqText(pair.slice(eqIdx + 1));
          data[k] = v;
        }
      }
    }
    segments.push({ type, data });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < str.length) {
    segments.push({
      type: "text",
      data: { text: unescapeCqText(str.slice(lastIndex)) },
    });
  }
  return segments;
}

function normalizeSegmentObject(item) {
  const type = String(item.type).trim();
  const topLevel = {};
  for (const [k, v] of Object.entries(item)) {
    if (k !== "type" && k !== "data" && v !== undefined) {
      topLevel[k] = v;
    }
  }
  if (type.toLowerCase() === "json" && typeof item.data === "string") {
    return { type, data: { ...topLevel, data: item.data } };
  }
  const nested =
    item.data && typeof item.data === "object" && !Array.isArray(item.data)
      ? item.data
      : {};
  return { type, data: { ...topLevel, ...nested } };
}

function normalizeOneBotMessage(message, autoEscape = false) {
  if (Array.isArray(message)) {
    const out = [];
    for (const item of message) {
      if (typeof item === "string") {
        out.push(...parseCqCodeToSegments(item, autoEscape));
      } else if (item && typeof item === "object" && !Array.isArray(item) && item.type) {
        out.push(normalizeSegmentObject(item));
      }
    }
    return out;
  }
  if (message && typeof message === "object" && !Array.isArray(message) && message.type) {
    return [normalizeSegmentObject(message)];
  }
  if (typeof message === "string") {
    return parseCqCodeToSegments(message, autoEscape);
  }
  return [];
}

module.exports = {
  escapeCqText,
  unescapeCqText,
  escapeCqParam,
  segmentsToCqCode,
  parseCqCodeToSegments,
  normalizeSegmentObject,
  normalizeOneBotMessage,
};

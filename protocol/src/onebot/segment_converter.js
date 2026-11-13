"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const { segmentsToCqCode, normalizeOneBotMessage } = require("./cq_codec");
const { pickPositiveUin, lookupCachedUin } = require("./stores");
const { resolveMediaSource } = require("../core/media_security");

function buildNtPicUrl(picElement, chatType) {
  if (!picElement || typeof picElement !== "object") return "";
  if (typeof picElement.__base64Uri === "string" && picElement.__base64Uri) {
    return picElement.__base64Uri;
  }
  const origin = String(picElement.originImageUrl || "").trim();
  if (origin) {
    if (/^https?:\/\//i.test(origin)) {
      if (!origin.includes("multimedia.nt.qq.com.cn/download") || origin.includes("rkey=")) {
        return origin;
      }
    } else if (origin.startsWith("/download")) {
      if (origin.includes("rkey=")) {
        return `https://multimedia.nt.qq.com.cn${origin}`;
      }
    } else if (origin.startsWith("/")) {
      return `https://gchat.qpic.cn${origin}`;
    }
  }
  const candidatePaths = [];
  if (picElement.sourcePath) candidatePaths.push(String(picElement.sourcePath));
  if (picElement.thumbPath instanceof Map) {
    for (const p of picElement.thumbPath.values()) {
      if (p) candidatePaths.push(String(p));
    }
  } else if (picElement.thumbPath && typeof picElement.thumbPath === "object") {
    for (const p of Object.values(picElement.thumbPath)) {
      if (p) candidatePaths.push(String(p));
    }
  }
  for (const localPath of candidatePaths) {
    try {
      if (localPath && fs.existsSync(localPath)) {
        const st = fs.statSync(localPath);
        if (st.isFile() && st.size > 0) {
          if (st.size <= 10 * 1024 * 1024) {
            const b64 = fs.readFileSync(localPath).toString("base64");
            return `base64://${b64}`;
          }
          return `file://${localPath}`;
        }
      }
    } catch (_) {}
  }
  const md5 = String(picElement.md5HexStr || "").toUpperCase();
  if (!origin.startsWith("/download") && md5 && /^[0-9A-F]{32}$/.test(md5)) {
    return `https://gchat.qpic.cn/gchatpic_new/0/0-0-${md5}/0?term=2`;
  }
  if (origin.startsWith("/download")) {
    return `https://multimedia.nt.qq.com.cn${origin}`;
  }
  return "";
}

function buildNtRecordUri(pttElement) {
  if (!pttElement || typeof pttElement !== "object") return "";
  const params = new URLSearchParams();
  if (pttElement.fileUuid) params.set("uuid", String(pttElement.fileUuid));
  if (pttElement.md5HexStr) params.set("md5", String(pttElement.md5HexStr));
  if (pttElement.fileName) params.set("file", String(pttElement.fileName));
  const qs = params.toString();
  return qs ? `ntqq://record?${qs}` : "";
}

/**
 * Convert NTQQ `ntMsg` (or `{ elements, chatType, peerUid }`) into OneBot v11
 * `{ segments, raw_message }`.
 */
function ntMsgToOneBotSegments(ntMsg, ctx = {}) {
  const elements = Array.isArray(ntMsg) ? ntMsg : Array.isArray(ntMsg?.elements) ? ntMsg.elements : [];
  const chatType = Number(ntMsg?.chatType || ctx.chatType || 1);
  const peerUid = String(ntMsg?.peerUid || ctx.peerUid || "");
  const uinUidStore = ctx.uinUidStore || null;
  const messageIdStore = ctx.messageIdStore || ctx.msgIdStore || null;

  if (uinUidStore && ntMsg && !Array.isArray(ntMsg)) {
    uinUidStore.rememberFromNtMsg(ntMsg);
  }

  const segments = [];
  for (const el of elements) {
    if (!el || typeof el !== "object") continue;
    const elType = Number(el.elementType || 0);

    // 1: textElement (text & @ mentions)
    if (elType === 1 && el.textElement) {
      const te = el.textElement;
      const atType = Number(te.atType || 0);
      if (atType === 1) {
        segments.push({
          type: "at",
          data: {
            qq: "all",
            ...(te.content ? { name: String(te.content).replace(/^@/, "") } : {}),
          },
        });
      } else if (atType === 2) {
        let qq = "";
        const posAtUin = pickPositiveUin(te.atUid);
        if (posAtUin > 0) {
          qq = String(posAtUin);
        } else if (uinUidStore && te.atNtUid) {
          const resolved = pickPositiveUin(lookupCachedUin(uinUidStore, te.atNtUid));
          if (resolved > 0) qq = String(resolved);
        }
        if (!qq && te.atNtUid) {
          qq = String(te.atNtUid);
        }
        const name = te.content ? String(te.content).replace(/^@/, "").trim() : "";
        segments.push({
          type: "at",
          data: {
            qq: String(qq || "0"),
            ...(name ? { name } : {}),
          },
        });
      } else {
        const text = String(te.content ?? "");
        if (text !== "") {
          segments.push({
            type: "text",
            data: { text },
          });
        }
      }
      continue;
    }

    // 2: picElement
    if (elType === 2 && el.picElement) {
      const pe = el.picElement;
      const url = buildNtPicUrl(pe, chatType);
      const file =
        pe.fileName ||
        (pe.md5HexStr ? `${String(pe.md5HexStr).toLowerCase()}.jpg` : "") ||
        pe.fileUuid ||
        "image.jpg";
      segments.push({
        type: "image",
        data: {
          file: String(file),
          ...(url ? { url } : {}),
          ...(pe.fileUuid ? { file_id: String(pe.fileUuid) } : {}),
          file_size: String(pe.fileSize ?? 0),
          sub_type: Number(pe.picSubType ?? 0),
          ...(pe.summary ? { summary: String(pe.summary) } : {}),
        },
      });
      continue;
    }

    // 3: fileElement
    if (elType === 3 && el.fileElement) {
      const fe = el.fileElement;
      const fileName = String(fe.fileName || "file");
      const fileId = String(fe.fileUuid || fe.fileBizId || fe.fileMd5 || fileName);
      const fileSize = Number(fe.fileSize || 0);
      segments.push({
        type: "file",
        data: {
          file: fileName,
          name: fileName,
          file_name: fileName,
          file_id: fileId,
          size: fileSize,
          file_size: fileSize,
          ...(fe.fileMd5 ? { file_hash: String(fe.fileMd5) } : {}),
          ...(fe.filePath ? { path: String(fe.filePath) } : {}),
          busid: Number(fe.fileBizId || 102),
        },
      });
      continue;
    }

    // 4: pttElement (voice record)
    if (elType === 4 && el.pttElement) {
      const ptt = el.pttElement;
      const pttLocal = String(ptt.filePath || ptt.sourcePath || "");
      let url = "";
      if (typeof ptt.__base64Uri === "string" && ptt.__base64Uri) {
        url = ptt.__base64Uri;
      } else if (pttLocal && fs.existsSync(pttLocal)) {
        url = pathToFileURL(pttLocal).href;
      } else {
        url = buildNtRecordUri(ptt);
      }
      const file = String(
        ptt.fileName || ptt.md5HexStr || ptt.fileUuid || url || "record.amr"
      );
      segments.push({
        type: "record",
        data: {
          file,
          ...(pttLocal ? { path: pttLocal } : {}),
          ...(url ? { url } : {}),
          ...(ptt.fileUuid ? { file_id: String(ptt.fileUuid) } : {}),
          file_size: String(ptt.fileSize || 0),
          magic: ptt.voiceChangeType ? "1" : "0",
        },
      });
      continue;
    }

    // 5: videoElement
    if (elType === 5 && el.videoElement) {
      const ve = el.videoElement;
      const veLocal = String(ve.filePath || ve.sourcePath || "");
      let url = "";
      if (veLocal && fs.existsSync(veLocal)) {
        url = pathToFileURL(veLocal).href;
      }
      const file = String(
        ve.fileName || ve.videoMd5 || ve.md5HexStr || ve.fileUuid || "video.mp4"
      );
      segments.push({
        type: "video",
        data: {
          file,
          ...(veLocal ? { path: veLocal } : {}),
          ...(url ? { url } : {}),
          ...(ve.fileUuid ? { file_id: String(ve.fileUuid) } : {}),
          file_size: String(ve.fileSize || 0),
        },
      });
      continue;
    }

    // 6: faceElement (standard emoji, dice, rps, poke)
    if (elType === 6 && el.faceElement) {
      const face = el.faceElement;
      const idx = Number(face.faceIndex ?? 0);
      if (face.pokeType !== undefined && face.pokeType !== null && Number(face.faceType) === 5) {
        segments.push({
          type: "poke",
          data: {
            type: String(face.pokeType),
            id: String(face.vasPokeId ?? 0),
            ...(face.vasPokeName ? { name: String(face.vasPokeName) } : {}),
          },
        });
      } else if (idx === 358 || (Number(face.faceType) === 4 && String(face.faceText || "").includes("骰子"))) {
        segments.push({
          type: "dice",
          data: { result: String(face.resultId || "1") },
        });
      } else if (idx === 359 || (Number(face.faceType) === 4 && String(face.faceText || "").includes("猜拳"))) {
        segments.push({
          type: "rps",
          data: { result: String(face.resultId || "1") },
        });
      } else {
        const hasResultId =
          face.resultId !== undefined &&
          face.resultId !== null &&
          String(face.resultId) !== "";
        segments.push({
          type: "face",
          data: {
            id: String(idx),
            ...(hasResultId ? { resultId: String(face.resultId) } : {}),
          },
        });
      }
      continue;
    }

    // 7: replyElement
    if (elType === 7 && el.replyElement) {
      const re = el.replyElement;
      const rawReplyMsgId =
        re.replayMsgId && String(re.replayMsgId) !== "0"
          ? String(re.replayMsgId)
          : re.sourceMsgIdInRecords && String(re.sourceMsgIdInRecords) !== "0"
          ? String(re.sourceMsgIdInRecords)
          : "";
      const rawReplySeq =
        re.replayMsgSeq && String(re.replayMsgSeq) !== "0" ? String(re.replayMsgSeq) : "";

      let resolvedShortId = null;
      if (messageIdStore) {
        if (rawReplyMsgId) {
          const hit = messageIdStore.getByMsgId(rawReplyMsgId);
          if (hit) resolvedShortId = hit.shortId;
        }
        if (!resolvedShortId && rawReplySeq && peerUid) {
          const hit = messageIdStore.getByPeerAndSeq(chatType, peerUid, rawReplySeq);
          if (hit) resolvedShortId = hit.shortId;
        }
        if (!resolvedShortId && (rawReplyMsgId || rawReplySeq)) {
          resolvedShortId = messageIdStore.register(
            rawReplyMsgId || `seq_${chatType}_${peerUid}_${rawReplySeq}`,
            { chatType, peerUid, guildId: "" },
            rawReplySeq || "0",
            {
              senderUin: re.senderUid ? String(re.senderUid) : "",
              senderUid: re.senderUidStr ? String(re.senderUidStr) : "",
              msgTime: Number(re.replyMsgTime || 0),
            }
          );
        }
      }
      const replyId = resolvedShortId || rawReplyMsgId || rawReplySeq || "0";
      segments.push({
        type: "reply",
        data: { id: String(replyId) },
      });
      continue;
    }

    // 8: grayTipElement (only include if it carries text inside a normal message; system notices are handled separately)
    if (elType === 8 && el.grayTipElement) {
      continue;
    }

    // 10: arkElement (JSON card)
    if (elType === 10 && el.arkElement) {
      const bytesData = el.arkElement.bytesData || "";
      if (bytesData) {
        segments.push({
          type: "json",
          data: { data: String(bytesData) },
        });
      }
      continue;
    }

    // 11: marketFaceElement (mall sticker)
    if (elType === 11 && el.marketFaceElement) {
      const mf = el.marketFaceElement;
      segments.push({
        type: "mface",
        data: {
          emoji_id: String(mf.emojiId || ""),
          emoji_package_id: String(mf.emojiPackageId || ""),
          key: String(mf.key || ""),
          summary: String(mf.faceName || "[商城表情]"),
          ...(mf.url ? { url: String(mf.url) } : {}),
        },
      });
      continue;
    }

    // 16: multiForwardMsgElement (merged forward message)
    if (elType === 16 && el.multiForwardMsgElement) {
      const fwd = el.multiForwardMsgElement;
      const resId = String(fwd.resId || ntMsg?.msgId || "");
      segments.push({
        type: "forward",
        data: {
          id: resId,
          ...(fwd.xmlContent ? { content: String(fwd.xmlContent) } : {}),
        },
      });
      continue;
    }
  }

  return {
    segments,
    raw_message: segmentsToCqCode(segments),
  };
}

function pickMediaSource(data) {
  const file = String(data.file ?? "").trim();
  const url = String(data.url ?? "").trim();
  const fallback =
    file || url || String(data.path ?? "").trim() || String(data.media ?? "").trim();
  if (!file) return fallback;
  if (/^(base64:\/\/|data:|https?:\/\/|file:\/\/)/i.test(file) || /[\\/]/.test(file)) {
    return file;
  }
  if (/^(https?:\/\/|base64:\/\/|data:|file:\/\/)/i.test(url)) {
    return url;
  }
  return fallback;
}

/**
 * Convert OneBot v11 message (array of segments or CQ-code string) into NTQQ
 * `msgElements` array ready for `nodeIKernelMsgService/sendMsg`.
 */
async function oneBotSegmentsToNtElements(message, ctx = {}) {
  const segments = normalizeOneBotMessage(message, Boolean(ctx.autoEscape));
  const uinUidStore = ctx.uinUidStore || null;
  const messageIdStore = ctx.messageIdStore || ctx.msgIdStore || null;
  const invokeNt = ctx.invokeNt || null;
  const elements = [];
  const sideEffects = [];
  const cleanupCallbacks = [];
  const tempFiles = [];

  function trackTempMedia(media) {
    if (media && media.isTempFile && media.localPath) {
      const tempPath = media.localPath;
      tempFiles.push(tempPath);
      cleanupCallbacks.push(() => {
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch (_) {}
      });
    }
  }

  for (const seg of segments) {
    const type = String(seg.type || "").toLowerCase();
    const data = seg.data && typeof seg.data === "object" ? seg.data : {};

    if (type === "text") {
      const content = String(data.text ?? "");
      if (content !== "") {
        elements.push({
          elementType: 1,
          elementId: "",
          textElement: {
            content,
            atType: 0,
            atUid: "",
            atTinyId: "",
            atNtUid: "",
          },
        });
      }
      continue;
    }

    if (type === "at") {
      const qq = String(data.qq ?? data.id ?? "").trim();
      if (qq === "all" || qq === "0") {
        const display = data.name
          ? String(data.name).startsWith("@")
            ? String(data.name)
            : `@${data.name}`
          : "@全体成员";
        elements.push({
          elementType: 1,
          elementId: "",
          textElement: {
            content: display,
            atType: 1,
            atUid: "0",
            atTinyId: "",
            atNtUid: "all",
          },
        });
      } else if (qq) {
        let uid = "";
        if (typeof ctx.resolveUid === "function") {
          uid = await ctx.resolveUid(qq);
        } else if (uinUidStore) {
          uid = await uinUidStore.resolveUid(qq, invokeNt);
        }
        let displayName = data.name ? String(data.name).replace(/^@/, "") : "";
        if (!displayName && uinUidStore) {
          const gKey = ctx.groupId ? `${ctx.groupId}:${qq}` : "";
          const gMeta = gKey ? uinUidStore.groupMemberMeta.get(gKey) : null;
          const uMeta = uinUidStore.userMeta.get(qq);
          displayName = gMeta?.card || gMeta?.nickname || uMeta?.nickname || qq;
        }
        if (!displayName) displayName = qq;
        elements.push({
          elementType: 1,
          elementId: "",
          textElement: {
            content: `@${displayName}`,
            atType: 2,
            atUid: qq,
            atTinyId: "",
            atNtUid: String(uid || ""),
          },
        });
      }
      continue;
    }

    if (type === "reply") {
      const rawId = data.id ?? data.message_id;
      let entry = null;
      if (messageIdStore && rawId !== undefined && rawId !== null) {
        entry = messageIdStore.getByShortId(rawId) || messageIdStore.getByMsgId(rawId);
      }
      const replayMsgId = entry?.msgId && /^\d+$/.test(String(entry.msgId)) ? String(entry.msgId) : "0";
      const replayMsgSeq = String(entry?.msgSeq || data.seq || "0");
      const senderUin = String(entry?.senderUin || data.qq || "0");
      const senderUid = String(entry?.senderUid || (uinUidStore ? uinUidStore.getUidSync(senderUin) : "") || "");
      elements.push({
        elementType: 7,
        elementId: "",
        replyElement: {
          replayMsgId,
          replayMsgSeq,
          replayMsgRootSeq: "0",
          replayMsgRootMsgId: "0",
          replayMsgRootCommentCnt: "0",
          sourceMsgIdInRecords: replayMsgId,
          sourceMsgText: "",
          senderUid: senderUin,
          senderUidStr: senderUid,
          replyMsgClientSeq: "0",
          replyMsgTime: String(entry?.msgTime || Math.floor(Date.now() / 1000)),
          replyMsgRevokeType: 0,
          sourceMsgTextElems: [],
          sourceMsgIsIncPic: false,
          sourceMsgExpired: false,
        },
      });
      continue;
    }

    if (type === "face") {
      const faceIndex = Number(data.id ?? 0);
      const rawResultId = data.resultId ?? data.result_id;
      const hasResultId =
        rawResultId !== undefined && rawResultId !== null && String(rawResultId) !== "";
      const isLarge =
        data.large === true ||
        data.large === "true" ||
        data.large === 1 ||
        data.large === "1";
      elements.push({
        elementType: 6,
        elementId: "",
        faceElement: {
          faceIndex,
          faceType: isLarge || hasResultId ? 3 : faceIndex >= 1000 ? 2 : 1,
          faceText: data.text ? String(data.text) : "",
          imageType: 0,
          packId: hasResultId ? "1" : "0",
          stickerId: "0",
          sourceType: hasResultId ? 1 : 0,
          stickerType: hasResultId ? 2 : isLarge ? 1 : 0,
          resultId: hasResultId ? String(rawResultId) : "",
          surpriseId: "",
          randomType: 1,
        },
      });
      continue;
    }

    if (type === "dice" || type === "rps") {
      const isDice = type === "dice";
      elements.push({
        elementType: 6,
        elementId: "",
        faceElement: {
          faceIndex: isDice ? 358 : 359,
          faceType: 4,
          faceText: isDice ? "[骰子]" : "[包剪锤]",
          imageType: 0,
          packId: "1",
          stickerId: isDice ? "33" : "34",
          sourceType: 1,
          stickerType: 2,
          resultId: data.result ? String(data.result) : "",
          surpriseId: "",
          randomType: 1,
        },
      });
      continue;
    }

    if (type === "mface" || type === "marketface") {
      elements.push({
        elementType: 11,
        elementId: "",
        marketFaceElement: {
          itemType: 6,
          faceInfo: 1,
          emojiPackageId: Number(data.emoji_package_id || data.tab_id || 0),
          subType: 3,
          faceName: String(data.summary || "[商城表情]"),
          emojiId: String(data.emoji_id || ""),
          key: String(data.key || ""),
          staticFacePath: "",
          dynamicFacePath: "",
        },
      });
      continue;
    }

    if (type === "image") {
      const imgEmojiId = String(data.emoji_id ?? "").trim();
      if (imgEmojiId) {
        elements.push({
          elementType: 11,
          elementId: "",
          marketFaceElement: {
            itemType: 6,
            faceInfo: 1,
            emojiPackageId: Number(data.emoji_package_id || data.tab_id || 0),
            subType: 3,
            faceName: String(data.summary || data.name || "[商城表情]"),
            emojiId: imgEmojiId,
            key: String(data.key || ""),
            staticFacePath: "",
            dynamicFacePath: "",
          },
        });
        continue;
      }
      const src = pickMediaSource(data);
      const media =
        typeof ctx.resolveMediaSource === "function"
          ? await ctx.resolveMediaSource(src, { kind: "image" })
          : await resolveMediaSource(src, {
              tempDir: ctx.tempDir,
              maxMediaBytes: ctx.maxMediaBytes,
              allowPrivateUrls: ctx.allowPrivateUrls,
              allowPrivateMediaUrls: ctx.allowPrivateMediaUrls,
              allowArbitraryLocalFiles: ctx.allowArbitraryLocalFiles,
              allowedFileDirs: ctx.allowedFileDirs,
            });
      trackTempMedia(media);
      const subType = Number(data.sub_type ?? data.subType ?? 0);
      let finalPath = media.localPath;
      let md5HexStr = media.md5HexStr;
      let fileSize = media.fileSize;
      let fileName = media.fileName;
      if (typeof ctx.prepareNtImagePath === "function") {
        const prepared = await ctx.prepareNtImagePath(media, subType);
        if (prepared && typeof prepared === "object") {
          if (prepared.localPath) finalPath = String(prepared.localPath);
          if (prepared.md5HexStr) md5HexStr = String(prepared.md5HexStr);
          if (prepared.fileSize) fileSize = Number(prepared.fileSize);
          if (prepared.fileName) fileName = String(prepared.fileName);
        } else if (typeof prepared === "string" && prepared) {
          finalPath = prepared;
        }
      }
      const extLower = path.extname(fileName || finalPath || "").toLowerCase();
      const picType = media.isGif || extLower === ".gif"
        ? 2000
        : extLower === ".png"
        ? 1001
        : extLower === ".webp"
        ? 1002
        : extLower === ".bmp"
        ? 1005
        : 1000;
      elements.push({
        elementType: 2,
        elementId: "",
        picElement: {
          md5HexStr,
          fileSize: String(fileSize),
          picWidth: media.width || 512,
          picHeight: media.height || 512,
          fileName,
          sourcePath: finalPath,
          original: true,
          picType,
          picSubType: subType,
          thumbPath: new Map(),
          fileUuid: "",
          fileSubId: "",
          thumbFileSize: 0,
          summary: data.summary ? String(data.summary) : subType === 1 ? "[动画表情]" : "",
        },
      });
      continue;
    }

    if (type === "record") {
      const src = pickMediaSource(data);
      const media =
        typeof ctx.resolveMediaSource === "function"
          ? await ctx.resolveMediaSource(src, { kind: "record", preferredExt: ".amr" })
          : await resolveMediaSource(src, {
              tempDir: ctx.tempDir,
              preferredExt: ".amr",
              maxMediaBytes: ctx.maxMediaBytes,
              allowPrivateUrls: ctx.allowPrivateUrls,
              allowPrivateMediaUrls: ctx.allowPrivateMediaUrls,
              allowArbitraryLocalFiles: ctx.allowArbitraryLocalFiles,
              allowedFileDirs: ctx.allowedFileDirs,
            });
      trackTempMedia(media);
      let finalPath = media.localPath;
      let duration = Math.max(1, Number(data.duration || 3));
      if (typeof ctx.prepareNtRecordPath === "function") {
        const prepared = await ctx.prepareNtRecordPath(media);
        if (prepared && typeof prepared === "object") {
          if (prepared.localPath) finalPath = prepared.localPath;
          if (prepared.duration) duration = prepared.duration;
        } else if (typeof prepared === "string") {
          finalPath = prepared;
        }
      }
      elements.push({
        elementType: 4,
        elementId: "",
        pttElement: {
          fileName: path.basename(finalPath),
          filePath: finalPath,
          md5HexStr: media.md5HexStr,
          fileSize: String(media.fileSize),
          duration,
          formatType: 1,
          voiceType: 1,
          voiceChangeType: Number(data.magic || 0),
          canConvert2Text: true,
          fileId: 0,
          fileUuid: "",
          text: "",
          waveAmplitudes: [18, 42, 65, 51, 33, 72, 48, 25],
        },
      });
      continue;
    }

    if (type === "video") {
      const src = pickMediaSource(data);
      const media =
        typeof ctx.resolveMediaSource === "function"
          ? await ctx.resolveMediaSource(src, { kind: "video", preferredExt: ".mp4" })
          : await resolveMediaSource(src, {
              tempDir: ctx.tempDir,
              preferredExt: ".mp4",
              maxMediaBytes: ctx.maxMediaBytes,
              allowPrivateUrls: ctx.allowPrivateUrls,
              allowPrivateMediaUrls: ctx.allowPrivateMediaUrls,
              allowArbitraryLocalFiles: ctx.allowArbitraryLocalFiles,
              allowedFileDirs: ctx.allowedFileDirs,
            });
      trackTempMedia(media);
      elements.push({
        elementType: 5,
        elementId: "",
        videoElement: {
          filePath: media.localPath,
          fileName: media.fileName,
          videoMd5: media.md5HexStr,
          thumbMd5: "",
          fileTime: Number(data.duration || 5),
          thumbSize: 0,
          fileFormat: 2,
          fileSize: String(media.fileSize),
          thumbWidth: 480,
          thumbHeight: 270,
          busiType: 0,
          subBusiType: 0,
          thumbPath: new Map(),
          transferStatus: 0,
          progress: 0,
          invalidState: 0,
          fileUuid: "",
          fileSubId: "",
          fileBizId: null,
        },
      });
      continue;
    }

    if (type === "file") {
      const src = pickMediaSource(data);
      const preferredName = data.name || data.file_name || undefined;
      const media =
        typeof ctx.resolveMediaSource === "function"
          ? await ctx.resolveMediaSource(src, { kind: "file", preferredName })
          : await resolveMediaSource(src, {
              tempDir: ctx.tempDir,
              preferredName,
              maxMediaBytes: ctx.maxMediaBytes,
              allowPrivateUrls: ctx.allowPrivateUrls,
              allowPrivateMediaUrls: ctx.allowPrivateMediaUrls,
              allowArbitraryLocalFiles: ctx.allowArbitraryLocalFiles,
              allowedFileDirs: ctx.allowedFileDirs,
            });
      trackTempMedia(media);
      elements.push({
        elementType: 3,
        elementId: "",
        fileElement: {
          fileMd5: media.md5HexStr,
          fileName: preferredName || media.fileName,
          filePath: media.localPath,
          fileSize: String(media.fileSize),
          picHeight: 0,
          picWidth: 0,
          picThumbPath: new Map(),
          expireTime: "0",
          file10MMd5: "",
          fileSha: "",
          fileSha3: "",
          videoDuration: 0,
          transferStatus: 0,
          progress: 0,
          invalidState: 0,
          fileUuid: "",
          fileSubId: "",
          thumbFileSize: 0,
          fileBizId: null,
        },
      });
      continue;
    }

    if (type === "share") {
      const shareUrl = String(data.url ?? "").trim();
      const shareTitle = String(data.title ?? shareUrl).trim();
      const shareContent = String(data.content ?? "");
      const shareImage = String(data.image ?? "");
      if (shareUrl) {
        elements.push({
          elementType: 10,
          elementId: "",
          arkElement: {
            bytesData: JSON.stringify({
              app: "com.tencent.structmsg",
              view: "news",
              prompt: shareTitle,
              meta: {
                news: {
                  title: shareTitle,
                  desc: shareContent,
                  jumpUrl: shareUrl,
                  preview: shareImage,
                },
              },
            }),
            linkInfo: null,
            subElementType: null,
          },
        });
      }
      continue;
    }

    if (type === "json") {
      let jsonStr;
      if (typeof data.data === "string") {
        jsonStr = data.data;
      } else if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
        jsonStr = JSON.stringify(data.data);
      } else if (data.data === undefined && Object.keys(data).length > 0) {
        jsonStr = JSON.stringify(data);
      } else {
        jsonStr = JSON.stringify(data.data || {});
      }
      elements.push({
        elementType: 10,
        elementId: "",
        arkElement: {
          bytesData: jsonStr,
          linkInfo: null,
          subElementType: null,
        },
      });
      continue;
    }

    if (type === "poke") {
      const targetQq = data.qq || data.id || data.user_id;
      sideEffects.push({
        type: "poke",
        qq: targetQq ? Number(targetQq) : undefined,
        pokeType: Number(data.type || 1),
        pokeId: Number(data.id || 1),
      });
      continue;
    }
  }

  const pokeTargets = sideEffects.filter((s) => s.type === "poke");
  return { elements, sideEffects, pokeTargets, cleanupCallbacks, tempFiles };
}

module.exports = {
  buildNtPicUrl,
  buildNtRecordUri,
  ntMsgToOneBotSegments,
  pickMediaSource,
  oneBotSegmentsToNtElements,
};

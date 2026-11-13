"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const { resolveMediaSource } = require("../core/media_security");
const { createActionRouter, createEventWaiter } = require("../core/primitives");
const {
  computeBkn,
  cookieObjToString,
  httpsGetCookies,
  httpRequestText,
  parseJsonpOrJson,
} = require("../core/web_http");
const { dispatchWebCredentialOrQzoneAction } = require("../core/qzone_actions");

const WEB_HTTP_HELPERS = Object.freeze({
  computeBkn,
  cookieObjToString,
  httpsGetCookies,
  httpRequestText,
  parseJsonpOrJson,
});

function resolveMessageEntry(bridge, rawMsgId) {
  const store = bridge?.messageIdStore;
  if (!store || rawMsgId === undefined || rawMsgId === null || rawMsgId === "") {
    return null;
  }
  if (typeof store.resolve === "function") {
    const resolved = store.resolve(rawMsgId);
    return resolved ? resolved.entry || resolved : store.resolveByOneBotId?.(rawMsgId) || null;
  }
  return (
    store.resolveByOneBotId?.(rawMsgId) ||
    store.getByShortId?.(rawMsgId) ||
    store.getByMsgId?.(rawMsgId) ||
    null
  );
}

async function statNonEmptyFile(candidatePath) {
  if (!candidatePath || typeof candidatePath !== "string") return null;
  try {
    const st = await fs.promises.stat(candidatePath);
    if (st.isFile() && st.size > 0) return st;
  } catch (_) {}
  return null;
}

function scheduleResolvedMediaCleanup(bridge, media) {
  if (!media) return;
  if (typeof media.cleanup === "function") {
    bridge._scheduleTempCleanup(media.cleanup);
  } else {
    bridge._scheduleMediaCleanup(media);
  }
}

function createPttTextWaiter(bridge, ntMsgId, timeoutMs = 10000) {
  if (!(bridge._pttTextWaiters instanceof Map)) {
    bridge._pttTextWaiters = new Map();
  }
  const waiterMap = bridge._pttTextWaiters;
  const key = String(ntMsgId || "");
  let dispatcher = waiterMap.get(key);
  if (typeof dispatcher !== "function" || !(dispatcher._listeners instanceof Set)) {
    const listeners = new Set();
    if (typeof dispatcher === "function") {
      listeners.add(dispatcher);
    }
    dispatcher = (txt) => {
      for (const fn of Array.from(listeners)) {
        try {
          fn(txt);
        } catch (_) {}
      }
    };
    dispatcher._listeners = listeners;
    waiterMap.set(key, dispatcher);
  }

  const listeners = dispatcher._listeners;
  const cleanupIfEmpty = () => {
    if (listeners.size === 0 && waiterMap.get(key) === dispatcher) {
      waiterMap.delete(key);
    }
  };
  const waiterSetAdapter = {
    add(fn) {
      listeners.add(fn);
    },
    delete(fn) {
      const removed = listeners.delete(fn);
      cleanupIfEmpty();
      return removed;
    },
  };

  const inner = createEventWaiter(waiterSetAdapter, timeoutMs);
  return {
    promise: inner.promise.then((txt) => (txt === null || txt === undefined ? "" : String(txt))),
    cancel() {
      inner.cancel();
      cleanupIfEmpty();
    },
  };
}

function elementToMediaDesc(el, ntMsgId, chatType, peerUid) {
  if (!el || typeof el !== "object") return null;
  const elementId = String(el.elementId || "");
  const t = Number(el.elementType || 0);
  if (t === 2 && el.picElement) {
    const pe = el.picElement;
    let sourcePath = String(pe.sourcePath || "");
    if (!sourcePath && pe.thumbPath) {
      const thumbs =
        pe.thumbPath instanceof Map
          ? Array.from(pe.thumbPath.values())
          : typeof pe.thumbPath === "object"
          ? Object.values(pe.thumbPath)
          : [];
      sourcePath = String(thumbs[0] || "");
    }
    return {
      ntMsgId: String(ntMsgId || ""),
      chatType: Number(chatType || 1),
      peerUid: String(peerUid || ""),
      elementId,
      elementType: 2,
      md5: String(pe.md5HexStr || "").toLowerCase(),
      fileUuid: String(pe.fileUuid || ""),
      fileName: String(pe.fileName || ""),
      sourcePath,
      url: String(pe.originImageUrl || ""),
      fileSize: Number(pe.fileSize || 0),
    };
  }
  if (t === 3 && el.fileElement) {
    const fe = el.fileElement;
    return {
      ntMsgId: String(ntMsgId || ""),
      chatType: Number(chatType || 1),
      peerUid: String(peerUid || ""),
      elementId,
      elementType: 3,
      md5: String(fe.fileMd5 || "").toLowerCase(),
      fileUuid: String(fe.fileUuid || ""),
      fileName: String(fe.fileName || ""),
      sourcePath: String(fe.filePath || fe.sourcePath || ""),
      url: "",
      fileSize: Number(fe.fileSize || 0),
    };
  }
  if (t === 4 && el.pttElement) {
    const ptt = el.pttElement;
    return {
      ntMsgId: String(ntMsgId || ""),
      chatType: Number(chatType || 1),
      peerUid: String(peerUid || ""),
      elementId,
      elementType: 4,
      md5: String(ptt.md5HexStr || "").toLowerCase(),
      fileUuid: String(ptt.fileUuid || ""),
      fileName: String(ptt.fileName || ""),
      sourcePath: String(ptt.filePath || ptt.sourcePath || ""),
      url: "",
      fileSize: Number(ptt.fileSize || 0),
    };
  }
  if (t === 5 && el.videoElement) {
    const ve = el.videoElement;
    return {
      ntMsgId: String(ntMsgId || ""),
      chatType: Number(chatType || 1),
      peerUid: String(peerUid || ""),
      elementId,
      elementType: 5,
      md5: String(ve.videoMd5 || "").toLowerCase(),
      fileUuid: String(ve.fileUuid || ""),
      fileName: String(ve.fileName || ""),
      sourcePath: String(ve.filePath || ve.sourcePath || ""),
      url: "",
      fileSize: Number(ve.fileSize || 0),
    };
  }
  return null;
}

function selectMediaDescFromRawMsg(rawMsg, entry, action, rawFile, rawFileId, elementIdHint) {
  if (!rawMsg || !Array.isArray(rawMsg.elements)) return null;
  const ntMsgId = String(rawMsg.msgId || entry?.msgId || entry?.ntMsgId || "");
  const chatType = Number(rawMsg.chatType || entry?.peer?.chatType || entry?.chatType || 1);
  const peerUid = String(rawMsg.peerUid || entry?.peer?.peerUid || entry?.peerUid || "");
  const descs = rawMsg.elements
    .map((el) => elementToMediaDesc(el, ntMsgId, chatType, peerUid))
    .filter(Boolean);
  if (descs.length === 0) return null;

  if (elementIdHint && String(elementIdHint) !== "0") {
    const byElId = descs.find((d) => d.elementId === String(elementIdHint));
    if (byElId) return byElId;
  }

  const tokens = [rawFile, rawFileId]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  for (const tok of tokens) {
    const cleanHex = tok.replace(/^\{|\}$/g, "").replace(/-/g, "").split(".")[0].toLowerCase();
    const hit = descs.find(
      (d) =>
        (d.fileUuid && d.fileUuid === tok) ||
        (d.fileName && d.fileName === tok) ||
        (d.md5 && (d.md5 === tok.toLowerCase() || d.md5 === cleanHex))
    );
    if (hit) return hit;
  }

  if (action === "get_image") {
    return descs.find((d) => d.elementType === 2) || descs[0];
  }
  if (action === "get_record") {
    return descs.find((d) => d.elementType === 4) || descs[0];
  }
  return descs.find((d) => d.elementType === 3 || d.elementType === 5) || descs[0];
}

async function listGroupFiles(bridge, groupId, folderId) {
  const res = await bridge.invokeNt("nodeIKernelRichMediaService/getGroupFileList", {
    groupId: String(groupId),
    groupFileListForm: {
      sortType: 1,
      fileCount: 100,
      startIndex: 0,
      sortOrder: 2,
      showOnlinedocFolder: 0,
      folderId,
    },
  });
  const items = Array.isArray(res?.items)
    ? res.items
    : Array.isArray(res?.files)
    ? res.files
    : [];
  const files = [];
  const folders = [];
  for (const item of items) {
    if (item.type === 1 || item.fileInfo) {
      const fi = item.fileInfo || item;
      files.push({
        group_id: groupId,
        file_id: String(fi.fileId || fi.file_id || ""),
        file_name: String(fi.fileName || fi.file_name || ""),
        busid: Number(fi.busId || fi.busid || 102),
        file_size: Number(fi.fileSize || fi.file_size || 0),
        upload_time: Number(fi.uploadTime || fi.upload_time || 0),
        dead_time: Number(fi.deadTime || 0),
        modify_time: Number(fi.modifyTime || 0),
        download_times: Number(fi.downloadTimes || 0),
        uploader: Number(fi.uploaderUin || fi.uploader || 0),
        uploader_name: String(fi.uploaderName || fi.uploader_name || ""),
      });
    } else if (item.type === 2 || item.folderInfo) {
      const fo = item.folderInfo || item;
      folders.push({
        group_id: groupId,
        folder_id: String(fo.folderId || fo.folder_id || ""),
        folder_name: String(fo.folderName || fo.folder_name || ""),
        create_time: Number(fo.createTime || 0),
        creator: Number(fo.createUin || 0),
        create_name: String(fo.creatorName || ""),
        total_file_count: Number(fo.totalFileCount || fo.total_file_count || 0),
      });
    }
  }
  return { files, folders };
}

async function extractUploadedFileUuid(bridge, peer, sent) {
  const entry = resolveMessageEntry(bridge, sent.message_id);
  let fileUuid = String(
    entry?.rawMsg?.elements?.find((e) => e?.fileElement)?.fileElement?.fileUuid || ""
  );
  if (
    !fileUuid &&
    sent.real_id &&
    !/^(sent_|fwd_|echo_timeout_)/.test(String(sent.real_id))
  ) {
    try {
      const res = await bridge.invokeNt(
        "nodeIKernelMsgService/getMsgsByMsgId",
        { peer, msgIds: [String(sent.real_id)] },
        [peer, [String(sent.real_id)]]
      );
      const fetched = res?.msgList?.[0];
      fileUuid = String(
        fetched?.elements?.find((e) => e?.fileElement)?.fileElement?.fileUuid || ""
      );
    } catch (_) {}
  }
  return fileUuid;
}

async function resolveOneBotMediaAction(p, _context, action) {
  const rawFile = String(p.file || p.file_id || "").trim();
  const rawFileId = String(p.file_id || "").trim();
  const includeB64 = Boolean(p.base64) || Boolean(this.config?.enableLocalFile2Url);

  // Step A: Resolve NTQQ kernel-owned media metadata via msg_id/message_id or lookupMedia
  let mediaDesc = null;
  if (p.msg_id || p.message_id) {
    const entry = resolveMessageEntry(this, p.msg_id || p.message_id);
    if (entry) {
      let rawMsg = entry.rawMsg || null;
      const ntMsgId = String(entry.msgId || entry.ntMsgId || "");
      const peer =
        entry.peer ||
        (entry.peerUid
          ? {
              chatType: Number(entry.chatType || 1),
              peerUid: String(entry.peerUid),
              guildId: "",
            }
          : null);
      if (
        !rawMsg &&
        ntMsgId &&
        !/^(sent_|fwd_|echo_timeout_)/.test(ntMsgId) &&
        peer?.peerUid
      ) {
        try {
          const res = await this.invokeNt(
            "nodeIKernelMsgService/getMsgsByMsgId",
            { peer, msgIds: [ntMsgId] },
            [peer, [ntMsgId]]
          );
          rawMsg = res?.msgList?.[0] || null;
        } catch (_) {
          rawMsg = null;
        }
      }
      mediaDesc = selectMediaDescFromRawMsg(
        rawMsg,
        entry,
        action,
        rawFile,
        rawFileId,
        p.element_id
      );
    }
  }

  if (!mediaDesc && typeof this.messageIdStore?.lookupMedia === "function") {
    if (rawFile) {
      mediaDesc = this.messageIdStore.lookupMedia(rawFile);
    }
    if (!mediaDesc && rawFileId && rawFileId !== rawFile) {
      mediaDesc = this.messageIdStore.lookupMedia(rawFileId);
    }
  }

  let kernelLocalPath = mediaDesc?.sourcePath ? String(mediaDesc.sourcePath) : "";
  let kernelStat = await statNonEmptyFile(kernelLocalPath);
  let kernelRemoteUrl = "";

  if (mediaDesc && !kernelStat) {
    const ntMsgId = String(mediaDesc.ntMsgId || "");
    const chatType = Number(mediaDesc.chatType || 1);
    const peerUid = String(mediaDesc.peerUid || "");
    const elementId = String(mediaDesc.elementId || "");
    const safeTargetPath = mediaDesc.sourcePath ? String(mediaDesc.sourcePath) : "";
    if (ntMsgId && !/^(sent_|fwd_|echo_timeout_)/.test(ntMsgId) && peerUid && elementId) {
      if (typeof this._downloadRichMediaElement === "function") {
        try {
          const dlPath = await this._downloadRichMediaElement({
            msgId: ntMsgId,
            chatType,
            peerUid,
            elementId,
            downloadType: 1,
            thumbSize: 0,
            filePath: safeTargetPath,
            timeoutMs: 8000,
          });
          const candidate = String(dlPath || safeTargetPath || "");
          const st = await statNonEmptyFile(candidate);
          if (st) {
            kernelLocalPath = candidate;
            kernelStat = st;
          }
        } catch (_) {}
      } else {
        try {
          const getReq = {
            downSourceType: 0,
            fileModelId: "0",
            downloadSourceType: 0,
            triggerType: 1,
            msgId: ntMsgId,
            chatType,
            peerUid,
            elementId,
            thumbSize: 0,
            downloadType: 1,
            filePath: safeTargetPath,
          };
          const res = await this.invokeNt(
            "nodeIKernelMsgService/downloadRichMedia",
            { getReq },
            [getReq]
          );
          const candidate = String(res?.filePath || safeTargetPath || "");
          const st = await statNonEmptyFile(candidate);
          if (st) {
            kernelLocalPath = candidate;
            kernelStat = st;
          }
        } catch (_) {}
      }
    }
  }

  if (action === "get_file" && !kernelStat) {
    const groupCode = String(
      p.group_id || (Number(mediaDesc?.chatType) === 2 ? mediaDesc.peerUid : "") || ""
    );
    const knownUuid = String(
      mediaDesc?.fileUuid ||
        (p.group_id && rawFileId
          ? rawFileId
          : p.group_id &&
            rawFile &&
            !rawFile.includes("..") &&
            !/^(?:file|base64|https?):\/\//i.test(rawFile) &&
            !/^[a-zA-Z]:[\\/]/.test(rawFile) &&
            !/^\/(?:etc|proc|sys|root|home|var|usr|opt|tmp)\b/i.test(rawFile)
          ? rawFile
          : "") ||
        ""
    ).trim();
    if (knownUuid && (groupCode || mediaDesc?.peerUid)) {
      const busId = Number(p.busid || 102);
      const filePeer = groupCode
        ? { chatType: 2, peerUid: groupCode, guildId: "" }
        : {
            chatType: Number(mediaDesc.chatType || 1),
            peerUid: String(mediaDesc.peerUid),
            guildId: "",
          };
      const attempts = [
        ...(groupCode
          ? [
              [
                "nodeIKernelRichMediaService/downloadFileForModelId",
                { peer: filePeer, modelIdList: [knownUuid], downSourceType: 0 },
                [filePeer, [knownUuid], ""],
              ],
            ]
          : []),
        [
          "nodeIKernelRichMediaService/downloadFileForFileUuid",
          {
            peer: filePeer,
            fileUuid: knownUuid,
            httpsUrl: "",
            fileName: String(mediaDesc?.fileName || ""),
            fileSize: String(mediaDesc?.fileSize || 0),
            busId,
          },
          [filePeer, knownUuid, ""],
        ],
        ...(groupCode
          ? [
              [
                "nodeIKernelRichMediaService/getGroupFileDownloadUrl",
                { groupId: groupCode, fileId: knownUuid, busId },
                [groupCode, knownUuid, busId],
              ],
            ]
          : []),
      ];
      for (const [cmd, payload, posArgs] of attempts) {
        try {
          const res = await this.invokeNt(cmd, payload, posArgs);
          const candidatePath =
            res && typeof res === "object" && res.filePath ? String(res.filePath) : "";
          if (candidatePath) {
            const st = await statNonEmptyFile(candidatePath);
            if (st) {
              kernelLocalPath = candidatePath;
              kernelStat = st;
              break;
            }
          }
          const candidateUrl =
            typeof res === "string"
              ? res
              : String(res?.url || res?.downloadUrl || res?.httpsUrl || "");
          if (/^https?:\/\//i.test(candidateUrl)) {
            kernelRemoteUrl = candidateUrl;
            break;
          }
        } catch (_) {}
      }
    }
  }

  if (kernelStat) {
    return {
      file: kernelLocalPath,
      url: pathToFileURL(kernelLocalPath).href,
      file_size: String(kernelStat.size),
      file_name: String(mediaDesc?.fileName || path.basename(kernelLocalPath)),
      ...(includeB64
        ? { base64: (await fs.promises.readFile(kernelLocalPath)).toString("base64") }
        : {}),
    };
  }

  if (kernelRemoteUrl || (mediaDesc?.url && /^https?:\/\//i.test(String(mediaDesc.url)))) {
    const remoteUrl = String(kernelRemoteUrl || mediaDesc.url);
    let urlName = "";
    try {
      urlName = path.basename(new URL(remoteUrl).pathname);
    } catch (_) {}
    const fileName = String(mediaDesc?.fileName || urlName || "file");
    return {
      file: fileName,
      url: remoteUrl,
      file_size: String(mediaDesc?.fileSize || 0),
      file_name: fileName,
    };
  }

  // Step B: Validate direct URI / local path via resolveMediaSource (never trust raw caller path)
  const directFile = p.file !== undefined && p.file !== null ? String(p.file).trim() : "";
  if (!directFile) {
    throw new Error("Media file not found or not accessible");
  }
  const hasExplicitSchemeOrAbs =
    /^(?:file|base64|https?):\/\//i.test(directFile) ||
    /^data:[^;]+;base64,/i.test(directFile) ||
    path.isAbsolute(directFile);
  if (!hasExplicitSchemeOrAbs) {
    const err = new Error(`Blocked relative or unverified local media path: ${directFile}`);
    err.code = "ERR_LFI_BLOCKED";
    throw err;
  }

  let resolved;
  try {
    resolved = await resolveMediaSource(directFile, this._mediaSecurityOptions());
  } catch (err) {
    if (
      err &&
      (err.code === "ERR_LFI_BLOCKED" ||
        err.code === "ERR_SSRF_BLOCKED" ||
        err.code === "ERR_MEDIA_TOO_LARGE")
    ) {
      throw err;
    }
    const notFound = new Error("Media file not found or not accessible");
    if (err && err.code) notFound.code = err.code;
    throw notFound;
  }

  if (resolved.isTempFile) {
    if (typeof this.tempFileCleaner?.track === "function") {
      this.tempFileCleaner.track(resolved.localPath);
    } else if (
      !this.config?.cleanupTempImmediately &&
      typeof this._scheduleMediaCleanup === "function"
    ) {
      this._scheduleMediaCleanup(resolved);
    }
  }

  let st;
  try {
    st = await fs.promises.stat(resolved.localPath);
  } catch (_) {
    throw new Error("Media file not found or not accessible");
  }
  if (!st.isFile()) {
    throw new Error("Media file not found or not accessible");
  }

  return {
    file: resolved.localPath,
    url: pathToFileURL(resolved.localPath).href,
    file_size: String(st.size),
    file_name: String(resolved.fileName || path.basename(resolved.localPath)),
    ...(includeB64
      ? { base64: (await fs.promises.readFile(resolved.localPath)).toString("base64") }
      : {}),
  };
}

async function handleWebCredentialOrQzoneAction(p, _context, action) {
  return await dispatchWebCredentialOrQzoneAction(this, action, p, WEB_HTTP_HELPERS);
}

// ============================================================================
// Declarative Action Handlers & Aliases
// ============================================================================

const ACTION_HANDLERS = {
  // ---- 7. Group & Private Files ----
  async get_group_root_files(p) {
    return await listGroupFiles(this, Number(p.group_id || 0), "/");
  },

  async get_group_files_by_folder(p) {
    return await listGroupFiles(
      this,
      Number(p.group_id || 0),
      String(p.folder_id || p.folder || "/")
    );
  },

  async get_group_file_system_info(p) {
    const groupId = String(p.group_id || "");
    const res = await this.invokeNt("nodeIKernelRichMediaService/getGroupSpace", {
      groupId,
    });
    return {
      file_count: Number(res?.fileCount || 0),
      limit_count: Number(res?.maxFileCount || 10000),
      used_space: Number(res?.usedSpace || 0),
      total_space: Number(res?.totalSpace || 10737418240),
    };
  },

  async get_group_file_url(p) {
    const groupId = String(p.group_id || "");
    const fileId = String(p.file_id || "");
    const busId = Number(p.busid || 102);
    const peer = { chatType: 2, peerUid: groupId, guildId: "" };

    // 1. Primary: genuine NTQQ RichMedia downloadFileForModelId / downloadFileForFileUuid
    for (const [cmd, payload, posArgs] of [
      [
        "nodeIKernelRichMediaService/downloadFileForModelId",
        { peer, modelIdList: [fileId], downSourceType: 0 },
        [peer, [fileId], ""],
      ],
      [
        "nodeIKernelRichMediaService/downloadFileForFileUuid",
        { peer, fileUuid: fileId, httpsUrl: "", fileName: "", fileSize: "0", busId },
        [peer, fileId, ""],
      ],
      [
        "nodeIKernelRichMediaService/getGroupFileDownloadUrl",
        { groupId, fileId, busId },
        [groupId, fileId, busId],
      ],
    ]) {
      try {
        const res = await this.invokeNt(cmd, payload, posArgs);
        const url =
          typeof res === "string"
            ? res
            : String(res?.url || res?.downloadUrl || res?.httpsUrl || "");
        if (url) return { url };
      } catch (_) {}
    }
    return { url: "" };
  },

  async get_private_file_url(p) {
    const fileId = String(p.file_id || "");
    const fileHash = String(p.file_hash || "");
    const userId = String(p.user_id || "");
    const peer = userId
      ? await this._resolvePeerForUser(userId)
      : { chatType: 1, peerUid: "", guildId: "" };

    for (const [cmd, payload, posArgs] of [
      [
        "nodeIKernelRichMediaService/downloadFileForFileUuid",
        { peer, fileUuid: fileId, fileHash, userId },
        [peer, fileId, ""],
      ],
      [
        "nodeIKernelRichMediaService/getPrivateFileDownloadUrl",
        { fileId, fileHash, userId },
        [fileId, fileHash, userId],
      ],
    ]) {
      try {
        const res = await this.invokeNt(cmd, payload, posArgs);
        const url =
          typeof res === "string"
            ? res
            : String(res?.url || res?.downloadUrl || res?.httpsUrl || "");
        if (url) return { url };
      } catch (_) {}
    }
    return { url: "" };
  },

  async upload_group_file(p) {
    const groupId = Number(p.group_id || 0);
    const folder = String(p.folder || p.folder_id || "/").trim();
    const peer = { chatType: 2, peerUid: String(groupId), guildId: "" };
    const sent = await this._sendMessageToPeer(peer, [
      {
        type: "file",
        data: {
          file: p.file,
          name: p.name || undefined,
          folder: folder || "/",
        },
      },
    ]);
    const fileUuid = await extractUploadedFileUuid(this, peer, sent);
    if (folder && folder !== "/" && fileUuid) {
      try {
        await this.invokeNt(
          "nodeIKernelRichMediaService/moveGroupFile",
          {
            groupId: String(groupId),
            busIdList: [Number(p.busid || 102)],
            fileIdList: [String(fileUuid)],
            curFolderId: "/",
            dstFolderId: folder,
          },
          [String(groupId), [String(fileUuid)], "/", folder]
        );
      } catch (_) {}
    }
    return {
      file_id: String(fileUuid || sent.real_id || sent.message_id),
      message_id: sent.message_id,
    };
  },

  async upload_private_file(p) {
    const peer = await this._resolvePeerForUser(p.user_id);
    const sent = await this._sendMessageToPeer(peer, [
      {
        type: "file",
        data: {
          file: p.file,
          name: p.name || undefined,
        },
      },
    ]);
    const fileUuid = await extractUploadedFileUuid(this, peer, sent);
    return {
      file_id: String(fileUuid || sent.real_id || sent.message_id),
      message_id: sent.message_id,
    };
  },

  async create_group_file_folder(p) {
    const res = await this.invokeNt("nodeIKernelRichMediaService/createGroupFolder", {
      groupId: String(p.group_id),
      parentFolderId: String(p.parent_id || "/"),
      folderName: String(p.name || ""),
    });
    return {
      result: { retCode: 0, retMsg: "success" },
      groupItem: {
        folderInfo: res?.folderInfo || {
          folderId: String(res?.folderId || `folder_${Date.now()}`),
          folderName: String(p.name || ""),
          folderPath: String(p.parent_id || "/"),
        },
      },
    };
  },

  async delete_group_folder(p) {
    await this.invokeNt("nodeIKernelRichMediaService/deleteGroupFolder", {
      groupId: String(p.group_id),
      folderId: String(p.folder_id || ""),
    });
    return {};
  },

  async delete_group_file(p) {
    await this.invokeNt("nodeIKernelRichMediaService/deleteGroupFile", {
      groupId: String(p.group_id),
      busIdList: [Number(p.busid || 102)],
      fileIdList: [String(p.file_id || "")],
    });
    return {};
  },

  async move_group_file(p) {
    await this.invokeNt("nodeIKernelRichMediaService/moveGroupFile", {
      groupId: String(p.group_id),
      busIdList: [Number(p.busid || 102)],
      fileIdList: [String(p.file_id || "")],
      curFolderId: String(p.parent_directory || "/"),
      dstFolderId: String(p.target_directory || "/"),
    });
    return {};
  },

  async rename_group_file(p) {
    await this.invokeNt("nodeIKernelRichMediaService/renameGroupFile", {
      groupId: String(p.group_id),
      busId: Number(p.busid || 102),
      fileId: String(p.file_id || ""),
      parentFolderId: String(p.current_parent_directory || p.parent_directory || "/"),
      newFileName: String(p.new_name || p.name || ""),
    });
    return {};
  },

  async rename_group_file_folder(p) {
    await this.invokeNt("nodeIKernelRichMediaService/renameGroupFolder", {
      groupId: String(p.group_id),
      folderId: String(p.folder_id || ""),
      newFolderName: String(p.new_folder_name || p.new_name || p.name || ""),
    });
    return {};
  },

  async trans_group_file(p) {
    await this.invokeNt("nodeIKernelRichMediaService/transGroupFile", {
      groupId: String(p.group_id),
      fileId: String(p.file_id || ""),
    });
    return { ok: true };
  },

  // ---- 8. Media / OCR / Translate / Voice / Profile / Online Status ----
  get_image: resolveOneBotMediaAction,
  get_record: resolveOneBotMediaAction,
  get_file: resolveOneBotMediaAction,

  async ocr_image(p) {
    const imgSrc = String(p.image || "");
    let media = null;
    try {
      media = await resolveMediaSource(imgSrc, this._mediaSecurityOptions());
      const res = await this.invokeNt("nodeIKernelMiscService/ocr", {
        path: media.localPath,
      });
      return {
        texts: Array.isArray(res?.texts) ? res.texts : [],
        language: String(res?.language || "zh"),
      };
    } finally {
      scheduleResolvedMediaCleanup(this, media);
    }
  },

  async translate_en2zh(p) {
    const words = Array.isArray(p.words) ? p.words : [String(p.words || "")];
    const res = await this.invokeNt(
      "nodeIKernelRichMediaService/translateEnWordToZn",
      { words },
      [words]
    );
    return { words: Array.isArray(res?.words) ? res.words : words };
  },

  async voice_msg_to_text(p) {
    const entry = resolveMessageEntry(this, p.message_id);
    if (!entry) throw new Error("message not found");
    let rawMsg = entry.rawMsg || null;
    const ntMsgId = String(entry.msgId || entry.ntMsgId || "");
    const peer =
      entry.peer ||
      (entry.peerUid
        ? {
            chatType: Number(entry.chatType || 1),
            peerUid: String(entry.peerUid),
            guildId: "",
          }
        : null);
    if (!rawMsg && ntMsgId && !/^(sent_|fwd_|echo_timeout_)/.test(ntMsgId) && peer?.peerUid) {
      try {
        const msgRes = await this.invokeNt(
          "nodeIKernelMsgService/getMsgsByMsgId",
          { peer, msgIds: [ntMsgId] },
          [peer, [ntMsgId]]
        );
        rawMsg = msgRes?.msgList?.[0] || null;
      } catch (_) {
        rawMsg = null;
      }
    }
    const pttEl = Array.isArray(rawMsg?.elements)
      ? rawMsg.elements.find((e) => e?.elementType === 4 && e.pttElement)
      : null;
    if (pttEl?.pttElement?.text) {
      return { text: String(pttEl.pttElement.text) };
    }

    const waiter = createPttTextWaiter(this, ntMsgId, 10000);
    try {
      const res = await this.invokeNt("nodeIKernelMsgService/translatePtt2Text", {
        msgId: ntMsgId,
        peer,
        msgElement: pttEl || { elementType: 4, elementId: "" },
      });
      if (res?.text) {
        waiter.cancel();
        return { text: String(res.text) };
      }
      const waitedText = await waiter.promise;
      return { text: String(waitedText || "") };
    } catch (err) {
      waiter.cancel();
      throw err;
    }
  },

  async set_qq_profile(p) {
    await this.invokeNt("nodeIKernelProfileService/modifyDesktopMiniProfile", {
      profile: {
        nick: p.nickname !== undefined ? String(p.nickname) : undefined,
        longNick: p.personal_note !== undefined ? String(p.personal_note) : undefined,
      },
    });
    return {};
  },

  async set_self_longnick(p) {
    await this.invokeNt("nodeIKernelProfileService/modifyDesktopMiniProfile", {
      profile: {
        longNick: String(p.longNick ?? p.personal_note ?? ""),
      },
    });
    return {};
  },

  async set_online_status(p) {
    await this.invokeNt("nodeIKernelOnlineStatusService/setOnlineStatus", {
      statusReq: {
        status: Number(p.status || 10),
        extStatus: Number(p.ext_status || 0),
        batteryStatus: Number(p.battery_status || 100),
      },
    });
    return {};
  },

  async set_diy_online_status(p) {
    await this.invokeNt("nodeIKernelOnlineStatusService/setOnlineStatus", {
      statusReq: {
        status: 10,
        extStatus: 2000,
        customStatus: {
          faceId: String(p.face_id ?? 212),
          faceType: Number(p.face_type ?? 1),
          wording: String(p.wording ?? ""),
        },
      },
    });
    return {};
  },

  async set_qq_avatar(p) {
    let media = null;
    try {
      media = await resolveMediaSource(p.file, this._mediaSecurityOptions());
      await this.invokeNt(
        "nodeIKernelProfileService/setHeader",
        { path: media.localPath },
        [media.localPath]
      );
      return {};
    } finally {
      scheduleResolvedMediaCleanup(this, media);
    }
  },

  async fetch_custom_face(p) {
    const count = Number(p.count || 48);
    const res = await this.invokeNt("nodeIKernelMsgService/fetchFavEmojiList", {
      resId: "",
      count,
      backwardFetch: true,
      forceRefresh: true,
    });
    const list = Array.isArray(res?.emojiInfoList) ? res.emojiInfoList : [];
    return list.map((e) => String(e.url || e.emoOriginalPath || "")).filter(Boolean);
  },

  // ---- 9. Ark Share & Robot UIN Range ----
  async ArkSharePeer(p) {
    if (p.group_id) {
      const res = await this.invokeNt(
        "nodeIKernelGroupService/getGroupRecommendContactArkJson",
        { groupCode: String(p.group_id) },
        [String(p.group_id)]
      );
      return { arkMsg: String(res?.arkJson || res?.arkMsg || res || "") };
    }
    const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
    const res = await this.invokeNt(
      "nodeIKernelBuddyService/getBuddyRecommendContactArkJson",
      { uid, phoneNumber: String(p.phone_number || "") },
      [uid, String(p.phone_number || "")]
    );
    return { arkMsg: String(res?.arkJson || res?.arkMsg || res || "") };
  },

  async ArkShareGroup(p) {
    const res = await this.invokeNt(
      "nodeIKernelGroupService/getGroupRecommendContactArkJson",
      { groupCode: String(p.group_id) },
      [String(p.group_id)]
    );
    return String(res?.arkJson || res?.arkMsg || res || "");
  },

  async get_robot_uin_range() {
    const res = await this.invokeNt("nodeIKernelRobotService/getRobotUinRange", {
      req: {
        justFetchMsgConfig: "0",
        type: 1,
        version: 0,
        aioKeywordVersion: 0,
      },
    });
    return Array.isArray(res?.response?.robotUinRanges)
      ? res.response.robotUinRanges
      : [];
  },

  // ---- 10. Credentials, ClientKey, Cookies, QZone (Opt-in via enableWebCredentialApi) ----
  get_clientkey: handleWebCredentialOrQzoneAction,
  get_cookies: handleWebCredentialOrQzoneAction,
  get_csrf_token: handleWebCredentialOrQzoneAction,
  get_credentials: handleWebCredentialOrQzoneAction,
  get_qzone_msg_list: handleWebCredentialOrQzoneAction,
  get_qzone_feeds: handleWebCredentialOrQzoneAction,
  send_qzone_msg: handleWebCredentialOrQzoneAction,
  delete_qzone_msg: handleWebCredentialOrQzoneAction,
  like_qzone: handleWebCredentialOrQzoneAction,
  unlike_qzone: handleWebCredentialOrQzoneAction,
  comment_qzone: handleWebCredentialOrQzoneAction,

  async get_rkey() {
    const res = await this.invokeNt("nodeIKernelUnitedConfigService/loadUnitedConfig", {
      id: "100293",
    });
    return {
      rkeys: [
        { type: "private", rkey: String(res?.configData?.content || "") },
        { type: "group", rkey: String(res?.configData?.content || "") },
      ],
    };
  },
};

const ACTION_ALIASES = {
  delete_group_file_folder: "delete_group_folder",
  ".ocr_image": "ocr_image",
  fetch_ptt_text: "voice_msg_to_text",
  get_ptt_text: "voice_msg_to_text",
  get_record_text: "voice_msg_to_text",
  share_peer: "ArkSharePeer",
  send_ark_share: "ArkSharePeer",
  share_group_ex: "ArkShareGroup",
  send_group_ark_share: "ArkShareGroup",
  nc_get_rkey: "get_rkey",
};

const { HANDLED_ACTIONS, dispatch } = createActionRouter(ACTION_HANDLERS, ACTION_ALIASES);

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
};

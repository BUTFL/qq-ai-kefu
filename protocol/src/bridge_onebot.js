"use strict";

/**
 * Pure Node.js OneBot v11 Protocol & NTQQ Kernel Data Converter (`src/bridge_onebot.js`)
 *
 * Barrel facade re-exporting decomposed protocol modules (`src/onebot/*`) and
 * media security utilities (`src/core/media_security.js`) for backward compatibility.
 */

const {
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
} = require("./core/media_security");

const {
  MessageIdStore,
  UinUidStore,
  pickPositiveUin,
  stripTransientNtMedia,
} = require("./onebot/stores");

const {
  escapeCqText,
  unescapeCqText,
  escapeCqParam,
  segmentsToCqCode,
  parseCqCodeToSegments,
  normalizeOneBotMessage,
} = require("./onebot/cq_codec");

const {
  buildNtPicUrl,
  buildNtRecordUri,
  ntMsgToOneBotSegments,
  oneBotSegmentsToNtElements,
} = require("./onebot/segment_converter");

const {
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
  formatMetaEvent,
} = require("./onebot/event_formatter");

module.exports = {
  DEFAULT_MAX_MEDIA_BYTES,
  MessageIdStore,
  UinUidStore,
  pickPositiveUin,
  stripTransientNtMedia,
  escapeCqText,
  unescapeCqText,
  escapeCqParam,
  segmentsToCqCode,
  parseCqCodeToSegments,
  normalizeOneBotMessage,
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
  buildNtPicUrl,
  buildNtRecordUri,
  ntMsgToOneBotSegments,
  oneBotSegmentsToNtElements,
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
  formatMetaEvent,
};

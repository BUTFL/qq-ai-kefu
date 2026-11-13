"use strict";

/**
 * Architectural & Core Submodule Unit Test Suite (`test/test_core_modules.js`)
 *
 * Directly verifies the modularized Rosmontis architecture:
 * 1. `src/core/env.js` & zero-scattered-`process.env` source invariant
 * 2. `src/core/primitives.js` (`BoundedMap`, `TtlDedupeSet`, `TempCleanupQueue`,
 *    event waiters, `BridgeLogger`, symmetric lossless wire codec, `createActionRouter`)
 * 3. `src/core/nt_normalizer.js` (V1/V2 anti-corruption normalizers & `"0"` UIN guards)
 * 4. `src/core/echo_correlator.js` (`EchoCorrelator` out-of-order & lifecycle drain)
 * 5. `src/core/session_controller.js` (`HumanSessionController` & causal step runners)
 * 6. `src/onebot/*` decomposed protocol modules & `MessageIdStore.prototype.resolve`
 * 7. Declarative action router collision & coverage guarantees + installer LF invariant
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const envMod = require("../src/core/env");
const {
  BoundedMap,
  setBoundedMap,
  TtlDedupeSet,
  TempCleanupQueue,
  createEventWaiter,
  waitForEventOnce,
  BridgeLogger,
  safeJsJson,
  serializeBridgePayload,
  reviveBridgePayload,
  createActionRouter,
} = require("../src/core/primitives");
const {
  isPositiveUin,
  pickPositiveUin,
  normalizePeer,
  normalizeGroupSummary,
  normalizeBuddyProfile,
  normalizeGroupMember,
  normalizeLoginIdentity,
} = require("../src/core/nt_normalizer");
const {
  EchoCorrelator,
  hasRichMediaElements,
} = require("../src/core/echo_correlator");
const {
  HumanSessionController,
  runCausalActivateSteps,
  runCausalLeaveSteps,
} = require("../src/core/session_controller");
const storesMod = require("../src/onebot/stores");
const cqCodecMod = require("../src/onebot/cq_codec");
const segmentConverterMod = require("../src/onebot/segment_converter");
const eventFormatterMod = require("../src/onebot/event_formatter");
const bridgeOnebotFacade = require("../src/bridge_onebot");

const messageActions = require("../src/actions/message_actions");
const contactActions = require("../src/actions/contact_actions");
const groupActions = require("../src/actions/group_actions");
const fileMediaActions = require("../src/actions/file_media_actions");

function walkJsFiles(dirPath) {
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

async function withSavedEnv(keys, fn) {
  const saved = new Map();
  for (const k of keys) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
    delete process.env[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function runTests() {
  console.log("=== Rosmontis Core Architecture Module Suite ===");

  // --------------------------------------------------------------------------
  // Suite 1: Unified Environment Module & Single-Source `process.env` Invariant
  // --------------------------------------------------------------------------
  {
    const srcRoot = path.resolve(__dirname, "..", "src");
    const envFile = path.resolve(srcRoot, "core", "env.js");
    const allSrcFiles = walkJsFiles(srcRoot);
    assert.ok(allSrcFiles.length >= 28, "Expected decomposed src/ module tree");

    for (const filePath of allSrcFiles) {
      if (path.resolve(filePath) === envFile) continue;
      const content = fs.readFileSync(filePath, "utf8");
      assert.strictEqual(
        /\bprocess\.env\b/.test(content),
        false,
        `Direct process.env access must be confined to src/core/env.js, found in ${path.relative(srcRoot, filePath)}`
      );
    }

    await withSavedEnv(
      [
        "ROSMONTIS_ACCESS_TOKEN",
        "ONEBOT_ACCESS_TOKEN",
        "XIAO_BRIDGE_ACCESS_TOKEN",
        "ROSMONTIS_ALLOWED_FILE_DIRS",
        "ONEBOT_ALLOWED_FILE_DIRS",
        "XIAO_BRIDGE_ALLOWED_FILE_DIRS",
        "ONEBOT_QUIET",
      ],
      async () => {
        process.env.XIAO_BRIDGE_ACCESS_TOKEN = "legacy-tok";
        assert.strictEqual(envMod.pickPrefixedEnv("ACCESS_TOKEN"), "legacy-tok");
        process.env.ONEBOT_ACCESS_TOKEN = "onebot-tok";
        assert.strictEqual(envMod.pickPrefixedEnv("ACCESS_TOKEN"), "onebot-tok");
        process.env.ROSMONTIS_ACCESS_TOKEN = "rosmontis-tok";
        assert.strictEqual(envMod.pickPrefixedEnv("ACCESS_TOKEN"), "rosmontis-tok");

        process.env.ROSMONTIS_ALLOWED_FILE_DIRS = "/a";
        process.env.XIAO_BRIDGE_ALLOWED_FILE_DIRS = "/b";
        assert.deepStrictEqual(envMod.collectPrefixedEnvValues("ALLOWED_FILE_DIRS"), ["/a", "/b"]);

        process.env.ONEBOT_QUIET = "true";
        assert.strictEqual(envMod.isQuietLogsEnabled({ quietLogs: false }), true);
      }
    );
    console.log("  [PASS] Suite 1: Unified env resolver & zero-scattered process.env invariant");
  }

  // --------------------------------------------------------------------------
  // Suite 2: Core Primitives, Wire Codec & Declarative Action Router
  // --------------------------------------------------------------------------
  {
    const lru = new BoundedMap(3);
    lru.set("a", 1).set("b", 2).set("c", 3);
    assert.strictEqual(lru.get("a"), 1); // refreshes "a" as MRU
    lru.set("d", 4); // evicts "b"
    assert.strictEqual(lru.has("b"), false);
    assert.deepStrictEqual([...lru.keys()], ["c", "a", "d"]);

    const plainMap = new Map();
    setBoundedMap(plainMap, "k1", 1, 2);
    setBoundedMap(plainMap, "k2", 2, 2);
    setBoundedMap(plainMap, "k1", 10, 2);
    setBoundedMap(plainMap, "k3", 3, 2);
    assert.deepStrictEqual([...plainMap.entries()], [["k1", 10], ["k3", 3]]);

    const dedupe = new TtlDedupeSet(3, 5000);
    assert.strictEqual(dedupe.isDuplicate("ev1"), false);
    assert.strictEqual(dedupe.isDuplicate("ev1"), true);
    assert.strictEqual(dedupe.isDuplicate("ev2"), false);
    assert.strictEqual(dedupe.isDuplicate("ev3"), false);
    assert.strictEqual(dedupe.isDuplicate("ev4"), false);
    assert.strictEqual(dedupe.entries.size, 3);

    let cleaned = 0;
    const cleanupQueue = new TempCleanupQueue(() => ({
      cleanupTempImmediately: false,
      maxTempCleanupRing: 8,
      tempCleanupDelayMs: 60000,
    }));
    for (let i = 0; i < 9; i++) {
      cleanupQueue.schedule(() => { cleaned += 1; });
    }
    assert.strictEqual(cleaned, 1); // 9th item overflows maxRing=8 -> runs oldest immediately
    cleanupQueue.flush();
    assert.strictEqual(cleaned, 9);

    const waiters = new Set();
    const waitPromise = waitForEventOnce(waiters, 500, (v) => v && v.ready === true);
    for (const fn of [...waiters]) fn({ ready: false });
    assert.strictEqual(waiters.size, 1, "Non-matching predicate must keep waiter active");
    for (const fn of [...waiters]) fn({ ready: true, count: 42 });
    const waitRes = await waitPromise;
    assert.deepStrictEqual(waitRes, { ready: true, count: 42 });
    assert.strictEqual(waiters.size, 0);

    const cancelableSet = new Set();
    const handle = createEventWaiter(cancelableSet, 5000);
    assert.strictEqual(cancelableSet.size, 1);
    handle.cancel();
    assert.strictEqual(await handle.promise, null);
    assert.strictEqual(cancelableSet.size, 0);

    const emittedLines = [];
    let cfgState = { quietLogs: false, debugLogs: false };
    const logger = new BridgeLogger({
      getConfig: () => cfgState,
      write: (line) => emittedLines.push(line),
    });
    assert.strictEqual(logger.debug("scope", "hidden when debugLogs=false"), false);
    cfgState.debugLogs = true;
    assert.strictEqual(logger.debug("scope", "visible debug"), true);
    assert.strictEqual(logger.warnThrottled("k", "warn once", 60000), true);
    assert.strictEqual(logger.warnThrottled("k", "warn duplicate", 60000), false);
    cfgState.quietLogs = true;
    assert.strictEqual(logger.error("suppressed in quiet mode"), false);
    assert.strictEqual(emittedLines.length, 2);

    // Symmetric cross-process wire codec (Map, Uint8Array, bigint, void, XSS chars)
    const nestedMap = new Map([
      ["thumb", new Map([[0, "/tmp/thumb_0.jpg"]])],
      ["bytes", new Uint8Array([1, 2, 255])],
      ["undefVal", undefined],
    ]);
    const rawPayload = {
      msgId: 7299999999999999999n,
      scriptTag: "</script>\u2028\u2029",
      attrs: nestedMap,
      arr: [undefined, "ok"],
    };
    const wireJson = serializeBridgePayload(rawPayload);
    assert.ok(!wireJson.includes("</script>"), "HTML script close must be escaped");
    assert.ok(!wireJson.includes("\u2028"), "JS line separator must be escaped");
    assert.strictEqual(safeJsJson("<tag>"), '"\\u003ctag\\u003e"');

    const revived = reviveBridgePayload(
      JSON.parse(wireJson),
    );
    assert.strictEqual(revived.msgId, "7299999999999999999");
    assert.strictEqual(revived.scriptTag, "</script>\u2028\u2029");
    assert.ok(revived.attrs instanceof Map);
    assert.strictEqual(revived.attrs.get("thumb").get(0), "/tmp/thumb_0.jpg");
    assert.ok(revived.attrs.get("bytes") instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(revived.attrs.get("bytes")), [1, 2, 255]);
    assert.strictEqual(
      reviveBridgePayload({ __rosmontisVoid__: true }),
      undefined
    );

    // Declarative action router
    const router = createActionRouter(
      {
        canonical_act(p, ctx, invokedAction) {
          return { selfTag: this.tag, x: p.x, fmt: ctx.messageFormat, invokedAction };
        },
      },
      { alias_act: "canonical_act" }
    );
    assert.ok(router.HANDLED_ACTIONS.has("canonical_act"));
    assert.ok(router.HANDLED_ACTIONS.has("alias_act"));
    const aliasResult = await router.dispatch.call(
      { tag: "bridge-ctx" },
      "alias_act",
      { x: 9 },
      { messageFormat: "string" }
    );
    assert.deepStrictEqual(aliasResult, {
      selfTag: "bridge-ctx",
      x: 9,
      fmt: "string",
      invokedAction: "alias_act",
    });
    assert.throws(
      () => createActionRouter({ ok() {} }, { bad_alias: "nonexistent" }),
      /missing or invalid handler/
    );
    console.log("  [PASS] Suite 2: Core primitives, lossless wire codec & action router");
  }

  // --------------------------------------------------------------------------
  // Suite 3: NTQQ Anti-Corruption Normalizers (`src/core/nt_normalizer.js`)
  // --------------------------------------------------------------------------
  {
    assert.strictEqual(isPositiveUin("0"), false);
    assert.strictEqual(isPositiveUin(0), false);
    assert.strictEqual(isPositiveUin("-10"), false);
    assert.strictEqual(isPositiveUin("123456"), true);
    assert.strictEqual(pickPositiveUin("0", "", null, "987654321"), 987654321);

    assert.deepStrictEqual(normalizePeer({ chatType: "2", peerUid: " 888999 " }), {
      chatType: 2,
      peerUid: "888999",
      guildId: "",
      peerKey: "2:888999:",
    });

    const grp = normalizeGroupSummary({
      groupCode: "7654321",
      groupName: "Rosmontis Dev",
      memberCount: "42",
      maxMember: 500,
      remarkName: "Core Team",
    });
    assert.strictEqual(grp.groupId, 7654321);
    assert.strictEqual(grp.groupName, "Rosmontis Dev");
    assert.strictEqual(grp.memberCount, 42);
    assert.strictEqual(grp.maxMemberCount, 500);
    assert.strictEqual(grp.groupRemark, "Core Team");

    const buddy = normalizeBuddyProfile({
      uid: "u_top",
      uin: "0",
      simpleInfo: {
        coreInfo: { uid: "u_core", uin: "24681012", nick: "Amiya", remark: "Leader" },
        baseInfo: { sex: 2, age: 16, qid: "amiya_rhodes", longNick: "Working hard" },
      },
    });
    assert.strictEqual(buddy.uid, "u_core");
    assert.strictEqual(buddy.uin, 24681012);
    assert.strictEqual(buddy.nickname, "Amiya");
    assert.strictEqual(buddy.remark, "Leader");
    assert.strictEqual(buddy.sex, "female");
    assert.strictEqual(buddy.age, 16);

    const member = normalizeGroupMember(
      { uid: "u_m1", uin: "13579", nick: "Kal'tsit", role: 3, memberSpecialTitle: "Doctor" },
      "7654321"
    );
    assert.strictEqual(member.group_id, 7654321);
    assert.strictEqual(member.uin, 13579);
    assert.strictEqual(member.role, "admin");
    assert.strictEqual(member.title, "Doctor");

    assert.deepStrictEqual(
      normalizeLoginIdentity({ uin: "0", selfInfo: { uin: "10001", uid: "u_self", nickName: "Bot" } }),
      { uin: "10001", uid: "u_self", nick: "Bot" }
    );
    console.log("  [PASS] Suite 3: NTQQ anti-corruption normalizers & placeholder UIN guards");
  }

  // --------------------------------------------------------------------------
  // Suite 4: Standalone EchoCorrelator & HumanSessionController
  // --------------------------------------------------------------------------
  {
    const correlator = new EchoCorrelator();
    const peer = { chatType: 2, peerUid: "90001" };
    const picA = [{ elementType: 2, picElement: { md5HexStr: "aaaa", fileSize: 2 * 1024 * 1024 } }];
    const picB = [{ elementType: 2, picElement: { md5HexStr: "bbbb", fileSize: 512 } }];
    assert.strictEqual(hasRichMediaElements(picA), true);
    assert.ok(correlator.computeTimeoutMs(picA, { sendEchoTimeoutMs: 3000, richMediaEchoTimeoutMs: 15000 }) >= 17000);

    const wA = correlator.register(peer, picA);
    const wB = correlator.register(peer, picB);
    // Out-of-order echo: B arrives before A
    assert.strictEqual(
      correlator.match({ chatType: 2, peerUid: "90001", msgId: "7002", msgSeq: "22", elements: picB }),
      true
    );
    assert.strictEqual(
      correlator.match({ chatType: 2, peerUid: "90001", msgId: "7001", msgSeq: "21", elements: picA }),
      true
    );
    assert.strictEqual((await wB.wait(100)).msgId, "7002");
    assert.strictEqual((await wA.wait(100)).msgId, "7001");

    // Pending waiter cleanly drained via clear()
    const wPending = correlator.register(peer, picA);
    const pendingPromise = wPending.wait(10000);
    correlator.clear();
    assert.strictEqual(await pendingPromise, null);
    assert.strictEqual(correlator.waiters.size, 0);

    // HumanSessionController causal steps & deduplication
    const ntCalls = [];
    const controller = new HumanSessionController({
      getConfig: () => ({
        humanSimulation: true,
        aioSwitchCooldownMs: 0,
        dedupeWindowMs: 5000,
        humanReadToTypingDelayMs: 0,
        aioIdleExitMs: 0,
        focusIdleBlurMs: 0,
      }),
      invokeNt: async (cmd, payload) => {
        ntCalls.push({ cmd, payload });
        return { result: 0 };
      },
    });

    const firstAct = await controller.simulate({
      chatType: 1,
      peerUid: "u_peer_1",
      markRead: true,
      sendTyping: true,
    });
    assert.strictEqual(firstAct.markRead, true);
    assert.strictEqual(firstAct.sendTyping, true);
    assert.strictEqual(controller.activeAioPeerKey, "1:u_peer_1:");
    assert.strictEqual(controller.windowFocused, true);

    // Immediate second call within dedupeWindowMs skips duplicate read & typing IPCs
    const secondAct = await controller.simulate({
      chatType: 1,
      peerUid: "u_peer_1",
      markRead: true,
      sendTyping: true,
    });
    assert.strictEqual(secondAct.alreadyInAio, true);
    assert.strictEqual(secondAct.markRead, false);
    assert.strictEqual(secondAct.sendTyping, false);

    const leaveRes = await controller.leave({ exitAio: true, blurWindow: true });
    assert.strictEqual(leaveRes.exitedAio, true);
    assert.strictEqual(leaveRes.blurredWindow, true);
    assert.strictEqual(controller.activeAioPeerKey, "");
    assert.strictEqual(controller.windowFocused, false);
    assert.ok(typeof runCausalActivateSteps === "function");
    assert.ok(typeof runCausalLeaveSteps === "function");
    controller.reset();
    console.log("  [PASS] Suite 4: EchoCorrelator & HumanSessionController lifecycle");
  }

  // --------------------------------------------------------------------------
  // Suite 5: Decomposed `src/onebot/*` Submodules, Action Disjointness & Installer LF
  // --------------------------------------------------------------------------
  {
    assert.strictEqual(bridgeOnebotFacade.MessageIdStore, storesMod.MessageIdStore);
    assert.strictEqual(bridgeOnebotFacade.segmentsToCqCode, cqCodecMod.segmentsToCqCode);
    assert.strictEqual(bridgeOnebotFacade.ntMsgToOneBotSegments, segmentConverterMod.ntMsgToOneBotSegments);
    assert.strictEqual(bridgeOnebotFacade.formatNtMsgToOneBotEvent, eventFormatterMod.formatNtMsgToOneBotEvent);

    const store = new storesMod.MessageIdStore(100);
    const shortId = store.register("7300000000000000123", { chatType: 2, peerUid: "555666" }, "88");
    const byShort = store.resolve(shortId);
    const byRawNt = store.resolve("7300000000000000123");
    assert.ok(byShort && byRawNt);
    assert.strictEqual(byShort.msgId, "7300000000000000123");
    assert.strictEqual(byRawNt.entry.oneBotId, shortId);

    // Verify 4 action routers have zero overlapping action names and >= 130 total routes
    const seenActions = new Set();
    for (const mod of [messageActions, contactActions, groupActions, fileMediaActions]) {
      assert.ok(mod.HANDLED_ACTIONS instanceof Set && mod.HANDLED_ACTIONS.size > 0);
      assert.strictEqual(typeof mod.dispatch, "function");
      for (const act of mod.HANDLED_ACTIONS) {
        assert.strictEqual(seenActions.has(act), false, `Overlapping action route: ${act}`);
        seenActions.add(act);
      }
    }
    assert.ok(seenActions.size >= 130, `Expected >= 130 total OneBot routes, got ${seenActions.size}`);

    // Shell scripts mounted into Linux containers must retain LF line endings
    for (const relScript of ["scripts/install_bridge.sh", "scripts/entrypoint.sh"]) {
      const scriptBytes = fs.readFileSync(path.resolve(__dirname, "..", relScript), "utf8");
      assert.strictEqual(
        scriptBytes.includes("\r\n"),
        false,
        `${relScript} must use LF line endings for Linux container execution`
      );
    }
    console.log(
      `  [PASS] Suite 5: Decomposed onebot/* facade, ${seenActions.size} disjoint action routes & LF shell scripts`
    );
  }

  console.log("=== All 5 Core Architecture Module Suites Passed ===");
}

runTests().catch((err) => {
  console.error("Core module test suite failed:", err);
  process.exit(1);
});

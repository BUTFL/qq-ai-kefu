"use strict";

const assert = require("assert");
const crypto = require("crypto");
const EventEmitter = require("events");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

// Silence throttled degrade/blocked-replay warnings from bridge_main during tests.
process.env.ROSMONTIS_QUIET = process.env.ROSMONTIS_QUIET || "1";

const onebot = require("../src/bridge_onebot.js");
const rendererMod = require("../src/bridge_renderer.js");
const mainMod = require("../src/bridge_main.js");

async function runTests() {
  let passed = 0;
  function check(name, fn) {
    return Promise.resolve()
      .then(fn)
      .then(() => {
        passed += 1;
        console.log(`  [PASS] ${name}`);
      });
  }

  console.log("=== 1. Testing package_patch.json & app_launcher_index.js ===");
  await check("package_patch.json is valid JSON and points to ./app_launcher/index.js", () => {
    const pkgPatch = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "src", "package_patch.json"), "utf8")
    );
    assert.strictEqual(pkgPatch.main, "./app_launcher/index.js");
    assert.strictEqual(
      pkgPatch.original_main,
      "./application.asar/app_launcher/index.js"
    );
  });

  await check("app_launcher_index.js safely boots bridge_main and delegates to major.node", () => {
    process.env.ROSMONTIS_TEST_MODE = "1";
    let majorLoaded = null;
    const launcher = require("../src/app_launcher_index.js");
    assert.strictEqual(typeof launcher.bootBridgeMain, "function");
    assert.strictEqual(typeof launcher.loadOfficialInternalIndex, "function");
    const ret = launcher.loadOfficialInternalIndex(module, {
      load(target, mod) {
        majorLoaded = { target, hasMod: Boolean(mod) };
        return "major_ok";
      },
    });
    assert.strictEqual(ret, "major_ok");
    assert.deepStrictEqual(majorLoaded, { target: "internal_index", hasMod: true });
  });

  console.log("=== 2. Testing MessageIdStore & UinUidStore ===");
  await check("MessageIdStore assigns deterministic positive 31-bit shortId and supports reverse lookup", () => {
    const store = new onebot.MessageIdStore(50);
    const id1 = store.register({
      msgId: "7428192837192837123",
      chatType: 2,
      peerUid: "987654321",
      msgSeq: "10042",
      senderUid: "u_abc123",
      senderUin: "12345678",
    });
    assert.ok(Number.isInteger(id1) && id1 > 0 && id1 <= 0x7fffffff);
    const id1Again = store.register({
      msgId: "7428192837192837123",
      chatType: 2,
      peerUid: "987654321",
      msgSeq: "10042",
    });
    assert.strictEqual(id1, id1Again);

    const recByShort = store.getByShortId(id1);
    assert.strictEqual(recByShort.msgId, "7428192837192837123");
    assert.strictEqual(recByShort.chatType, 2);
    assert.strictEqual(recByShort.peerUid, "987654321");
    assert.strictEqual(recByShort.msgSeq, "10042");

    const recByMsgId = store.getByMsgId("7428192837192837123");
    assert.strictEqual(recByMsgId.shortId, id1);

    const recByPeerSeq = store.getByPeerSeq(2, "987654321", "10042");
    assert.strictEqual(recByPeerSeq.shortId, id1);
  });

  await check("MessageIdStore enforces LRU maxEntries bound", () => {
    const store = new onebot.MessageIdStore(10);
    const firstId = store.register({ msgId: "1000", chatType: 1, peerUid: "u_0", msgSeq: "1" });
    for (let i = 1; i < 15; i++) {
      store.register({ msgId: String(1000 + i), chatType: 1, peerUid: `u_${i}`, msgSeq: String(i) });
    }
    assert.strictEqual(store.size, 10);
    assert.strictEqual(store.getByShortId(firstId), null);
    assert.notStrictEqual(store.getByMsgId("1014"), null);
  });

  await check("UinUidStore caches and resolves UIN <-> UID bi-directionally", async () => {
    const uinUid = new onebot.UinUidStore();
    uinUid.record("100010001", "u_rosmontis_self_uid", { nick: "Rosmontis" });
    assert.strictEqual(uinUid.getUid("100010001"), "u_rosmontis_self_uid");
    assert.strictEqual(uinUid.getUin("u_rosmontis_self_uid"), "100010001");

    const resolvedUid = await uinUid.resolveUid("246813579", async (cmd, payload) => {
      assert.strictEqual(cmd, "nodeIKernelUixConvertService/getUid");
      assert.deepStrictEqual(payload, { uins: ["246813579"] });
      return { uidInfo: { "246813579": "u_remote_2468" } };
    });
    assert.strictEqual(resolvedUid, "u_remote_2468");
    assert.strictEqual(uinUid.getUin("u_remote_2468"), "246813579");

    const resolvedUin = await uinUid.resolveUin("u_remote_9999", async (cmd, payload) => {
      assert.strictEqual(cmd, "nodeIKernelUixConvertService/getUin");
      assert.deepStrictEqual(payload, { uids: ["u_remote_9999"] });
      return { uinInfo: { u_remote_9999: "99998888" } };
    });
    assert.strictEqual(resolvedUin, "99998888");
  });

  console.log("=== 3. Testing OneBot Segments <-> NTQQ Elements & Events ===");
  await check("ntMsgToOneBotSegments converts text, @all, @member, reply, face, image, file, record, video, mface, json, forward", () => {
    const msgIdStore = new onebot.MessageIdStore();
    const uinUidStore = new onebot.UinUidStore();
    uinUidStore.record("111222333", "u_target_111");

    const repliedShortId = msgIdStore.register({
      msgId: "7000000000000000001",
      chatType: 2,
      peerUid: "888888",
      msgSeq: "55",
    });

    const ntMsg = {
      msgId: "7000000000000000002",
      msgSeq: "56",
      msgTime: "1730000000",
      chatType: 2,
      peerUid: "888888",
      peerUin: "888888",
      senderUid: "u_sender_1",
      senderUin: "123456789",
      sendMemberName: "博士卡片",
      sendNickName: "博士昵称",
      elements: [
        {
          elementType: 7,
          replyElement: {
            replayMsgId: "7000000000000000001",
            replayMsgSeq: "55",
            senderUin: "111222333",
          },
        },
        {
          elementType: 1,
          textElement: {
            content: "@全体成员",
            atType: 1,
          },
        },
        {
          elementType: 1,
          textElement: {
            content: "@某人",
            atType: 2,
            atNtUid: "u_target_111",
          },
        },
        {
          elementType: 1,
          textElement: {
            content: " 你好 [a,b]&c ",
            atType: 0,
          },
        },
        {
          elementType: 6,
          faceElement: {
            faceIndex: 178,
            faceText: "/斜眼笑",
          },
        },
        {
          elementType: 2,
          picElement: {
            fileName: "cat.png",
            sourcePath: "/tmp/cat.png",
            originImageUrl: "/download?rkey=abc",
            md5HexStr: "0123456789abcdef0123456789abcdef",
            fileSize: "2048",
            picSubType: 0,
          },
        },
        {
          elementType: 4,
          pttElement: {
            fileName: "voice.amr",
            filePath: "/tmp/voice.amr",
          },
        },
        {
          elementType: 5,
          videoElement: {
            fileName: "clip.mp4",
            filePath: "/tmp/clip.mp4",
          },
        },
        {
          elementType: 3,
          fileElement: {
            fileName: "report.pdf",
            filePath: "/tmp/report.pdf",
            fileSize: "4096",
            fileUuid: "uuid-pdf",
          },
        },
        {
          elementType: 10,
          arkElement: {
            bytesData: '{"app":"com.tencent.miniapp"}',
          },
        },
        {
          elementType: 11,
          marketFaceElement: {
            emojiPackageId: 100,
            emojiId: "mface_01",
            key: "key_01",
            faceName: "[大哭]",
          },
        },
        {
          elementType: 16,
          multiForwardMsgElement: {
            resId: "res_forward_123",
            xmlContent: "<msg resid=\"res_forward_123\"/>",
          },
        },
      ],
    };

    const { segments, raw_message } = onebot.ntMsgToOneBotSegments(ntMsg, {
      msgIdStore,
      uinUidStore,
    });

    assert.strictEqual(segments.length, 12);
    assert.deepStrictEqual(segments[0], {
      type: "reply",
      data: { id: String(repliedShortId) },
    });
    assert.strictEqual(segments[1].type, "at");
    assert.strictEqual(segments[1].data.qq, "all");
    assert.strictEqual(segments[2].type, "at");
    assert.strictEqual(segments[2].data.qq, "111222333");
    assert.deepStrictEqual(segments[3], {
      type: "text",
      data: { text: " 你好 [a,b]&c " },
    });
    assert.strictEqual(segments[4].type, "face");
    assert.strictEqual(segments[4].data.id, "178");
    assert.strictEqual(segments[5].type, "image");
    assert.strictEqual(segments[5].data.url, "https://multimedia.nt.qq.com.cn/download?rkey=abc");
    assert.strictEqual(segments[6].type, "record");
    assert.strictEqual(segments[7].type, "video");
    assert.strictEqual(segments[8].type, "file");
    assert.strictEqual(segments[9].type, "json");
    assert.strictEqual(segments[10].type, "mface");
    assert.strictEqual(segments[11].type, "forward");
    assert.strictEqual(segments[11].data.id, "res_forward_123");
    assert.ok(raw_message.includes(`[CQ:reply,id=${repliedShortId}]`));
    assert.ok(raw_message.includes("&#91;a,b&#93;&amp;c"));

    const obEvent = onebot.formatNtMsgToOneBotEvent(ntMsg, {
      selfId: 100010001,
      selfUid: "u_self",
      msgIdStore,
      uinUidStore,
    });
    assert.strictEqual(obEvent.post_type, "message");
    assert.strictEqual(obEvent.message_type, "group");
    assert.strictEqual(obEvent.sub_type, "normal");
    assert.strictEqual(obEvent.group_id, 888888);
    assert.strictEqual(obEvent.user_id, 123456789);
    assert.strictEqual(obEvent.sender.card, "博士卡片");
  });

  await check("oneBotSegmentsToNtElements converts CQ strings and segment arrays including base64 PNG image", async () => {
    const msgIdStore = new onebot.MessageIdStore();
    const uinUidStore = new onebot.UinUidStore();
    uinUidStore.record("555666777", "u_member_555");
    const replyShort = msgIdStore.register({
      msgId: "7111111111111111111",
      chatType: 2,
      peerUid: "999999",
      msgSeq: "88",
      senderUid: "u_member_555",
      senderUin: "555666777",
    });

    // 1x1 valid PNG in base64
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const { elements, cleanupCallbacks, pokeTargets } =
      await onebot.oneBotSegmentsToNtElements(
        [
          { type: "reply", data: { id: String(replyShort) } },
          { type: "at", data: { qq: "555666777", name: "测试员" } },
          { type: "at", data: { qq: "all" } },
          { type: "text", data: { text: " 收到！" } },
          { type: "face", data: { id: "14" } },
          { type: "image", data: { file: `base64://${pngBase64}`, summary: "[图片]" } },
          { type: "json", data: { data: '{"app":"test"}' } },
          { type: "poke", data: { qq: "555666777" } },
        ],
        {
          chatType: 2,
          peerUid: "999999",
          msgIdStore,
          uinUidStore,
        }
      );

    try {
      assert.strictEqual(elements.length, 7);
      assert.strictEqual(elements[0].elementType, 7);
      assert.strictEqual(elements[0].replyElement.replayMsgId, "7111111111111111111");
      assert.strictEqual(elements[1].elementType, 1);
      assert.strictEqual(elements[1].textElement.atType, 2);
      assert.strictEqual(elements[1].textElement.atNtUid, "u_member_555");
      assert.strictEqual(elements[2].elementType, 1);
      assert.strictEqual(elements[2].textElement.atType, 1);
      assert.strictEqual(elements[3].elementType, 1);
      assert.strictEqual(elements[3].textElement.content, " 收到！");
      assert.strictEqual(elements[4].elementType, 6);
      assert.strictEqual(elements[4].faceElement.faceIndex, 14);
      assert.strictEqual(elements[5].elementType, 2);
      assert.strictEqual(elements[5].picElement.picWidth, 1);
      assert.strictEqual(elements[5].picElement.picHeight, 1);
      assert.strictEqual(elements[6].elementType, 10);
      assert.strictEqual(pokeTargets.length, 1);
    } finally {
      for (const fn of cleanupCallbacks) fn();
    }
  });

  await check("GrayTip recall & poke & group upload notice events format accurately", () => {
    const msgIdStore = new onebot.MessageIdStore();
    const uinUidStore = new onebot.UinUidStore();
    uinUidStore.record("10001", "u_10001");
    uinUidStore.record("10002", "u_10002");

    const recalledShortId = msgIdStore.register({
      msgId: "7222222222222222222",
      chatType: 2,
      peerUid: "777777",
      msgSeq: "99",
    });

    const recallNtMsg = {
      msgId: "7222222222222222222",
      msgSeq: "99",
      msgTime: "1730000100",
      chatType: 2,
      peerUid: "777777",
      senderUid: "u_10001",
      senderUin: "10001",
      elements: [
        {
          elementType: 8,
          grayTipElement: {
            subElementType: 1,
            revokeElement: {
              operatorUid: "u_10002",
              origMsgSenderUid: "u_10001",
            },
          },
        },
      ],
    };
    const recallEv = onebot.formatNtMsgToOneBotEvent(recallNtMsg, {
      selfId: 100010001,
      msgIdStore,
      uinUidStore,
    });
    assert.strictEqual(recallEv.post_type, "notice");
    assert.strictEqual(recallEv.notice_type, "group_recall");
    assert.strictEqual(recallEv.group_id, 777777);
    assert.strictEqual(recallEv.user_id, 10001);
    assert.strictEqual(recallEv.operator_id, 10002);
    assert.strictEqual(recallEv.message_id, recalledShortId);

    const pokeNtMsg = {
      msgId: "7222222222222222223",
      msgSeq: "100",
      msgTime: "1730000200",
      chatType: 2,
      peerUid: "777777",
      senderUid: "u_10001",
      senderUin: "10001",
      elements: [
        {
          elementType: 8,
          grayTipElement: {
            subElementType: 17,
            jsonGrayTipElement: {
              busiId: "1061",
              xmlToJsonParam: {
                templParam: new Map([
                  ["uin_str1", "10001"],
                  ["uin_str2", "100010001"],
                  ["action_str", "戳了戳"],
                  ["suffix_str", "的小脑袋"],
                ]),
              },
            },
          },
        },
      ],
    };
    const pokeEv = onebot.formatNtMsgToOneBotEvent(pokeNtMsg, {
      selfId: 100010001,
      msgIdStore,
      uinUidStore,
    });
    assert.strictEqual(pokeEv.post_type, "notice");
    assert.strictEqual(pokeEv.notice_type, "notify");
    assert.strictEqual(pokeEv.sub_type, "poke");
    assert.strictEqual(pokeEv.user_id, 10001);
    assert.strictEqual(pokeEv.target_id, 100010001);
  });

  console.log("=== 4. Testing bridge_renderer.js in Simulated Window Environment ===");
  await check("bridge_renderer.js sends RM_IPCFROM_RENDERER frames, handles promiseStatue, deduplicates session state, and forwards RM_IPCFROM_MAIN", async () => {
    const sentIpcFrames = [];
    const forwardedEvents = [];
    const mainListeners = new Map();

    const fakeIpcRenderer = {
      send(channel, metaOrPayload, data) {
        if (channel === "__ROSMONTIS_BRIDGE_EVENT__") {
          forwardedEvents.push({ channel, data: metaOrPayload });
          return;
        }
        sentIpcFrames.push({ channel, meta: metaOrPayload, data });
        if (metaOrPayload && metaOrPayload.callbackId) {
          const onMain = mainListeners.get(`RM_IPCFROM_MAIN${metaOrPayload.peerId || 1}`);
          if (typeof onMain === "function") {
            setImmediate(() => {
              if (data && data.cmdName === "nodeIKernelTest/failCmd") {
                onMain(
                  {},
                  {
                    callbackId: metaOrPayload.callbackId,
                    promiseStatue: "err",
                    type: "response",
                    eventName: "ntApi",
                    peerId: metaOrPayload.peerId || 1,
                  },
                  "Simulated kernel failure"
                );
              } else {
                onMain(
                  {},
                  {
                    callbackId: metaOrPayload.callbackId,
                    promiseStatue: "full",
                    type: "response",
                    eventName: "ntApi",
                    peerId: metaOrPayload.peerId || 1,
                  },
                  { result: 0, errMsg: "", echoCmd: data?.cmdName }
                );
              }
            });
          }
        }
      },
      on(channel, listener) {
        mainListeners.set(channel, listener);
      },
    };

    const fakeWin = {
      webContentId: 1,
      location: { search: "?webcontentsid=1&tid=" },
      ipcRenderer: fakeIpcRenderer,
      document: {
        querySelector(sel) {
          if (sel === "#app") {
            return {
              __vue_app__: {
                config: {
                  globalProperties: {
                    $route: { path: "/main/message" },
                    $pinia: { _s: new Map([["aio", {}], ["chat", {}]]) },
                  },
                },
              },
            };
          }
          return null;
        },
      },
    };

    const rBridge = rendererMod.installRendererBridge(fakeWin, {
      forceReinstall: true,
      autoRegisterListeners: true,
    });
    assert.strictEqual(rBridge.windowId, 1);

    // Confirm ntApi-register frames were sent on init
    const registerFrames = sentIpcFrames.filter((f) => f.meta?.eventName === "ntApi-register");
    assert.ok(registerFrames.length >= 5, "Expected ntApi-register frames on init");
    sentIpcFrames.length = 0;

    const apiRes = await rBridge.invokeNtApi("nodeIKernelMsgService/sendMsg", [
      { msgId: "0", peer: { chatType: 1, peerUid: "u_test" } },
      null,
    ]);
    assert.strictEqual(apiRes.result, 0);
    assert.strictEqual(apiRes.echoCmd, "nodeIKernelMsgService/sendMsg");
    assert.strictEqual(sentIpcFrames[0].channel, "RM_IPCFROM_RENDERER1");
    assert.strictEqual(sentIpcFrames[0].meta.eventName, "ntApi");
    assert.strictEqual(sentIpcFrames[0].meta.peerId, 1);
    assert.strictEqual(sentIpcFrames[0].data.cmdName, "nodeIKernelMsgService/sendMsg");
    assert.strictEqual(sentIpcFrames[0].data.cmdType, "invoke");
    assert.ok(Array.isArray(sentIpcFrames[0].data.payload));

    // Verify promiseStatue === "err" rejects properly
    await assert.rejects(
      () => rBridge.invokeNtApi("nodeIKernelTest/failCmd", {}),
      /Simulated kernel failure/
    );

    // 1st human session flow for u_friend_1
    const simRes1 = await rBridge.simulateHumanSessionFlow({
      chatType: 1,
      peerUid: "u_friend_1",
      markRead: true,
      sendTyping: true,
    });
    assert.strictEqual(simRes1.vueState.mounted, true);
    assert.strictEqual(simRes1.alreadyInAio, false);
    assert.strictEqual(simRes1.enterOrExitAio, true);
    assert.strictEqual(simRes1.addActiveChatByUid, true);
    assert.strictEqual(simRes1.setFocusOnBase, true);
    assert.strictEqual(simRes1.markRead, true);
    assert.strictEqual(simRes1.sendTyping, true);

    // 2nd human session flow immediately for same u_friend_1 -> anti-burst deduplication
    const simRes2 = await rBridge.simulateHumanSessionFlow({
      chatType: 1,
      peerUid: "u_friend_1",
      markRead: true,
      sendTyping: true,
    });
    assert.strictEqual(simRes2.alreadyInAio, true);
    assert.strictEqual(simRes2.markRead, false);
    assert.strictEqual(simRes2.markReadSkipped, true);
    assert.strictEqual(simRes2.sendTyping, false);
    assert.strictEqual(simRes2.sendTypingSkipped, true);

    // 3rd human session flow switching to u_friend_2 -> exits u_friend_1 AIO first
    const simRes3 = await rBridge.simulateHumanSessionFlow({
      chatType: 1,
      peerUid: "u_friend_2",
      markRead: true,
      sendTyping: false,
    });
    assert.strictEqual(simRes3.exitedPreviousAio, true);
    assert.strictEqual(simRes3.enterOrExitAio, true);
    assert.strictEqual(simRes3.markRead, true);

    // Simulate incoming RM_IPCFROM_MAIN1 event (and verify O3 telemetry is untouched)
    const onMainChannel = mainListeners.get("RM_IPCFROM_MAIN1");
    assert.strictEqual(typeof onMainChannel, "function");
    onMainChannel(
      {},
      { eventName: "ntApi", peerId: 1 },
      { cmdName: "nodeIKernelMsgListener/onRecvMsg", cmdType: "event", payload: [{ msgId: "9001" }] }
    );
    assert.strictEqual(forwardedEvents.length, 1);
    assert.strictEqual(forwardedEvents[0].channel, "__ROSMONTIS_BRIDGE_EVENT__");
    assert.strictEqual(forwardedEvents[0].data.cmdName, "nodeIKernelMsgListener/onRecvMsg");
  });

  console.log("=== 5. Testing bridge_main.js End-to-End (DI Hooks + 65+ OneBot Actions + HTTP & WS) ===");
  await check("bridge_main.js survives globalIPCMainMap ntApi overwrite, executes 65+ actions with real signatures, and serves HTTP/WS/ReverseWS", async () => {
    const controller = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      selfNickname: "Rosmontis",
      config: {
        selfUin: "100010001",
        selfNickname: "Rosmontis",
        httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
        wsServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
        allowExternalHttp: false,
        allowPtloginJump: false,
        enableWebCredentialApi: true,
      },
    });

    // Install Map.prototype.set hook and simulate 908.background.jsc DI registration
    controller.installMapPrototypeHook();
    const diMap = new Map();

    const calledNtApis = [];
    const fakeNtApi = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== "string" || !prop.includes("/")) return undefined;
          // Real NTQQ 3.2.32 ntApi.invoke[cmd] takes (payload, ipcEvent) directly!
          return async (payload, ipcEvent) => {
            assert.ok(
              !Array.isArray(payload),
              `Expected payload for ${prop} to be an object, not an array`
            );
            calledNtApis.push({ cmd: prop, payload, ipcEvent });
            if (prop === "nodeIKernelMsgService/sendMsg") {
              return { result: 0, errMsg: "", msgId: "7500000000000000100" };
            }
            if (prop === "nodeIKernelUixConvertService/getUid") {
              const uidInfo = {};
              for (const u of payload.uins || []) uidInfo[u] = `u_uid_${u}`;
              return { uidInfo };
            }
            if (prop === "nodeIKernelUixConvertService/getUin") {
              const uinInfo = {};
              for (const uid of payload.uids || []) {
                uinInfo[uid] = uid.replace(/^u_uid_/, "") || "123456";
              }
              return { uinInfo };
            }
            if (prop === "nodeIKernelBuddyService/getBuddyList") {
              return {
                data: [
                  {
                    categoryId: 0,
                    categroyName: "我的好友",
                    buddyList: [
                      { uin: "100020002", uid: "u_uid_100020002", nick: "Doctor", remark: "博士" },
                    ],
                  },
                ],
              };
            }
            if (prop === "nodeIKernelGroupService/getGroupList") {
              return {
                groupList: [
                  { groupCode: "654321", groupName: "罗德岛作战群", memberCount: 42, maxMember: 500 },
                ],
              };
            }
            if (
              prop === "nodeIKernelGroupService/getMemberInfo" ||
              prop === "nodeIKernelGroupService/getNextMemberList"
            ) {
              return {
                result: {
                  infos: new Map([
                    [
                      "u_uid_100020002",
                      {
                        uid: "u_uid_100020002",
                        uin: "100020002",
                        nick: "Doctor",
                        cardName: "博士",
                        role: 4,
                      },
                    ],
                  ]),
                },
              };
            }
            if (prop === "nodeIKernelGroupService/createMemberListScene") {
              return { sceneId: "scene_1" };
            }
            if (prop === "nodeIKernelMsgService/translatePtt2Text") {
              return { result: 0, text: "博士你好，这是语音转文字结果" };
            }
            if (prop === "nodeIKernelMsgService/getMsgEmojiLikesList") {
              return {
                result: 0,
                emojiLikesList: [{ emojiId: "128077", emojiType: 2, likesCnt: 1, isClicked: true }],
              };
            }
            if (prop === "nodeIKernelTicketService/forceFetchClientKey") {
              return { result: 0, clientKey: "ck_test_12345" };
            }
            if (prop === "nodeIKernelTipOffService/getPskey") {
              return {
                domainPskeyMap: new Map([
                  ["qun.qq.com", "pskey_qun_123"],
                  ["qzone.qq.com", "pskey_qzone_123"],
                ]),
              };
            }
            if (prop === "nodeIKernelUnitedConfigService/loadUnitedConfig") {
              return { configData: { content: "rkey_private=1&rkey_group=2" } };
            }
            if (prop === "nodeIKernelRichMediaService/downloadFileForModelId") {
              return { url: "https://multimedia.nt.qq.com.cn/group_file_test.pdf" };
            }
            if (prop === "nodeIKernelRichMediaService/downloadFileForFileUuid") {
              return { url: "https://multimedia.nt.qq.com.cn/private_file_test.pdf" };
            }
            return { result: 0, errMsg: "" };
          };
        },
      }
    );

    // 1st Map.set("ntApi", fakeNtApi) in Inversify
    diMap.set("ntApi", fakeNtApi);
    // 2nd Map.set("ntApi", { emit, invoke }) in globalIPCMainMap (real NTQQ 3.2.32 behavior)
    diMap.set("ntApi", { emit: () => {}, invoke: fakeNtApi });

    assert.strictEqual(controller.capturedServices.ntApi, fakeNtApi);

    const msgEmitter = new EventEmitter();
    const groupEmitter = new EventEmitter();
    const buddyEmitter = new EventEmitter();
    const loginEmitter = new EventEmitter();
    const listenerMap = new Map([
      ["nodeIKernelMsgListener", msgEmitter],
      ["nodeIKernelGroupListener", groupEmitter],
    ]);

    const fakeNtStore = {
      listenerEventEmitterMap: listenerMap,
      setNewListenEmitter(name, emitter) {
        this.listenerEventEmitterMap.set(name, emitter);
      },
    };

    function FakeSessionManager() {}
    FakeSessionManager.prototype.createNt = function () {};
    FakeSessionManager.prototype.ntStore = fakeNtStore;
    const fakeSessionMgrInstance = new FakeSessionManager();
    Object.defineProperty(fakeSessionMgrInstance, "ntStore", {
      value: fakeNtStore,
      enumerable: true,
    });

    diMap.set(Symbol("ntSessionManager"), [{ cache: fakeSessionMgrInstance }]);
    // Dynamically register buddy & login listeners via setNewListenEmitter (real post-login flow)
    fakeNtStore.setNewListenEmitter("nodeIKernelBuddyListener", buddyEmitter);
    fakeNtStore.setNewListenEmitter("nodeIKernelLoginListener", loginEmitter);

    assert.strictEqual(controller.capturedServices.ntSessionManager, fakeSessionMgrInstance);

    // Verify group member role cache is NOT polluted by ordinary chat messages (rememberFromNtMsg)
    controller.uinUidStore.rememberFromNtMsg({
      chatType: 2,
      peerUid: "654321",
      senderUin: "100020002",
      senderUid: "u_uid_100020002",
      sendNickName: "Doctor",
      sendMemberName: "博士",
    });
    const memberInfoResp = await controller.handleOneBotAction("get_group_member_info", {
      group_id: 654321,
      user_id: 100020002,
    });
    assert.strictEqual(memberInfoResp.status, "ok");
    assert.strictEqual(
      memberInfoResp.data.role,
      "owner",
      "Expected get_group_member_info to fetch real role ('owner') instead of polluted 'member'"
    );

    // Verify send_group_forward_msg stages custom nodes to selfUid (srcContact) and forwards to group (dstContact)
    calledNtApis.length = 0;
    const fwdResp = await controller.handleOneBotAction("send_group_forward_msg", {
      group_id: 654321,
      messages: [
        {
          type: "node",
          data: {
            name: "Rosmontis",
            uin: "100010001",
            content: [{ type: "text", data: { text: "合并转发分片1" } }],
          },
        },
      ],
    });
    assert.strictEqual(fwdResp.status, "ok");
    const stagedSend = calledNtApis.find((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
    const multiFwd = calledNtApis.find(
      (c) => c.cmd === "nodeIKernelMsgService/multiForwardMsgWithComment"
    );
    assert.ok(stagedSend, "Expected staging sendMsg call");
    assert.strictEqual(stagedSend.payload.peer.chatType, 1);
    assert.strictEqual(stagedSend.payload.peer.peerUid, "u_rosmontis_self");
    assert.ok(multiFwd, "Expected multiForwardMsgWithComment call");
    assert.strictEqual(multiFwd.payload.srcContact.peerUid, "u_rosmontis_self");
    assert.strictEqual(multiFwd.payload.dstContact.peerUid, "654321");

    // Verify all core OneBot actions execute cleanly
    const actionsToVerify = [
      ["get_login_info", {}],
      ["get_status", {}],
      ["get_version_info", {}],
      ["send_private_msg", { user_id: 100020002, message: "你好博士 [CQ:face,id=14]" }],
      ["send_group_msg", { group_id: 654321, message: [{ type: "text", data: { text: "群消息测试" } }] }],
      ["send_msg", { message_type: "group", group_id: 654321, message: "通用发送" }],
      ["get_friend_list", {}],
      ["get_stranger_info", { user_id: 100020002 }],
      ["get_group_list", {}],
      ["get_group_info", { group_id: 654321 }],
      ["get_group_member_list", { group_id: 654321 }],
      ["get_group_member_info", { group_id: 654321, user_id: 100020002 }],
      ["mark_msg_as_read", { group_id: 654321 }],
      ["mark_private_msg_as_read", { user_id: 100020002 }],
      ["mark_group_msg_as_read", { group_id: 654321 }],
      ["mark_all_as_read", {}],
      ["set_input_status", { user_id: 100020002, event_type: 1 }],
      ["send_like", { user_id: 100020002, times: 5 }],
      ["group_poke", { group_id: 654321, user_id: 100020002 }],
      ["friend_poke", { user_id: 100020002 }],
      ["send_poke", { group_id: 654321, user_id: 100020002 }],
      ["set_group_kick", { group_id: 654321, user_id: 100020002 }],
      ["set_group_ban", { group_id: 654321, user_id: 100020002, duration: 60 }],
      ["set_group_whole_ban", { group_id: 654321, enable: true }],
      ["set_group_admin", { group_id: 654321, user_id: 100020002, enable: true }],
      ["set_group_card", { group_id: 654321, user_id: 100020002, card: "阿米娅" }],
      ["set_group_name", { group_id: 654321, group_name: "新罗德岛" }],
      ["set_group_special_title", { group_id: 654321, user_id: 100020002, special_title: "领袖" }],
      ["set_group_leave", { group_id: 654321 }],
      ["set_qq_profile", { nickname: "Rosmontis", personal_note: "常驻干员" }],
      ["set_self_longnick", { longNick: "常驻干员" }],
      ["set_online_status", { status: 10, ext_status: 0 }],
      ["set_diy_online_status", { face_id: 1, wording: "执勤中" }],
      ["get_cookies", { domain: "qun.qq.com" }],
      ["get_csrf_token", {}],
      ["get_credentials", { domain: "qun.qq.com" }],
      ["get_clientkey", {}],
      ["get_rkey", {}],
      ["can_send_image", {}],
      ["can_send_record", {}],
      ["clean_cache", {}],
      [
        "ocr_image",
        {
          image:
            "base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
      ["translate_en2zh", { words: ["hello"] }],
      ["_get_group_notice", { group_id: 654321 }],
      ["get_essence_msg_list", { group_id: 654321 }],
      ["get_group_honor_info", { group_id: 654321, type: "all" }],
      ["get_group_system_msg", {}],
      ["get_group_ignore_add_request", {}],
      ["get_doubt_friends_add_request", {}],
      ["get_friend_With_category", {}],
      ["get_robot_uin_range", {}],
      ["get_group_root_files", { group_id: 654321 }],
      ["get_group_files_by_folder", { group_id: 654321, folder_id: "/" }],
      ["get_group_file_system_info", { group_id: 654321 }],
      ["create_group_file_folder", { group_id: 654321, name: "作战记录" }],
      ["delete_group_folder", { group_id: 654321, folder_id: "f1" }],
      ["delete_group_file", { group_id: 654321, file_id: "file1" }],
      ["get_group_file_url", { group_id: 654321, file_id: "file1" }],
      ["get_private_file_url", { user_id: 100020002, file_id: "file_priv_1" }],
      ["get_group_msg_history", { group_id: 654321, count: 10 }],
      ["get_friend_msg_history", { user_id: 100020002, count: 10 }],
    ];

    let sentMessageId = null;
    for (const [act, params] of actionsToVerify) {
      const resp = await controller.handleOneBotAction(act, params, `echo_${act}`);
      assert.strictEqual(resp.status, "ok", `Action ${act} failed: ${resp.message}`);
      assert.strictEqual(resp.retcode, 0);
      assert.strictEqual(resp.echo, `echo_${act}`);
      if (act === "send_group_msg") {
        sentMessageId = resp.data.message_id;
        assert.ok(Number.isInteger(sentMessageId) && sentMessageId > 0);
      }
      if (act === "get_group_file_url") {
        assert.strictEqual(
          resp.data.url,
          "https://multimedia.nt.qq.com.cn/group_file_test.pdf"
        );
      }
      if (act === "get_private_file_url") {
        assert.strictEqual(
          resp.data.url,
          "https://multimedia.nt.qq.com.cn/private_file_test.pdf"
        );
      }
    }

    // Verify get_cookies fails cleanly with status === "failed" & retcode === 1403 when enableWebCredentialApi is omitted or false
    for (const cfgOverride of [{}, { enableWebCredentialApi: false }]) {
      const gatedBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_rosmontis_self",
        ntApi: fakeNtApi,
        config: {
          selfUin: "100010001",
          httpServers: [],
          wsServers: [],
          wsClients: [],
          ...cfgOverride,
        },
      });
      const gatedResp = await gatedBridge.handleOneBotAction("get_cookies", { domain: "qun.qq.com" });
      assert.strictEqual(gatedResp.status, "failed");
      assert.strictEqual(gatedResp.retcode, 1403);
    }

    // Confirm send_poke invoked real sendNudge
    assert.ok(
      calledNtApis.some((c) => c.cmd === "nodeIKernelMsgService/sendNudge"),
      "Expected send_poke / group_poke to invoke nodeIKernelMsgService/sendNudge"
    );
    // Confirm set_group_special_title invoked real setIdentityTitleInfo
    assert.ok(
      calledNtApis.some((c) => c.cmd === "nodeIKernelGroupService/setIdentityTitleInfo"),
      "Expected set_group_special_title to invoke nodeIKernelGroupService/setIdentityTitleInfo"
    );
    // Confirm get_essence_msg_list invoked real getGroupLatestEssenceList
    assert.ok(
      calledNtApis.some((c) => c.cmd === "nodeIKernelGroupService/getGroupLatestEssenceList"),
      "Expected get_essence_msg_list to invoke nodeIKernelGroupService/getGroupLatestEssenceList"
    );

    // Verify message-dependent actions using the registered message_id
    const msgDepActions = [
      ["get_msg", { message_id: sentMessageId }],
      ["set_msg_emoji_like", { message_id: sentMessageId, emoji_id: "128077", set: true }],
      ["fetch_emoji_like", { message_id: sentMessageId, emojiId: "128077", emojiType: "2" }],
      ["voice_msg_to_text", { message_id: sentMessageId }],
      ["fetch_ptt_text", { message_id: sentMessageId }],
      ["set_essence_msg", { message_id: sentMessageId }],
      ["delete_essence_msg", { message_id: sentMessageId }],
      ["delete_msg", { message_id: sentMessageId }],
    ];
    for (const [act, params] of msgDepActions) {
      const resp = await controller.handleOneBotAction(act, params, `echo_${act}`);
      assert.strictEqual(resp.status, "ok", `Msg action ${act} failed: ${resp.message}`);
    }

    const pttResp = await controller.handleOneBotAction("fetch_ptt_text", {
      message_id: sentMessageId,
    });
    assert.strictEqual(pttResp.data.text, "博士你好，这是语音转文字结果");

    // Start HTTP & WebSocket servers and test real network transport + kernel event broadcast
    await controller.startServers();
    const httpPort = controller._httpServers[0].address().port;
    const wsPort = controller._wsServers[0].address().port;

    try {
      // Test HTTP POST /get_login_info
      const httpResp = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: httpPort,
            path: "/get_login_info",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          }
        );
        req.on("error", reject);
        req.write(JSON.stringify({}));
        req.end();
      });
      assert.strictEqual(httpResp.status, "ok");
      assert.strictEqual(httpResp.data.user_id, 100010001);

      // Connect a Reverse WS client to our WS server and verify lifecycle + incoming msg event
      const wsEvents = [];
      const wsHandle = mainMod.connectReverseWebSocket(
        `ws://127.0.0.1:${wsPort}`,
        { "X-Self-ID": "100010001" },
        () => {},
        (text) => {
          wsEvents.push(JSON.parse(text));
        },
        () => {}
      );

      // Wait for lifecycle connect event
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.ok(
        wsEvents.some((e) => e.post_type === "meta_event" && e.meta_event_type === "lifecycle"),
        "Expected lifecycle connect event over WebSocket"
      );

      // Emit an incoming message on nodeIKernelMsgListener and confirm it broadcasts to WS
      msgEmitter.emit("onRecvMsg", [
        {
          msgId: "7999999999999999999",
          msgSeq: "2001",
          msgTime: "1730000999",
          chatType: 1,
          peerUid: "u_uid_100020002",
          peerUin: "100020002",
          senderUid: "u_uid_100020002",
          senderUin: "100020002",
          sendNickName: "Doctor",
          elements: [{ elementType: 1, textElement: { content: "来自内核监听器的私聊消息" } }],
        },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const msgEv = wsEvents.find((e) => e.post_type === "message");
      assert.ok(msgEv, "Expected OneBot message event broadcast via WebSocket");
      assert.strictEqual(msgEv.message_type, "private");
      assert.strictEqual(msgEv.user_id, 100020002);
      assert.strictEqual(msgEv.raw_message, "来自内核监听器的私聊消息");

      wsHandle.close();
    } finally {
      await controller.stopServers();
    }
  });

  console.log("=== 6. Testing Anti-Cheat Hardening, Causal Order, Config Isolation & Resource Hygiene ===");
  await check("bridge_renderer.js generates native RFC 4122 v4 UUID callbackIds without rosmontis_cb_ prefix and prevents duplicate listeners on reattachListeners()", async () => {
    const sentIpcFrames = [];
    const forwardedEvents = [];
    const channelListeners = new Map();

    const fakeIpcRenderer = {
      send(channel, metaOrPayload, data) {
        if (channel === "__ROSMONTIS_BRIDGE_EVENT__") {
          forwardedEvents.push({ channel, data: metaOrPayload });
          return;
        }
        sentIpcFrames.push({ channel, meta: metaOrPayload, data });
        if (metaOrPayload && metaOrPayload.callbackId) {
          const listeners = channelListeners.get(`RM_IPCFROM_MAIN${metaOrPayload.peerId || 1}`) || [];
          setImmediate(() => {
            for (const fn of [...listeners]) {
              fn(
                {},
                {
                  callbackId: metaOrPayload.callbackId,
                  promiseStatue: "full",
                  type: "response",
                  eventName: "ntApi",
                  peerId: metaOrPayload.peerId || 1,
                },
                { result: 0 }
              );
            }
          });
        }
      },
      on(channel, listener) {
        if (!channelListeners.has(channel)) channelListeners.set(channel, []);
        channelListeners.get(channel).push(listener);
      },
      removeListener(channel, listener) {
        const list = channelListeners.get(channel);
        if (!list) return;
        const idx = list.indexOf(listener);
        if (idx !== -1) list.splice(idx, 1);
      },
    };

    const fakeWin = {
      webContentId: 1,
      ipcRenderer: fakeIpcRenderer,
      document: { querySelector: () => null },
    };

    const rBridge = rendererMod.installRendererBridge(fakeWin, {
      forceReinstall: true,
      autoRegisterListeners: false,
    });

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const sampleCbId = rBridge.makeCallbackId();
    assert.ok(!sampleCbId.startsWith("rosmontis_cb_"), `callbackId must not start with rosmontis_cb_: ${sampleCbId}`);
    assert.ok(uuidRegex.test(sampleCbId), `callbackId must be RFC 4122 v4 UUID: ${sampleCbId}`);

    await rBridge.invokeNtApi("nodeIKernelMsgService/setFocusOnBase", [{ isFocus: true }, null]);
    assert.strictEqual(sentIpcFrames.length, 1);
    const frameCbId = sentIpcFrames[0].meta.callbackId;
    assert.ok(!frameCbId.startsWith("rosmontis_cb_"));
    assert.ok(uuidRegex.test(frameCbId));

    // Call reattachListeners() multiple times and verify RM_IPCFROM_MAIN1 only has 1 listener
    rBridge.reattachListeners();
    rBridge.reattachListeners();
    rBridge.reattachListeners();

    const main1Listeners = channelListeners.get("RM_IPCFROM_MAIN1") || [];
    assert.strictEqual(main1Listeners.length, 1, "reattachListeners() must not duplicate handleIncomingMainIpc");
    assert.strictEqual(
      (channelListeners.get("RM_IPCFROM_MAIN3") || []).length,
      0,
      "Should only attach windowId 1 and fallback 2, not 3"
    );

    for (const fn of main1Listeners) {
      fn(
        {},
        { eventName: "ntApi", peerId: 1 },
        { cmdName: "nodeIKernelMsgListener/onRecvMsg", cmdType: "event", payload: [{ msgId: "9901" }] }
      );
    }
    assert.strictEqual(forwardedEvents.length, 1, "Incoming event must be forwarded exactly once");
  });

  await check("set_input_status marks read before sendShowInputStatusReq and send_private_msg/send_msg skips 0ms sendShowInputStatusReq", async () => {
    const callOrder = [];
    const controller = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      config: {
        selfUin: "100010001",
        httpServers: [],
        wsServers: [],
        wsClients: [],
        humanSimulation: true,
        dedupeWindowMs: 5000,
      },
    });
    controller.uinUidStore.record("100020002", "u_uid_100020002");
    controller.uinUidStore.record("100030003", "u_uid_100030003");

    controller.capturedServices.ntApi = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string" || !prop.includes("/")) return undefined;
          return async (payload) => {
            callOrder.push({ cmd: prop, payload });
            return { result: 0, errMsg: "", msgId: "7600000000000000001" };
          };
        },
      }
    );

    try {
      // 1. Trigger set_input_status (event_type: 1): setFocusOnBase -> addActiveChatByUid -> enterOrExitAio(1) -> setMsgRead -> sendShowInputStatusReq
      const statusResp = await controller.handleOneBotAction("set_input_status", {
        user_id: 100020002,
        event_type: 1,
      });
      assert.strictEqual(statusResp.status, "ok");

      const cmdsAfterTyping = callOrder.map((c) => c.cmd);
      const focusIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/setFocusOnBase");
      const activeIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/addActiveChatByUid");
      const enterIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/enterOrExitAio");
      const readIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/setMsgRead");
      const typingIdx = cmdsAfterTyping.indexOf("nodeIKernelMsgService/sendShowInputStatusReq");
      assert.ok(focusIdx >= 0 && focusIdx < activeIdx, "setFocusOnBase must precede addActiveChatByUid");
      assert.ok(activeIdx >= 0 && activeIdx < enterIdx, "addActiveChatByUid must precede enterOrExitAio");
      assert.ok(enterIdx >= 0 && enterIdx < readIdx, "enterOrExitAio must precede setMsgRead");
      assert.ok(readIdx >= 0 && readIdx < typingIdx, "setMsgRead must precede sendShowInputStatusReq");

      // 2. Immediately send_private_msg -> already in AIO & read deduplicated, NO 0ms sendShowInputStatusReq before sendMsg!
      callOrder.length = 0;
      const sendResp = await controller.handleOneBotAction("send_private_msg", {
        user_id: 100020002,
        message: "你好博士",
      });
      assert.strictEqual(sendResp.status, "ok");

      const cmdsAfterSend = callOrder.map((c) => c.cmd);
      assert.strictEqual(
        cmdsAfterSend.includes("nodeIKernelMsgService/setMsgRead"),
        false,
        "setMsgRead must be deduplicated within the 5s window after set_input_status already marked read"
      );
      assert.strictEqual(
        cmdsAfterSend.includes("nodeIKernelMsgService/sendShowInputStatusReq"),
        false,
        "send_private_msg must NOT emit a 0ms sendShowInputStatusReq right before sendMsg"
      );
      assert.deepStrictEqual(cmdsAfterSend, ["nodeIKernelMsgService/sendMsg"]);

      // 3. Direct send_msg to a fresh private peer activates AIO + marks read WITHOUT 0ms sendShowInputStatusReq
      callOrder.length = 0;
      const directMsgResp = await controller.handleOneBotAction("send_msg", {
        message_type: "private",
        user_id: 100030003,
        message: "直接回复",
      });
      assert.strictEqual(directMsgResp.status, "ok");
      const cmdsDirect = callOrder.map((c) => c.cmd);
      assert.deepStrictEqual(cmdsDirect, [
        "nodeIKernelMsgService/enterOrExitAio",
        "nodeIKernelMsgService/addActiveChatByUid",
        "nodeIKernelMsgService/enterOrExitAio",
        "nodeIKernelMsgService/setMsgRead",
        "nodeIKernelMsgService/sendMsg",
      ]);
    } finally {
      await controller.stopServers();
    }
  });

  await check("mark_msg_as_read & mark_group_msg_as_read resolve group/private peers even when message_id is absent from MessageIdStore", async () => {
    const readPeers = [];
    const controller = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      config: {
        selfUin: "100010001",
        httpServers: [],
        wsServers: [],
        wsClients: [],
        humanSimulation: true,
        dedupeWindowMs: 0,
      },
    });
    controller.uinUidStore.record("100020002", "u_uid_100020002");
    controller.capturedServices.ntApi = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string" || !prop.includes("/")) return undefined;
          return async (payload) => {
            if (prop === "nodeIKernelMsgService/setMsgRead") {
              readPeers.push(payload.peer);
            }
            return { result: 0, errMsg: "" };
          };
        },
      }
    );

    // 1. mark_msg_as_read with unknown message_id + group_id
    await controller.handleOneBotAction("mark_msg_as_read", {
      message_id: 99999991,
      group_id: 654321,
    });
    assert.strictEqual(readPeers.length, 1);
    assert.deepStrictEqual(readPeers[0], { chatType: 2, peerUid: "654321", guildId: "" });

    // 2. mark_group_msg_as_read with target_id only
    await controller.handleOneBotAction("mark_group_msg_as_read", {
      target_id: 777888,
    });
    assert.strictEqual(readPeers.length, 2);
    assert.deepStrictEqual(readPeers[1], { chatType: 2, peerUid: "777888", guildId: "" });

    // 3. mark_msg_as_read with unknown message_id + user_id
    await controller.handleOneBotAction("mark_msg_as_read", {
      message_id: 99999992,
      user_id: 100020002,
    });
    assert.strictEqual(readPeers.length, 3);
    assert.deepStrictEqual(readPeers[2], { chatType: 1, peerUid: "u_uid_100020002", guildId: "" });
  });

  await check("loadBridgeConfig supports onebot_sandbox.json, honors empty wsClients: [], filters disabled entries, and isolates multiple account files", () => {
    const tmpCfgDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis_cfg_test_"));
    const savedEnv = { ...process.env };
    try {
      delete process.env.ROSMONTIS_HTTP_PORT;
      delete process.env.ROSMONTIS_WS_PORT;
      delete process.env.ROSMONTIS_REVERSE_WS_URL;
      delete process.env.ROSMONTIS_DISABLE_DEFAULT_WS;
      delete process.env.ONEBOT_SELF_ID;
      delete process.env.ROSMONTIS_SELF_ID;

      // Case A: onebot_sandbox.json with empty wsClients: [] and a disabled httpServer
      const sandboxFile = path.join(tmpCfgDir, "onebot_sandbox.json");
      fs.writeFileSync(
        sandboxFile,
        JSON.stringify({
          networks: {
            httpServers: [
              { enable: true, host: "127.0.0.1", port: 13000, accessToken: "" },
              { enable: false, host: "127.0.0.1", port: 13999, accessToken: "" },
            ],
            wsServers: [{ enable: true, host: "127.0.0.1", port: 13001, accessToken: "" }],
            wsClients: [],
          },
        }),
        "utf8"
      );

      const cfgSandbox = mainMod.loadBridgeConfig(tmpCfgDir);
      assert.strictEqual(cfgSandbox.selfUin, "", "Non-numeric suffix 'sandbox' must not populate selfUin");
      assert.strictEqual(cfgSandbox.httpServers.length, 1, "Disabled httpServer must be filtered out");
      assert.strictEqual(cfgSandbox.httpServers[0].port, 13000);
      assert.strictEqual(
        cfgSandbox.wsClients.length,
        0,
        "Explicitly empty wsClients: [] in config file must NOT inject ws://127.0.0.1:8080/onebot/v11/ws"
      );

      // Case B: Two account files in the same dir -> must NOT merge servers from both files
      fs.unlinkSync(sandboxFile);
      fs.writeFileSync(
        path.join(tmpCfgDir, "onebot_111111.json"),
        JSON.stringify({
          networks: {
            httpServers: [{ enable: true, host: "127.0.0.1", port: 3000 }],
            wsServers: [],
            wsClients: [],
          },
        }),
        "utf8"
      );
      fs.writeFileSync(
        path.join(tmpCfgDir, "onebot_222222.json"),
        JSON.stringify({
          networks: {
            httpServers: [{ enable: true, host: "127.0.0.1", port: 4000 }],
            wsServers: [],
            wsClients: [{ enable: true, url: "ws://127.0.0.1:8080/onebot/v11/ws" }],
          },
        }),
        "utf8"
      );

      const cfgMulti = mainMod.loadBridgeConfig(tmpCfgDir);
      assert.strictEqual(cfgMulti.selfUin, "222222");
      assert.strictEqual(
        cfgMulti.httpServers.length,
        1,
        "loadBridgeConfig must load only from bestEntry and never merge ports from multiple account files"
      );
      assert.strictEqual(cfgMulti.httpServers[0].port, 4000);
      assert.strictEqual(cfgMulti.wsClients.length, 1);
    } finally {
      process.env = savedEnv;
      fs.rmSync(tmpCfgDir, { recursive: true, force: true });
    }
  });

  await check("Dynamic User-Agent, temp file cleanup, multi-window activeWebContents contention, and onAddSendMsg deduplication", async () => {
    const ua = onebot.buildNtqqUserAgent();
    assert.ok(ua.includes("QQ/3.2.32-52194"), `Expected dynamic QQ version in User-Agent, got: ${ua}`);
    assert.ok(!ua.includes("QQ/3.2.26"), "User-Agent must not contain hardcoded outdated QQ/3.2.26");

    // Verify temp file creation & cleanup on send_private_msg with base64:// image
    const tmpMediaDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis_media_test_"));
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    try {
      const { elements, cleanupCallbacks, tempFiles } = await onebot.oneBotSegmentsToNtElements(
        [{ type: "image", data: { file: `base64://${pngBase64}` } }],
        { chatType: 1, peerUid: "u_test", tempDir: tmpMediaDir }
      );
      assert.strictEqual(elements.length, 1);
      assert.strictEqual(tempFiles.length, 1);
      assert.strictEqual(cleanupCallbacks.length, 1);
      assert.ok(fs.existsSync(tempFiles[0]), "Temp file should exist before cleanup");
      for (const fn of cleanupCallbacks) fn();
      assert.ok(!fs.existsSync(tempFiles[0]), "Temp file must be unlinked after cleanupCallback");
    } finally {
      fs.rmSync(tmpMediaDir, { recursive: true, force: true });
    }

    // Verify multi-window activeWebContents protection & onAddSendMsg deduplication
    const controller = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      config: { httpServers: [], wsServers: [], wsClients: [] },
    });

    const mainWc = new EventEmitter();
    mainWc.isDestroyed = () => false;
    mainWc.getURL = () => "app://./renderer/index.html#/main/message";
    mainWc.executeJavaScript = async () => ({ ok: true });

    const devtoolsWc = new EventEmitter();
    devtoolsWc.isDestroyed = () => false;
    devtoolsWc.getURL = () => "devtools://devtools/bundled/inspector.html";
    devtoolsWc.executeJavaScript = async () => ({ ok: true });

    controller._attachToWebContents(mainWc);
    assert.strictEqual(controller.activeWebContents, mainWc);

    // Auxiliary devtools window must NOT overwrite active main window
    controller._attachToWebContents(devtoolsWc);
    assert.strictEqual(controller.activeWebContents, mainWc);

    // When mainWc is destroyed, activeWebContents is cleared
    mainWc.emit("destroyed");
    assert.strictEqual(controller.activeWebContents, null);

    // Verify onAddSendMsg deduplication
    let sendBroadcastCount = 0;
    controller._broadcastOneBotEvent = () => {
      sendBroadcastCount += 1;
    };
    const sampleSentMsg = {
      msgId: "7888888888888888888",
      msgSeq: "301",
      chatType: 1,
      peerUid: "u_friend_1",
      elements: [],
    };
    await controller._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [sampleSentMsg]);
    await controller._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [sampleSentMsg]);
    assert.strictEqual(sendBroadcastCount, 0);
    assert.notStrictEqual(controller.messageIdStore.getByMsgId("7888888888888888888"), null);
  });

  console.log("=== 7. Testing Real NTQQ 3.2.32 ntStore.emitter, Async List Waiters & Map Revival ===");

  await check("ntStore.emitter hyphenated events, async get_friend_list/get_group_list, and nested Map revival", async () => {
    const rootEmitter = new EventEmitter();
    const fakeNtStore = {
      emitter: rootEmitter,
      listenerEventEmitterMap: new Map(),
      wrapperSession: null,
    };
    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "",
      online: false,
      config: { httpServers: [], wsServers: [], wsClients: [], heartbeatIntervalMs: 0 },
      rendererExecute: async (cmd) => {
        if (cmd === "nodeIKernelBuddyService/getBuddyList") {
          setTimeout(() => {
            rootEmitter.emit("nodeIKernelBuddyListener-onBuddyListChange", [
              {
                categoryId: 0,
                buddyList: [
                  { uin: "100020002", uid: "u_doctor_1", nick: "Doctor", remark: "博士" },
                ],
              },
            ]);
          }, 15);
          return { result: 0, errMsg: "" };
        }
        if (cmd === "nodeIKernelGroupService/getGroupList") {
          setTimeout(() => {
            rootEmitter.emit("nodeIKernelGroupListener-onGroupListUpdate", 1, [
              { groupCode: "888999000", groupName: "罗德岛作战室", memberCount: 42, maxMember: 200 },
            ]);
          }, 15);
          return { result: 0, errMsg: "" };
        }
        return { result: 0, errMsg: "" };
      },
    });

    assert.strictEqual(bridge.online, false);
    bridge._inspectInversifyCache(fakeNtStore);

    const friendsResp = await bridge.handleOneBotAction("get_friend_list", { no_cache: true });
    assert.strictEqual(friendsResp.status, "ok");
    assert.strictEqual(friendsResp.data.length, 1);
    assert.strictEqual(friendsResp.data[0].user_id, 100020002);
    assert.strictEqual(friendsResp.data[0].remark, "博士");
    assert.strictEqual(bridge.online, true);

    const groupsResp = await bridge.handleOneBotAction("get_group_list", { no_cache: true });
    assert.strictEqual(groupsResp.status, "ok");
    assert.strictEqual(groupsResp.data.length, 1);
    assert.strictEqual(groupsResp.data[0].group_id, 888999000);
    assert.strictEqual(groupsResp.data[0].group_name, "罗德岛作战室");

    // Verify nested Map serialization from bridge_main -> bridge_renderer
    const sentFrames = [];
    const mockWin = {
      webContentId: 2,
      ipcImpl: {
        on() {},
        send(channel, meta, data) {
          sentFrames.push({ channel, meta, data });
        },
      },
    };
    const rBridge = rendererMod.installRendererBridge(mockWin, { windowId: 2, autoRegisterListeners: false });
    const serialized = bridge._serializeBridgePayload([
      {
        msgId: "0",
        msgAttributeInfos: new Map(),
        msgElements: [
          {
            elementType: 2,
            picElement: {
              thumbPath: new Map([[0, "/tmp/thumb.png"]]),
            },
          },
        ],
      },
      null,
    ]);
    const pInvoke = rBridge.invokeNtApi("nodeIKernelMsgService/sendMsg", JSON.parse(serialized), 50);
    pInvoke.catch(() => {});
    const sendFrame = sentFrames.find((f) => f.data?.cmdName === "nodeIKernelMsgService/sendMsg");
    assert.ok(sendFrame, "Expected sendMsg IPC frame");
    assert.ok(sendFrame.data.payload[0].msgAttributeInfos instanceof Map);
    assert.ok(sendFrame.data.payload[0].msgElements[0].picElement.thumbPath instanceof Map);
    assert.strictEqual(sendFrame.data.payload[0].msgElements[0].picElement.thumbPath.get(0), "/tmp/thumb.png");
  });

  console.log("=== 8. Testing Inbound rkey-less Image Hydration, Outbound EXIF Copy & 3.2.32 Member List ===");

  await check("Inbound rkey-less image hydration, outbound copyFileWithDelExifInfo & 3.2.32 member list", async () => {
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis-bridge-img-"));
    const rootEmitter = new EventEmitter();
    const calls = [];
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    const dlFilePath = path.join(tmpDir, "inbound_dl.png");
    const exifFilePath = path.join(tmpDir, "outbound_noexif.png");
    fs.writeFileSync(exifFilePath, pngBytes);

    let sceneDestroyed = false;
    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis_self",
      online: true,
      config: { httpServers: [], wsServers: [], wsClients: [], heartbeatIntervalMs: 0, humanSimulation: false },
      rendererExecute: async (cmd, args) => {
        const payload = Array.isArray(args) ? args[0] : args;
        calls.push({ cmd, payload });
        if (cmd === "nodeIKernelMsgService/getRichMediaFilePathForGuild") {
          return dlFilePath;
        }
        if (cmd === "nodeIKernelMsgService/downloadRichMedia") {
          setTimeout(() => {
            fs.writeFileSync(dlFilePath, pngBytes);
            rootEmitter.emit("nodeIKernelMsgListener-onRichMediaDownloadComplete", {
              notifyInfo: {
                msgId: "750001",
                msgElementId: "9001",
                filePath: dlFilePath,
              },
            });
          }, 15);
          return undefined;
        }
        if (cmd === "nodeIKernelMsgService/copyFileWithDelExifInfo") {
          return {
            errorMsg: "",
            md5: "deadbeefcafebabe0011223344556677",
            newPath: exifFilePath,
          };
        }
        if (cmd === "nodeIKernelMsgService/sendMsg") {
          return { result: 0, msgId: "750002", msgSeq: "12" };
        }
        if (cmd === "nodeIKernelGroupService/createMemberListScene") {
          return "scene_3232";
        }
        if (cmd === "nodeIKernelLoginService/getLoginList") {
          return {
            result: 0,
            LocalLoginInfoList: [
              { uin: "100010001", uid: "u_rosmontis", nickName: "Rosmontis", isQuickLogin: true, isAutoLogin: false },
            ],
          };
        }
        if (cmd === "nodeIKernelLoginService/setAutoLogin") {
          return { result: 0 };
        }
        if (cmd === "nodeIKernelLoginService/quickLoginWithUin") {
          assert.strictEqual(payload.uin, "100010001");
          return { result: 0 };
        }
        if (cmd === "nodeIKernelGroupService/getNextMemberList") {
          assert.strictEqual(payload.sceneId, "scene_3232");
          assert.strictEqual(payload.num, 3000);
          return {
            result: {
              finished: true,
              ids: ["u_m1"],
              infos: new Map([
                [
                  "u_m1",
                  {
                    uid: "u_m1",
                    uin: "0",
                    nick: "阿米娅",
                    cardName: "兔兔",
                    role: 4,
                  },
                ],
              ]),
            },
          };
        }
        if (cmd === "nodeIKernelGroupService/destroyMemberListScene") {
          sceneDestroyed = true;
          return { result: 0 };
        }
        if (cmd === "nodeIKernelUixConvertService/getUin") {
          return { uinInfo: new Map([["u_m1", "1008611"]]) };
        }
        return { result: 0 };
      },
    });

    bridge._attachNtStoreRootEmitter(rootEmitter);
    const broadcasted = [];
    bridge.broadcastOneBotEvent = (ev) => broadcasted.push(ev);

    // 8a. Inbound NTQQv2 image without rkey= downloads and becomes base64://
    await bridge._processIncomingNtMessage({
      msgId: "750001",
      msgSeq: "88",
      msgTime: "1760000000",
      chatType: 1,
      peerUid: "u_doctor_1",
      senderUid: "u_doctor_1",
      senderUin: "100020002",
      elements: [
        {
          elementId: "9001",
          elementType: 2,
          picElement: {
            md5HexStr: "0123456789abcdef0123456789abcdef",
            fileName: "test.png",
            fileSize: String(pngBytes.length),
            sourcePath: "",
            originImageUrl: "/download?appid=1406&fileid=EhTks1thsAOGmQ&spec=0",
          },
        },
      ],
    });

    assert.strictEqual(broadcasted.length, 1);
    const imgSeg = broadcasted[0].message.find((s) => s.type === "image");
    assert.ok(imgSeg, "Expected image segment");
    assert.strictEqual(imgSeg.data.url, `base64://${pngBytes.toString("base64")}`);

    // 8b. Outbound PNG image uses copyFileWithDelExifInfo, picType=1001, and thumbPath Map
    const sendResp = await bridge.handleOneBotAction("send_private_msg", {
      user_id: 100020002,
      message: [{ type: "image", data: { file: `base64://${pngBytes.toString("base64")}` } }],
    });
    assert.strictEqual(sendResp.status, "ok");
    const sendCall = calls.find((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
    assert.ok(sendCall, "Expected sendMsg call");
    const sentPe = sendCall.payload.msgElements[0].picElement;
    assert.strictEqual(sentPe.sourcePath, exifFilePath);
    assert.strictEqual(sentPe.md5HexStr, "deadbeefcafebabe0011223344556677");
    assert.strictEqual(sentPe.picType, 1001);
    assert.ok(sentPe.thumbPath instanceof Map);

    // 8c. NTQQ 3.2.32 get_group_member_list resolves missing uin and destroys scene
    const membersResp = await bridge.handleOneBotAction("get_group_member_list", {
      group_id: 888999000,
    });
    assert.strictEqual(membersResp.status, "ok");
    assert.strictEqual(membersResp.data.length, 1);
    assert.strictEqual(membersResp.data[0].user_id, 1008611);
    assert.strictEqual(membersResp.data[0].card, "兔兔");
    assert.strictEqual(membersResp.data[0].role, "owner");
    assert.strictEqual(sceneDestroyed, true);

    // 8d. Auto quick-login recovery invokes setAutoLogin + quickLoginWithUin when offline
    bridge.online = false;
    const qlResp = await bridge.handleOneBotAction("quick_login", {});
    assert.strictEqual(qlResp.status, "ok");
    assert.strictEqual(qlResp.data.triggered, true);
    assert.strictEqual(qlResp.data.uin, "100010001");
    assert.strictEqual(qlResp.data.method, "nodeIKernelLoginService/quickLoginWithUin");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  console.log("=== 9. Testing invokeNt Side-Effect Replay Guard ===");

  await check("invokeNt never replays dispatched side-effect commands but keeps read fallbacks", async () => {
    const makeBridge = (rendererImpl, ntApiImpl, tier3Calls) =>
      new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_self",
        online: true,
        config: { httpServers: [], wsServers: [], wsClients: [], heartbeatIntervalMs: 0, humanSimulation: false },
        rendererExecute: rendererImpl,
        ntApi: new Proxy(
          {},
          {
            get(_t, prop) {
              if (typeof prop !== "string" || !prop.includes("/")) return undefined;
              return async (payload) => ntApiImpl(prop, payload);
            },
          }
        ),
        wrapperSession: {
          getMsgService: () => ({
            sendMsg: async (...args) => {
              tier3Calls.push(["sendMsg", args]);
              return { result: 0 };
            },
            recallMsg: async (...args) => {
              tier3Calls.push(["recallMsg", args]);
              return { result: 0 };
            },
          }),
          getGroupService: () => ({}),
        },
      });

    // 9a. Renderer dispatched sendMsg then timed out -> surface error, no Tier 2 / Tier 3 replay
    {
      const ntApiCalls = [];
      const tier3Calls = [];
      const bridge = makeBridge(
        async () => {
          throw new Error("invokeNtApi timeout (15000ms): nodeIKernelMsgService/sendMsg");
        },
        async (cmd) => {
          ntApiCalls.push(cmd);
          return { result: 0 };
        },
        tier3Calls
      );
      await assert.rejects(
        () => bridge.invokeNt("nodeIKernelMsgService/sendMsg", { msgId: "0" }, ["0"]),
        /timeout/
      );
      assert.deepStrictEqual(ntApiCalls, []);
      assert.deepStrictEqual(tier3Calls, []);
      assert.strictEqual(bridge.invokeStats.blockedReplays, 1);
    }

    // 9b. Renderer bridge not injected (tagged unavailable) -> safe to fall back to Tier 2 exactly once
    {
      const ntApiCalls = [];
      const tier3Calls = [];
      const bridge = makeBridge(
        async () => {
          throw new Error("ROSMONTIS_BRIDGE_UNAVAILABLE: Renderer bridge not ready");
        },
        async (cmd) => {
          ntApiCalls.push(cmd);
          return { result: 0, msgId: "7500000000000000999" };
        },
        tier3Calls
      );
      const res = await bridge.invokeNt("nodeIKernelMsgService/sendMsg", { msgId: "0" }, ["0"]);
      assert.strictEqual(res.msgId, "7500000000000000999");
      assert.deepStrictEqual(ntApiCalls, ["nodeIKernelMsgService/sendMsg"]);
      assert.deepStrictEqual(tier3Calls, []);
      assert.strictEqual(bridge.invokeStats.tier2, 1);
      assert.strictEqual(bridge.invokeStats.degraded, 1);
    }

    // 9c. Tier 2 void (undefined) result for a side-effect command is success; Tier 3 not invoked
    {
      const tier3Calls = [];
      const bridge = makeBridge(
        async () => {
          throw new Error("ROSMONTIS_BRIDGE_UNAVAILABLE: Renderer bridge not ready");
        },
        async () => undefined,
        tier3Calls
      );
      const res = await bridge.invokeNt("nodeIKernelMsgService/recallMsg", { peer: {}, msgIds: ["1"] });
      assert.strictEqual(res, undefined);
      assert.deepStrictEqual(tier3Calls, []);
    }

    // 9d. Risk-control rejection from Tier 2 is not replayed via Tier 3
    {
      const tier3Calls = [];
      const bridge = makeBridge(
        async () => {
          throw new Error("ROSMONTIS_BRIDGE_UNAVAILABLE: Renderer bridge not ready");
        },
        async () => {
          throw new Error("send too frequently");
        },
        tier3Calls
      );
      await assert.rejects(
        () => bridge.invokeNt("nodeIKernelMsgService/sendMsg", { msgId: "0" }, ["0"]),
        /send too frequently/
      );
      assert.deepStrictEqual(tier3Calls, []);
    }

    // 9e. Read-only commands keep legacy fallback after a dispatched renderer failure
    {
      const ntApiCalls = [];
      const bridge = makeBridge(
        async () => {
          throw new Error("NTQQ IPC error (nodeIKernelGroupService/getGroupList): boom");
        },
        async (cmd) => {
          ntApiCalls.push(cmd);
          return { groupList: [] };
        },
        []
      );
      const res = await bridge.invokeNt("nodeIKernelGroupService/getGroupList", { forceFetch: true });
      assert.deepStrictEqual(res, { groupList: [] });
      assert.deepStrictEqual(ntApiCalls, ["nodeIKernelGroupService/getGroupList"]);
      const status = await bridge.handleOneBotAction("get_status", {});
      assert.strictEqual(status.data.bridge.invoke.tier2, 1);
    }
  });

  console.log("=== 10. Testing Outbound sendMsg <-> onAddSendMsg Echo Correlation ===");

  await check("send_private_msg maps message_id to the real onAddSendMsg msgId so delete_msg can recall it", async () => {
    const recallCalls = [];
    const pendingEchoes = [];
    let bridge = null;
    const textOf = (elements) =>
      (elements || [])
        .filter((e) => e && e.elementType === 1)
        .map((e) => e.textElement.content)
        .join("");
    const echoFor = (msgId, text, msgSeq) => ({
      msgRecord: {
        msgId,
        msgSeq,
        msgTime: "1794380000",
        chatType: 1,
        peerUid: "u_friend",
        senderUid: "u_self",
        senderUin: "100010001",
        elements: [{ elementType: 1, textElement: { content: text, atType: 0 } }],
      },
    });
    bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self",
      online: true,
      config: {
        httpServers: [],
        wsServers: [],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
        sendEchoTimeoutMs: 80,
      },
      rendererExecute: async (cmd, args) => {
        const payload = args[0];
        if (cmd === "nodeIKernelMsgService/sendMsg") {
          const text = textOf(payload.msgElements);
          const plan = pendingEchoes.shift() || {};
          if (plan.foreignFirst) {
            // A manual send from the QQ UI to the same peer must not be mistaken for ours
            await bridge._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
              echoFor("7600000000000000900", "我是手动发的", "90"),
            ]);
          }
          if (plan.mode === "before") {
            await bridge._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
              echoFor(plan.msgId, text, plan.msgSeq),
            ]);
          } else if (plan.mode === "after") {
            setTimeout(() => {
              bridge
                ._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                  echoFor(plan.msgId, text, plan.msgSeq),
                ])
                .catch(() => {});
            }, 20);
          }
          return { result: 0, errMsg: "" };
        }
        if (cmd === "nodeIKernelMsgService/recallMsg") {
          recallCalls.push(payload);
          return { result: 0, errMsg: "" };
        }
        throw new Error(`unexpected cmd ${cmd}`);
      },
    });
    bridge.uinUidStore.record("100020002", "u_friend");

    // 10a. Echo arrives before sendMsg resolves
    pendingEchoes.push({ mode: "before", msgId: "7600000000000000001", msgSeq: "55" });
    const r1 = await bridge.handleOneBotAction("send_private_msg", { user_id: 100020002, message: "你好" });
    assert.strictEqual(r1.status, "ok");
    assert.strictEqual(r1.data.real_id, "7600000000000000001");
    await bridge.handleOneBotAction("delete_msg", { message_id: r1.data.message_id });
    assert.deepStrictEqual(recallCalls[0].msgIds, ["7600000000000000001"]);
    assert.strictEqual(recallCalls[0].peer.peerUid, "u_friend");

    // 10b. Echo arrives after sendMsg resolves; a foreign manual send to the same peer is skipped
    pendingEchoes.push({ mode: "after", msgId: "7600000000000000002", msgSeq: "56", foreignFirst: true });
    const r2 = await bridge.handleOneBotAction("send_private_msg", { user_id: 100020002, message: "第二条" });
    assert.strictEqual(r2.data.real_id, "7600000000000000002");
    assert.notStrictEqual(r2.data.message_id, r1.data.message_id);

    // 10c. No echo at all -> bounded wait, placeholder id, counted as timed out
    pendingEchoes.push({ mode: "none" });
    const r3 = await bridge.handleOneBotAction("send_private_msg", { user_id: 100020002, message: "第三条" });
    assert.strictEqual(r3.status, "ok");
    assert.ok(String(r3.data.real_id).startsWith("sent_"));
    assert.deepStrictEqual(bridge.sendEchoStats, { matched: 2, fromResult: 0, timedOut: 1 });
    assert.strictEqual(bridge._sendEchoWaiters.size, 0, "waiter queues must be drained");
  });

  console.log("=== 11. Testing Map.prototype.set Capture Hook Release ===");

  await check("Map.prototype.set hook is restored to native once ntApi/ntStore/session are captured", async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self",
      online: true,
      config: {
        httpServers: [],
        wsServers: [],
        wsClients: [],
        heartbeatIntervalMs: 0,
        mapHookReleaseDelayMs: 10,
      },
    });
    bridge.installMapPrototypeHook();
    assert.ok(!/\[native code\]/.test(Map.prototype.set.toString()), "hook should be active");
    assert.strictEqual(bridge._mapSetHook, Map.prototype.set);

    // Simulate 908.background.js DI registrations
    const di = new Map();
    di.set("ntApi", {
      emit: {},
      invoke: new Proxy(
        {},
        { get: (_t, prop) => (typeof prop === "string" && prop.includes("/") ? async () => ({}) : undefined) }
      ),
    });
    await sleep(30);
    assert.ok(bridge._mapSetHook, "must not release before ntStore/session are captured");

    const listenerMap = new Map();
    const fakeSession = { getMsgService: () => ({}), getGroupService: () => ({}) };
    const fakeNtStore = {
      emitter: new EventEmitter(),
      listenerEventEmitterMap: listenerMap,
      wrapperSession: fakeSession,
    };
    di.set(Symbol("ntStore"), [{ cache: fakeNtStore, implementationType: function NtStore() {}, type: "Singleton" }]);
    assert.strictEqual(bridge.capturedServices.ntStore, fakeNtStore);
    assert.strictEqual(bridge.capturedServices.wrapperSession, fakeSession);

    await sleep(40);
    assert.ok(/\[native code\]/.test(Map.prototype.set.toString()), "native Map.prototype.set must be restored");
    assert.ok(!("__rosmontisBridgeHooked__" in Map.prototype), "hook marker must be removed");
    assert.deepStrictEqual(
      { reason: bridge.mapHookRelease.reason, restored: bridge.mapHookRelease.restored },
      { reason: "captured", restored: true }
    );

    // Kernel listeners registered after release still reach the bridge via the instance patch
    const seen = [];
    bridge._handleKernelEvent = async (listenerName, eventName) => {
      seen.push(`${listenerName}/${eventName}`);
    };
    const lateEmitter = new EventEmitter();
    listenerMap.set("nodeIKernelMsgListener", lateEmitter);
    lateEmitter.emit("onRecvMsg", []);
    assert.deepStrictEqual(seen, ["nodeIKernelMsgListener/onRecvMsg"]);
    assert.strictEqual(listenerMap.get("nodeIKernelMsgListener"), lateEmitter);

    // Ordinary Maps no longer pass through the bridge
    const plain = new Map();
    plain.set("nodeIKernelBuddyListener", new EventEmitter());
    assert.strictEqual(seen.length, 1);

    const status = await bridge.handleOneBotAction("get_status", {});
    assert.strictEqual(status.data.bridge.map_hook_active, false);
    assert.strictEqual(status.data.bridge.map_hook_release.reason, "captured");

    // Releasing twice is a no-op
    assert.strictEqual(bridge.releaseMapPrototypeHook("again"), false);
  });

  console.log("=== 12. Testing MessageIdStore PeerSeq Isolation & Reverse WS Single-Connection Guard ===");

  await check("MessageIdStore does not collide distinct real msgIds sharing msgSeq and reverse WS never multiplies on ECONNREFUSED", async () => {
    // 12a. Two distinct real msgIds sharing (chatType, peerUid, msgSeq) keep distinct shortIds
    const store = new onebot.MessageIdStore();
    const peer = { chatType: 1, peerUid: "u_owner_1", guildId: "" };
    const s1 = store.register("7500000000000001001", peer, "42");
    const s2 = store.register("7500000000000001002", peer, "42");
    assert.notStrictEqual(s1, s2, "Distinct real msgIds must never collapse into one shortId");
    assert.strictEqual(store.getByShortId(s1).msgId, "7500000000000001001");
    assert.strictEqual(store.getByShortId(s2).msgId, "7500000000000001002");

    // Placeholder sent_... entry upgrades cleanly when real msgId arrives for same peerSeq
    const sPlaceholder = store.register("sent_1794375000000", peer, "99");
    const sUpgraded = store.register("7500000000000001099", peer, "99");
    assert.strictEqual(sPlaceholder, sUpgraded);
    assert.strictEqual(store.getByShortId(sUpgraded).msgId, "7500000000000001099");

    // 12b. Repeated ECONNREFUSED before server startup must open strictly 1 reverse WS connection once server listens
    const probeSrv = net.createServer();
    await new Promise((r) => probeSrv.listen(0, "127.0.0.1", r));
    const freePort = probeSrv.address().port;
    await new Promise((r) => probeSrv.close(r));

    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_rosmontis",
      online: true,
      config: {
        httpServers: [],
        wsServers: [],
        wsClients: [
          {
            name: "wsclient-test",
            url: `ws://127.0.0.1:${freePort}/ws`,
            reconnectIntervalMs: 30,
          },
        ],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
      },
    });
    // Temporarily allow sub-500ms reconnect in unit test by invoking connectReverseWebSocket directly + loop
    let closeCalls = 0;
    await new Promise((resolve) => {
      mainMod.connectReverseWebSocket(
        `ws://127.0.0.1:${freePort}/ws`,
        {},
        () => {},
        () => {},
        () => {
          closeCalls += 1;
          setTimeout(resolve, 40);
        }
      );
    });
    assert.strictEqual(closeCalls, 1, "connectReverseWebSocket must invoke onClose exactly once on ECONNREFUSED");
    await bridge.stopServers();
  });

  console.log("=== 13. Testing Token Env Guard, Echo Element Isolation, Poke Replay Guard, HTTP Null Body & Forward WS Error Safety ===");

  await check("Empty env token preserves config token; sendEcho isolates element types/md5; poke honors replay guard; HTTP null body & Forward WS socket errors never crash", async () => {
    const os = require("os");

    // 13a. Empty ROSMONTIS_ACCESS_TOKEN / ONEBOT_ACCESS_TOKEN must not clobber config file accessToken
    const tmpCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis_tok_test_"));
    const prevRosTok = process.env.ROSMONTIS_ACCESS_TOKEN;
    const prevObTok = process.env.ONEBOT_ACCESS_TOKEN;
    try {
      fs.writeFileSync(
        path.join(tmpCfgDir, "rosmontis.json"),
        JSON.stringify({
          networks: {
            httpServers: [{ enable: true, host: "127.0.0.1", port: 3000, accessToken: "cfg-secret-token" }],
            wsServers: [{ enable: true, host: "127.0.0.1", port: 3001, accessToken: "cfg-secret-token" }],
            wsClients: [{ enable: true, url: "ws://127.0.0.1:8080/ws", accessToken: "cfg-secret-token" }],
          },
        }),
        "utf8"
      );
      process.env.ROSMONTIS_ACCESS_TOKEN = "";
      process.env.ONEBOT_ACCESS_TOKEN = "";
      const loadedEmptyEnv = mainMod.loadBridgeConfig(tmpCfgDir);
      assert.strictEqual(loadedEmptyEnv.httpServers[0].accessToken, "cfg-secret-token");
      assert.strictEqual(loadedEmptyEnv.wsServers[0].accessToken, "cfg-secret-token");
      assert.strictEqual(loadedEmptyEnv.wsClients[0].accessToken, "cfg-secret-token");

      process.env.ROSMONTIS_ACCESS_TOKEN = "env-override-token";
      const loadedOverride = mainMod.loadBridgeConfig(tmpCfgDir);
      assert.strictEqual(loadedOverride.httpServers[0].accessToken, "env-override-token");
      assert.strictEqual(loadedOverride.wsServers[0].accessToken, "env-override-token");
      assert.strictEqual(loadedOverride.wsClients[0].accessToken, "env-override-token");
    } finally {
      if (prevRosTok === undefined) delete process.env.ROSMONTIS_ACCESS_TOKEN;
      else process.env.ROSMONTIS_ACCESS_TOKEN = prevRosTok;
      if (prevObTok === undefined) delete process.env.ONEBOT_ACCESS_TOKEN;
      else process.env.ONEBOT_ACCESS_TOKEN = prevObTok;
      fs.rmSync(tmpCfgDir, { recursive: true, force: true });
    }

    // 13b. Outbound sendEcho rejects cross-type echoes (image/poke vs text) and matches concurrent images by md5
    {
      let echoBridge = null;
      echoBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_self",
        online: true,
        config: {
          httpServers: [],
          wsServers: [],
          wsClients: [],
          heartbeatIntervalMs: 0,
          humanSimulation: false,
          sendEchoTimeoutMs: 120,
        },
        rendererExecute: async (cmd, args) => {
          const payload = args[0];
          if (cmd === "nodeIKernelMsgService/copyFileWithDelExifInfo") {
            return { errorMsg: "skip" };
          }
          if (cmd === "nodeIKernelMsgService/getRichMediaFilePathForGuild") {
            return { path: "" };
          }
          if (cmd === "nodeIKernelMsgService/sendMsg") {
            const firstEl = payload.msgElements[0];
            if (firstEl && firstEl.elementType === 1) {
              // Foreign image & poke echoes arrive first; neither may hijack our text waiter
              await echoBridge._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                {
                  msgRecord: {
                    msgId: "7700000000000000901",
                    msgSeq: "91",
                    chatType: 1,
                    peerUid: "u_friend",
                    senderUid: "u_self",
                    senderUin: "100010001",
                    elements: [{ elementType: 2, picElement: { md5HexStr: "deadbeef", fileName: "other.png" } }],
                  },
                },
              ]);
              await echoBridge._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                {
                  msgRecord: {
                    msgId: "7700000000000000902",
                    msgSeq: "92",
                    chatType: 1,
                    peerUid: "u_friend",
                    senderUid: "u_self",
                    senderUin: "100010001",
                    elements: [],
                  },
                },
              ]);
              setTimeout(() => {
                echoBridge
                  ._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                    {
                      msgRecord: {
                        msgId: "7700000000000000101",
                        msgSeq: "101",
                        chatType: 1,
                        peerUid: "u_friend",
                        senderUid: "u_self",
                        senderUin: "100010001",
                        elements: payload.msgElements,
                      },
                    },
                  ])
                  .catch(() => {});
              }, 15);
            }
            return { result: 0, errMsg: "" };
          }
          throw new Error(`unexpected cmd ${cmd}`);
        },
      });
      echoBridge.uinUidStore.record("100020002", "u_friend");
      const textRes = await echoBridge.handleOneBotAction("send_private_msg", {
        user_id: 100020002,
        message: "纯文本消息",
      });
      assert.strictEqual(textRes.data.real_id, "7700000000000000101");

      // Direct waiter out-of-order correlation for two distinct images
      const peer = { chatType: 1, peerUid: "u_friend" };
      const wImgA = echoBridge._registerSendEchoWaiter(peer, [
        { elementType: 2, picElement: { md5HexStr: "aaaa1111", fileName: "a.png", picSubType: 0 } },
      ]);
      const wImgB = echoBridge._registerSendEchoWaiter(peer, [
        { elementType: 2, picElement: { md5HexStr: "bbbb2222", fileName: "b.png", picSubType: 0 } },
      ]);
      // Foreign text echo must match neither image waiter
      assert.strictEqual(
        echoBridge._matchSendEcho({
          msgId: "7700000000000000903",
          msgSeq: "93",
          chatType: 1,
          peerUid: "u_friend",
          elements: [{ elementType: 1, textElement: { content: "干扰文本", atType: 0 } }],
        }),
        false
      );
      // Image B arrives before Image A
      assert.strictEqual(
        echoBridge._matchSendEcho({
          msgId: "7700000000000000202",
          msgSeq: "202",
          chatType: 1,
          peerUid: "u_friend",
          elements: [{ elementType: 2, picElement: { md5HexStr: "BBBB2222", fileName: "b.png", picSubType: 0 } }],
        }),
        true
      );
      assert.strictEqual(
        echoBridge._matchSendEcho({
          msgId: "7700000000000000201",
          msgSeq: "201",
          chatType: 1,
          peerUid: "u_friend",
          elements: [{ elementType: 2, picElement: { md5HexStr: "aaaa1111", fileName: "a.png", picSubType: 0 } }],
        }),
        true
      );
      assert.strictEqual((await wImgA.wait(50)).msgId, "7700000000000000201");
      assert.strictEqual((await wImgB.wait(50)).msgId, "7700000000000000202");
    }

    // 13c. _sendPokeInternal must NOT replay via sendPoke / sendMsg when sendNudge was already dispatched
    {
      const pokeCmds = [];
      const dispatchedFailBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_self",
        online: true,
        config: { httpServers: [], wsServers: [], wsClients: [], heartbeatIntervalMs: 0, humanSimulation: false },
        rendererExecute: async (cmd) => {
          pokeCmds.push(cmd);
          throw new Error("invokeNtApi timeout (15000ms): nodeIKernelMsgService/sendNudge");
        },
      });
      dispatchedFailBridge.uinUidStore.record("100020002", "u_friend");
      const pokeFailResp = await dispatchedFailBridge.handleOneBotAction("send_poke", {
        group_id: 654321,
        user_id: 100020002,
      });
      assert.strictEqual(pokeFailResp.status, "failed");
      assert.deepStrictEqual(pokeCmds, ["nodeIKernelMsgService/sendNudge"]);

      // When sendNudge & sendPoke are genuinely unavailable, fallback to sendMsg poke faceElement still works
      const fallbackCmds = [];
      const fallbackBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_self",
        online: true,
        config: { httpServers: [], wsServers: [], wsClients: [], heartbeatIntervalMs: 0, humanSimulation: false },
        rendererExecute: async (cmd) => {
          fallbackCmds.push(cmd);
          if (cmd === "nodeIKernelMsgService/sendNudge" || cmd === "nodeIKernelMsgService/sendPoke") {
            throw new Error("ROSMONTIS_BRIDGE_UNAVAILABLE: handler missing");
          }
          return { result: 0, errMsg: "" };
        },
      });
      fallbackBridge.uinUidStore.record("100020002", "u_friend");
      const pokeOkResp = await fallbackBridge.handleOneBotAction("send_poke", {
        group_id: 654321,
        user_id: 100020002,
      });
      assert.strictEqual(pokeOkResp.status, "ok");
      assert.deepStrictEqual(fallbackCmds, [
        "nodeIKernelMsgService/sendNudge",
        "nodeIKernelMsgService/sendPoke",
        "nodeIKernelMsgService/sendMsg",
      ]);
    }

    // 13d & 13e. HTTP null/non-object JSON body and Forward WS abrupt socket errors must never throw unhandled errors
    {
      let unhandled = null;
      const onUnhandled = (err) => {
        unhandled = err;
      };
      process.on("unhandledRejection", onUnhandled);
      process.on("uncaughtException", onUnhandled);

      const netBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_self",
        online: true,
        config: {
          httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
          wsServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
          wsClients: [],
          heartbeatIntervalMs: 0,
          humanSimulation: false,
        },
      });
      await netBridge.startServers();
      try {
        const httpPort = netBridge._httpServers[0].address().port;
        const wsPort = netBridge._wsServers[0].address().port;

        const postRaw = (urlPath, rawBody) =>
          new Promise((resolve, reject) => {
            const req = http.request(
              {
                hostname: "127.0.0.1",
                port: httpPort,
                path: urlPath,
                method: "POST",
                headers: { "Content-Type": "application/json" },
              },
              (res) => {
                const bufs = [];
                res.on("data", (c) => bufs.push(c));
                res.on("end", () =>
                  resolve({ statusCode: res.statusCode, json: JSON.parse(Buffer.concat(bufs).toString("utf8")) })
                );
              }
            );
            req.on("error", reject);
            req.end(rawBody);
          });

        const rNullAction = await postRaw("/get_status?foo=bar", "null");
        assert.strictEqual(rNullAction.statusCode, 200);
        assert.strictEqual(rNullAction.json.status, "ok");

        const rNullRoot = await postRaw("/", "null");
        assert.strictEqual(rNullRoot.statusCode, 200);
        assert.strictEqual(rNullRoot.json.status, "failed");

        const rPrim = await postRaw("/get_status", "123");
        assert.strictEqual(rPrim.json.status, "ok");

        const rArr = await postRaw("/get_status", "[1,2,3]");
        assert.strictEqual(rArr.json.status, "ok");

        const rNullNested = await postRaw("/", JSON.stringify({ action: "get_status", params: null }));
        assert.strictEqual(rNullNested.json.status, "ok");

        // Upgrade Forward WebSocket client and trigger socket error + TCP reset
        const clientSock = net.connect(wsPort, "127.0.0.1");
        await new Promise((resolve, reject) => {
          const secKey = crypto.randomBytes(16).toString("base64");
          let buf = "";
          clientSock.on("connect", () => {
            clientSock.write(
              [
                "GET / HTTP/1.1",
                `Host: 127.0.0.1:${wsPort}`,
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Key: ${secKey}`,
                "Sec-WebSocket-Version: 13",
                "",
                "",
              ].join("\r\n")
            );
          });
          clientSock.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            if (buf.includes("101 Switching Protocols")) resolve();
          });
          clientSock.on("error", reject);
        });

        assert.strictEqual(netBridge._wsServerClients.size, 1);
        const srvConn = Array.from(netBridge._wsServerClients)[0];
        // Directly emit a socket error on the server-side upgraded socket (simulating ECONNRESET)
        srvConn.socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
        clientSock.destroy();
        await new Promise((r) => setTimeout(r, 30));

        assert.strictEqual(netBridge._wsServerClients.size, 0, "errored Forward WS client must be evicted");
        assert.strictEqual(unhandled, null, `Unexpected unhandled error: ${unhandled}`);
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
        process.removeListener("uncaughtException", onUnhandled);
        await netBridge.stopServers();
      }
    }
  });

  console.log("=== 14. Testing Session Causal State Machine, AIO Concurrency Mutex, Idle Exit & XIAO_BRIDGE_* Compat ===");
  await check("Strict causal order, slow-image AIO anti-thrashing, set_input_status re-entry, two-stage idle exit/blur, dynamic rich-media echo timeout & XIAO_BRIDGE_* env compat", async () => {
    const oneByOnePng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );

    // Helper: create a bridge wired to a real renderer bridge instance over simulated IPC
    function createCausalTestHarness(configOverrides = {}, { echoDelayMs = 5 } = {}) {
      const ipcCalls = [];
      const mainListeners = new Map();
      let currentActivePeerKey = "";
      let nextRealMsgCounter = 1;
      let bridgeRef = null;

      const fakeIpcRenderer = {
        send(channel, meta, data) {
          if (channel === "__ROSMONTIS_BRIDGE_EVENT__") return;
          if (meta?.eventName === "ntApi" && data?.cmdType === "invoke") {
            const cmd = data.cmdName;
            const arg0 = Array.isArray(data.payload) ? data.payload[0] : data.payload;
            if (cmd === "nodeIKernelMsgService/enterOrExitAio") {
              const p = arg0?.info?.peer;
              const pKey = p ? `${p.chatType}:${p.peerUid}:${p.guildId || ""}` : "";
              if (arg0?.info?.enterType === 1) {
                currentActivePeerKey = pKey;
              } else if (arg0?.info?.enterType === 2 && currentActivePeerKey === pKey) {
                currentActivePeerKey = "";
              }
            }
            ipcCalls.push({
              tier: 1,
              cmd,
              payload: arg0,
              activeAtCall: currentActivePeerKey,
              at: Date.now(),
            });

            const onMain = mainListeners.get(`RM_IPCFROM_MAIN${meta.peerId || 1}`);
            if (typeof onMain === "function" && meta.callbackId) {
              setImmediate(() => {
                let resultPayload = { result: 0, errMsg: "" };
                if (cmd === "nodeIKernelMsgService/copyFileWithDelExifInfo") {
                  resultPayload = { result: 0, errMsg: "", newPath: arg0?.sourcePath || "" };
                }
                onMain(
                  {},
                  {
                    callbackId: meta.callbackId,
                    promiseStatue: "full",
                    type: "response",
                    eventName: "ntApi",
                    peerId: meta.peerId || 1,
                  },
                  resultPayload
                );

                if (cmd === "nodeIKernelMsgService/sendMsg" && bridgeRef) {
                  const realId = `7699000000000000${String(nextRealMsgCounter++).padStart(3, "0")}`;
                  const delay = typeof echoDelayMs === "function" ? echoDelayMs(arg0) : echoDelayMs;
                  const t = setTimeout(() => {
                    bridgeRef._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                      {
                        msgId: realId,
                        msgSeq: String(1000 + nextRealMsgCounter),
                        msgTime: Math.floor(Date.now() / 1000),
                        chatType: arg0.peer.chatType,
                        peerUid: arg0.peer.peerUid,
                        senderUid: "u_rosmontis_self",
                        senderUin: "100010001",
                        elements: arg0.msgElements,
                      },
                    ]);
                  }, delay);
                  if (typeof t.unref === "function") t.unref();
                }
              });
            }
          }
        },
        on(ch, fn) {
          mainListeners.set(ch, fn);
        },
      };

      const rBridge = rendererMod.installRendererBridge(
        {
          webContentId: 1,
          location: { search: "?webcontentsid=1" },
          ipcRenderer: fakeIpcRenderer,
          document: { querySelector: () => null },
        },
        { forceReinstall: true, autoRegisterListeners: false }
      );

      const bridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_rosmontis_self",
        rendererExecute: (cmd, args) => rBridge.invokeNtApi(cmd, args),
        rendererSimulateSession: (opts) => rBridge.simulateHumanSessionFlow(opts),
        rendererLeaveSession: (opts) => rBridge.leaveHumanSessionFlow(opts),
        config: {
          selfUin: "100010001",
          httpServers: [],
          wsServers: [],
          wsClients: [],
          humanSimulation: true,
          dedupeWindowMs: 5000,
          aioIdleExitMs: 45000,
          focusIdleBlurMs: 300000,
          sendEchoTimeoutMs: 1000,
          richMediaEchoTimeoutMs: 3000,
          cleanupTempImmediately: true,
          ...configOverrides,
        },
      });
      bridgeRef = bridge;

      // Also wire Tier 2 fallback proxy to verify Tier 1 <-> Tier 2 state sync
      bridge.capturedServices.ntApi = new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop !== "string" || !prop.includes("/")) return undefined;
            return async (payload) => {
              if (prop === "nodeIKernelMsgService/enterOrExitAio") {
                const p = payload?.info?.peer;
                const pKey = p ? `${p.chatType}:${p.peerUid}:${p.guildId || ""}` : "";
                if (payload?.info?.enterType === 1) {
                  currentActivePeerKey = pKey;
                } else if (payload?.info?.enterType === 2 && currentActivePeerKey === pKey) {
                  currentActivePeerKey = "";
                }
              }
              ipcCalls.push({
                tier: 2,
                cmd: prop,
                payload,
                activeAtCall: currentActivePeerKey,
                at: Date.now(),
              });
              if (prop === "nodeIKernelMsgService/sendMsg") {
                return {
                  result: 0,
                  errMsg: "",
                  msgId: `7699990000000000${String(nextRealMsgCounter++).padStart(3, "0")}`,
                };
              }
              return { result: 0, errMsg: "" };
            };
          },
        }
      );

      bridge.uinUidStore.record("100020002", "u_uid_u1");
      bridge.uinUidStore.record("100030003", "u_uid_u2");
      return { bridge, rBridge, ipcCalls, getCurrentActivePeerKey: () => currentActivePeerKey };
    }

    // ------------------------------------------------------------------------
    // (1) Strict Causal Order + Tier 1 / Tier 2 Single-Source State Sync
    // ------------------------------------------------------------------------
    {
      const { bridge, rBridge, ipcCalls } = createCausalTestHarness();
      try {
        const res1 = await bridge.handleOneBotAction("send_private_msg", {
          user_id: 100020002,
          message: "first causal message",
        });
        assert.strictEqual(res1.status, "ok");

        assert.deepStrictEqual(
          ipcCalls.map((c) => c.cmd),
          [
            "nodeIKernelMsgService/setFocusOnBase",
            "nodeIKernelMsgService/addActiveChatByUid",
            "nodeIKernelMsgService/enterOrExitAio",
            "nodeIKernelMsgService/setMsgRead",
            "nodeIKernelMsgService/sendMsg",
          ],
          "Direct send_private_msg must strictly follow setFocusOnBase(true) -> addActiveChatByUid -> enterOrExitAio(1) -> setMsgRead -> sendMsg without a 0ms sendShowInputStatusReq"
        );
        assert.deepStrictEqual(ipcCalls[0].payload, { isFocus: true });
        assert.strictEqual(ipcCalls[2].payload.info.enterType, 1);
        assert.strictEqual(ipcCalls[2].payload.info.peer.peerUid, "u_uid_u1");

        // Switch to second session (Group 888002): must exit U1 first, addActiveChatByUid(G2), enterOrExitAio(G2, 1), without repeating setFocusOnBase(true)
        ipcCalls.length = 0;
        const res2 = await bridge.handleOneBotAction("send_group_msg", {
          group_id: 888002,
          message: "second session message",
        });
        assert.strictEqual(res2.status, "ok");
        assert.deepStrictEqual(
          ipcCalls.map((c) => c.cmd),
          [
            "nodeIKernelMsgService/enterOrExitAio",
            "nodeIKernelMsgService/addActiveChatByUid",
            "nodeIKernelMsgService/enterOrExitAio",
            "nodeIKernelMsgService/setMsgRead",
            "nodeIKernelMsgService/sendMsg",
          ],
          "Switching session must exit old AIO -> addActiveChatByUid(new) -> enterOrExitAio(new, 1) without repeating setFocusOnBase(true)"
        );
        assert.strictEqual(ipcCalls[0].payload.info.enterType, 2);
        assert.strictEqual(ipcCalls[0].payload.info.peer.peerUid, "u_uid_u1");
        assert.strictEqual(ipcCalls[2].payload.info.enterType, 1);
        assert.strictEqual(ipcCalls[2].payload.info.peer.peerUid, "888002");

        // Simulate temporary Tier 2 degradation switching to Group 888003, then Tier 1 recovery back to Group 888002
        bridge.rendererSimulateSession = null;
        bridge.rendererExecute = null;
        ipcCalls.length = 0;
        await bridge.handleOneBotAction("send_group_msg", {
          group_id: 888003,
          message: "tier2 degraded switch",
        });
        assert.strictEqual(ipcCalls[0].tier, 2);
        assert.strictEqual(ipcCalls[0].cmd, "nodeIKernelMsgService/enterOrExitAio");
        assert.strictEqual(ipcCalls[0].payload.info.peer.peerUid, "888002");
        assert.strictEqual(ipcCalls[0].payload.info.enterType, 2);

        // Restore Tier 1 renderer (whose local state was still stuck on 888002 before sync!) and send to 888002
        bridge.rendererExecute = (cmd, args) => rBridge.invokeNtApi(cmd, args);
        bridge.rendererSimulateSession = (opts) => rBridge.simulateHumanSessionFlow(opts);
        ipcCalls.length = 0;
        await bridge.handleOneBotAction("send_group_msg", {
          group_id: 888002,
          message: "tier1 recovered switch back to 888002",
        });
        assert.strictEqual(ipcCalls[0].tier, 1);
        assert.strictEqual(ipcCalls[0].cmd, "nodeIKernelMsgService/enterOrExitAio");
        assert.strictEqual(
          ipcCalls[0].payload.info.peer.peerUid,
          "888003",
          "Tier 1 must sync knownActivePeer from main process and exit 888003"
        );
        assert.strictEqual(ipcCalls[0].payload.info.enterType, 2);
        assert.strictEqual(ipcCalls[2].cmd, "nodeIKernelMsgService/enterOrExitAio");
        assert.strictEqual(ipcCalls[2].payload.info.peer.peerUid, "888002");
        assert.strictEqual(ipcCalls[2].payload.info.enterType, 1);
      } finally {
        await bridge.stopServers();
      }
    }

    // ------------------------------------------------------------------------
    // (2) Slow Remote Image Concurrency Anti-Thrashing (Core Regression Test)
    // ------------------------------------------------------------------------
    {
      let imageServedAt = 0;
      const slowImgServer = http.createServer((_req, res) => {
        setTimeout(() => {
          imageServedAt = Date.now();
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Content-Length": oneByOnePng.length,
          });
          res.end(oneByOnePng);
        }, 120);
      });
      await new Promise((resolve) => slowImgServer.listen(0, "127.0.0.1", resolve));
      const slowPort = slowImgServer.address().port;
      const { bridge, ipcCalls } = createCausalTestHarness({ allowPrivateUrls: true });

      try {
        // Group A starts sending a slow remote image (120ms HTTP download)
        const groupAPromise = bridge.handleOneBotAction("send_group_msg", {
          group_id: 900001,
          message: [{ type: "image", data: { file: `http://127.0.0.1:${slowPort}/slow.png` } }],
        });

        // 10ms later, Group B sends a plain text message
        await new Promise((r) => setTimeout(r, 10));
        const groupBResp = await bridge.handleOneBotAction("send_group_msg", {
          group_id: 900002,
          message: "fast text in group B",
        });
        const groupBDoneAt = Date.now();
        assert.strictEqual(groupBResp.status, "ok");
        assert.strictEqual(
          imageServedAt,
          0,
          `Group B must finish (${groupBDoneAt}) without waiting for Group A's 120ms slow image download`
        );

        const groupAResp = await groupAPromise;
        assert.strictEqual(groupAResp.status, "ok");

        const sendCalls = ipcCalls.filter((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
        assert.strictEqual(sendCalls.length, 2);
        assert.strictEqual(
          sendCalls[0].payload.peer.peerUid,
          "900002",
          "Group B sendMsg must dispatch first"
        );
        assert.strictEqual(
          sendCalls[1].payload.peer.peerUid,
          "900001",
          "Group A sendMsg must dispatch after slow image finishes"
        );

        for (const sc of sendCalls) {
          const expectedKey = `${sc.payload.peer.chatType}:${sc.payload.peer.peerUid}:${sc.payload.peer.guildId || ""}`;
          assert.strictEqual(
            sc.activeAtCall,
            expectedKey,
            `sendMsg(${expectedKey}) must NEVER fire while active AIO is '${sc.activeAtCall}'`
          );
        }

        // Verify between sendMsg(Group B) and sendMsg(Group A): enterOrExitAio(B, 2) -> addActiveChatByUid(A) -> enterOrExitAio(A, 1)
        const idxSendB = ipcCalls.indexOf(sendCalls[0]);
        const idxSendA = ipcCalls.indexOf(sendCalls[1]);
        const betweenCmds = ipcCalls.slice(idxSendB + 1, idxSendA);
        const exitBIdx = betweenCmds.findIndex(
          (c) =>
            c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
            c.payload.info.peer.peerUid === "900002" &&
            c.payload.info.enterType === 2
        );
        const enterAIdx = betweenCmds.findIndex(
          (c) =>
            c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
            c.payload.info.peer.peerUid === "900001" &&
            c.payload.info.enterType === 1
        );
        assert.ok(exitBIdx >= 0, "Must exit Group B AIO after Group A finishes downloading image");
        assert.ok(enterAIdx > exitBIdx, "Must enter Group A AIO after exiting Group B AIO and before sendMsg(Group A)");
      } finally {
        await bridge.stopServers();
        await new Promise((resolve) => slowImgServer.close(resolve));
      }
    }

    // ------------------------------------------------------------------------
    // (3) set_input_status Preempted by Cross-Group Message -> Auto Re-Entry
    // ------------------------------------------------------------------------
    {
      const { bridge, ipcCalls } = createCausalTestHarness();
      try {
        // Private U1 triggers set_input_status
        const st = await bridge.handleOneBotAction("set_input_status", {
          user_id: 100020002,
          event_type: 1,
        });
        assert.strictEqual(st.status, "ok");

        // Group G1 sends a message and preempts AIO away from U1
        const g1 = await bridge.handleOneBotAction("send_group_msg", {
          group_id: 900011,
          message: "group preemption",
        });
        assert.strictEqual(g1.status, "ok");

        // Private U1 now sends the actual message -> must exit G1 and re-enter U1 before sendMsg!
        ipcCalls.length = 0;
        const u1Send = await bridge.handleOneBotAction("send_private_msg", {
          user_id: 100020002,
          message: "reply after typing preemption",
        });
        assert.strictEqual(u1Send.status, "ok");

        const exitG1Idx = ipcCalls.findIndex(
          (c) =>
            c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
            c.payload.info.peer.peerUid === "900011" &&
            c.payload.info.enterType === 2
        );
        const enterU1Idx = ipcCalls.findIndex(
          (c) =>
            c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
            c.payload.info.peer.peerUid === "u_uid_u1" &&
            c.payload.info.enterType === 1
        );
        const sendU1Idx = ipcCalls.findIndex((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
        assert.ok(exitG1Idx >= 0, "Must exit preempting group G1 before sending private message");
        assert.ok(enterU1Idx > exitG1Idx, "Must re-enter private U1 AIO after exiting G1");
        assert.ok(sendU1Idx > enterU1Idx, "sendMsg(U1) must follow re-entering U1 AIO");
      } finally {
        await bridge.stopServers();
      }
    }

    // ------------------------------------------------------------------------
    // (4) Two-Stage Idle Exit (60ms) & Window Blur (140ms) + Offline Cleanup
    // ------------------------------------------------------------------------
    {
      const { bridge, ipcCalls } = createCausalTestHarness({
        aioIdleExitMs: 60,
        focusIdleBlurMs: 140,
      });
      try {
        await bridge.handleOneBotAction("send_group_msg", {
          group_id: 900021,
          message: "hello before idle",
        });
        ipcCalls.length = 0;

        // Wait 90ms (> 60ms aioIdleExitMs, < 140ms focusIdleBlurMs)
        await new Promise((r) => setTimeout(r, 90));
        assert.strictEqual(
          ipcCalls.some(
            (c) =>
              c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
              c.payload.info.peer.peerUid === "900021" &&
              c.payload.info.enterType === 2
          ),
          true,
          "Must auto-exit AIO after aioIdleExitMs (60ms)"
        );
        assert.strictEqual(
          ipcCalls.some(
            (c) => c.cmd === "nodeIKernelMsgService/setFocusOnBase" && c.payload.isFocus === false
          ),
          false,
          "Window must still remain focused before focusIdleBlurMs (140ms)"
        );

        // Wait until 175ms total (> 140ms focusIdleBlurMs)
        await new Promise((r) => setTimeout(r, 85));
        assert.strictEqual(
          ipcCalls.some(
            (c) => c.cmd === "nodeIKernelMsgService/setFocusOnBase" && c.payload.isFocus === false
          ),
          true,
          "Must auto-blur window via setFocusOnBase({ isFocus: false }) after focusIdleBlurMs (140ms)"
        );
        assert.strictEqual(
          ipcCalls.filter(
            (c) => c.cmd === "nodeIKernelMsgService/enterOrExitAio" && c.payload.info.enterType === 2
          ).length,
          1,
          "Must not emit duplicate enterOrExitAio(2) when blur timer fires"
        );

        // Subsequent message must re-focus window first
        ipcCalls.length = 0;
        await bridge.handleOneBotAction("send_group_msg", {
          group_id: 900021,
          message: "wake up from blur",
        });
        assert.strictEqual(ipcCalls[0].cmd, "nodeIKernelMsgService/setFocusOnBase");
        assert.deepStrictEqual(ipcCalls[0].payload, { isFocus: true });
        assert.strictEqual(ipcCalls[1].cmd, "nodeIKernelMsgService/addActiveChatByUid");
        assert.strictEqual(ipcCalls[2].cmd, "nodeIKernelMsgService/enterOrExitAio");
        assert.strictEqual(ipcCalls[2].payload.info.enterType, 1);

        // Verify onKickedOffLine clears active AIO, focus state, and idle timers
        assert.ok(bridge._activeAioPeer !== null);
        assert.strictEqual(bridge._windowFocused, true);
        await bridge._handleKernelEvent("nodeIKernelLoginListener", "onKickedOffLine", [
          { tipsTitle: "Kicked", tipsDesc: "Session expired" },
        ]);
        assert.strictEqual(bridge._activeAioPeer, null);
        assert.strictEqual(bridge._activeAioPeerKey, "");
        assert.strictEqual(bridge._windowFocused, false);
        assert.strictEqual(bridge._aioIdleTimer, null);
        assert.strictEqual(bridge._focusBlurTimer, null);
      } finally {
        await bridge.stopServers();
      }
    }

    // ------------------------------------------------------------------------
    // (5) Dynamic Rich-Media Echo Timeout (Rich Media > Default Text Timeout)
    // ------------------------------------------------------------------------
    {
      // Text timeout = 50ms, Rich-media timeout = 220ms, simulated kernel echo delay = 110ms
      const { bridge, ipcCalls } = createCausalTestHarness(
        {
          sendEchoTimeoutMs: 50,
          richMediaEchoTimeoutMs: 220,
        },
        { echoDelayMs: 110 }
      );
      try {
        // Plain text message exceeds 50ms -> times out to synthetic sent_*
        const txtResp = await bridge.handleOneBotAction("send_group_msg", {
          group_id: 900031,
          message: "plain text with 110ms echo",
        });
        assert.strictEqual(txtResp.status, "ok");
        const txtStored = bridge.messageIdStore.getByShortId(txtResp.data.message_id);
        assert.ok(
          String(txtStored?.msgId || "").startsWith("sent_"),
          "Plain text exceeding sendEchoTimeoutMs (50ms) should fall back to sent_*"
        );

        // Wait for delayed text echo to pass before sending rich media
        await new Promise((r) => setTimeout(r, 40));

        // Image message uses richMediaEchoTimeoutMs (220ms > 110ms) -> captures real msgId and supports delete_msg!
        const imgResp = await bridge.handleOneBotAction("send_group_msg", {
          group_id: 900031,
          message: [
            {
              type: "image",
              data: { file: `base64://${oneByOnePng.toString("base64")}` },
            },
          ],
        });
        assert.strictEqual(imgResp.status, "ok");
        const imgStored = bridge.messageIdStore.getByShortId(imgResp.data.message_id);
        assert.ok(
          imgStored && /^7699\d+$/.test(String(imgStored.msgId)),
          `Rich media message must resolve real onAddSendMsg msgId instead of sent_*, got: ${imgStored?.msgId}`
        );

        const delResp = await bridge.handleOneBotAction("delete_msg", {
          message_id: imgResp.data.message_id,
        });
        assert.strictEqual(delResp.status, "ok");
        assert.ok(
          ipcCalls.some(
            (c) =>
              c.cmd === "nodeIKernelMsgService/recallMsg" &&
              Array.isArray(c.payload.msgIds) &&
              c.payload.msgIds[0] === imgStored.msgId
          ),
          "delete_msg must recall the real msgId of the rich-media message"
        );
      } finally {
        await bridge.stopServers();
      }
    }

    // ------------------------------------------------------------------------
    // (6) Upstream XIAO_BRIDGE_* Environment Variable Alias Compatibility
    // ------------------------------------------------------------------------
    {
      const savedEnv = {};
      const envKeys = [
        "ROSMONTIS_DISABLE",
        "ROSMONTIS_BRIDGE_DISABLE",
        "XIAO_BRIDGE_DISABLE",
        "ROSMONTIS_SELF_ID",
        "ONEBOT_SELF_ID",
        "XIAO_BRIDGE_SELF_ID",
        "ROSMONTIS_HTTP_PORT",
        "ONEBOT_HTTP_PORT",
        "XIAO_BRIDGE_HTTP_PORT",
        "ROSMONTIS_WS_PORT",
        "ONEBOT_WS_PORT",
        "XIAO_BRIDGE_WS_PORT",
        "ROSMONTIS_REVERSE_WS_URL",
        "ONEBOT_REVERSE_WS_URL",
        "XIAO_BRIDGE_REVERSE_WS_URL",
        "ROSMONTIS_ACCESS_TOKEN",
        "ONEBOT_ACCESS_TOKEN",
        "XIAO_BRIDGE_ACCESS_TOKEN",
        "ROSMONTIS_KEEP_MAP_HOOK",
        "XIAO_BRIDGE_KEEP_MAP_HOOK",
        "ROSMONTIS_TEMP_DIR",
        "XIAO_BRIDGE_TEMP_DIR",
      ];
      for (const k of envKeys) savedEnv[k] = process.env[k];
      const emptyCfgDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis-xiao-env-"));
      const customTempDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis-xiao-tmp-"));

      try {
        for (const k of envKeys) delete process.env[k];

        // XIAO_BRIDGE_DISABLE=1 bypasses bootBridgeMain()
        process.env.XIAO_BRIDGE_DISABLE = "1";
        const launcher = require("../src/app_launcher_index.js");
        assert.strictEqual(launcher.bootBridgeMain(), null);
        delete process.env.XIAO_BRIDGE_DISABLE;

        // XIAO_BRIDGE_* fallbacks in loadBridgeConfig
        process.env.XIAO_BRIDGE_SELF_ID = "3956798580";
        process.env.XIAO_BRIDGE_HTTP_PORT = "13000";
        process.env.XIAO_BRIDGE_WS_PORT = "13001";
        process.env.XIAO_BRIDGE_REVERSE_WS_URL = "ws://127.0.0.1:18080/onebot/v11/ws";
        process.env.XIAO_BRIDGE_ACCESS_TOKEN = "xiao_legacy_token";

        const cfgLegacy = mainMod.loadBridgeConfig(emptyCfgDir);
        assert.strictEqual(cfgLegacy.selfUin, "3956798580");
        assert.strictEqual(cfgLegacy.httpServers[0].port, 13000);
        assert.strictEqual(cfgLegacy.wsServers[0].port, 13001);
        assert.strictEqual(cfgLegacy.wsClients[0].url, "ws://127.0.0.1:18080/onebot/v11/ws");
        assert.strictEqual(cfgLegacy.wsClients[0].accessToken, "xiao_legacy_token");

        // Priority check: ROSMONTIS_* > ONEBOT_* > XIAO_BRIDGE_*
        process.env.ONEBOT_HTTP_PORT = "14000";
        assert.strictEqual(mainMod.loadBridgeConfig(emptyCfgDir).httpServers[0].port, 14000);
        process.env.ROSMONTIS_HTTP_PORT = "15000";
        assert.strictEqual(mainMod.loadBridgeConfig(emptyCfgDir).httpServers[0].port, 15000);

        // XIAO_BRIDGE_KEEP_MAP_HOOK=1 disables Map hook release
        process.env.XIAO_BRIDGE_KEEP_MAP_HOOK = "1";
        const b = new mainMod.NtqqOneBotBridge({
          config: { httpServers: [], wsServers: [], wsClients: [] },
        });
        assert.strictEqual(b._mapHookReleaseDisabled(), true);

        // XIAO_BRIDGE_TEMP_DIR fallback in resolveMediaSource
        process.env.XIAO_BRIDGE_TEMP_DIR = customTempDir;
        const media = await onebot.resolveMediaSource(`base64://${oneByOnePng.toString("base64")}`);
        assert.strictEqual(path.dirname(media.localPath), customTempDir);
      } finally {
        for (const k of envKeys) {
          if (savedEnv[k] === undefined) delete process.env[k];
          else process.env[k] = savedEnv[k];
        }
        try {
          fs.rmSync(emptyCfgDir, { recursive: true, force: true });
          fs.rmSync(customTempDir, { recursive: true, force: true });
        } catch (_) {}
      }
    }
  });

  console.log("=== 15. Testing Transport, Auth, Origin Guard, Protected Mode, Body Cap & RFC 6455 WS Hardening ===");
  await check("Constant-time token auth (Bearer/Token/raw/query & allowQueryAccessToken: false), Origin guard, Protected Mode auto-token, HTTP 413 body cap, and RFC 6455 WS hardening", async () => {
    const transportSec = require("../src/core/transport_security.js");

    // 1. Unit-level constant-time token verification
    assert.strictEqual(transportSec.verifyAccessTokenConstantTime("", ""), true);
    assert.strictEqual(transportSec.verifyAccessTokenConstantTime("", "secret"), false);
    assert.strictEqual(transportSec.verifyAccessTokenConstantTime(null, "secret"), false);
    assert.strictEqual(transportSec.verifyAccessTokenConstantTime("short", "much_longer_secret_token"), false);
    assert.strictEqual(transportSec.verifyAccessTokenConstantTime("exact_secret_123", "exact_secret_123"), true);

    const httpRequestRaw = ({ port, urlPath = "/get_status", method = "POST", headers = {}, body = "{}" }) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: urlPath,
            method,
            headers: {
              "Content-Type": "application/json",
              ...headers,
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const rawText = Buffer.concat(chunks).toString("utf8");
              let json = null;
              try {
                json = JSON.parse(rawText);
              } catch (_) {}
              resolve({ statusCode: res.statusCode, json, rawText });
            });
          }
        );
        req.on("error", reject);
        req.end(body);
      });

    // 2. HTTP token formats (Bearer, Token, raw header, query param) + Origin guard + 413 body cap + WS hardening
    {
      const secBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_self",
        online: true,
        config: {
          allowedOrigins: ["https://admin.rosmontis.local"],
          maxHttpBodyBytes: 1024,
          maxWsPayloadBytes: 256,
          httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "s3cr3t_t0k3n" }],
          wsServers: [{ host: "127.0.0.1", port: 0, accessToken: "s3cr3t_t0k3n" }],
          wsClients: [],
          heartbeatIntervalMs: 0,
          humanSimulation: false,
        },
      });
      await secBridge.startServers();
      try {
        const httpPort = secBridge._httpServers[0].address().port;
        const wsPort = secBridge._wsServers[0].address().port;

        // Missing / wrong token -> 401
        const rNoAuth = await httpRequestRaw({ port: httpPort });
        assert.strictEqual(rNoAuth.statusCode, 401);
        assert.strictEqual(rNoAuth.json.status, "failed");
        assert.strictEqual(rNoAuth.json.retcode, 1403);

        const rBadAuth = await httpRequestRaw({
          port: httpPort,
          headers: { Authorization: "Bearer wrong_token" },
        });
        assert.strictEqual(rBadAuth.statusCode, 401);

        // Bearer, Token, raw header, and ?access_token= query param -> 200
        const rBearer = await httpRequestRaw({
          port: httpPort,
          headers: { Authorization: "Bearer s3cr3t_t0k3n" },
        });
        assert.strictEqual(rBearer.statusCode, 200);
        assert.strictEqual(rBearer.json.status, "ok");

        const rTokenScheme = await httpRequestRaw({
          port: httpPort,
          headers: { Authorization: "Token s3cr3t_t0k3n" },
        });
        assert.strictEqual(rTokenScheme.statusCode, 200);
        assert.strictEqual(rTokenScheme.json.status, "ok");

        const rRawHdr = await httpRequestRaw({
          port: httpPort,
          headers: { Authorization: "s3cr3t_t0k3n" },
        });
        assert.strictEqual(rRawHdr.statusCode, 200);
        assert.strictEqual(rRawHdr.json.status, "ok");

        const rQuery = await httpRequestRaw({
          port: httpPort,
          urlPath: "/get_status?access_token=s3cr3t_t0k3n",
        });
        assert.strictEqual(rQuery.statusCode, 200);
        assert.strictEqual(rQuery.json.status, "ok");

        // Origin guard on HTTP POST: no Origin -> 200; evil.example or null -> 403; allowedOrigins -> 200
        const rEvilOrigin = await httpRequestRaw({
          port: httpPort,
          headers: {
            Authorization: "Bearer s3cr3t_t0k3n",
            Origin: "http://evil.example",
          },
        });
        assert.strictEqual(rEvilOrigin.statusCode, 403);
        assert.strictEqual(rEvilOrigin.json.status, "failed");
        assert.strictEqual(rEvilOrigin.json.retcode, 1403);

        const rNullOrigin = await httpRequestRaw({
          port: httpPort,
          headers: {
            Authorization: "Bearer s3cr3t_t0k3n",
            Origin: "null",
          },
        });
        assert.strictEqual(rNullOrigin.statusCode, 403);
        assert.strictEqual(rNullOrigin.json.status, "failed");
        assert.strictEqual(rNullOrigin.json.retcode, 1403);

        const rAllowedOrigin = await httpRequestRaw({
          port: httpPort,
          headers: {
            Authorization: "Bearer s3cr3t_t0k3n",
            Origin: "https://ADMIN.rosmontis.local",
          },
        });
        assert.strictEqual(rAllowedOrigin.statusCode, 200);
        assert.strictEqual(rAllowedOrigin.json.status, "ok");

        // HTTP JSON body size cap: maxHttpBodyBytes: 1024 rejects 4096-byte payload with 413 (retcode 1413)
        const bigBody = JSON.stringify({ padding: "x".repeat(4096) });
        const rTooLarge = await httpRequestRaw({
          port: httpPort,
          headers: { Authorization: "Bearer s3cr3t_t0k3n" },
          body: bigBody,
        });
        assert.strictEqual(rTooLarge.statusCode, 413);
        assert.strictEqual(rTooLarge.json.status, "failed");
        assert.strictEqual(rTooLarge.json.retcode, 1413);

        // Also test streaming chunked body without Content-Length exceeding 1024 bytes -> 413
        const rChunkedTooLarge = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port: httpPort,
              path: "/get_status",
              method: "POST",
              headers: {
                Authorization: "Bearer s3cr3t_t0k3n",
                "Content-Type": "application/json",
                "Transfer-Encoding": "chunked",
              },
            },
            (res) => {
              const bufs = [];
              res.on("data", (c) => bufs.push(c));
              res.on("end", () => {
                resolve({
                  statusCode: res.statusCode,
                  json: JSON.parse(Buffer.concat(bufs).toString("utf8")),
                });
              });
            }
          );
          req.on("error", reject);
          req.write('{"pad":"' + "a".repeat(600));
          req.write("b".repeat(600) + '"}');
          req.end();
        });
        assert.strictEqual(rChunkedTooLarge.statusCode, 413);
        assert.strictEqual(rChunkedTooLarge.json.retcode, 1413);

        // WS upgrade with untrusted Origin receives HTTP/1.1 403 Forbidden
        const wsForbiddenResp = await new Promise((resolve, reject) => {
          const sock = net.connect(wsPort, "127.0.0.1");
          let raw = "";
          sock.on("connect", () => {
            const secKey = crypto.randomBytes(16).toString("base64");
            sock.write(
              [
                "GET / HTTP/1.1",
                `Host: 127.0.0.1:${wsPort}`,
                "Upgrade: websocket",
                "Connection: Upgrade",
                "Authorization: Bearer s3cr3t_t0k3n",
                "Origin: http://evil.example",
                `Sec-WebSocket-Key: ${secKey}`,
                "Sec-WebSocket-Version: 13",
                "",
                "",
              ].join("\r\n")
            );
          });
          sock.on("data", (c) => {
            raw += c.toString("utf8");
          });
          sock.on("close", () => resolve(raw));
          sock.on("error", reject);
        });
        assert.ok(
          wsForbiddenResp.startsWith("HTTP/1.1 403 Forbidden"),
          `Expected WS 403 Forbidden on untrusted Origin, got: ${wsForbiddenResp}`
        );

        // Helper to upgrade a raw WS client and observe protocol close code
        const openRawUpgradedWs = () =>
          new Promise((resolve, reject) => {
            const sock = net.connect(wsPort, "127.0.0.1");
            let buf = Buffer.alloc(0);
            let upgraded = false;
            const onData = (chunk) => {
              if (upgraded) return;
              buf = Buffer.concat([buf, chunk]);
              const sep = buf.indexOf("\r\n\r\n");
              if (sep === -1) return;
              const headerText = buf.subarray(0, sep).toString("utf8");
              const rest = buf.subarray(sep + 4);
              upgraded = true;
              sock.removeListener("data", onData);
              assert.ok(headerText.includes("101 Switching Protocols"));
              const clientConn = new mainMod.Rfc6455Connection(sock, { isClient: true });
              if (rest.length > 0) clientConn._onData(rest);
              resolve({ sock, clientConn });
            };
            sock.on("data", onData);
            sock.on("connect", () => {
              const secKey = crypto.randomBytes(16).toString("base64");
              sock.write(
                [
                  "GET / HTTP/1.1",
                  `Host: 127.0.0.1:${wsPort}`,
                  "Upgrade: websocket",
                  "Connection: Upgrade",
                  "Authorization: Bearer s3cr3t_t0k3n",
                  "Origin: https://admin.rosmontis.local",
                  `Sec-WebSocket-Key: ${secKey}`,
                  "Sec-WebSocket-Version: 13",
                  "",
                  "",
                ].join("\r\n")
              );
            });
            sock.on("error", reject);
          });

        // RFC 6455 hardening (a): Unmasked client-to-server frame triggers Close 1002
        {
          const { sock, clientConn } = await openRawUpgradedWs();
          const closePromise = new Promise((resolve) => {
            clientConn.once("close", (code, reason) => resolve({ code, reason }));
          });
          // Send UNMASKED frame (mask = false) from client to server
          sock.write(mainMod.encodeWsFrame(0x1, Buffer.from('{"action":"get_status"}'), false));
          const closeInfo = await closePromise;
          assert.strictEqual(closeInfo.code, 1002, `Expected Close 1002 for unmasked frame, got ${closeInfo.code}`);
          sock.destroy();
        }

        // RFC 6455 hardening (b): Oversized WS frame (> maxWsPayloadBytes = 256) triggers Close 1009 immediately
        {
          const { sock, clientConn } = await openRawUpgradedWs();
          const closePromise = new Promise((resolve) => {
            clientConn.once("close", (code, reason) => resolve({ code, reason }));
          });
          // Send masked 1024-byte frame exceeding 256-byte limit
          sock.write(mainMod.encodeWsFrame(0x1, Buffer.alloc(1024, 0x41), true));
          const closeInfo = await closePromise;
          assert.strictEqual(closeInfo.code, 1009, `Expected Close 1009 for oversized frame, got ${closeInfo.code}`);
          sock.destroy();
        }
      } finally {
        await secBridge.stopServers();
      }
    }

    // 3. allowQueryAccessToken: false rejects ?access_token= query tokens while allowing Authorization header
    {
      const noQueryBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_self",
        online: true,
        config: {
          allowQueryAccessToken: false,
          httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "hdr_only_tok" }],
          wsServers: [],
          wsClients: [],
          heartbeatIntervalMs: 0,
          humanSimulation: false,
        },
      });
      await noQueryBridge.startServers();
      try {
        const port = noQueryBridge._httpServers[0].address().port;
        const rQueryBlocked = await httpRequestRaw({
          port,
          urlPath: "/get_status?access_token=hdr_only_tok",
        });
        assert.strictEqual(rQueryBlocked.statusCode, 401);
        assert.strictEqual(rQueryBlocked.json.retcode, 1403);

        const rHdrAllowed = await httpRequestRaw({
          port,
          headers: { Authorization: "Bearer hdr_only_tok" },
        });
        assert.strictEqual(rHdrAllowed.statusCode, 200);
        assert.strictEqual(rHdrAllowed.json.status, "ok");
      } finally {
        await noQueryBridge.stopServers();
      }
    }

    // 4. Protected Mode auto-token: 127.0.0.1 stays unauthenticated; 0.0.0.0 auto-generates 64-hex token
    {
      const savedPubEnv = {
        a: process.env.ROSMONTIS_ALLOW_UNAUTHENTICATED_PUBLIC,
        b: process.env.ONEBOT_ALLOW_UNAUTHENTICATED_PUBLIC,
        c: process.env.XIAO_BRIDGE_ALLOW_UNAUTHENTICATED_PUBLIC,
      };
      delete process.env.ROSMONTIS_ALLOW_UNAUTHENTICATED_PUBLIC;
      delete process.env.ONEBOT_ALLOW_UNAUTHENTICATED_PUBLIC;
      delete process.env.XIAO_BRIDGE_ALLOW_UNAUTHENTICATED_PUBLIC;

      const loopbackBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        online: true,
        config: {
          httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
          wsServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
          wsClients: [],
          heartbeatIntervalMs: 0,
          humanSimulation: false,
        },
      });
      const publicBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        online: true,
        config: {
          httpServers: [{ host: "0.0.0.0", port: 0, accessToken: "" }],
          wsServers: [{ host: "0.0.0.0", port: 0, accessToken: "" }],
          wsClients: [],
          heartbeatIntervalMs: 0,
          humanSimulation: false,
        },
      });
      // Silence stderr warning during intentional Protected Mode test
      const origStderrWrite = process.stderr.write;
      const capturedWarnings = [];
      process.stderr.write = function (chunk, ...rest) {
        const s = String(chunk || "");
        if (s.includes("Protected Mode engaged")) {
          capturedWarnings.push(s);
          return true;
        }
        return origStderrWrite.call(process.stderr, chunk, ...rest);
      };
      try {
        await loopbackBridge.startServers();
        assert.strictEqual(loopbackBridge.config.httpServers[0].accessToken, "");
        assert.strictEqual(Boolean(loopbackBridge.config.httpServers[0].protectedModeAutoToken), false);
        const loopPort = loopbackBridge._httpServers[0].address().port;
        const rLoop = await httpRequestRaw({ port: loopPort });
        assert.strictEqual(rLoop.statusCode, 200);

        await publicBridge.startServers();
        const generatedToken = publicBridge.config.httpServers[0].accessToken;
        assert.match(generatedToken, /^[0-9a-f]{64}$/, "Expected 64-hex-char Protected Mode auto-token");
        assert.strictEqual(publicBridge.config.httpServers[0].protectedModeAutoToken, true);
        assert.strictEqual(publicBridge.config.wsServers[0].accessToken, generatedToken);
        assert.strictEqual(capturedWarnings.length, 1);

        const pubPort = publicBridge._httpServers[0].address().port;
        const rPubUnauth = await httpRequestRaw({ port: pubPort });
        assert.strictEqual(rPubUnauth.statusCode, 401);

        const rPubAuth = await httpRequestRaw({
          port: pubPort,
          headers: { Authorization: `Bearer ${generatedToken}` },
        });
        assert.strictEqual(rPubAuth.statusCode, 200);
        assert.strictEqual(rPubAuth.json.status, "ok");
      } finally {
        process.stderr.write = origStderrWrite;
        if (savedPubEnv.a !== undefined) process.env.ROSMONTIS_ALLOW_UNAUTHENTICATED_PUBLIC = savedPubEnv.a;
        if (savedPubEnv.b !== undefined) process.env.ONEBOT_ALLOW_UNAUTHENTICATED_PUBLIC = savedPubEnv.b;
        if (savedPubEnv.c !== undefined) process.env.XIAO_BRIDGE_ALLOW_UNAUTHENTICATED_PUBLIC = savedPubEnv.c;
        await loopbackBridge.stopServers();
        await publicBridge.stopServers();
      }
    }

    // 5. CRLF header injection attempt in connectReverseWebSocket is sanitized / rejected safely
    {
      // (a) Invalid header name with CRLF is rejected immediately without opening a socket
      let invalidHdrErr = null;
      const badHandle = mainMod.connectReverseWebSocket(
        "ws://127.0.0.1:65530/ws",
        { "X-Bad\r\nHeader": "injected" },
        () => {},
        () => {},
        (err) => {
          invalidHdrErr = err;
        }
      );
      assert.strictEqual(badHandle, null);
      assert.ok(invalidHdrErr && invalidHdrErr.code === "ERR_INVALID_HTTP_HEADER");

      // (b) Header value containing CRLF injection attempt has \r\n stripped before hitting the wire
      let capturedUpgradeRaw = "";
      const inspectSrv = net.createServer((sock) => {
        sock.on("data", (chunk) => {
          capturedUpgradeRaw += chunk.toString("utf8");
          if (capturedUpgradeRaw.includes("\r\n\r\n")) {
            sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          }
        });
      });
      await new Promise((resolve) => inspectSrv.listen(0, "127.0.0.1", resolve));
      const inspectPort = inspectSrv.address().port;
      try {
        await new Promise((resolve) => {
          mainMod.connectReverseWebSocket(
            `ws://127.0.0.1:${inspectPort}/onebot`,
            {
              Authorization: "Bearer safe_tok\r\nX-Injected-Evil: pwned\r\n\r\nGET /smuggled HTTP/1.1",
              "X-Role": "Universal\r\nEvil-Two: 1",
            },
            () => resolve(),
            () => {},
            () => resolve()
          );
        });
        const headerLines = capturedUpgradeRaw.split("\r\n");
        assert.strictEqual(
          headerLines.some((line) => /^x-injected-evil:/i.test(line) || /^evil-two:/i.test(line) || /^GET \/smuggled/i.test(line)),
          false,
          `CRLF injection leaked separate header lines: ${JSON.stringify(headerLines)}`
        );
        assert.ok(
          headerLines.some((line) => line.startsWith("Authorization: Bearer safe_tokX-Injected-Evil: pwned")),
          "Sanitized Authorization header should have CRLF stripped cleanly"
        );
      } finally {
        await new Promise((resolve) => inspectSrv.close(resolve));
      }
    }
  });

  console.log("=== 16. Testing Electron IPC Spoofing Defense, Structured CMD/ACK Channel & Web Credential Gate ===");
  await check("_isTrustedIpcEvent blocks spoofed renderer events, __ROSMONTIS_BRIDGE_CMD__ executes without per-call executeJavaScript, and all 11 WEB_CREDENTIAL_ACTIONS default to 1403", async () => {
    const vm = require("vm");
    const { WEB_CREDENTIAL_ACTIONS } = require("../src/core/qzone_actions.js");

    // 1 & 2. _isTrustedIpcEvent spoofing checks + structured __ROSMONTIS_BRIDGE_CMD__ / __ROSMONTIS_BRIDGE_CMD_ACK__ round-trips
    {
      const ipcMainListeners = new Map();
      const ipcMainHandlers = new Map();
      const appListeners = new Map();
      const fakeElectron = {
        app: {
          on(ev, fn) {
            appListeners.set(ev, fn);
          },
        },
        ipcMain: {
          on(ch, fn) {
            ipcMainListeners.set(ch, fn);
          },
          handle(ch, fn) {
            ipcMainHandlers.set(ch, fn);
          },
        },
        webContents: {
          getAllWebContents: () => [],
        },
      };

      const bridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_rosmontis_self",
        config: {
          selfUin: "100010001",
          httpServers: [],
          wsServers: [],
          wsClients: [],
          humanSimulation: true,
          dedupeWindowMs: 5000,
        },
      });
      bridge.uinUidStore.record("100020002", "u_ipc_peer");
      assert.strictEqual(bridge.installElectronHooks(fakeElectron), true);

      const mainFrameObj = { id: "frame-main" };
      const childSubFrameObj = { id: "frame-sub-iframe" };
      let currentRendererUrl = "app://./renderer/index.html#/main/message";
      let executeJsCount = 0;

      const rendererIpcListeners = new Map();
      const ntKernelCalls = [];
      let fakeWebContents = null;

      const fakeIpcRenderer = {
        on(ch, fn) {
          rendererIpcListeners.set(ch, fn);
        },
        removeListener(ch, fn) {
          if (rendererIpcListeners.get(ch) === fn) rendererIpcListeners.delete(ch);
        },
        send(ch, metaOrPayload, maybeData) {
          if (ch === "__ROSMONTIS_BRIDGE_EVENT__") {
            const onEv = ipcMainListeners.get("__ROSMONTIS_BRIDGE_EVENT__");
            if (onEv) {
              onEv({ sender: fakeWebContents, senderFrame: mainFrameObj }, metaOrPayload);
            }
            return;
          }
          if (ch === "__ROSMONTIS_BRIDGE_CMD_ACK__") {
            const onAck = ipcMainListeners.get("__ROSMONTIS_BRIDGE_CMD_ACK__");
            if (onAck) {
              onAck({ sender: fakeWebContents, senderFrame: mainFrameObj }, metaOrPayload);
            }
            return;
          }
          if (ch === "RM_IPCFROM_RENDERER1" && metaOrPayload?.eventName === "ntApi" && maybeData?.cmdType === "invoke") {
            const cmd = maybeData.cmdName;
            const arg0 = Array.isArray(maybeData.payload) ? maybeData.payload[0] : maybeData.payload;
            ntKernelCalls.push({ cmd, payload: arg0 });
            const onMain = rendererIpcListeners.get("RM_IPCFROM_MAIN1");
            if (typeof onMain === "function" && metaOrPayload.callbackId) {
              setImmediate(() => {
                let result = { result: 0, errMsg: "" };
                if (cmd === "nodeIKernelGroupService/getGroupList") {
                  result = {
                    groupList: [
                      { groupCode: "777001", groupName: "IPC测试群", memberCount: 12, maxMember: 200 },
                    ],
                  };
                }
                onMain(
                  {},
                  {
                    callbackId: metaOrPayload.callbackId,
                    promiseStatue: "full",
                    type: "response",
                    eventName: "ntApi",
                    peerId: 1,
                  },
                  result
                );
              });
            }
          }
        },
      };

      const fakeWindow = {
        webContentId: 1,
        location: { search: "?webcontentsid=1" },
        ipcRenderer: fakeIpcRenderer,
        document: { querySelector: () => null },
        crypto,
      };

      const wcEvents = new EventEmitter();
      fakeWebContents = Object.assign(wcEvents, {
        id: 1,
        mainFrame: mainFrameObj,
        isDestroyed: () => false,
        getURL: () => currentRendererUrl,
        send(ch, payload) {
          const fn = rendererIpcListeners.get(ch);
          if (typeof fn === "function") {
            fn({}, payload);
          }
        },
        executeJavaScript(code) {
          executeJsCount += 1;
          const sandbox = {
            window: fakeWindow,
            crypto,
            setTimeout,
            clearTimeout,
            URLSearchParams,
          };
          return Promise.resolve(vm.runInNewContext(code, sandbox));
        },
      });

      try {
        // Trigger web-contents-created + did-finish-load bootstrap injection
        appListeners.get("web-contents-created")({}, fakeWebContents);
        fakeWebContents.emit("did-finish-load");
        await new Promise((r) => setImmediate(r));

        assert.strictEqual(fakeWebContents.__rosmontisIpcTokenInjected, true);
        assert.strictEqual(fakeWebContents.__rosmontisCmdChannelReady, true);
        assert.strictEqual(executeJsCount, 1, "Bootstrap should run executeJavaScript once on load");
        // Verify ipcAuthToken is NOT exposed on window.__ROSMONTIS_RENDERER_BRIDGE__
        assert.strictEqual(fakeWindow.__ROSMONTIS_RENDERER_BRIDGE__.__ipcToken, undefined);
        assert.strictEqual(fakeWindow.__ROSMONTIS_RENDERER_BRIDGE__.ipcAuthToken, undefined);
        assert.strictEqual(
          Object.keys(fakeWindow.__ROSMONTIS_RENDERER_BRIDGE__).includes("setIpcAuthToken"),
          false
        );

        // Reset executeJsCount to prove zero per-message executeJavaScript calls afterward!
        executeJsCount = 0;

        // Structured IPC round-trip 1: invokeNt via get_group_list
        const grpResp = await bridge.handleOneBotAction("get_group_list", {});
        assert.strictEqual(grpResp.status, "ok");
        assert.strictEqual(grpResp.data.length, 1);
        assert.strictEqual(grpResp.data[0].group_id, 777001);
        assert.strictEqual(executeJsCount, 0, "invokeNt must use __ROSMONTIS_BRIDGE_CMD__ without executeJavaScript");
        assert.strictEqual(bridge.invokeStats.tier1 >= 1, true);
        assert.strictEqual(bridge.invokeStats.degraded, 0);

        // Structured IPC round-trip 2: simulateSession via set_input_status
        ntKernelCalls.length = 0;
        const typingResp = await bridge.handleOneBotAction("set_input_status", {
          user_id: 100020002,
          event_type: 1,
        });
        assert.strictEqual(typingResp.status, "ok");
        assert.strictEqual(executeJsCount, 0, "simulateSession must use __ROSMONTIS_BRIDGE_CMD__ without executeJavaScript");
        assert.deepStrictEqual(
          ntKernelCalls.map((c) => c.cmd),
          [
            "nodeIKernelMsgService/setFocusOnBase",
            "nodeIKernelMsgService/addActiveChatByUid",
            "nodeIKernelMsgService/enterOrExitAio",
            "nodeIKernelMsgService/setMsgRead",
            "nodeIKernelMsgService/sendShowInputStatusReq",
          ]
        );

        // Test _isTrustedIpcEvent & __ROSMONTIS_BRIDGE_EVENT__ spoofing vectors
        const emittedEvents = [];
        bridge.on("onebot_event", (ev) => emittedEvents.push(ev));
        const onBridgeEvent = ipcMainListeners.get("__ROSMONTIS_BRIDGE_EVENT__");

        const makeFakeRecvPayload = (msgId, token) => ({
          cmdName: "nodeIKernelMsgListener/onRecvMsg",
          eventName: "ntApi",
          ...(token !== undefined ? { __ipcToken: token } : {}),
          payload: [
            [
              {
                msgId,
                msgSeq: "501",
                msgTime: "1710000000",
                chatType: 1,
                msgType: 2,
                peerUid: "u_ipc_peer",
                senderUid: "u_ipc_peer",
                senderUin: "100020002",
                sendNickName: "Doctor",
                elements: [{ elementType: 1, textElement: { content: "spoof check" } }],
              },
            ],
          ],
        });

        // Spoof 1: Unknown webContents
        const unknownWc = { id: 99, mainFrame: mainFrameObj, isDestroyed: () => false, getURL: () => currentRendererUrl };
        onBridgeEvent({ sender: unknownWc, senderFrame: mainFrameObj }, makeFakeRecvPayload("spoof_1", bridge._ipcAuthToken));

        // Spoof 2: Subframe (senderFrame !== sender.mainFrame)
        onBridgeEvent(
          { sender: fakeWebContents, senderFrame: childSubFrameObj },
          makeFakeRecvPayload("spoof_2", bridge._ipcAuthToken)
        );

        // Spoof 3: Untrusted https://evil.example URL
        currentRendererUrl = "https://evil.example/malicious.html";
        onBridgeEvent(
          { sender: fakeWebContents, senderFrame: mainFrameObj },
          makeFakeRecvPayload("spoof_3", bridge._ipcAuthToken)
        );
        currentRendererUrl = "app://./renderer/index.html#/main/message";

        // Spoof 4: Wrong or missing __ipcToken
        onBridgeEvent(
          { sender: fakeWebContents, senderFrame: mainFrameObj },
          makeFakeRecvPayload("spoof_4a", "wrong_forged_ipc_token")
        );
        onBridgeEvent(
          { sender: fakeWebContents, senderFrame: mainFrameObj },
          makeFakeRecvPayload("spoof_4b", undefined)
        );

        await new Promise((r) => setImmediate(r));
        assert.strictEqual(emittedEvents.length, 0, "All 4 spoofed IPC vectors must emit zero OneBot events");

        // Valid mainFrame event from injected renderer (via RM_IPCFROM_MAIN1 -> forwardToMain with sealed ipcAuthToken)
        rendererIpcListeners.get("RM_IPCFROM_MAIN1")(
          {},
          { eventName: "ntApi", peerId: 1 },
          {
            cmdName: "nodeIKernelMsgListener/onRecvMsg",
            cmdType: "event",
            payload: [
              [
                {
                  msgId: "valid_ipc_9001",
                  msgSeq: "502",
                  msgTime: "1710000005",
                  chatType: 1,
                  msgType: 2,
                  peerUid: "u_ipc_peer",
                  senderUid: "u_ipc_peer",
                  senderUin: "100020002",
                  sendNickName: "Doctor",
                  elements: [{ elementType: 1, textElement: { content: "legitimate message" } }],
                },
              ],
            ],
          }
        );
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(emittedEvents.length, 1, "Legitimate mainFrame IPC event with valid __ipcToken must be processed");
        assert.strictEqual(emittedEvents[0].raw_message, "legitimate message");
      } finally {
        await bridge.stopServers();
      }
    }

    // 3. All 11 WEB_CREDENTIAL_ACTIONS return status: "failed", retcode: 1403 by default,
    //    while get_rkey remains accessible and get_essence_msg_list / _get_group_notice fall back to NT kernel APIs
    {
      assert.strictEqual(WEB_CREDENTIAL_ACTIONS.size, 11);
      const calledKernelCmds = [];
      const defaultBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_rosmontis_self",
        ntApi: new Proxy(
          {},
          {
            get(_t, prop) {
              if (typeof prop !== "string" || !prop.includes("/")) return undefined;
              return async (payload) => {
                calledKernelCmds.push(prop);
                if (prop === "nodeIKernelUnitedConfigService/loadUnitedConfig") {
                  return { configData: { content: "&rkey=test_cdn_rkey_123" } };
                }
                if (prop === "nodeIKernelGroupService/getGroupLatestEssenceList") {
                  return { msgList: [{ msg_seq: 88, sender_uin: "100020002" }] };
                }
                if (prop === "nodeIKernelGroupService/getGroupBulletin") {
                  return {
                    feeds: [{ feedId: "notice_1", msg: { text: "NT内核群公告" } }],
                  };
                }
                return { result: 0, errMsg: "" };
              };
            },
          }
        ),
        config: {
          selfUin: "100010001",
          httpServers: [],
          wsServers: [],
          wsClients: [],
        },
      });

      try {
        for (const action of WEB_CREDENTIAL_ACTIONS) {
          const resp = await defaultBridge.handleOneBotAction(action, {
            domain: "qun.qq.com",
            content: "test",
            tid: "t1",
          });
          assert.strictEqual(resp.status, "failed", `Expected ${action} to fail when gated`);
          assert.strictEqual(resp.retcode, 1403, `Expected ${action} retcode === 1403, got ${resp.retcode}`);
        }

        const rkeyResp = await defaultBridge.handleOneBotAction("get_rkey", {});
        assert.strictEqual(rkeyResp.status, "ok");
        assert.strictEqual(rkeyResp.retcode, 0);
        assert.strictEqual(rkeyResp.data.rkeys.length, 2);
        assert.strictEqual(rkeyResp.data.rkeys[0].rkey, "&rkey=test_cdn_rkey_123");

        const essenceResp = await defaultBridge.handleOneBotAction("get_essence_msg_list", {
          group_id: 654321,
        });
        assert.strictEqual(essenceResp.status, "ok");
        assert.strictEqual(Array.isArray(essenceResp.data), true);
        assert.strictEqual(essenceResp.data.length, 1);
        assert.ok(calledKernelCmds.includes("nodeIKernelGroupService/getGroupLatestEssenceList"));

        const noticeResp = await defaultBridge.handleOneBotAction("_get_group_notice", {
          group_id: 654321,
        });
        assert.strictEqual(noticeResp.status, "ok");
        assert.strictEqual(Array.isArray(noticeResp.data), true);
        assert.strictEqual(noticeResp.data[0].feedId, "notice_1");
        assert.ok(calledKernelCmds.includes("nodeIKernelGroupService/getGroupBulletin"));
      } finally {
        await defaultBridge.stopServers();
      }
    }
  });

  console.log("=== 17. Testing Causal Session Scheduler, Peer-Affinity Mutex, Auto-Read Cooldown & messageFormat ===");
  await check("Full private-chat causal timeline, CausalSessionScheduler peer-affinity & maxAffinityStreak, autoReadAndTypeOnPrivateRecv coalescing/cooldown, and messageFormat string vs array", async () => {
    const { CausalSessionScheduler } = require("../src/core/session_scheduler.js");

    function createPrivateCausalBridge(cfgOverrides = {}) {
      const calls = [];
      const bridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_rosmontis_self",
        ntApi: new Proxy(
          {},
          {
            get(_t, prop) {
              if (typeof prop !== "string" || !prop.includes("/")) return undefined;
              return async (payload) => {
                calls.push({ cmd: prop, payload, at: Date.now() });
                if (prop === "nodeIKernelMsgService/sendMsg") {
                  return { result: 0, errMsg: "", msgId: `7700000000000000${calls.length}` };
                }
                return { result: 0, errMsg: "" };
              };
            },
          }
        ),
        config: {
          selfUin: "100010001",
          httpServers: [],
          wsServers: [],
          wsClients: [],
          humanSimulation: true,
          dedupeWindowMs: 5000,
          aioSwitchCooldownMs: 0,
          ...cfgOverrides,
        },
      });
      bridge.uinUidStore.record("100020002", "u_priv_1");
      bridge.uinUidStore.record("100030003", "u_priv_2");
      bridge.uinUidStore.record("100040004", "u_priv_3");
      return { bridge, calls };
    }

    // 1a. Full private-chat causal timeline: recv -> set_input_status -> LLM gap -> send_private_msg
    {
      const { bridge, calls } = createPrivateCausalBridge({ autoReadAndTypeOnPrivateRecv: false });
      try {
        await bridge._handleKernelEvent("nodeIKernelMsgListener", "onRecvMsg", [
          [
            {
              msgId: "c_in_1",
              msgSeq: "101",
              msgTime: "1710000100",
              chatType: 1,
              msgType: 2,
              peerUid: "u_priv_1",
              senderUid: "u_priv_1",
              senderUin: "100020002",
              sendNickName: "Doctor",
              elements: [{ elementType: 1, textElement: { content: "在吗迷迭香？" } }],
            },
          ],
        ]);
        assert.strictEqual(calls.length, 0, "Passive receipt with autoReadAndTypeOnPrivateRecv=false should not invoke AIO commands yet");

        // Step 2: set_input_status -> focus -> activeChat -> enterAio(1) -> setMsgRead -> sendShowInputStatusReq
        const stRes = await bridge.handleOneBotAction("set_input_status", {
          user_id: 100020002,
          event_type: 1,
        });
        assert.strictEqual(stRes.status, "ok");
        assert.deepStrictEqual(
          calls.map((c) => c.cmd),
          [
            "nodeIKernelMsgService/setFocusOnBase",
            "nodeIKernelMsgService/addActiveChatByUid",
            "nodeIKernelMsgService/enterOrExitAio",
            "nodeIKernelMsgService/setMsgRead",
            "nodeIKernelMsgService/sendShowInputStatusReq",
          ]
        );

        // Step 3: LLM generation gap
        await new Promise((r) => setTimeout(r, 30));

        // Step 4: send_private_msg -> sendMsg directly on already-active peer with NO redundant enterOrExitAio and NO 0ms sendShowInputStatusReq
        calls.length = 0;
        const sendRes = await bridge.handleOneBotAction("send_private_msg", {
          user_id: 100020002,
          message: "我在的，博士。",
        });
        assert.strictEqual(sendRes.status, "ok");
        assert.deepStrictEqual(
          calls.map((c) => c.cmd),
          ["nodeIKernelMsgService/sendMsg"],
          "send_private_msg on already-active session must invoke sendMsg directly with zero redundant enterOrExitAio or 0ms sendShowInputStatusReq"
        );
      } finally {
        await bridge.stopServers();
      }
    }

    // 1b. "Typed then deleted / chose not to reply" path: set_input_status runs, send_private_msg is NEVER called -> clean idle exit/blur & zero leaks
    {
      const { bridge, calls } = createPrivateCausalBridge({
        aioIdleExitMs: 45,
        focusIdleBlurMs: 95,
      });
      try {
        await bridge.handleOneBotAction("set_input_status", {
          user_id: 100020002,
          event_type: 1,
        });
        assert.strictEqual(bridge._activeAioPeerKey, "1:u_priv_1:");
        assert.strictEqual(bridge._windowFocused, true);

        // Never call send_private_msg; let idle timers settle cleanly
        await new Promise((r) => setTimeout(r, 135));

        assert.strictEqual(bridge._activeAioPeerKey, "");
        assert.strictEqual(bridge._windowFocused, false);
        assert.strictEqual(bridge._sendEchoWaiters.size, 0);
        assert.strictEqual(bridge._sessionScheduler.pendingReactionCount, 0);
        assert.ok(
          calls.some(
            (c) =>
              c.cmd === "nodeIKernelMsgService/enterOrExitAio" &&
              c.payload?.info?.enterType === 2 &&
              c.payload?.info?.peer?.peerUid === "u_priv_1"
          ),
          "Unanswered typing session must cleanly exit AIO after idle timeout"
        );
        assert.ok(
          calls.some(
            (c) => c.cmd === "nodeIKernelMsgService/setFocusOnBase" && c.payload?.isFocus === false
          ),
          "Unanswered typing session must cleanly blur window after focus idle timeout"
        );
      } finally {
        await bridge.stopServers();
      }
    }

    // 2. Peer-affinity mutex scheduling (CausalSessionScheduler) + maxAffinityStreak anti-starvation
    {
      let activePeer = "A";
      const scheduler = new CausalSessionScheduler({
        getActivePeerKey: () => activePeer,
        maxAffinityStreak: 2,
      });
      try {
        // (a) Peer A holds lock; [B1, A2, B2] queue up while activePeer === "A" -> A2 runs BEFORE B1!
        const order1 = [];
        let releaseA1;
        const holdA1 = new Promise((r) => {
          releaseA1 = r;
        });

        const pA1 = scheduler.runExclusive("A", async () => {
          order1.push("A1");
          await holdA1;
        });
        const pB1 = scheduler.runExclusive("B", async () => {
          activePeer = "B";
          order1.push("B1");
        });
        const pA2 = scheduler.runExclusive("A", async () => {
          activePeer = "A";
          order1.push("A2");
        });
        const pB2 = scheduler.runExclusive("B", async () => {
          activePeer = "B";
          order1.push("B2");
        });

        releaseA1();
        await Promise.all([pA1, pB1, pA2, pB2]);
        assert.deepStrictEqual(
          order1,
          ["A1", "A2", "B1", "B2"],
          "A2 must execute before B1 while activePeerKey === 'A' to eliminate A->B->A->B ping-pong"
        );

        // (b) maxAffinityStreak: 2 prevents starvation when [B1, A2, A3, A4] queue behind A1
        activePeer = "A";
        const order2 = [];
        let releaseFirst;
        const holdFirst = new Promise((r) => {
          releaseFirst = r;
        });

        const qA1 = scheduler.runExclusive("A", async () => {
          order2.push("A1");
          await holdFirst;
        });
        const qB1 = scheduler.runExclusive("B", async () => {
          activePeer = "B";
          order2.push("B1");
        });
        const qA2 = scheduler.runExclusive("A", async () => {
          activePeer = "A";
          order2.push("A2");
        });
        const qA3 = scheduler.runExclusive("A", async () => {
          activePeer = "A";
          order2.push("A3");
        });
        const qA4 = scheduler.runExclusive("A", async () => {
          activePeer = "A";
          order2.push("A4");
        });

        releaseFirst();
        await Promise.all([qA1, qB1, qA2, qA3, qA4]);
        assert.deepStrictEqual(
          order2,
          ["A1", "A2", "A3", "B1", "A4"],
          "After maxAffinityStreak=2 consecutive affinity picks (A2, A3), B1 must run before A4 to prevent starvation"
        );
      } finally {
        scheduler.dispose();
      }
    }

    // 3. High-frequency switch cooldown & autoReadAndTypeOnPrivateRecv (burst coalescing, immediate cancel, cooldown skip)
    {
      // Keep event loop alive while awaiting serverless sleepUnref(humanReadToTypingDelayMs); cleared in finally
      const keepAlive = setInterval(() => {}, 1000);
      const { bridge, calls } = createPrivateCausalBridge({
        autoReadAndTypeOnPrivateRecv: true,
        autoReadReactionDelayMs: 35,
        humanReadToTypingDelayMs: 10,
        aioSwitchCooldownMs: 400,
      });
      try {
        const pushPrivRecv = (msgId, peerUid, uin, text) =>
          bridge._handleKernelEvent("nodeIKernelMsgListener", "onRecvMsg", [
            [
              {
                msgId,
                msgSeq: msgId.replace(/\D+/g, "") || "1",
                msgTime: String(Math.floor(Date.now() / 1000)),
                chatType: 1,
                msgType: 2,
                peerUid,
                senderUid: peerUid,
                senderUin: uin,
                sendNickName: "Friend",
                elements: [{ elementType: 1, textElement: { content: text } }],
              },
            ],
          ]);

        // (a) Rapid 3-message burst from u_priv_1 coalesces into 1 delayed read+typing reaction
        await pushPrivRecv("burst_1", "u_priv_1", "100020002", "msg 1");
        await pushPrivRecv("burst_2", "u_priv_1", "100020002", "msg 2");
        await pushPrivRecv("burst_3", "u_priv_1", "100020002", "msg 3");
        assert.strictEqual(bridge._sessionScheduler.pendingReactionCount, 1);
        assert.strictEqual(calls.length, 0, "Auto-read reaction must wait for reaction delay");

        await new Promise((r) => setTimeout(r, 80));
        assert.strictEqual(bridge._sessionScheduler.pendingReactionCount, 0);
        const readCalls = calls.filter((c) => c.cmd === "nodeIKernelMsgService/setMsgRead");
        const typingCalls = calls.filter((c) => c.cmd === "nodeIKernelMsgService/sendShowInputStatusReq");
        assert.strictEqual(readCalls.length, 1, "Coalesced burst must mark read once");
        assert.strictEqual(typingCalls.length, 1, "Coalesced burst must send typing once");
        assert.ok(typingCalls[0].at >= readCalls[0].at, "sendShowInputStatusReq must occur after setMsgRead");

        // Wait for 400ms cooldown from u_priv_1 switch to expire before testing cancel on u_priv_2 / u_priv_3
        bridge._sessionScheduler.lastSwitchAt = Date.now() - 1000;

        // (b) Immediate cancellation when send_private_msg or set_input_status runs first
        bridge.config.autoReadReactionDelayMs = 80;
        calls.length = 0;
        await pushPrivRecv("cancel_by_send", "u_priv_2", "100030003", "fast reply test");
        assert.strictEqual(bridge._sessionScheduler.hasPendingReaction("1:u_priv_2:"), true);

        const fastReply = await bridge.handleOneBotAction("send_private_msg", {
          user_id: 100030003,
          message: "秒回消息",
        });
        assert.strictEqual(fastReply.status, "ok");
        assert.strictEqual(
          bridge._sessionScheduler.hasPendingReaction("1:u_priv_2:"),
          false,
          "send_private_msg must immediately cancel pending auto-read/typing reaction"
        );
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(
          calls.some((c) => c.cmd === "nodeIKernelMsgService/sendShowInputStatusReq"),
          false,
          "Cancelled reaction must never fire a late sendShowInputStatusReq after send_private_msg"
        );

        await pushPrivRecv("cancel_by_typing", "u_priv_3", "100040004", "explicit typing test");
        assert.strictEqual(bridge._sessionScheduler.hasPendingReaction("1:u_priv_3:"), true);
        bridge._sessionScheduler.lastSwitchAt = Date.now() - 1000;
        await bridge.handleOneBotAction("set_input_status", {
          user_id: 100040004,
          event_type: 1,
        });
        assert.strictEqual(
          bridge._sessionScheduler.hasPendingReaction("1:u_priv_3:"),
          false,
          "set_input_status must immediately cancel pending auto-read/typing reaction"
        );

        // (c) Advisory switch skipped when another peer just switched within aioSwitchCooldownMs (400ms)
        bridge.config.autoReadReactionDelayMs = 20;
        bridge._recentReadByPeer.clear();
        bridge._recentTypingByPeer.clear();
        await bridge.handleOneBotAction("send_group_msg", {
          group_id: 999888,
          message: "锁定当前活跃群会话",
        });
        assert.strictEqual(bridge._activeAioPeerKey, "2:999888:");
        calls.length = 0;

        // Incoming private message arrives immediately while 400ms cooldown from 2:999888: is active
        await pushPrivRecv("cooldown_skip_1", "u_priv_1", "100020002", "should skip advisory switch");
        await new Promise((r) => setTimeout(r, 55));
        assert.strictEqual(
          bridge._activeAioPeerKey,
          "2:999888:",
          "Advisory auto-read reaction must skip switching when another peer just switched within aioSwitchCooldownMs"
        );
        assert.strictEqual(calls.length, 0);
      } finally {
        clearInterval(keepAlive);
        await bridge.stopServers();
      }
    }

    // 4. End-to-end messageFormat: "string" vs "array" across broadcastOneBotEvent, WS clients, and get_msg
    {
      const fmtBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        selfUid: "u_rosmontis_self",
        online: true,
        config: {
          selfUin: "100010001",
          messageFormat: "string",
          httpServers: [],
          wsServers: [
            { host: "127.0.0.1", port: 0, accessToken: "", messageFormat: "string" },
            { host: "127.0.0.1", port: 0, accessToken: "", messageFormat: "array" },
          ],
          wsClients: [],
          heartbeatIntervalMs: 0,
          humanSimulation: false,
        },
      });
      fmtBridge.uinUidStore.record("100020002", "u_fmt_peer");
      await fmtBridge.startServers();

      const connectWsTestClient = (port) =>
        new Promise((resolve, reject) => {
          const msgs = [];
          const waiters = [];
          const handle = mainMod.connectReverseWebSocket(
            `ws://127.0.0.1:${port}/`,
            {},
            (conn) =>
              resolve({
                conn,
                handle,
                msgs,
                nextJson: (predicate) => {
                  const idx = msgs.findIndex(predicate);
                  if (idx >= 0) {
                    const [found] = msgs.splice(idx, 1);
                    return Promise.resolve(found);
                  }
                  return new Promise((res) => waiters.push({ predicate, res }));
                },
              }),
            (text) => {
              const parsed = JSON.parse(text);
              const wIdx = waiters.findIndex((w) => w.predicate(parsed));
              if (wIdx >= 0) {
                const [w] = waiters.splice(wIdx, 1);
                w.res(parsed);
              } else {
                msgs.push(parsed);
              }
            },
            () => {}
          );
          if (!handle) reject(new Error("Failed to connect WS test client"));
        });

      let wsStrClient = null;
      let wsArrClient = null;
      try {
        const wsStrPort = fmtBridge._wsServers[0].address().port;
        const wsArrPort = fmtBridge._wsServers[1].address().port;
        wsStrClient = await connectWsTestClient(wsStrPort);
        wsArrClient = await connectWsTestClient(wsArrPort);

        await wsStrClient.nextJson((m) => m.post_type === "meta_event" && m.sub_type === "connect");
        await wsArrClient.nextJson((m) => m.post_type === "meta_event" && m.sub_type === "connect");

        const localEvents = [];
        fmtBridge.on("onebot_event", (ev) => localEvents.push(ev));

        // Emit incoming message containing face + text
        await fmtBridge._handleKernelEvent("nodeIKernelMsgListener", "onRecvMsg", [
          [
            {
              msgId: "fmt_msg_7001",
              msgSeq: "7001",
              msgTime: "1710000200",
              chatType: 1,
              msgType: 2,
              peerUid: "u_fmt_peer",
              senderUid: "u_fmt_peer",
              senderUin: "100020002",
              sendNickName: "Doctor",
              elements: [
                { elementType: 6, faceElement: { faceIndex: 14, faceType: 1 } },
                { elementType: 1, textElement: { content: "博士你好" } },
              ],
            },
          ],
        ]);

        const strBroadcast = await wsStrClient.nextJson((m) => m.post_type === "message");
        const arrBroadcast = await wsArrClient.nextJson((m) => m.post_type === "message");

        // Verify local broadcastOneBotEvent (global messageFormat: "string")
        assert.strictEqual(localEvents.length, 1);
        assert.strictEqual(typeof localEvents[0].message, "string");
        assert.strictEqual(localEvents[0].message, "[CQ:face,id=14]博士你好");

        // Verify WS client 1 (messageFormat: "string") vs WS client 2 (messageFormat: "array")
        assert.strictEqual(typeof strBroadcast.message, "string");
        assert.strictEqual(strBroadcast.message, "[CQ:face,id=14]博士你好");

        assert.strictEqual(Array.isArray(arrBroadcast.message), true);
        assert.deepStrictEqual(arrBroadcast.message, [
          { type: "face", data: { id: "14" } },
          { type: "text", data: { text: "博士你好" } },
        ]);

        const msgId = strBroadcast.message_id;

        // Verify get_msg over WS client 1 ("string") vs WS client 2 ("array")
        wsStrClient.conn.sendJson({
          action: "get_msg",
          params: { message_id: msgId },
          echo: "get_str",
        });
        const getStrReply = await wsStrClient.nextJson((m) => m.echo === "get_str");
        assert.strictEqual(getStrReply.status, "ok");
        assert.strictEqual(typeof getStrReply.data.message, "string");
        assert.strictEqual(getStrReply.data.message, "[CQ:face,id=14]博士你好");

        wsArrClient.conn.sendJson({
          action: "get_msg",
          params: { message_id: msgId },
          echo: "get_arr",
        });
        const getArrReply = await wsArrClient.nextJson((m) => m.echo === "get_arr");
        assert.strictEqual(getArrReply.status, "ok");
        assert.strictEqual(Array.isArray(getArrReply.data.message), true);
        assert.deepStrictEqual(getArrReply.data.message, [
          { type: "face", data: { id: "14" } },
          { type: "text", data: { text: "博士你好" } },
        ]);

        // Also verify direct handleOneBotAction("get_msg") respects global "string" and per-call message_format override
        const directDefault = await fmtBridge.handleOneBotAction("get_msg", { message_id: msgId });
        assert.strictEqual(directDefault.data.message, "[CQ:face,id=14]博士你好");

        const directArray = await fmtBridge.handleOneBotAction("get_msg", {
          message_id: msgId,
          message_format: "array",
        });
        assert.strictEqual(Array.isArray(directArray.data.message), true);
      } finally {
        if (wsStrClient) wsStrClient.handle.close();
        if (wsArrClient) wsArrClient.handle.close();
        await fmtBridge.stopServers();
      }
    }
  });

  console.log("=== 18. Testing Downstream SnowLuma / NapCat / OneBot SDK Compatibility ===");
  await check("compatProfile (global & per-endpoint), get_status.time, .handle_quick_operation, JSON/face/share/image shorthands & group compat actions", async () => {
    // 1. Config & env loading for compatProfile
    const prevCompatEnv = process.env.ROSMONTIS_COMPAT_PROFILE;
    try {
      process.env.ROSMONTIS_COMPAT_PROFILE = "snowluma";
      const slCfg = mainMod.loadBridgeConfig(path.join(__dirname, "non_existent_cfg_dir"));
      assert.strictEqual(slCfg.compatProfile, "snowluma");
      process.env.ROSMONTIS_COMPAT_PROFILE = "napcat";
      const ncCfg = mainMod.loadBridgeConfig(path.join(__dirname, "non_existent_cfg_dir"));
      assert.strictEqual(ncCfg.compatProfile, "napcat");
    } finally {
      if (prevCompatEnv === undefined) {
        delete process.env.ROSMONTIS_COMPAT_PROFILE;
      } else {
        process.env.ROSMONTIS_COMPAT_PROFILE = prevCompatEnv;
      }
    }

    // 2. Segment shorthands & round-trip codecs
    const pngBase64 =
      "base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const conv = await onebot.oneBotSegmentsToNtElements([
      { type: "text", text: "顶层简写" },
      { type: "json", data: '{"app":"com.tencent.str"}' },
      { type: "json", data: { data: { app: "com.tencent.nested" } } },
      { type: "json", data: { app: "com.tencent.direct" } },
      {
        type: "share",
        data: {
          url: "https://example.com/post",
          title: "测试分享",
          content: "摘要",
          image: "https://example.com/thumb.png",
        },
      },
      { type: "face", data: { id: "394", resultId: "2" } },
      { type: "face", data: { id: "14" } },
      {
        type: "image",
        data: {
          file: "a1b2c3d4e5f6.png",
          url: pngBase64,
        },
      },
      {
        type: "image",
        data: {
          emoji_id: "0123456789abcdef0123456789abcdef",
          emoji_package_id: "2001",
          key: "mk_key_1",
          summary: "[狗狗]",
        },
      },
    ]);
    try {
      assert.strictEqual(conv.elements.length, 9);
      assert.strictEqual(conv.elements[0].textElement.content, "顶层简写");
      assert.deepStrictEqual(JSON.parse(conv.elements[1].arkElement.bytesData), {
        app: "com.tencent.str",
      });
      assert.deepStrictEqual(JSON.parse(conv.elements[2].arkElement.bytesData), {
        app: "com.tencent.nested",
      });
      assert.deepStrictEqual(JSON.parse(conv.elements[3].arkElement.bytesData), {
        app: "com.tencent.direct",
      });
      const shareArk = JSON.parse(conv.elements[4].arkElement.bytesData);
      assert.strictEqual(shareArk.app, "com.tencent.structmsg");
      assert.strictEqual(shareArk.meta.news.jumpUrl, "https://example.com/post");
      assert.strictEqual(shareArk.meta.news.title, "测试分享");
      assert.strictEqual(conv.elements[5].faceElement.faceIndex, 394);
      assert.strictEqual(conv.elements[5].faceElement.resultId, "2");
      assert.strictEqual(conv.elements[5].faceElement.faceType, 3);
      assert.strictEqual(conv.elements[6].faceElement.faceIndex, 14);
      assert.strictEqual(conv.elements[6].faceElement.resultId, "");
      assert.strictEqual(conv.elements[6].faceElement.faceType, 1);
      assert.strictEqual(conv.elements[7].elementType, 2); // echoed image fell back from bare md5 token to base64 url
      assert.strictEqual(conv.elements[8].elementType, 11); // image with emoji_id rebuilt as mface
      assert.strictEqual(
        conv.elements[8].marketFaceElement.emojiId,
        "0123456789abcdef0123456789abcdef"
      );
    } finally {
      for (const fn of conv.cleanupCallbacks) fn();
    }

    // Inbound animated face preserves resultId while regular face stays clean
    const inboundFaceSegs = onebot.ntMsgToOneBotSegments({
      chatType: 2,
      peerUid: "654321",
      elements: [
        { elementType: 6, faceElement: { faceIndex: 394, faceType: 3, resultId: "2" } },
        { elementType: 6, faceElement: { faceIndex: 14, faceType: 1, resultId: "" } },
      ],
    });
    assert.deepStrictEqual(inboundFaceSegs.segments, [
      { type: "face", data: { id: "394", resultId: "2" } },
      { type: "face", data: { id: "14" } },
    ]);

    // 3. Live Bridge + per-endpoint HTTP/WS compatProfile + .handle_quick_operation + group compat actions
    const ntCalls = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const compatBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self_compat",
      selfNickname: "Rosmontis",
      online: true,
      startedAtMs: Date.now() - 4200,
      config: {
        selfUin: "100010001",
        compatProfile: "rosmontis",
        humanSimulation: false,
        sendEchoTimeoutMs: 50,
        heartbeatIntervalMs: 0,
        httpServers: [
          { host: "127.0.0.1", port: 0, accessToken: "" },
          { host: "127.0.0.1", port: 0, accessToken: "", compatProfile: "snowluma" },
        ],
        wsServers: [
          { host: "127.0.0.1", port: 0, accessToken: "", compatProfile: "napcat" },
        ],
        wsClients: [],
      },
      rendererExecute: async (cmd, args) => {
        const payload = Array.isArray(args) ? args[0] : args;
        ntCalls.push({ cmd, payload });
        if (cmd === "nodeIKernelGroupService/getGroupList") {
          return {
            groupList: [
              {
                groupCode: "777888",
                groupName: "测试群",
                remarkName: "主测试群",
                memberCount: 42,
                maxMember: 500,
                createTime: 1700000000,
                groupLevel: 5,
                richFingerMemo: "群简介",
                shutUpAllTimestamp: nowSec + 3600,
              },
            ],
          };
        }
        if (cmd === "nodeIKernelGroupService/getGroupAllInfo") {
          return {
            groupInfo: {
              groupCode: "777888",
              groupName: "测试群",
              remarkName: "主测试群",
              memberCount: 42,
              maxMember: 500,
              createTime: 1700000000,
              groupLevel: 5,
              richFingerMemo: "群简介",
              shutUpAllTimestamp: 0,
            },
          };
        }
        if (cmd === "nodeIKernelGroupService/getGroupRecommendContactArkJson") {
          return {
            arkJson: JSON.stringify({
              app: "com.tencent.troopsharecard",
              meta: {
                contact: {
                  jumpUrl: "https://qm.qq.com/cgi-bin/qm/qr?k=TEST_SHARE_KEY",
                },
              },
            }),
          };
        }
        if (cmd === "nodeIKernelGroupService/getGroupRemainAtTimes") {
          return {
            atInfo: {
              canAtAll: true,
              RemainAtAllCountForGroup: 8,
              RemainAtAllCountForUin: 3,
            },
          };
        }
        if (cmd === "nodeIKernelGroupService/getAllMemberList") {
          return {
            infos: [
              {
                uid: "u_muted_1",
                uin: "20001",
                nick: "被禁言群友",
                cardName: "禁言名片",
                role: 2,
                shutUpTime: nowSec + 600,
              },
              {
                uid: "u_normal_2",
                uin: "20002",
                nick: "正常群友",
                role: 0,
                shutUpTime: 0,
              },
            ],
          };
        }
        if (cmd === "nodeIKernelMsgService/getMsgEmojiLikesList") {
          return { emojiLikesList: [{ tinyId: "20002", nickName: "正常群友" }] };
        }
        if (cmd === "nodeIKernelMsgService/sendMsg") {
          return { result: 0, errMsg: "" };
        }
        return { result: 0, errMsg: "" };
      },
    });
    compatBridge.uinUidStore.record("20002", "u_normal_2");
    const recMsgId = compatBridge.messageIdStore.register({
      msgId: "7500000000000000099",
      chatType: 2,
      peerUid: "777888",
      msgSeq: "888",
      senderUin: "20002",
      senderUid: "u_normal_2",
    });

    const httpJson = (port, urlPath, bodyObj) =>
      new Promise((resolve, reject) => {
        const raw = JSON.stringify(bodyObj);
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: urlPath,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(raw),
            },
          },
          (res) => {
            let buf = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (buf += c));
            res.on("end", () => {
              try {
                resolve(JSON.parse(buf));
              } catch (e) {
                reject(e);
              }
            });
          }
        );
        req.on("error", reject);
        req.end(raw);
      });

    await compatBridge.startServers();
    let wsNapClient = null;
    try {
      const portDefault = compatBridge._httpServers[0].address().port;
      const portSnow = compatBridge._httpServers[1].address().port;
      const wsPortNap = compatBridge._wsServers[0].address().port;

      // Default HTTP endpoint reports Rosmontis; SnowLuma HTTP endpoint reports SnowLuma
      const vDef = await httpJson(portDefault, "/get_version_info", {});
      assert.strictEqual(vDef.status, "ok");
      assert.strictEqual(vDef.data.app_name, "Rosmontis");
      assert.strictEqual(vDef.data.bridge_name, undefined);

      const vSnow = await httpJson(portSnow, "/get_version_info", {});
      assert.strictEqual(vSnow.status, "ok");
      assert.strictEqual(vSnow.data.app_name, "SnowLuma");
      assert.strictEqual(vSnow.data.bridge_name, "Rosmontis");

      // get_status includes uptime `time` in seconds
      const st = await httpJson(portSnow, "/get_status", {});
      assert.strictEqual(st.status, "ok");
      assert.strictEqual(st.data.online, true);
      assert.strictEqual(st.data.good, true);
      assert.ok(Number.isInteger(st.data.time) && st.data.time >= 3);

      // WS endpoint reports NapCat.Onebot
      wsNapClient = await new Promise((resolve, reject) => {
        const queue = [];
        const waiters = [];
        let handle = null;
        handle = mainMod.connectReverseWebSocket(
          `ws://127.0.0.1:${wsPortNap}/`,
          {},
          (conn) => {
            resolve({
              conn,
              handle,
              nextJson(pred) {
                const idx = queue.findIndex(pred);
                if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
                return new Promise((res, rej) => {
                  const t = setTimeout(() => rej(new Error("WS wait timeout")), 3000);
                  waiters.push({ pred, res, t });
                });
              },
            });
          },
          (txt) => {
            const msg = JSON.parse(txt);
            const wIdx = waiters.findIndex((w) => w.pred(msg));
            if (wIdx >= 0) {
              const w = waiters.splice(wIdx, 1)[0];
              clearTimeout(w.t);
              w.res(msg);
            } else {
              queue.push(msg);
            }
          },
          () => {}
        );
        setTimeout(() => reject(new Error("WS connect timeout")), 3000).unref();
      });

      wsNapClient.conn.sendJson({ action: "get_version_info", params: {}, echo: "v_nap" });
      const vNap = await wsNapClient.nextJson((m) => m.echo === "v_nap");
      assert.strictEqual(vNap.data.app_name, "NapCat.Onebot");
      assert.strictEqual(vNap.data.bridge_name, "Rosmontis");

      // .handle_quick_operation over HTTP: missing params -> 1400
      const badQuick = await httpJson(portSnow, "/.handle_quick_operation", {});
      assert.strictEqual(badQuick.status, "failed");
      assert.strictEqual(badQuick.retcode, 1400);

      // .handle_quick_operation on group message: reply (auto @sender) + delete + ban + kick
      ntCalls.length = 0;
      const quickGrp = await httpJson(portSnow, "/.handle_quick_operation", {
        context: {
          post_type: "message",
          message_type: "group",
          group_id: 777888,
          user_id: 20002,
          message_id: recMsgId,
        },
        operation: {
          reply: "收到 [CQ:face,id=14]",
          delete: true,
          ban: true,
          ban_duration: 300,
          kick: true,
          reject_add_request: true,
        },
      });
      assert.strictEqual(quickGrp.status, "ok");

      const sentCall = ntCalls.find((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
      assert.ok(sentCall, "Expected sendMsg from quick_operation reply");
      assert.strictEqual(sentCall.payload.msgElements[0].textElement.atType, 2);
      assert.strictEqual(sentCall.payload.msgElements[0].textElement.atUid, "20002");
      assert.strictEqual(sentCall.payload.msgElements[1].textElement.content, "收到 ");
      assert.strictEqual(sentCall.payload.msgElements[2].faceElement.faceIndex, 14);
      assert.ok(ntCalls.some((c) => c.cmd === "nodeIKernelMsgService/recallMsg"));
      const banCall = ntCalls.find((c) => c.cmd === "nodeIKernelGroupService/banMember");
      assert.ok(banCall);
      assert.strictEqual(banCall.payload.memList[0].timeStamp, 300);
      assert.ok(ntCalls.some((c) => c.cmd === "nodeIKernelGroupService/kickMember"));

      // .handle_quick_operation_async on friend & group request events
      ntCalls.length = 0;
      const quickFriendReq = await compatBridge.handleOneBotAction(
        ".handle_quick_operation_async",
        {
          context: { post_type: "request", request_type: "friend", flag: "u_req_friend|123" },
          operation: { approve: true, remark: "新好友" },
        }
      );
      assert.strictEqual(quickFriendReq.status, "ok");
      assert.ok(
        ntCalls.some((c) => c.cmd === "nodeIKernelBuddyService/approvalFriendRequest")
      );

      ntCalls.length = 0;
      const quickGroupReq = await compatBridge.handleOneBotAction("handle_quick_operation", {
        context: {
          post_type: "request",
          request_type: "group",
          sub_type: "add",
          flag: "777888|seq_99|1",
        },
        operation: { approve: false, reason: "暂不开放" },
      });
      assert.strictEqual(quickGroupReq.status, "ok");
      assert.ok(
        ntCalls.some((c) => c.cmd === "nodeIKernelGroupService/operateSysNotify")
      );

      // Exclusive forward node array passed directly to send_group_msg routes to forward pipeline
      ntCalls.length = 0;
      const exclFwd = await compatBridge.handleOneBotAction("send_group_msg", {
        group_id: 777888,
        message: [
          { type: "text", data: { text: "" } },
          {
            type: "node",
            data: { user_id: 100010001, nickname: "Rosmontis", content: "合并节点正文" },
          },
        ],
      });
      assert.strictEqual(exclFwd.status, "ok");
      assert.ok(
        ntCalls.some((c) => c.cmd === "nodeIKernelMsgService/multiForwardMsgWithComment")
      );

      // Group schema fields & new group/file helper actions
      const grpList = await compatBridge.handleOneBotAction("get_group_list", { no_cache: true });
      assert.strictEqual(grpList.status, "ok");
      assert.strictEqual(grpList.data[0].group_remark, "主测试群");
      assert.strictEqual(grpList.data[0].group_all_shut, -1);

      const grpInfoEx = await compatBridge.handleOneBotAction("get_group_info_ex", {
        group_id: 777888,
      });
      assert.strictEqual(grpInfoEx.status, "ok");
      assert.strictEqual(grpInfoEx.data.group_remark, "主测试群");
      assert.strictEqual(grpInfoEx.data.group_all_shut, 0);

      const shareLink = await compatBridge.handleOneBotAction("get_group_share_link", {
        group_id: 777888,
      });
      assert.strictEqual(shareLink.status, "ok");
      assert.strictEqual(
        shareLink.data.url,
        "https://qm.qq.com/cgi-bin/qm/qr?k=TEST_SHARE_KEY"
      );

      const atRemain = await compatBridge.handleOneBotAction("get_group_at_all_remain", {
        group_id: 777888,
      });
      assert.deepStrictEqual(atRemain.data, {
        can_at_all: true,
        remain_at_all_count_for_group: 8,
        remain_at_all_count_for_uin: 3,
      });

      const shutList = await compatBridge.handleOneBotAction("get_group_shut_list", {
        group_id: 777888,
      });
      assert.strictEqual(shutList.data.length, 1);
      assert.strictEqual(shutList.data[0].user_id, 20001);
      assert.strictEqual(shutList.data[0].role, "admin");

      const setRmk = await compatBridge.handleOneBotAction("set_group_remark", {
        group_id: 777888,
        remark: "新群备注",
      });
      assert.strictEqual(setRmk.status, "ok");

      const emojiLikes = await compatBridge.handleOneBotAction("get_msg_emoji_likes", {
        message_id: recMsgId,
        emoji_id: "14",
      });
      assert.strictEqual(emojiLikes.status, "ok");
      assert.strictEqual(emojiLikes.data.emoji_like_list.length, 1);

      const renFile = await compatBridge.handleOneBotAction("rename_group_file", {
        group_id: 777888,
        file_id: "/f_1",
        new_name: "renamed.pdf",
      });
      assert.strictEqual(renFile.status, "ok");

      const renFolder = await compatBridge.handleOneBotAction("rename_group_file_folder", {
        group_id: 777888,
        folder_id: "/d_1",
        new_folder_name: "共享目录",
      });
      assert.strictEqual(renFolder.status, "ok");
    } finally {
      if (wsNapClient) wsNapClient.handle.close();
      await compatBridge.stopServers();
    }
  });

  console.log(
    "=== 19. Testing MessageIdStore Heap Bound, Hoisted msgRandom, Media Index & Transient __base64Uri Stripping ==="
  );
  await check("MessageIdStore maxRawEntries eviction, hoisted msgRandom, offline get_msg, pic+ptt hydration, __base64Uri stripping & byMediaKey eviction", async () => {
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "rosmontis-suite19-"));
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    const pttBytes = Buffer.from("#!AMR\nrosmontis_voice_hydration_test", "utf8");
    const dlPicPath = path.join(tmpDir, "hydrated_pic.jpg");
    const dlPttPath = path.join(tmpDir, "hydrated_ptt.amr");
    const picMd5 = "aabbccddeeff00112233445566778899";
    const pttMd5 = "11223344556677889900aabbccddeeff";
    const picUuid = "uuid_suite19_pic";
    const pttUuid = "uuid_suite19_ptt";

    const store = new onebot.MessageIdStore(10, 3);
    const ntCalls = [];
    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self_19",
      selfNickname: "Rosmontis",
      online: true,
      messageIdStore: store,
      config: {
        httpServers: [],
        wsServers: [],
        wsClients: [],
        heartbeatIntervalMs: 0,
        wsPingIntervalMs: 0,
        humanSimulation: false,
      },
      rendererExecute: async (cmd, args) => {
        const payload = Array.isArray(args) ? args[0] : args;
        ntCalls.push({ cmd, payload });
        if (cmd === "nodeIKernelMsgService/getMsgsByMsgId") {
          throw new Error("NTQQ offline: getMsgsByMsgId unavailable");
        }
        if (cmd === "nodeIKernelMsgService/getRichMediaFilePathForGuild") {
          return dlPicPath;
        }
        if (cmd === "nodeIKernelMsgService/downloadRichMedia") {
          const elId = String(payload?.getReq?.elementId || "");
          if (elId === "el_pic_19") {
            fs.writeFileSync(dlPicPath, pngBytes);
            return { filePath: dlPicPath };
          }
          if (elId === "el_ptt_19") {
            fs.writeFileSync(dlPttPath, pttBytes);
            return { filePath: dlPttPath };
          }
        }
        return { result: 0, errMsg: "" };
      },
    });

    try {
      // 19a. Register 5 messages in MessageIdStore(10, 3): oldest 2 raw-evicted, latest 3 retained
      const registered = [];
      for (let i = 1; i <= 5; i++) {
        const msgId = `791900000000000000${i}`;
        const shortId = store.register({
          msgId,
          chatType: 2,
          peerUid: "888",
          msgSeq: String(200 + i),
          senderUin: "20001",
          rawMsg: {
            msgId,
            chatType: 2,
            peerUid: "888",
            msgSeq: String(200 + i),
            msgRandom: "987654",
            elements: [{ elementType: 1, textElement: { content: `msg_${i}` } }],
          },
          oneBotEvent: { post_type: "message", raw_message: `msg_${i}` },
        });
        registered.push({ msgId, shortId });
      }

      for (let i = 0; i < 2; i++) {
        const recShort = store.getByShortId(registered[i].shortId);
        const recMsg = store.getByMsgId(registered[i].msgId);
        assert.strictEqual(recShort, recMsg);
        assert.strictEqual(recShort.rawMsg, null);
        assert.strictEqual(recShort.oneBotEvent, null);
        assert.strictEqual(recShort.msgRandom, "987654");
      }
      for (let i = 2; i < 5; i++) {
        const rec = store.getByShortId(registered[i].shortId);
        assert.ok(rec && rec.rawMsg !== null, `Expected latest entry ${i} to retain rawMsg`);
        assert.strictEqual(rec.msgRandom, "987654");
      }

      // 19b. set_essence_msg succeeds via hoisted entry.msgRandom; offline get_msg falls back to scalar summary
      const essenceRes = await bridge.handleOneBotAction("set_essence_msg", {
        message_id: registered[0].shortId,
      });
      assert.strictEqual(essenceRes.status, "ok");
      const essenceCall = ntCalls.find((c) => c.cmd === "nodeIKernelGroupService/addGroupEssence");
      assert.ok(essenceCall, "Expected addGroupEssence call");
      assert.deepStrictEqual(essenceCall.payload, {
        param: {
          groupCode: "888",
          msgRandom: 987654,
          msgSeq: 201,
        },
      });

      const offlineMsgRes = await bridge.handleOneBotAction("get_msg", {
        message_id: registered[0].shortId,
      });
      assert.strictEqual(offlineMsgRes.status, "ok");
      assert.strictEqual(offlineMsgRes.data.message_id, registered[0].shortId);
      assert.strictEqual(offlineMsgRes.data.real_id, registered[0].msgId);
      assert.strictEqual(offlineMsgRes.data.message_type, "group");
      assert.strictEqual(offlineMsgRes.data.group_id, 888);
      assert.deepStrictEqual(offlineMsgRes.data.message, []);

      // 19c. Inbound _processIncomingNtMessage hydrates picElement + pttElement, indexes media, strips __base64Uri
      const emitted = [];
      bridge.broadcastOneBotEvent = (ev) => emitted.push(ev);
      const inboundMediaMsg = {
        msgId: "7919000000000000099",
        msgSeq: "299",
        msgTime: "1760001900",
        msgRandom: "135790",
        chatType: 2,
        peerUid: "888",
        senderUid: "u_sender_19",
        senderUin: "20019",
        elements: [
          {
            elementId: "el_pic_19",
            elementType: 2,
            picElement: {
              md5HexStr: picMd5,
              fileUuid: picUuid,
              fileName: `${picMd5}.jpg`,
              fileSize: String(pngBytes.length),
              sourcePath: "",
              originImageUrl: "/download?appid=1406&fileid=NoRkeyPic19",
            },
          },
          {
            elementId: "el_ptt_19",
            elementType: 4,
            pttElement: {
              md5HexStr: pttMd5,
              fileUuid: pttUuid,
              fileName: "voice19.amr",
              fileSize: String(pttBytes.length),
              filePath: "",
            },
          },
        ],
      };

      await bridge._processIncomingNtMessage(inboundMediaMsg);
      assert.strictEqual(emitted.length, 1);
      const msgEv = emitted[0];
      const imgSeg = msgEv.message.find((s) => s.type === "image");
      const pttSeg = msgEv.message.find((s) => s.type === "record");
      assert.ok(imgSeg && pttSeg, "Expected hydrated image and record segments");
      assert.strictEqual(imgSeg.data.url, `base64://${pngBytes.toString("base64")}`);
      assert.strictEqual(pttSeg.data.url, `base64://${pttBytes.toString("base64")}`);

      assert.strictEqual(inboundMediaMsg.elements[0].picElement.sourcePath, dlPicPath);
      assert.strictEqual(inboundMediaMsg.elements[1].pttElement.filePath, dlPttPath);

      const mediaByMd5 = store.lookupMedia(`${picMd5}.jpg`);
      const mediaByPicUuid = store.lookupMedia(picUuid);
      const mediaByPttUuid = store.lookupMedia(pttUuid);
      assert.ok(mediaByMd5 && mediaByMd5.sourcePath === dlPicPath);
      assert.ok(mediaByPicUuid && mediaByPicUuid.fileUuid === picUuid);
      assert.ok(mediaByPttUuid && mediaByPttUuid.sourcePath === dlPttPath);

      const storedMediaEntry = store.getByShortId(msgEv.message_id);
      assert.ok(storedMediaEntry && storedMediaEntry.rawMsg);
      assert.strictEqual(storedMediaEntry.oneBotEvent, null);
      assert.strictEqual("__base64Uri" in storedMediaEntry.rawMsg.elements[0].picElement, false);
      assert.strictEqual(storedMediaEntry.rawMsg.elements[0].picElement.__base64Uri, undefined);
      assert.strictEqual("__base64Uri" in storedMediaEntry.rawMsg.elements[1].pttElement, false);
      assert.strictEqual(storedMediaEntry.rawMsg.elements[1].pttElement.__base64Uri, undefined);

      // 19d. Overflowing maxEntries (10) evicts the media entry and cleans up its keys in byMediaKey
      for (let k = 1; k <= 10; k++) {
        store.register({
          msgId: `79199900000000000${String(k).padStart(2, "0")}`,
          chatType: 2,
          peerUid: "888",
          msgSeq: String(500 + k),
        });
      }
      assert.strictEqual(store.size, 10);
      assert.strictEqual(store.byShortId.has(msgEv.message_id), false);
      assert.strictEqual(store.lookupMedia(`${picMd5}.jpg`), null);
      assert.strictEqual(store.lookupMedia(picUuid), null);
      assert.strictEqual(store.lookupMedia(pttUuid), null);
    } finally {
      await bridge.stopServers();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  console.log(
    "=== 20. Testing Truthy \"0\" UIN Hardening, GrayTip/Recall UID->UIN, Forward Enhancements & upload_group_file fileUuid ==="
  );
  await check("UinUidStore/pickPositiveUin \"0\" hardening, grayTip/recall/request UID->UIN resolution, recursive forward & upload_group_file moveGroupFile", async () => {
    // 20a. UinUidStore ignores "0"/0 and pickPositiveUin skips non-positive candidates
    assert.strictEqual(onebot.pickPositiveUin("0", 0, "", "123456"), 123456);
    assert.strictEqual(onebot.pickPositiveUin("0", 0, "", false, null, undefined), 0);

    const uinStore = new onebot.UinUidStore();
    uinStore.register("0", "u_should_ignore");
    uinStore.register(0, "u_should_ignore_2");
    uinStore.register("654321", "0");
    uinStore.register("654321", 0);
    assert.strictEqual(uinStore.getUid("0"), "");
    assert.strictEqual(uinStore.getUin("u_should_ignore"), "");
    assert.strictEqual(uinStore.getUin("u_should_ignore_2"), "");
    assert.strictEqual(uinStore.getUid("654321"), "");

    let zeroInvokeCount = 0;
    assert.strictEqual(
      await uinStore.resolveUin("0", async () => {
        zeroInvokeCount += 1;
        return { uinInfo: { "0": "999" } };
      }),
      ""
    );
    assert.strictEqual(
      await uinStore.resolveUin(0, async () => {
        zeroInvokeCount += 1;
        return { uinInfo: { "0": "999" } };
      }),
      ""
    );
    assert.strictEqual(
      await uinStore.resolveUid("0", async () => {
        zeroInvokeCount += 1;
        return { uidInfo: { "0": "u_bad" } };
      }),
      ""
    );
    assert.strictEqual(
      await uinStore.resolveUid(0, async () => {
        zeroInvokeCount += 1;
        return { uidInfo: { "0": "u_bad" } };
      }),
      ""
    );
    assert.strictEqual(zeroInvokeCount, 0);
    assert.strictEqual(
      await uinStore.resolveUin("u_returns_zero", async () => ({
        uinInfo: { u_returns_zero: "0" },
        uins: { u_returns_zero: 0 },
      })),
      ""
    );
    assert.strictEqual(
      await uinStore.resolveUid("888000", async () => ({
        uidInfo: { "888000": "0" },
        uids: { "888000": "0" },
      })),
      ""
    );

    // 20b-d. Inbound UID->UIN resolution, recursive forward staging & upload_group_file
    const uidDirectory = {
      u_admin: "111222",
      u_member: "222333",
      u_friend: "333444",
      u_poker: "444555",
      u_poked: "555666",
      u_joiner: "666777",
      u_req: "777888",
      u_recall_op: "888111",
      u_recall_sender: "888222",
    };

    const ntCalls = [];
    const emitted = [];
    let stagedMsgCounter = 1000;
    let forwardEchoCounter = 9000;

    const bridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self_20",
      selfNickname: "Rosmontis",
      online: true,
      config: {
        httpServers: [],
        wsServers: [],
        wsClients: [],
        heartbeatIntervalMs: 0,
        wsPingIntervalMs: 0,
        humanSimulation: false,
        sendEchoTimeoutMs: 150,
        forwardEchoTimeoutMs: 150,
      },
      rendererExecute: async (cmd, args) => {
        const payload = Array.isArray(args) ? args[0] : args;
        ntCalls.push({ cmd, payload });

        if (
          cmd === "nodeIKernelUixConvertService/getUin" ||
          cmd === "nodeIKernelGroupService/getUinByUids"
        ) {
          const list = payload?.uids || payload?.uidList || [];
          const uinInfo = {};
          for (const uid of list) {
            if (uidDirectory[uid]) uinInfo[uid] = uidDirectory[uid];
          }
          return { uinInfo, uins: uinInfo };
        }

        if (cmd === "nodeIKernelMsgService/sendMsg") {
          const peer = payload.peer;
          const els = payload.msgElements || [];
          const fileEl = els.find((e) => e?.elementType === 3 && e.fileElement)?.fileElement;
          if (fileEl) {
            setImmediate(() => {
              bridge
                ._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                  {
                    msgId: "7720000999",
                    msgSeq: "301",
                    chatType: peer.chatType,
                    peerUid: peer.peerUid,
                    senderUin: "100010001",
                    senderUid: "u_self_20",
                    elements: [
                      {
                        elementType: 3,
                        fileElement: {
                          fileMd5: fileEl.fileMd5,
                          fileName: fileEl.fileName,
                          fileSize: fileEl.fileSize,
                          fileUuid: "/uuid_doc_suite20",
                        },
                      },
                    ],
                  },
                ])
                .catch(() => {});
            });
            return { result: 0, errMsg: "" };
          }
          stagedMsgCounter += 1;
          return {
            result: 0,
            msgId: `772000${stagedMsgCounter}`,
            msgSeq: String(stagedMsgCounter),
          };
        }

        if (cmd === "nodeIKernelMsgService/multiForwardMsgWithComment") {
          const dstPeer = payload.dstContact;
          forwardEchoCounter += 1;
          const fwdMsgId = `772999${forwardEchoCounter}`;
          setImmediate(() => {
            bridge
              ._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
                {
                  msgId: fwdMsgId,
                  msgSeq: String(forwardEchoCounter),
                  chatType: dstPeer.chatType,
                  peerUid: dstPeer.peerUid,
                  senderUin: "100010001",
                  senderUid: "u_self_20",
                  elements: [
                    {
                      elementType: 16,
                      multiForwardMsgElement: { xmlContent: "<msg/>", resId: `res_${fwdMsgId}` },
                    },
                  ],
                },
              ])
              .catch(() => {});
          });
          return { result: 0, errMsg: "" };
        }

        return { result: 0, errMsg: "" };
      },
    });
    bridge.broadcastOneBotEvent = (ev) => emitted.push(ev);

    try {
      // 1) revokeElement via _processIncomingNtMessage & onMsgInfoListUpdate
      await bridge._processIncomingNtMessage({
        msgId: "772001",
        msgSeq: "11",
        msgType: 5,
        chatType: 2,
        peerUid: "90020",
        senderUin: "0",
        elements: [
          {
            elementType: 8,
            grayTipElement: {
              revokeElement: {
                operatorUin: "0",
                operatorUid: "u_admin",
                origMsgSenderUin: "0",
                origMsgSenderUid: "u_member",
              },
            },
          },
        ],
      });
      const revIncoming = emitted.pop();
      assert.strictEqual(revIncoming.notice_type, "group_recall");
      assert.strictEqual(revIncoming.operator_id, 111222);
      assert.strictEqual(revIncoming.user_id, 222333);

      await bridge._handleKernelEvent("nodeIKernelMsgListener", "onMsgInfoListUpdate", [
        [
          {
            msgId: "772002",
            msgSeq: "12",
            msgType: 5,
            recallTime: "1760002000",
            chatType: 2,
            peerUid: "90020",
            senderUin: "0",
            elements: [
              {
                elementType: 8,
                grayTipElement: {
                  revokeElement: {
                    operatorUin: "0",
                    operatorUid: "u_recall_op",
                    origMsgSenderUin: "0",
                    origMsgSenderUid: "u_recall_sender",
                  },
                },
              },
            ],
          },
        ],
      ]);
      const revUpdate = emitted.pop();
      assert.strictEqual(revUpdate.notice_type, "group_recall");
      assert.strictEqual(revUpdate.operator_id, 888111);
      assert.strictEqual(revUpdate.user_id, 888222);

      // 2) groupElement single-member shutUp vs whole-group mute, and type:3 kick with memberUin===0
      await bridge._processIncomingNtMessage({
        msgId: "772003",
        msgSeq: "13",
        msgType: 5,
        chatType: 2,
        peerUid: "90020",
        elements: [
          {
            elementType: 8,
            grayTipElement: {
              groupElement: {
                type: 4,
                adminUin: "0",
                adminUid: "u_admin",
                shutUp: {
                  duration: 600,
                  admin: { uin: "0", uid: "u_admin" },
                  member: { uin: "0", uid: "u_member" },
                },
              },
            },
          },
        ],
      });
      const singleBan = emitted.pop();
      assert.strictEqual(singleBan.notice_type, "group_ban");
      assert.strictEqual(singleBan.user_id, 222333);
      assert.strictEqual(singleBan.operator_id, 111222);

      await bridge._processIncomingNtMessage({
        msgId: "772004",
        msgSeq: "14",
        msgType: 5,
        chatType: 2,
        peerUid: "90020",
        elements: [
          {
            elementType: 8,
            grayTipElement: {
              groupElement: {
                type: 4,
                memberUin: "222333",
                adminUin: "0",
                adminUid: "u_admin",
                shutUp: {
                  duration: 1800,
                  admin: { uin: "0", uid: "u_admin" },
                  member: { uin: "0", uid: "" },
                },
              },
            },
          },
        ],
      });
      const wholeBan = emitted.pop();
      assert.strictEqual(wholeBan.notice_type, "group_ban");
      assert.strictEqual(wholeBan.user_id, 0);
      assert.strictEqual(wholeBan.operator_id, 111222);

      await bridge._processIncomingNtMessage({
        msgId: "772005",
        msgSeq: "15",
        msgType: 5,
        chatType: 2,
        peerUid: "90020",
        elements: [
          {
            elementType: 8,
            grayTipElement: {
              groupElement: {
                type: 3,
                memberUin: "0",
                memberUid: "u_unknown_kicked",
                adminUin: "0",
                adminUid: "u_admin",
              },
            },
          },
        ],
      });
      const kickNotice = emitted.pop();
      assert.strictEqual(kickNotice.notice_type, "group_decrease");
      assert.strictEqual(kickNotice.user_id, 0);
      assert.strictEqual(kickNotice.sub_type, "kick");

      // 3) buddyElement friend_add with peerUin: "0", peerUid: "u_friend"
      await bridge._processIncomingNtMessage({
        msgId: "772006",
        msgSeq: "16",
        msgType: 5,
        chatType: 1,
        peerUin: "0",
        peerUid: "u_friend",
        senderUin: "0",
        elements: [
          {
            elementType: 8,
            grayTipElement: {
              buddyElement: {
                peerUin: "0",
                peerUid: "u_friend",
              },
            },
          },
        ],
      });
      const friendAdd = emitted.pop();
      assert.strictEqual(friendAdd.notice_type, "friend_add");
      assert.strictEqual(friendAdd.user_id, 333444);

      // 4) templParam uid_str1 / uid_str2 poke
      await bridge._processIncomingNtMessage({
        msgId: "772007",
        msgSeq: "17",
        msgType: 5,
        chatType: 2,
        peerUid: "90020",
        senderUin: "0",
        elements: [
          {
            elementType: 8,
            grayTipElement: {
              xmlElement: {
                busiId: "1061",
                content: "<gtip>戳了戳</gtip>",
                templParam: new Map([
                  ["uin_str1", "0"],
                  ["uid_str1", "u_poker"],
                  ["uin_str2", "0"],
                  ["uid_str2", "u_poked"],
                ]),
              },
            },
          },
        ],
      });
      const pokeEv = emitted.pop();
      assert.strictEqual(pokeEv.notice_type, "notify");
      assert.strictEqual(pokeEv.sub_type, "poke");
      assert.strictEqual(pokeEv.user_id, 444555);
      assert.strictEqual(pokeEv.target_id, 555666);

      // 5) onGroupNotifiesUpdated & onBuddyReqChange with "0" UIN
      await bridge._handleKernelEvent("nodeIKernelGroupListener", "onGroupNotifiesUpdated", [
        false,
        [
          {
            seq: "seq_20_1",
            type: 1,
            status: 1,
            group: { groupCode: "90020" },
            user1: { uin: "0", uid: "u_joiner", nickName: "Joiner" },
            postscript: "let me in",
          },
        ],
      ]);
      const grpReqEv = emitted.pop();
      assert.strictEqual(grpReqEv.post_type, "request");
      assert.strictEqual(grpReqEv.request_type, "group");
      assert.strictEqual(grpReqEv.user_id, 666777);

      await bridge._handleKernelEvent("nodeIKernelBuddyListener", "onBuddyReqChange", [
        {
          buddyReqs: [
            {
              isDecide: false,
              reqType: 1,
              friendUin: "0",
              friendUid: "u_req",
              reqTime: "1760002100",
              extWords: "add me",
            },
          ],
        },
      ]);
      const buddyReqEv = emitted.pop();
      assert.strictEqual(buddyReqEv.post_type, "request");
      assert.strictEqual(buddyReqEv.request_type, "friend");
      assert.strictEqual(buddyReqEv.user_id, 777888);

      // 20c. send_group_forward_msg: distinct senderShowName, recursive depth <=3, flatten depth 4, firstRefPeer & sendEchoStats isolation
      ntCalls.length = 0;
      const customFwdRes = await bridge.handleOneBotAction("send_group_forward_msg", {
        group_id: 90020,
        messages: [
          {
            type: "node",
            data: {
              name: "Alice",
              uin: "10001",
              content: [
                {
                  type: "node",
                  data: {
                    name: "Depth2User",
                    uin: "10002",
                    content: [
                      {
                        type: "node",
                        data: {
                          name: "Depth3User",
                          uin: "10003",
                          content: [
                            { type: "text", data: { text: "L3-prefix:" } },
                            {
                              type: "node",
                              data: { name: "Depth4User", uin: "10004", content: "deep-secret" },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: "node",
            data: { nickname: "Bob", user_id: "10005", content: "Hello from Bob" },
          },
        ],
      });
      assert.strictEqual(customFwdRes.status, "ok");

      const multiFwdCalls = ntCalls.filter(
        (c) => c.cmd === "nodeIKernelMsgService/multiForwardMsgWithComment"
      );
      // Depth 3 node flattens depth 4 to text, Depth 2 packs Depth 3 (1), Depth 1 packs Depth 2 (2), outer packs Alice+Bob (3)
      assert.strictEqual(multiFwdCalls.length, 3);
      const outerFwd = multiFwdCalls[multiFwdCalls.length - 1].payload;
      assert.deepStrictEqual(
        outerFwd.msgInfos.map((m) => m.senderShowName),
        ["Alice", "Bob"]
      );

      const stagedSendTexts = ntCalls
        .filter((c) => c.cmd === "nodeIKernelMsgService/sendMsg")
        .map((c) =>
          (c.payload.msgElements || [])
            .map((e) => e.textElement?.content || "")
            .join("")
        );
      assert.ok(
        stagedSendTexts.includes("L3-prefix:[转发消息]"),
        `Expected depth-4 node flattened to [转发消息], got: ${JSON.stringify(stagedSendTexts)}`
      );
      assert.ok(!stagedSendTexts.some((t) => t.includes("deep-secret")));

      // Reference-only forward: uses firstRefPeer as srcContact & correlates onAddSendMsg without touching sendEchoStats
      const refId1 = bridge.messageIdStore.register({
        msgId: "7720801",
        chatType: 1,
        peerUid: "u_ref_peer_first",
        msgSeq: "81",
        senderUin: "111222",
      });
      const refId2 = bridge.messageIdStore.register({
        msgId: "7720802",
        chatType: 2,
        peerUid: "99999",
        msgSeq: "82",
        senderUin: "222333",
      });
      ntCalls.length = 0;
      const statsBeforeRefFwd = { ...bridge.sendEchoStats };
      const refFwdRes = await bridge.handleOneBotAction("send_group_forward_msg", {
        group_id: 90020,
        messages: [
          { type: "node", data: { id: refId1, name: "Alice" } },
          { type: "node", data: { id: refId2, name: "Bob" } },
        ],
      });
      assert.strictEqual(refFwdRes.status, "ok");
      assert.deepStrictEqual(bridge.sendEchoStats, statsBeforeRefFwd);
      assert.match(String(refFwdRes.data.res_id), /^772999\d+$/);
      assert.strictEqual(
        bridge.messageIdStore.getByShortId(refFwdRes.data.message_id)?.msgId,
        refFwdRes.data.res_id
      );
      const refFwdCall = ntCalls.find(
        (c) => c.cmd === "nodeIKernelMsgService/multiForwardMsgWithComment"
      );
      assert.deepStrictEqual(refFwdCall.payload.srcContact, {
        chatType: 1,
        peerUid: "u_ref_peer_first",
        guildId: "",
      });
      assert.deepStrictEqual(
        refFwdCall.payload.msgInfos.map((m) => m.senderShowName),
        ["Alice", "Bob"]
      );

      // 20d. upload_group_file extracts fileElement.fileUuid from echoRawMsg & invokes moveGroupFile for folder="/docs"
      ntCalls.length = 0;
      const fileB64 = Buffer.from("suite20 group document payload", "utf8").toString("base64");
      const uploadRes = await bridge.handleOneBotAction("upload_group_file", {
        group_id: 90020,
        file: `base64://${fileB64}`,
        name: "handbook.pdf",
        folder: "/docs",
      });
      assert.strictEqual(uploadRes.status, "ok");
      assert.strictEqual(uploadRes.data.file_id, "/uuid_doc_suite20");
      const moveCall = ntCalls.find((c) => c.cmd === "nodeIKernelRichMediaService/moveGroupFile");
      assert.ok(moveCall, "Expected moveGroupFile call when folder=/docs");
      assert.deepStrictEqual(moveCall.payload, {
        groupId: "90020",
        busIdList: [102],
        fileIdList: ["/uuid_doc_suite20"],
        curFolderId: "/",
        dstFolderId: "/docs",
      });
    } finally {
      await bridge.stopServers();
    }
  });

  console.log(
    "=== 21. Testing WebSocket Send-Buffer Backpressure, Periodic ping/pong Timeout & listenErrors Reporting ==="
  );
  await check("Rfc6455Connection maxSendBufferBytes backpressure, periodic WS ping/pong timeout & EADDRINUSE listenErrors reporting", async () => {
    // 21a. Rfc6455Connection with maxSendBufferBytes: 1024
    const mockSocket = new EventEmitter();
    mockSocket.writableLength = 0;
    mockSocket.destroyed = false;
    mockSocket.written = [];
    mockSocket.write = (buf) => {
      mockSocket.written.push(buf);
      return true;
    };
    mockSocket.destroy = () => {
      if (!mockSocket.destroyed) {
        mockSocket.destroyed = true;
        mockSocket.emit("close");
      }
    };
    mockSocket.end = () => mockSocket.destroy();

    const conn = new mainMod.Rfc6455Connection(mockSocket, { maxSendBufferBytes: 1024 });
    const closeEvents = [];
    conn.on("close", (code, reason) => closeEvents.push({ code, reason }));

    // Healthy empty socket (writableLength: 0) allows a single 2048-byte frame without termination
    const okLarge = conn.sendText("a".repeat(2048));
    assert.strictEqual(okLarge, true);
    assert.strictEqual(conn.closed, false);
    assert.strictEqual(mockSocket.destroyed, false);
    assert.strictEqual(closeEvents.length, 0);
    assert.strictEqual(mockSocket.written.length, 1);

    // Stalled socket (writableLength: 600) + 600-byte frame (> 1024) terminates once with 1006 & destroys socket
    mockSocket.writableLength = 600;
    const okOverflow = conn.sendText("b".repeat(600));
    assert.strictEqual(okOverflow, false);
    assert.strictEqual(conn.closed, true);
    assert.strictEqual(mockSocket.destroyed, true);
    assert.strictEqual(closeEvents.length, 1);
    assert.strictEqual(closeEvents[0].code, 1006);

    // 21b. Periodic WS liveness (wsPingIntervalMs: 40, wsPongTimeoutMs: 90) evicts unresponsive raw TCP WS client
    const pingBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      online: true,
      config: {
        httpServers: [],
        wsServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
        wsClients: [],
        heartbeatIntervalMs: 0,
        wsPingIntervalMs: 40,
        wsPongTimeoutMs: 90,
        quietLogs: true,
      },
    });
    let rawTcpClient = null;
    try {
      await pingBridge.startServers();
      const wsPort = pingBridge._wsServers[0].address().port;

      let sawUpgrade = false;
      let sawPingFrame = false;
      let upgradedAt = 0;

      const closedElapsedMs = await new Promise((resolve, reject) => {
        const safetyTimer = setTimeout(() => {
          reject(new Error("Timed out waiting for unresponsive WS client termination"));
        }, 1200);
        rawTcpClient = net.connect({ host: "127.0.0.1", port: wsPort }, () => {
          const secKey = crypto.randomBytes(16).toString("base64");
          rawTcpClient.write(
            [
              "GET / HTTP/1.1",
              `Host: 127.0.0.1:${wsPort}`,
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Key: ${secKey}`,
              "Sec-WebSocket-Version: 13",
              "",
              "",
            ].join("\r\n")
          );
        });
        let rxBuf = Buffer.alloc(0);
        rawTcpClient.on("data", (chunk) => {
          rxBuf = Buffer.concat([rxBuf, chunk]);
          if (!sawUpgrade) {
            const headerEnd = rxBuf.indexOf("\r\n\r\n");
            if (headerEnd !== -1) {
              const headerStr = rxBuf.subarray(0, headerEnd).toString("utf8");
              if (headerStr.includes("101 Switching Protocols")) {
                sawUpgrade = true;
                upgradedAt = Date.now();
                assert.strictEqual(pingBridge._wsServerClients.size, 1);
                rxBuf = rxBuf.subarray(headerEnd + 4);
              }
            }
          }
          if (sawUpgrade) {
            // Scan server frames; deliberately ignore 0x89 ping frames without replying pong
            while (rxBuf.length >= 2) {
              const opcode = rxBuf[0] & 0x0f;
              let len = rxBuf[1] & 0x7f;
              let offset = 2;
              if (len === 126) {
                if (rxBuf.length < 4) break;
                len = rxBuf.readUInt16BE(2);
                offset = 4;
              } else if (len === 127) {
                if (rxBuf.length < 10) break;
                len = Number(rxBuf.readBigUInt64BE(2));
                offset = 10;
              }
              if (rxBuf.length < offset + len) break;
              if (opcode === 0x9) sawPingFrame = true;
              rxBuf = rxBuf.subarray(offset + len);
            }
          }
        });
        rawTcpClient.on("error", () => {});
        rawTcpClient.on("close", () => {
          clearTimeout(safetyTimer);
          resolve(upgradedAt > 0 ? Date.now() - upgradedAt : 9999);
        });
      });

      assert.strictEqual(sawUpgrade, true);
      assert.strictEqual(sawPingFrame, true);
      assert.ok(
        closedElapsedMs >= 90 && closedElapsedMs < 500,
        `Expected unresponsive WS client closed around ~130-250ms, got ${closedElapsedMs}ms`
      );
      assert.strictEqual(pingBridge._wsServerClients.size, 0);
    } finally {
      if (rawTcpClient && !rawTcpClient.destroyed) rawTcpClient.destroy();
      await pingBridge.stopServers();
    }

    // 21c. Port bind conflict (EADDRINUSE): startServers() resolves cleanly, records listenErrors & exposes in get_status
    const blocker = net.createServer();
    let conflictBridge = null;
    try {
      await new Promise((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, "127.0.0.1", resolve);
      });
      const occupiedPort = blocker.address().port;

      conflictBridge = new mainMod.NtqqOneBotBridge({
        selfUin: "100010001",
        online: true,
        config: {
          httpServers: [{ host: "127.0.0.1", port: occupiedPort, accessToken: "" }],
          wsServers: [{ host: "127.0.0.1", port: occupiedPort, accessToken: "" }],
          wsClients: [],
          heartbeatIntervalMs: 0,
          wsPingIntervalMs: 0,
          quietLogs: true,
        },
      });

      await conflictBridge.startServers();
      assert.strictEqual(conflictBridge.listenErrors.length, 2);
      assert.ok(
        conflictBridge.listenErrors.every(
          (e) => e.code === "EADDRINUSE" && e.host === "127.0.0.1" && e.port === occupiedPort
        )
      );

      const stOnline = await conflictBridge.handleOneBotAction("get_status", {});
      assert.strictEqual(stOnline.status, "ok");
      assert.strictEqual(stOnline.data.online, true);
      assert.strictEqual(stOnline.data.good, true);
      assert.deepStrictEqual(stOnline.data.bridge.listenErrors, conflictBridge.listenErrors);

      conflictBridge.online = false;
      const stOffline = await conflictBridge.handleOneBotAction("get_status", {});
      assert.strictEqual(stOffline.data.online, false);
      assert.strictEqual(stOffline.data.good, false);
      assert.strictEqual(stOffline.data.bridge.listenErrors.length, 2);
    } finally {
      if (conflictBridge) await conflictBridge.stopServers();
      await new Promise((resolve) => blocker.close(() => resolve()));
    }
  });

  console.log(`\nALL ${passed} TEST SUITES PASSED SUCCESSFULLY!`);
  return passed;
}

let allSuitesFinished = false;
process.on("exit", (code) => {
  if (code === 0 && !allSuitesFinished) {
    console.error("FATAL: Event loop drained before runTests() completed all suites!");
    process.exitCode = 1;
  }
});

runTests()
  .then(() => {
    allSuitesFinished = true;
  })
  .catch((err) => {
    console.error("Test suite failed:", err);
    process.exit(1);
  });

"use strict";

/**
 * Web Credential, Cookie & QZone Action Gate (`src/core/qzone_actions.js`)
 *
 * Isolates high-privilege web credential (`clientkey`, `p_skey`, `skey`, `bkn`/`csrf_token`)
 * and QZone actions behind an explicit opt-in security gate while leaving internal NT media
 * CDN rkey actions (`get_rkey` / `nc_get_rkey`) unblocked.
 *
 * All outbound HTTP/HTTPS, cookie-jar, redirect-validation, and JSON/JSONP helpers delegate
 * directly to the SSRF-hardened `./web_http` module.
 */

const webHttp = require("./web_http");

const {
  WEB_CREDENTIAL_ACTIONS,
  isWebCredentialApiEnabled,
  assertWebCredentialApiEnabled,
  computeBkn,
  cookieObjToString,
  isTrustedTencentHost,
  isAllowedRedirectHost,
  assertSafeTencentRedirect,
  httpsGetCookies: defaultHttpsGetCookies,
  httpRequestText: defaultHttpRequestText,
  httpGetJson: defaultHttpGetJson,
  httpPostFormJson: defaultHttpPostFormJson,
  parseJsonpOrJson: defaultParseJsonpOrJson,
} = webHttp;

function resolveHelpers(helpers = {}) {
  const resolvedComputeBkn =
    typeof helpers?.computeBkn === "function"
      ? helpers.computeBkn
      : typeof helpers?.computeGtk === "function"
      ? helpers.computeGtk
      : computeBkn;
  const resolvedCookieObjToString =
    typeof helpers?.cookieObjToString === "function"
      ? helpers.cookieObjToString
      : cookieObjToString;
  const resolvedHttpsGetCookies =
    typeof helpers?.httpsGetCookies === "function"
      ? helpers.httpsGetCookies
      : defaultHttpsGetCookies;
  const resolvedHttpRequestText =
    typeof helpers?.httpRequestText === "function"
      ? helpers.httpRequestText
      : defaultHttpRequestText;
  const resolvedParseJsonpOrJson =
    typeof helpers?.parseJsonpOrJson === "function"
      ? helpers.parseJsonpOrJson
      : defaultParseJsonpOrJson;

  const usesDefaultRequestLayer =
    resolvedHttpRequestText === defaultHttpRequestText &&
    resolvedParseJsonpOrJson === defaultParseJsonpOrJson;

  const resolvedHttpGetJson =
    typeof helpers?.httpGetJson === "function"
      ? helpers.httpGetJson
      : usesDefaultRequestLayer
      ? defaultHttpGetJson
      : async (urlStr, headers = {}, options = undefined) => {
          const text =
            options !== undefined
              ? await resolvedHttpRequestText(urlStr, "GET", "", headers, undefined, options)
              : await resolvedHttpRequestText(urlStr, "GET", "", headers);
          return resolvedParseJsonpOrJson(text);
        };

  const resolvedHttpPostFormJson =
    typeof helpers?.httpPostFormJson === "function"
      ? helpers.httpPostFormJson
      : usesDefaultRequestLayer
      ? defaultHttpPostFormJson
      : async (urlStr, formParams = {}, headers = {}, options = undefined) => {
          let encodedBody = "";
          if (Buffer.isBuffer(formParams) || typeof formParams === "string") {
            encodedBody = formParams;
          } else if (formParams instanceof URLSearchParams) {
            encodedBody = formParams.toString();
          } else if (formParams && typeof formParams === "object") {
            const sp = new URLSearchParams();
            for (const [k, v] of Object.entries(formParams)) {
              if (v !== undefined && v !== null) {
                sp.append(k, String(v));
              }
            }
            encodedBody = sp.toString();
          }
          const hasCt =
            headers &&
            typeof headers === "object" &&
            Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
          const reqHeaders = hasCt
            ? headers
            : { ...headers, "Content-Type": "application/x-www-form-urlencoded" };
          const text =
            options !== undefined
              ? await resolvedHttpRequestText(
                  urlStr,
                  "POST",
                  encodedBody,
                  reqHeaders,
                  undefined,
                  options
                )
              : await resolvedHttpRequestText(urlStr, "POST", encodedBody, reqHeaders);
          return resolvedParseJsonpOrJson(text);
        };

  return {
    computeBkn: resolvedComputeBkn,
    cookieObjToString: resolvedCookieObjToString,
    httpsGetCookies: resolvedHttpsGetCookies,
    httpRequestText: resolvedHttpRequestText,
    httpGetJson: resolvedHttpGetJson,
    httpPostFormJson: resolvedHttpPostFormJson,
    parseJsonpOrJson: resolvedParseJsonpOrJson,
  };
}

async function fetchClientKey(bridge) {
  const res = await bridge.invokeNt("nodeIKernelTicketService/forceFetchClientKey", {}, []);
  return {
    clientKey: String(res?.clientKey || ""),
    expireTime: String(res?.expireTime || "7200"),
    keyIndex: String(res?.keyIndex || "19"),
    url: String(res?.url || ""),
  };
}

async function getCookiesObject(bridge, domain = "qun.qq.com", helpers = {}) {
  const { httpsGetCookies } = resolveHelpers(helpers);
  const uin = bridge.selfUin || "0";
  const uinCookie = `o${String(uin).padStart(10, "0")}`;
  const cookies = {
    uin: uinCookie,
    p_uin: uinCookie,
  };

  for (const psCmd of [
    "nodeIKernelTipOffService/getPskey",
    "nodeIKernelTicketService/getPskey",
  ]) {
    if (cookies.p_skey) break;
    try {
      const psRes = await bridge.invokeNt(
        psCmd,
        { domainList: [domain], isForNewPCQQ: true },
        [[domain], true]
      );
      const map = psRes?.domainPskeyMap || psRes;
      const pskey =
        map instanceof Map ? map.get(domain) : map && typeof map === "object" ? map[domain] : "";
      if (pskey) cookies.p_skey = String(pskey);
    } catch (_) {}
  }

  if (!cookies.p_skey && bridge.config?.allowPtloginJump !== false) {
    try {
      const ck = await fetchClientKey(bridge);
      if (ck.clientKey) {
        const jumpUrl =
          `https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=${encodeURIComponent(String(uin))}` +
          `&clientkey=${encodeURIComponent(ck.clientKey)}` +
          `&u1=${encodeURIComponent(`https://${domain}/${uin}/infocenter`)}` +
          `&keyindex=${encodeURIComponent(ck.keyIndex || "19")}`;
        const fetched = await httpsGetCookies(jumpUrl);
        Object.assign(cookies, fetched);
      }
    } catch (_) {}
  }

  return cookies;
}

async function dispatchWebCredentialOrQzoneAction(bridge, action, p = {}, helpers = {}) {
  const act = String(action || "").replace(/^\/+/, "").trim();
  assertWebCredentialApiEnabled(bridge?.config, act);

  const params = p && typeof p === "object" ? p : {};
  const resolvedHelpers = resolveHelpers(helpers);
  const {
    computeBkn: calcBkn,
    cookieObjToString: serializeCookies,
    httpGetJson,
    httpPostFormJson,
  } = resolvedHelpers;

  switch (act) {
    case "get_clientkey":
      return await fetchClientKey(bridge);

    case "get_cookies": {
      const cookies = await getCookiesObject(bridge, params.domain || "qun.qq.com", resolvedHelpers);
      return { cookies: serializeCookies(cookies) };
    }

    case "get_csrf_token": {
      const cookies = await getCookiesObject(bridge, params.domain || "qun.qq.com", resolvedHelpers);
      const token = calcBkn(cookies.p_skey || cookies.skey);
      return { token };
    }

    case "get_credentials": {
      const cookies = await getCookiesObject(bridge, params.domain || "qun.qq.com", resolvedHelpers);
      const token = calcBkn(cookies.p_skey || cookies.skey);
      return {
        cookies: serializeCookies(cookies),
        token,
        csrf_token: token,
      };
    }

    case "get_qzone_msg_list": {
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = calcBkn(cookies.p_skey || cookies.skey);
      const targetUin = String(params.target_uin || bridge.selfUin || "");
      const pos = Number(params.pos || 0);
      const num = Number(params.num || 10);
      const url =
        `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6?` +
        new URLSearchParams({
          uin: targetUin,
          ftype: "0",
          sort: "0",
          pos: String(pos),
          num: String(num),
          replynum: "100",
          g_tk: String(bkn),
          callback: "_preloadCallback",
          code_version: "1",
          format: "jsonp",
          need_private_comment: "1",
        }).toString();
      const data = await httpGetJson(url, {
        Cookie: serializeCookies(cookies),
      });
      const list = Array.isArray(data.msglist) ? data.msglist : [];
      return {
        total: Number(data.total ?? list.length),
        msglist: list.map((e) => ({
          tid: String(e.tid || ""),
          content: String(e.content || ""),
          time: Number(e.created_time || 0),
          comment_num: Number(e.cmtnum || 0),
          is_private: Number(e.secret || 0) !== 0,
          images: Array.isArray(e.pic)
            ? e.pic.map((pic) => pic.url2 || pic.url3 || pic.url1 || "").filter(Boolean)
            : [],
        })),
      };
    }

    case "get_qzone_feeds": {
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = calcBkn(cookies.p_skey || cookies.skey);
      const url =
        `https://h5.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?` +
        new URLSearchParams({
          uin: String(bridge.selfUin || ""),
          scope: "0",
          view: "1",
          filter: "all",
          flag: "1",
          applist: "all",
          pagenum: String(params.page_num || 1),
          count: String(params.count || 10),
          g_tk: String(bkn),
          callback: "_preloadCallback",
          format: "jsonp",
          useutf8: "1",
          outputhtmlfeed: "1",
        }).toString();
      const data = await httpGetJson(url, {
        Cookie: serializeCookies(cookies),
      });
      const rawFeeds = Array.isArray(data.data?.data) ? data.data.data : [];
      return {
        feeds: rawFeeds.filter(Boolean).map((f) => ({
          uin: Number(f.uin || 0),
          nickname: String(f.nickname || ""),
          time: Number(f.abstime || 0),
          appid: Number(f.appid || 0),
          key: String(f.key || f.feedskey || ""),
          html: String(f.html || ""),
        })),
        has_more: Number(data.data?.hasmore || 0) !== 0,
      };
    }

    case "send_qzone_msg": {
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = calcBkn(cookies.p_skey || cookies.skey);
      const hostUin = String(bridge.selfUin || "");
      const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${bkn}`;
      const body = new URLSearchParams({
        syn_tweet_verson: "1",
        paramstr: "1",
        con: String(params.content || ""),
        feedversion: "1",
        ver: "1",
        ugc_right: String(params.ugc_right || 1),
        to_sign: "0",
        who: "1",
        hostuin: hostUin,
        code_version: "1",
        format: "json",
        qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
      }).toString();
      const data = await httpPostFormJson(url, body, {
        Cookie: serializeCookies(cookies),
        "Content-Type": "application/x-www-form-urlencoded",
      });
      return {
        tid: String(data.t1_tid || data.tid || `qz_${Date.now()}`),
        time: Number(data.t1_time || data.now || Math.floor(Date.now() / 1000)),
      };
    }

    case "delete_qzone_msg": {
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = calcBkn(cookies.p_skey || cookies.skey);
      const hostUin = String(bridge.selfUin || "");
      const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${bkn}`;
      const body = new URLSearchParams({
        hostuin: hostUin,
        tid: String(params.tid || ""),
        t1_source: "1",
        code_version: "1",
        format: "fs",
        qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
      }).toString();
      await httpPostFormJson(url, body, {
        Cookie: serializeCookies(cookies),
        "Content-Type": "application/x-www-form-urlencoded",
      });
      return {};
    }

    case "like_qzone":
    case "unlike_qzone": {
      const like = act === "like_qzone";
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = calcBkn(cookies.p_skey || cookies.skey);
      const opUin = String(bridge.selfUin || "");
      const targetUin = String(params.target_uin || opUin);
      const tid = String(params.tid || "");
      const unikey = `http://user.qzone.qq.com/${targetUin}/mood/${tid}`;
      const url = `https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/${
        like ? "internal_dolike_app" : "internal_unlike_app"
      }?g_tk=${bkn}`;
      const body = new URLSearchParams({
        qzreferrer: `https://user.qzone.qq.com/${opUin}`,
        opuin: opUin,
        unikey,
        curkey: unikey,
        appid: "311",
        typeid: "0",
        abstime: String(params.abstime || 0),
        fid: tid,
        from: "1",
        active: "0",
        fupdate: "1",
        format: "json",
      }).toString();
      await httpPostFormJson(url, body, {
        Cookie: serializeCookies(cookies),
        "Content-Type": "application/x-www-form-urlencoded",
      });
      return {};
    }

    case "comment_qzone": {
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = calcBkn(cookies.p_skey || cookies.skey);
      const selfUin = String(bridge.selfUin || "");
      const hostUin = String(params.target_uin || selfUin);
      const tid = String(params.tid || "");
      const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${bkn}`;
      const body = new URLSearchParams({
        qzreferrer: `https://user.qzone.qq.com/${selfUin}`,
        inCharset: "utf-8",
        outCharset: "utf-8",
        hostUin,
        format: "json",
        ref: "feeds",
        topicId: `${hostUin}_${tid}__1`,
        feedsType: "100",
        private: "0",
        paramstr: "1",
        uin: selfUin,
        content: String(params.content || ""),
        plat: "qzone",
        source: "ic",
        platformid: "52",
      }).toString();
      const data = await httpPostFormJson(url, body, {
        Cookie: serializeCookies(cookies),
        "Content-Type": "application/x-www-form-urlencoded",
      });
      return { comment_id: String(data.commentid || data.commentId || "") };
    }

    default:
      throw new Error(`Unsupported web credential / QZone action: ${act}`);
  }
}

module.exports = {
  WEB_CREDENTIAL_ACTIONS,
  isWebCredentialApiEnabled,
  assertWebCredentialApiEnabled,
  computeBkn,
  computeGtk: computeBkn,
  cookieObjToString,
  isTrustedTencentHost,
  isAllowedRedirectHost,
  assertSafeTencentRedirect,
  httpsGetCookies: defaultHttpsGetCookies,
  httpRequestText: defaultHttpRequestText,
  httpGetJson: defaultHttpGetJson,
  httpPostFormJson: defaultHttpPostFormJson,
  parseJsonpOrJson: defaultParseJsonpOrJson,
  fetchClientKey,
  getCookiesObject,
  dispatchWebCredentialOrQzoneAction,
};

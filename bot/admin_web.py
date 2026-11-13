"""知识库接口：给 6099 控制台左边「标准答案」「资料库」两页用的 JSON API，只绑 127.0.0.1:8090。

页面本身在 ~/linmuAIBot（NapCat 前端的自维护版）里，这里只剩接口：
- **资料**：knowledge/ 里入库的文件。能上传 txt/md/pdf/docx/图片（图片由看图模型转成文字），
  能看切出来的块、删掉。逻辑在 `kb/uploads.py`。
  也能输网址抓那一页（`/api/docs/fetch`，逻辑在 `kb/webpage.py`，只认公网地址）。
- **爬常见问题**：给一个网址顺着同一个站往下爬，问答 + 截图整理成待审草稿（`/api/crawl`，逻辑在 `kb/crawl.py`）。
- **标准答案**：问法 → 回复，能增删改，能给答案配图（命中时文字发完接着发图，见 qa.py）。
  每次改完都 `sync.write()` 一遍，`data/知识库.md` 跟后台永远一致。
- **截图学答法**：传客服和客户的聊天截图，看图模型抄成对话（`/api/learn/read`，一张一个请求，张数不限），
  改好后整理成待审草稿（`/api/learn/analyze`），采纳才生效。逻辑在 `kb/learn_chat.py`。
- **被封禁的人**：你踢出群的人自动记进来，以后申请哪个群都拒；也能手动加、解封（`/api/banned`，表在 data/approvals.db）。
- **群公告**：勾几个售前、售后群（还有日报群），发群公告 / 传群文件 / 发一条 @全体 的群消息，看、删已经挂着的公告（`/api/groups/*`，逻辑在 `announce.py`）。
  要用机器人自己的 QQ 连接，所以 `serve()` 多收一个 client。

**跑在机器人进程里**，不单独起一个服务：库和向量缓存是同一份，后台一改，
下一个问题就按新的答（retrieve.py 按 revision 判断缓存失效）。
另起进程的话两边各开一个 sqlite 连接，还得想办法通知机器人重建缓存。

安全：
- 只绑 127.0.0.1，Host 也必须是本机（挡 DNS rebinding：恶意域名解析到 127.0.0.1 时 Host 是那个域名）。
  跑在容器里时绑 0.0.0.0（`ADMIN_HOST`），由 compose 只映射到宿主机 127.0.0.1:8090，Host 校验不变。
- 局域网访问（2026-09-29，`scripts/lan_proxy.py`）：Host 和 CORS 再认 `LAN_HOSTS` 里**列出来的**地址，
  不是什么都认。凭证那一层不变。
- 不另设口令，跟 6099 共用一套登录：请求带 6099 发的凭证（`Authorization: Bearer`），
  转手问 NapCat 真假（`napcat_auth.py`）。6099 登出/过期/NapCat 重启，这边一起失效。
- 页面在 6099、接口在 8090，属于跨域，CORS 只放行 6099 那几个本机来源。
  别的网页既拿不到凭证，也发不了带 Authorization 的跨域请求（预检过不了）。
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime
from urllib.parse import urlsplit
from pathlib import Path
from collections.abc import Awaitable, Callable
from typing import Any

from aiohttp import web

from . import announce
from .config import Settings
from .kb import crawl, learn_chat, review, sync, uploads, webpage
from .kb.llm import LLM, LLMError
from .kb.store import KB_IMAGE_DIR, KBStore
from .napcat_auth import NapCatAuth, NapCatDown
from .onebot import ApiError, OneBotClient
from .store import Store

log = logging.getLogger(__name__)

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
MAX_UPLOAD = 30 * 1024 * 1024
IMAGE_SUFFIXES = set(uploads.IMAGE_MIME)


def _json(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda o: __import__("json").dumps(o, ensure_ascii=False))


def _err(msg: str, status: int = 400) -> web.Response:
    return _json({"error": msg}, status)


def _allowed_origins(webui_url: str, lan_hosts: frozenset[str] = frozenset()) -> frozenset[str]:
    """6099 页面可能从 127.0.0.1 或 localhost 打开，两种都放行；开了局域网再加 LAN_HOSTS 里的"""
    u = urlsplit(webui_url)
    port = f":{u.port}" if u.port else ""
    return frozenset(f"{u.scheme}://{h}{port}" for h in ("127.0.0.1", "localhost", "[::1]", *sorted(lan_hosts)))


class AdminApp:
    def __init__(
        self, settings: Settings, store: KBStore, llm: LLM, auth: NapCatAuth | None = None, *,
        rewrite_llm: LLM | None = None, client: OneBotClient | None = None, approval_store: Store | None = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.llm = llm
        # 抓网页改成灵眸说法用的模型（复盘那个 REVIEW_MODEL：长提示词稳，答题那个会只思考不出正文）
        self.rewrite_llm = rewrite_llm or llm
        # 顺着网址爬常见问题（kb/crawl.py）。一次只跑一个，后台任务
        self.crawler = crawl.Crawler(
            store, llm, rewrite_llm=self.rewrite_llm, vision_model=settings.crawl_vision_model, hit_score=settings.kb_hit_score,
        )
        # 离线用例塞一个假的进来
        self.auth = auth or NapCatAuth(settings.webui_url)
        # CORS 看的是浏览器地址栏里 6099 的来源，不是机器人去连 NapCat 的地址：
        # 容器里后者是 http://napcat:6099，但浏览器永远是从 127.0.0.1:6099 打开的
        self.origins = _allowed_origins(settings.webui_public_url or settings.webui_url, settings.lan_hosts)
        self.hosts = LOCAL_HOSTS | settings.lan_hosts
        # 同一时间只跑一个上传/改问法：都要算向量，并发跑没好处还容易撞中转站限流
        self._embed_lock = asyncio.Lock()
        # 离线用例要指到临时文件，不然会盖掉真的 知识库.md
        self.kb_file = sync.KB_FILE
        # 发群公告、传群文件。没给 client（只起接口不连 QQ）时这几个接口一律 503
        self.announcer = announce.Announcer(client, settings.report_group) if client is not None else None
        # 入群审批的 Store（管被封禁用户）
        self.approval_store = approval_store

    # ---- 中间件：本机 Host + CORS + 6099 凭证 ----

    def _cors(self, request: web.Request, resp: web.StreamResponse) -> web.StreamResponse:
        origin = request.headers.get("Origin", "")
        if origin in self.origins:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Vary"] = "Origin"
            resp.headers["Access-Control-Expose-Headers"] = "Content-Disposition"
        return resp

    @web.middleware
    async def guard(self, request: web.Request, handler):  # type: ignore[no-untyped-def]
        host = (request.host or "").rsplit(":", 1)[0].strip("[]").lower()
        if host not in self.hosts:
            return web.Response(status=403, text="只允许本机和 LAN_HOSTS 里的地址访问")
        if not request.path.startswith("/api/"):
            return web.Response(status=404)
        if request.method == "OPTIONS":
            # 预检：带 Authorization 的跨域请求浏览器会先问这一下
            if request.headers.get("Origin", "") not in self.origins:
                return web.Response(status=403)
            resp = web.Response(status=204, headers={
                "Access-Control-Allow-Methods": "GET, POST, DELETE",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
                "Access-Control-Max-Age": "600",
            })
            return self._cors(request, resp)
        auth = request.headers.get("Authorization", "")
        cred = auth[7:] if auth.startswith("Bearer ") else ""
        try:
            ok = await self.auth.check(cred)
        except NapCatDown as e:
            return self._cors(request, _err(f"{e}，验不了登录", 503))
        if not ok:
            return self._cors(request, _err("没登录或登录过期了，重新登录 6099", 401))
        try:
            resp = await handler(request)
        except web.HTTPException as e:
            resp = e
        return self._cors(request, resp)

    # ---- 资料 ----

    async def list_docs(self, request: web.Request) -> web.Response:
        docs = await asyncio.to_thread(self.store.docs)
        return _json([
            {
                "path": d.path,
                "name": Path(d.path).name,
                "chars": d.chars,
                "chunks": d.n_chunks,
                "imported_at": d.imported_at,
                "uploaded": d.path.startswith("knowledge/上传/"),
                "has_raw": uploads.raw_of(d.path) is not None or webpage.raw_of(d.path) is not None,
                # 网页抓的（输网址那个框）：原网址，页面上能点开、能重新抓
                "web_url": webpage.source_url(d.path),
            }
            for d in docs
        ])

    async def doc_chunks(self, request: web.Request) -> web.Response:
        path = request.query.get("path", "")
        rows = await asyncio.to_thread(self.store.doc_chunks, path)
        return _json([{"title": t, "body": b} for t, b in rows])

    async def doc_raw(self, request: web.Request) -> web.StreamResponse:
        path = request.query.get("path", "")
        web_raw = webpage.raw_of(path)
        raw = uploads.raw_of(path) or web_raw
        if raw is None:
            return _err("没有原件", 404)
        if raw == web_raw:
            # 网页改写前的原文是 .md，按 text/markdown 给浏览器会直接下载，按纯文本给才能点开就看
            return web.FileResponse(raw, headers={"Content-Type": "text/plain; charset=utf-8"})
        return web.FileResponse(raw)

    async def upload_docs(self, request: web.Request) -> web.Response:
        reader = await request.multipart()
        results: list[dict[str, Any]] = []
        async for part in reader:
            if part.name != "file" or not part.filename:
                continue
            data = await part.read(decode=False)
            try:
                async with self._embed_lock:
                    r = await uploads.save_and_ingest(
                        self.store, self.llm, part.filename, bytes(data),
                        vision_model=self.settings.vision_model,
                    )
                results.append({"name": part.filename, "ok": True, "state": r.state, "chunks": r.chunks, "chars": r.chars})
            except (uploads.UploadError, LLMError) as e:
                results.append({"name": part.filename, "ok": False, "error": str(e)})
            except Exception as e:  # pdf/docx 解析库抛什么都有可能，别让一份坏文件把整批带崩
                log.exception("上传 %s 失败", part.filename)
                results.append({"name": part.filename, "ok": False, "error": f"解析失败：{e}"})
        return _json(results)

    async def fetch_url(self, request: web.Request) -> web.Response:
        """输一个网址，抓那一页入库（`kb/webpage.py`）。同一个网址再抓一次 = 更新那一份"""
        try:
            url = str((await request.json()).get("url", "")).strip()
        except ValueError:
            return _err("请求格式不对")
        if not url:
            return _err("网址是空的")
        try:
            r = await webpage.fetch_and_ingest(self.store, self.llm, url, rewrite_llm=self.rewrite_llm, lock=self._embed_lock)
        except (webpage.FetchError, uploads.UploadError, LLMError) as e:
            return _json({"url": url, "ok": False, "error": str(e)})
        except Exception as e:  # 网页千奇百怪，解析炸了别让整个接口 500
            log.exception("抓网页 %s 失败", url)
            return _json({"url": url, "ok": False, "error": f"解析失败：{type(e).__name__}"})
        return _json({
            "url": r.url, "ok": True, "title": r.title, "path": r.doc_path, "state": r.state,
            "chunks": r.chunks, "chars": r.chars, "replaced": r.replaced,
        })

    async def delete_doc(self, request: web.Request) -> web.Response:
        path = (await request.json()).get("path", "")
        try:
            ok = await asyncio.to_thread(uploads.delete, self.store, path)
        except uploads.UploadError as e:
            return _err(str(e))
        log.info("后台删除资料 %s", path)
        return _json({"ok": ok})

    # ---- 标准答案 ----

    def _entry_json(self, e: Any, images: list[tuple[int, str]]) -> dict[str, Any]:
        return {
            "id": e.id,
            "question": e.question,
            "aliases": [a for a in e.aliases.splitlines() if a.strip()],
            "answer": e.answer,
            "hits": e.hits,
            "updated_at": e.updated_at,
            "source": e.source,
            "images": [{"id": i, "url": f"/api/image/{i}"} for i, _ in images],
        }

    async def list_entries(self, request: web.Request) -> web.Response:
        entries = await asyncio.to_thread(self.store.entries)
        images = await asyncio.to_thread(self.store.all_entry_images)
        return _json([self._entry_json(e, images.get(e.id, [])) for e in entries])

    async def save_entry(self, request: web.Request) -> web.Response:
        """新建（不带 id）或修改（带 id）。问法/别名变了才重算向量。"""
        body = await request.json()
        question = str(body.get("question", "")).strip()
        answer = str(body.get("answer", "")).strip()
        aliases = "\n".join(
            a.strip() for a in body.get("aliases", []) if isinstance(a, str) and a.strip() and a.strip() != question
        )
        if not question or not answer:
            return _err("问题和回复都不能空")
        eid = body.get("id")
        old = None
        if eid is not None:
            old = await asyncio.to_thread(self.store.get_entry, int(eid))
            if old is None:
                return _err(f"没有 #{eid} 这条答案", 404)

        async with self._embed_lock:
            new_id, _ = await asyncio.to_thread(
                self.store.upsert_entry,
                question=question, answer=answer, aliases=aliases, source="web",
                entry_id=old.id if old else None,
            )
            entry = await asyncio.to_thread(self.store.get_entry, new_id)
            assert entry is not None
            if old is None or old.question != question or old.aliases != aliases:
                try:
                    vecs = await self.llm.embed(entry.phrasings)
                except LLMError as e:
                    # 跟 /答 一样：存下了但还检索不到，说清楚状态
                    await asyncio.to_thread(sync.write, self.store, self.kb_file)
                    return _err(f"答案 #{new_id} 存下了，但算向量失败（{e}），现在还匹配不到，稍后再点一次保存")
                await asyncio.to_thread(self.store.set_entry_vecs, new_id, list(zip(entry.phrasings, vecs)))
        await asyncio.to_thread(sync.write, self.store, self.kb_file)
        log.info("后台%s答案 #%d「%s」", "修改" if old else "新建", new_id, question[:30])
        await asyncio.to_thread(self.store.audit, "改" if old else "定", new_id, question, 0, "6099 页面")
        images = await asyncio.to_thread(self.store.entry_images, new_id)
        return _json(self._entry_json(entry, images))

    async def delete_entry(self, request: web.Request) -> web.Response:
        eid = int(request.match_info["id"])
        files = [f for _, f in await asyncio.to_thread(self.store.entry_images, eid)]
        ok = await asyncio.to_thread(self.store.delete_entry, eid)
        if ok:
            for f in files:
                (KB_IMAGE_DIR / f).unlink(missing_ok=True)
            await asyncio.to_thread(sync.write, self.store, self.kb_file)
            log.info("后台删除答案 #%d", eid)
            await asyncio.to_thread(self.store.audit, "删", eid, "", 0, "6099 页面")
        return _json({"ok": ok})

    async def upload_entry_image(self, request: web.Request) -> web.Response:
        eid = int(request.match_info["id"])
        if await asyncio.to_thread(self.store.get_entry, eid) is None:
            return _err(f"没有 #{eid} 这条答案", 404)
        reader = await request.multipart()
        added = []
        async for part in reader:
            if part.name != "file" or not part.filename:
                continue
            suffix = Path(part.filename).suffix.lower()
            if suffix not in IMAGE_SUFFIXES:
                return _err(f"只收图片（{' '.join(sorted(IMAGE_SUFFIXES))}）")
            data = bytes(await part.read(decode=False))
            if not data:
                continue
            KB_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
            fname = f"{eid}-{uuid.uuid4().hex[:12]}{suffix}"
            (KB_IMAGE_DIR / fname).write_bytes(data)
            iid = await asyncio.to_thread(self.store.add_entry_image, eid, fname)
            added.append({"id": iid, "url": f"/api/image/{iid}"})
        log.info("后台给答案 #%d 加了 %d 张图", eid, len(added))
        return _json(added)

    async def get_image(self, request: web.Request) -> web.StreamResponse:
        fname = await asyncio.to_thread(self.store.get_image, int(request.match_info["id"]))
        if fname is None or not (KB_IMAGE_DIR / fname).exists():
            return _err("图片不在了", 404)
        return web.FileResponse(KB_IMAGE_DIR / fname)

    async def delete_image(self, request: web.Request) -> web.Response:
        fname = await asyncio.to_thread(self.store.delete_image, int(request.match_info["id"]))
        if fname:
            (KB_IMAGE_DIR / fname).unlink(missing_ok=True)
        return _json({"ok": bool(fname)})

    async def stats(self, request: web.Request) -> web.Response:
        return _json({"line": await asyncio.to_thread(self.store.stats_line)})

    # ---- 夜间复盘的待审草稿（逻辑在 kb/review.py，跟私聊 /采纳 /不要 共用）----

    @property
    def _decider(self) -> int:
        # 页面是靠 6099 的令牌登录的，不知道是哪个 QQ 号在点。记成第一个超管，
        # 草稿表里 decided_by 只是留个痕，不参与任何判断
        return min(self.settings.super_admins) if self.settings.super_admins else 0

    def _draft_json(self, d: Any) -> dict[str, Any]:
        return {
            "id": d["id"], "kind": d["kind"], "entry_id": d["entry_id"], "merge_from": d["merge_from"],
            "question": d["question"], "answer": d["answer"],
            "options": self.store.draft_options(d),
            "aliases": [a for a in d["aliases"].splitlines() if a.strip()],
            "evidence": d["evidence"], "note": d["note"], "created_at": d["created_at"],
            "source_url": d["source_url"],
            "images": [
                {"id": i["id"], "url": f"/api/draft_image/{i['id']}", "caption": i["caption"]}
                for i in self.store.draft_images(d["id"])
            ],
        }

    async def list_drafts(self, request: web.Request) -> web.Response:
        rows = await asyncio.to_thread(self.store.drafts, "pending", 100)
        last = await asyncio.to_thread(self.store.last_review, datetime.now().strftime("%Y-%m-%d"))
        return _json({
            "drafts": [self._draft_json(d) for d in rows],
            "review": {"at": last["finished_at"] or last["started_at"], "summary": last["summary"], "error": last["error"]} if last else None,
        })

    async def accept_draft(self, request: web.Request) -> web.Response:
        did = int(request.match_info["id"])
        try:
            body = await request.json() if request.can_read_body else {}
        except ValueError:
            return _err("请求格式不对")
        aliases = body.get("aliases")
        if isinstance(aliases, list):
            aliases = "\n".join(a.strip() for a in aliases if isinstance(a, str) and a.strip())
        # 爬来的截图留哪几张（页面上勾的）。不传 = 全留
        imgs = body.get("images")
        images = [int(i) for i in imgs if isinstance(i, int)] if isinstance(imgs, list) else None
        try:
            async with self._embed_lock:
                said = await review.accept(
                    self.store, self.llm, self.settings, did, 0,
                    question=body.get("question"), answer=body.get("answer"), aliases=aliases,
                    kb_file=self.kb_file, by_name="6099 页面", images=images,
                )
        except review.DraftError as e:
            return _err(str(e), 409)
        return _json({"ok": True, "message": said})

    async def get_draft_image(self, request: web.Request) -> web.StreamResponse:
        row = await asyncio.to_thread(self.store.get_draft_image, int(request.match_info["id"]))
        if row is None or not (KB_IMAGE_DIR / row["file"]).exists():
            return _err("图片不在了", 404)
        return web.FileResponse(KB_IMAGE_DIR / row["file"])

    # ---- 截图学答法（kb/learn_chat.py）----

    async def learn_read(self, request: web.Request) -> web.Response:
        """一张聊天截图 → 抄出来的对话。一个请求一张：张数不限，页面一张张发，单张出错不连累别的"""
        reader = await request.multipart()
        data, name, staff = b"", "", ""
        async for part in reader:
            if part.name == "staff":
                staff = (await part.text()).strip()[:100]
            elif part.name == "file" and part.filename:
                name = part.filename
                data = bytes(await part.read(decode=False))
        suffix = Path(name).suffix.lower()
        if not data:
            return _err("没收到图片")
        if suffix not in IMAGE_SUFFIXES:
            return _err(f"{name} 不是图片（认 {'、'.join(sorted(IMAGE_SUFFIXES))}）")
        try:
            text = await learn_chat.transcribe(
                self.llm, data, uploads.IMAGE_MIME[suffix], model=self.settings.vision_model, staff_hint=staff,
            )
        except learn_chat.LearnError as e:
            return _err(str(e), 502)
        return _json({"name": name, "text": text})

    async def learn_analyze(self, request: web.Request) -> web.Response:
        """（改过的）几段对话 → 待审草稿，原样回给页面就地审。采纳 / 不要走 /api/drafts/{id}/... 那两个"""
        try:
            body = await request.json()
        except ValueError:
            return _err("请求格式不对")
        texts = body.get("texts") if isinstance(body, dict) else None
        if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
            return _err("texts 要是对话文字的列表")
        try:
            async with self._embed_lock:
                res = await learn_chat.analyze(
                    self.store, self.rewrite_llm, self.llm, texts, hit_score=self.settings.kb_hit_score,
                )
        except learn_chat.LearnError as e:
            return _err(str(e))
        rows = [await asyncio.to_thread(self.store.get_draft, i) for i in res.drafts]
        return _json({"drafts": [self._draft_json(d) for d in rows if d is not None], "skipped": res.skipped})

    # ---- 顺着网址爬常见问题（kb/crawl.py）----

    async def crawl_start(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except ValueError:
            return _err("请求格式不对")
        url = str(body.get("url", "")).strip()
        try:
            pages = int(body.get("max_pages") or crawl.MAX_PAGES)
        except (TypeError, ValueError):
            return _err("页数要是数字")
        if not url:
            return _err("网址是空的")
        try:
            jid = self.crawler.start(url, pages)
        except (crawl.CrawlError, webpage.FetchError) as e:
            return _err(str(e), 409)
        log.info("后台开始爬 %s（#%d，最多 %d 页）", url, jid, pages)
        return _json({"id": jid})

    async def crawl_stop(self, request: web.Request) -> web.Response:
        return _json({"ok": self.crawler.stop()})

    async def _crawl_again(self, request: web.Request, resume: bool) -> web.Response:
        """接着爬 / 重试。页数上限可选，不传就用这个任务原来的"""
        try:
            body = await request.json() if request.can_read_body else {}
        except ValueError:
            body = {}
        pages = body.get("max_pages")
        try:
            pages = int(pages) if pages not in (None, "") else None
        except (TypeError, ValueError):
            return _err("页数要是数字")
        jid = int(request.match_info["id"])
        try:
            new_id = self.crawler.resume(jid, pages) if resume else self.crawler.retry(jid, pages)
        except (crawl.CrawlError, webpage.FetchError) as e:
            return _err(str(e), 409)
        return _json({"ok": True, "id": new_id})

    async def crawl_resume(self, request: web.Request) -> web.Response:
        return await self._crawl_again(request, resume=True)

    async def crawl_retry(self, request: web.Request) -> web.Response:
        return await self._crawl_again(request, resume=False)

    async def crawl_list(self, request: web.Request) -> web.Response:
        rows = await asyncio.to_thread(self.store.crawl_jobs, 20)
        return _json({"running": self.crawler.running, "jobs": [crawl.job_json(r) for r in rows]})

    # ---- 自己人名单（复盘学谁的答法）----

    async def list_trusted(self, request: web.Request) -> web.Response:
        rows = await asyncio.to_thread(self.store.trusted_list)
        return _json({
            # 超管和 .env 里写的也列出来，但标成改不了 —— 那两处要改 .env
            "fixed": [{"user_id": u, "why": "超管" if u in self.settings.super_admins else ".env 的 TRUSTED"}
                      for u in sorted(self.settings.trusted)],
            "list": [{"user_id": r["user_id"], "note": r["note"], "created_at": r["created_at"]} for r in rows],
        })

    async def add_trusted(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            uid = int(str(body.get("user_id", "")).strip())
        except (ValueError, TypeError):
            return _err("QQ 号要是数字")
        if not (10000 <= uid <= 99999999999):
            return _err("这不像 QQ 号")
        note = str(body.get("note", "")).strip()[:40]
        await asyncio.to_thread(self.store.add_trusted, uid, note)
        log.info("自己人名单加了 %s（%s）", uid, note)
        return _json({"ok": True})

    async def remove_trusted(self, request: web.Request) -> web.Response:
        uid = int(request.match_info["uid"])
        ok = await asyncio.to_thread(self.store.remove_trusted, uid)
        if ok:
            log.info("自己人名单去掉了 %s", uid)
        return _json({"ok": ok})

    async def reject_draft(self, request: web.Request) -> web.Response:
        try:
            said = await review.reject(self.store, int(request.match_info["id"]), self._decider)
        except review.DraftError as e:
            return _err(str(e), 409)
        return _json({"ok": True, "message": said})

    # ---- 被封禁的人（入群审批那个库的 banned 表，见 handlers/approval.py）----
    # **不包 to_thread**：入群审批那个库的 sqlite 连接是在主线程开的，别的线程用会报错；
    # 那边一天几条审批，读写亚毫秒，直接在事件循环里调就行（store.py 开头写了为什么不上线程池）

    async def list_banned(self, request: web.Request) -> web.Response:
        if self.approval_store is None:
            return _err("没连入群审批的库", 503)
        return _json({"list": self.approval_store.banned()})

    async def add_banned(self, request: web.Request) -> web.Response:
        if self.approval_store is None:
            return _err("没连入群审批的库", 503)
        try:
            body = await request.json()
            uid = int(str(body.get("user_id", "")).strip())
        except (ValueError, TypeError, AttributeError):
            return _err("QQ 号要是数字")
        if not (10000 <= uid <= 99999999999):
            return _err("这不像 QQ 号")
        if uid in self.settings.super_admins:
            return _err("这是超管，不能封")
        note = str(body.get("note", "")).strip()[:40]
        self.approval_store.ban(uid, operator_id=self._decider, source="web", note=note)
        log.info("后台封了 %s（%s），以后申请哪个群都拒", uid, note)
        return _json({"ok": True})

    async def remove_banned(self, request: web.Request) -> web.Response:
        if self.approval_store is None:
            return _err("没连入群审批的库", 503)
        uid = int(request.match_info["uid"])
        ok = self.approval_store.unban(uid)
        if ok:
            log.info("后台解封了 %s", uid)
        return _json({"ok": ok})

    # ---- 群公告、群文件（announce.py）----

    async def _announce(self, do: Callable[[announce.Announcer], Awaitable[dict[str, Any]]]) -> web.Response:
        """`do(announcer)` 的几种失败翻成页面能直接显示的话"""
        if self.announcer is None:
            return _err("这个接口没连 QQ", 503)
        try:
            return _json(await do(self.announcer))
        except announce.AnnounceError as e:
            return _err(str(e), 409)
        except (ApiError, ConnectionError) as e:
            return _err(f"问 NapCat 失败：{e}", 503)

    @staticmethod
    def _group_ids(values: list[str]) -> list[int]:
        """表单里的 group_id 可以重复多个，也可以一个里面逗号隔开"""
        return [int(x) for v in values for x in str(v).replace("，", ",").split(",") if x.strip()]

    async def list_groups(self, request: web.Request) -> web.Response:
        async def do(a: announce.Announcer) -> dict[str, Any]:
            return {"groups": [announce.group_json(g) for g in await a.groups()], "busy": a.busy}
        return await self._announce(do)

    async def send_notice(self, request: web.Request) -> web.Response:
        """multipart：group_id（可多个）、content、pinned、confirm（"1" 算勾上），image 可选一张图"""
        form = await request.post()
        try:
            gids = self._group_ids(form.getall("group_id", []))
        except ValueError:
            return _err("群号要是数字")
        image = None
        f = form.get("image")
        if isinstance(f, web.FileField):
            if Path(f.filename).suffix.lower() not in IMAGE_SUFFIXES:
                return _err(f"公告图只收图片（{' '.join(sorted(IMAGE_SUFFIXES))}）")
            image = f.file.read() or None
        content = str(form.get("content", ""))
        pinned, confirm = form.get("pinned") in ("1", "true"), form.get("confirm") in ("1", "true")

        async def do(a: announce.Announcer) -> dict[str, Any]:
            return {"results": await a.notice(gids, content, image=image, pinned=pinned, confirm=confirm)}
        return await self._announce(do)

    async def send_file(self, request: web.Request) -> web.Response:
        """multipart：group_id（可多个）、file 一个文件，传到这几个群的群文件"""
        form = await request.post()
        try:
            gids = self._group_ids(form.getall("group_id", []))
        except ValueError:
            return _err("群号要是数字")
        f = form.get("file")
        if not isinstance(f, web.FileField):
            return _err("没收到文件")
        name, data = f.filename, f.file.read()

        async def do(a: announce.Announcer) -> dict[str, Any]:
            return {"results": await a.upload(gids, name, data)}
        return await self._announce(do)

    async def send_message(self, request: web.Request) -> web.Response:
        """multipart：group_id（可多个）、content、at_all（"1" = @全体，默认是），image 可选一张图"""
        form = await request.post()
        try:
            gids = self._group_ids(form.getall("group_id", []))
        except ValueError:
            return _err("群号要是数字")
        image = None
        f = form.get("image")
        if isinstance(f, web.FileField):
            if Path(f.filename).suffix.lower() not in IMAGE_SUFFIXES:
                return _err(f"图只收图片（{' '.join(sorted(IMAGE_SUFFIXES))}）")
            image = f.file.read() or None
        content = str(form.get("content", ""))
        at_all = form.get("at_all", "1") in ("1", "true")

        async def do(a: announce.Announcer) -> dict[str, Any]:
            return {"results": await a.message(gids, content, at_all=at_all, image=image)}
        return await self._announce(do)

    async def at_all_remain(self, request: web.Request) -> web.Response:
        """几个群今天还能 @全体 几次：`?group_id=1&group_id=2`，一个群查失败不影响别的"""
        try:
            gids = self._group_ids(request.query.getall("group_id", []))
        except ValueError:
            return _err("群号要是数字")

        async def do(a: announce.Announcer) -> dict[str, Any]:
            out: dict[str, Any] = {}
            for gid in gids:
                try:
                    out[str(gid)] = await a.at_all_remain(gid)
                except (announce.AnnounceError, ApiError) as e:
                    out[str(gid)] = {"error": str(e)}
            return {"remain": out}
        return await self._announce(do)

    async def list_notices(self, request: web.Request) -> web.Response:
        try:
            gid = int(request.query.get("group_id", ""))
        except ValueError:
            return _err("群号要是数字")

        async def do(a: announce.Announcer) -> dict[str, Any]:
            return {"notices": await a.notices(gid)}
        return await self._announce(do)

    async def delete_notice(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            gid, fid = int(body.get("group_id")), str(body.get("notice_id") or "").strip()
        except (ValueError, TypeError, AttributeError):
            return _err("群号要是数字")
        if not fid:
            return _err("没说删哪条")

        async def do(a: announce.Announcer) -> dict[str, Any]:
            await a.delete_notice(gid, fid)
            return {"ok": True}
        return await self._announce(do)

    def build(self) -> web.Application:
        app = web.Application(middlewares=[self.guard], client_max_size=MAX_UPLOAD)
        r = app.router
        r.add_get("/api/stats", self.stats)
        r.add_get("/api/docs", self.list_docs)
        r.add_get("/api/docs/chunks", self.doc_chunks)
        r.add_get("/api/docs/raw", self.doc_raw)
        r.add_post("/api/docs/upload", self.upload_docs)
        r.add_post("/api/docs/fetch", self.fetch_url)
        r.add_post("/api/docs/delete", self.delete_doc)
        r.add_get("/api/entries", self.list_entries)
        r.add_post("/api/entries", self.save_entry)
        r.add_delete("/api/entries/{id:\\d+}", self.delete_entry)
        r.add_post("/api/entries/{id:\\d+}/images", self.upload_entry_image)
        r.add_get("/api/image/{id:\\d+}", self.get_image)
        r.add_delete("/api/image/{id:\\d+}", self.delete_image)
        r.add_get("/api/drafts", self.list_drafts)
        r.add_post("/api/drafts/{id:\\d+}/accept", self.accept_draft)
        r.add_post("/api/drafts/{id:\\d+}/reject", self.reject_draft)
        r.add_get("/api/draft_image/{id:\\d+}", self.get_draft_image)
        r.add_post("/api/learn/read", self.learn_read)
        r.add_post("/api/learn/analyze", self.learn_analyze)
        r.add_get("/api/crawl", self.crawl_list)
        r.add_post("/api/crawl", self.crawl_start)
        r.add_post("/api/crawl/stop", self.crawl_stop)
        r.add_post("/api/crawl/{id:\\d+}/resume", self.crawl_resume)
        r.add_post("/api/crawl/{id:\\d+}/retry", self.crawl_retry)
        r.add_get("/api/trusted", self.list_trusted)
        r.add_post("/api/trusted", self.add_trusted)
        r.add_delete("/api/trusted/{uid:\\d+}", self.remove_trusted)
        r.add_get("/api/groups", self.list_groups)
        r.add_post("/api/groups/notice", self.send_notice)
        r.add_post("/api/groups/file", self.send_file)
        r.add_post("/api/groups/message", self.send_message)
        r.add_get("/api/groups/at_all_remain", self.at_all_remain)
        r.add_get("/api/groups/notices", self.list_notices)
        r.add_post("/api/groups/notices/delete", self.delete_notice)
        r.add_get("/api/banned", self.list_banned)
        r.add_post("/api/banned", self.add_banned)
        r.add_delete("/api/banned/{uid:\\d+}", self.remove_banned)
        return app


async def serve(
    settings: Settings, store: KBStore, llm: LLM, *, rewrite_llm: LLM | None = None,
    client: OneBotClient | None = None, approval_store: Store | None = None,
) -> None:
    """一直跑到被取消。端口占了只记日志，不拖垮机器人。"""
    admin = AdminApp(settings, store, llm, rewrite_llm=rewrite_llm, client=client, approval_store=approval_store)
    n = await asyncio.to_thread(store.crawl_fail_running)
    if n:
        log.info("重启前还在爬的 %d 个标成中断", n)
    runner = web.AppRunner(admin.build(), access_log=None)
    await runner.setup()
    try:
        site = web.TCPSite(runner, settings.admin_host, settings.admin_port)
        try:
            await site.start()
        except OSError as e:
            log.error("知识库接口起不来（端口 %d）：%s。机器人其它功能照常", settings.admin_port, e)
            return
        log.info("知识库接口已启动：http://%s:%d（页面在 6099 左边栏）", settings.admin_host, settings.admin_port)
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()
        await admin.auth.close()

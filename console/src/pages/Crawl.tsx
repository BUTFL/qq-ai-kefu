import { useEffect, useRef, useState, type FormEvent } from 'react';

import { api } from '../api/client';
import type { CrawlJob, CrawlListResponse } from '../api/types';
import Card from '../components/Card';
import Confirm from '../components/Confirm';
import { StateEmpty, StateError, StateLoading } from '../components/States';
import { useToast } from '../components/Toast';
import { errorMessage, refreshCounts } from '../lib/events';
import { navigate } from '../router';

const STATE_TAG: Record<string, { text: string; cls: string }> = {
  running: { text: '在爬', cls: 'tag jade' },
  done: { text: '爬完了', cls: 'tag jade' },
  stopped: { text: '停了', cls: 'tag amber' },
  failed: { text: '出错', cls: 'tag seal' },
};

/** 在爬的时候自动刷，别让人手动点 */
const POLL_MS = 4000;

/** 一行长摘要，照 6099 那页的写法拼。 */
function summary(job: CrawlJob): string {
  const when = job.finished_at || job.created_at;
  const parts = [
    `看了 ${job.pages} 页`,
    `找到 ${job.found} 条`,
    `起了 ${job.drafts} 条草稿、${job.images} 张图`,
  ];
  if (job.pending) parts.push(`还有 ${job.pending} 个网址没爬`);
  if (job.replaced.length) parts.push(`${job.replaced.join('、')} 换成了灵眸`);
  if (job.error) parts.push(job.error);
  return `${when} · ${parts.join(' · ')}`;
}

type Pending = { job: CrawlJob; kind: 'retry' | 'resume' } | null;

export default function Crawl() {
  const [data, setData] = useState<CrawlListResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState('30');
  const [starting, setStarting] = useState(false);
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openLog, setOpenLog] = useState<number | null>(null);
  const toast = useToast();
  const abortRef = useRef<AbortController | null>(null);

  const load = async (silent = false, signal?: AbortSignal) => {
    if (!silent) setError(null);
    try {
      setData(await api.get<CrawlListResponse>('/crawl', signal));
    } catch (err) {
      if (!silent) setError(err);
      throw err;
    }
  };

  // 进页面拉一次；在爬的时候每 4 秒刷一次，离开页面就停
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    void load(false, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, []);

  const running = data?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void load(true, abortRef.current?.signal).catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (starting) return;
    const target = url.trim();
    if (!target) {
      setFormError('网址是空的');
      return;
    }
    if (!/^https?:\/\//i.test(target)) {
      setFormError('网址要以 http:// 或 https:// 开头');
      return;
    }
    setFormError('');
    setStarting(true);
    try {
      await api.post('/crawl', { url: target, max_pages: Number(maxPages) || undefined });
      setUrl('');
      toast('开始爬了，可以关掉这页，爬完再回来看');
      await load(true).catch(() => undefined);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const again = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const path =
        pending.kind === 'resume'
          ? `/crawl/${pending.job.id}/resume`
          : `/crawl/${pending.job.id}/retry`;
      await api.post(path, { max_pages: Number(maxPages) || undefined });
      setPending(null);
      toast(pending.kind === 'resume' ? '接着爬了' : '从头重爬了');
      await load(true).catch(() => undefined);
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post('/crawl/stop');
      setStopping(false);
      toast('停了。爬过的页不会白费，下面能接着爬');
      await load(true).catch(() => undefined);
      refreshCounts();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="note">
        给一个文档站的网址，机器人顺着这个站往下爬（只在同一个站、这一层往下，常见问题和报错排查的页先爬），
        把「客户会问的问题 + 怎么解决」整理成待审草稿，每条两三种说法，配的截图一起带上。
        <b>别家平台的文档会改成灵眸的说法</b>
        ：名称网址换成我们的，别家的价格政策不写，带别家名字网址的截图丢掉。跟已有标准答案、已有草稿重复的不再起。爬完去「待审草稿」挑，采纳了才算数。
      </p>

      <Card>
        <div className="pad">
          <form className="inline-form" onSubmit={start}>
            <label className="field grow-1">
              <span className="lab">从哪个网址开始爬</span>
              <span className="box">
                <input
                  className="inp"
                  id="crawl-url"
                  value={url}
                  placeholder="https://docs.xxx.com/docs/faq"
                  onChange={(event) => setUrl(event.target.value)}
                />
              </span>
            </label>
            <label className="field narrow">
              <span className="lab">最多几页</span>
              <span className="box">
                <input
                  className="inp"
                  id="crawl-pages"
                  value={maxPages}
                  inputMode="numeric"
                  onChange={(event) => setMaxPages(event.target.value)}
                />
              </span>
            </label>
            <button className="btn" type="submit" disabled={starting || running}>
              {starting ? '开着…' : running ? '有一个在爬' : '开始爬'}
            </button>
          </form>
          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}
          <p className="m dim wrap">
            一页大约 20~60 秒（要让模型挑问答、改说法、看图），30 页十几分钟。可以关掉这页，爬完再回来看。
            <b>一次只能爬一个站。</b>
            停了或者出错的，下面可以接着爬 —— 从上次停下的地方往下走，爬过的页不再爬。上面那个页数是总共最多爬几页，所以接着爬之前记得调大一点。
          </p>
        </div>
      </Card>

      <Card
        title="爬过的"
        sub={running ? '在爬，每几秒自动刷' : undefined}
        right={
          running ? (
            <button className="btn quiet" type="button" onClick={() => setStopping(true)}>
              停
            </button>
          ) : undefined
        }
      >
        {error ? (
          <StateError error={error} onRetry={() => void load().catch(() => undefined)} />
        ) : data === null ? (
          <StateLoading />
        ) : data.jobs.length === 0 ? (
          <StateEmpty>还没爬过。上面填个文档站的网址试试。</StateEmpty>
        ) : (
          data.jobs.map((job) => {
            const tag = STATE_TAG[job.state] ?? { text: job.state, cls: 'tag' };
            return (
              <div className="job" key={job.id}>
                <div className="top">
                  <span className={tag.cls}>{tag.text}</span>
                  <span className="url">{job.url}</span>
                  <span className="m dim">#{job.id}</span>
                </div>
                <div className="sum">{summary(job)}</div>
                {job.state === 'running' && job.max_pages ? (
                  <div
                    className="prog"
                    role="progressbar"
                    aria-valuenow={job.pages}
                    aria-valuemin={0}
                    aria-valuemax={job.max_pages}
                    aria-label={`爬了 ${job.pages} 页，最多 ${job.max_pages} 页`}
                  >
                    <i
                      className="run"
                      style={{ width: `${Math.min(100, (job.pages / job.max_pages) * 100)}%` }}
                    />
                  </div>
                ) : null}
                <div className="acts2">
                  {job.can_resume ? (
                    <button
                      className="link"
                      type="button"
                      onClick={() => setPending({ job, kind: 'resume' })}
                    >
                      接着爬（还剩 {job.pending} 个网址）
                    </button>
                  ) : null}
                  {job.state !== 'running' ? (
                    <button
                      className="link"
                      type="button"
                      onClick={() => setPending({ job, kind: 'retry' })}
                    >
                      从头重爬
                    </button>
                  ) : null}
                  {job.drafts > 0 ? (
                    <button className="link" type="button" onClick={() => navigate('/kb/drafts')}>
                      去待审草稿挑 →
                    </button>
                  ) : null}
                  {job.log ? (
                    <button
                      className="link"
                      type="button"
                      onClick={() => setOpenLog(openLog === job.id ? null : job.id)}
                    >
                      {openLog === job.id ? '收起日志' : '看日志'}
                    </button>
                  ) : null}
                </div>
                {openLog === job.id && job.log ? <pre className="logline">{job.log}</pre> : null}
              </div>
            );
          })
        )}
      </Card>

      <Confirm
        open={pending !== null}
        title={pending?.kind === 'resume' ? '接着爬' : '从头重爬'}
        busy={busy}
        confirmText={pending?.kind === 'resume' ? '接着爬' : '重爬'}
        message={
          pending?.kind === 'resume' ? (
            <>
              从上次停下的地方接着爬 <b>{pending.job.url}</b>，爬过的 {pending.job.pages}{' '}
              页不再爬。页数上限用上面填的 {maxPages} 页 —— 比爬过的页数大才有意义。
            </>
          ) : (
            <>
              从头重爬 <b>{pending?.job.url}</b>，之前爬过的页会重新看一遍，最多 {maxPages} 页。
            </>
          )
        }
        onConfirm={() => void again()}
        onCancel={() => setPending(null)}
      />

      <Confirm
        open={stopping}
        title="停下这次爬取"
        danger
        busy={busy}
        confirmText="停"
        message="停了之后已经起的草稿还在，爬过的页不会白费 —— 回头能从停下的地方接着爬。"
        onConfirm={() => void stop()}
        onCancel={() => setStopping(false)}
      />
    </>
  );
}

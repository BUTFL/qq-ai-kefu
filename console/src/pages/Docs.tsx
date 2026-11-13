import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

import { api } from '../api/client';
import type { Doc, DocChunk, FetchResult, UploadResult } from '../api/types';
import Card from '../components/Card';
import Confirm from '../components/Confirm';
import Modal from '../components/Modal';
import { StateEmpty, StateError, StateLoading } from '../components/States';
import Table, { type TableColumn } from '../components/Table';
import { useToast } from '../components/Toast';
import { useCounts } from '../lib/counts';
import { errorMessage, refreshCounts } from '../lib/events';

const ACCEPT = '.txt,.md,.markdown,.pdf,.docx,.png,.jpg,.jpeg,.webp,.gif';
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

interface LogLine {
  id: number;
  ok?: boolean;
  text: string;
}

interface Viewing {
  path: string;
  chunks: DocChunk[] | null;
  error?: unknown;
}

export default function Docs() {
  const { docs, docsError, loadDocs } = useCounts();
  const [log, setLog] = useState<LogLine[]>([]);
  const [urls, setUrls] = useState('');
  const [fetching, setFetching] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [deleting, setDeleting] = useState<Doc | null>(null);
  const [busy, setBusy] = useState(false);

  const uploadRef = useRef<HTMLInputElement>(null);
  const viewSeq = useRef(0);
  const logId = useRef(1);
  const toast = useToast();

  useEffect(() => {
    void loadDocs().catch(() => undefined);
  }, [loadDocs]);

  const totalChunks = useMemo(() => (docs ?? []).reduce((sum, doc) => sum + doc.chunks, 0), [docs]);

  // 上传 / 抓取 / 删除后刷新列表；刷新失败只 toast，不动页面级 error
  const refreshAfterChange = async () => {
    try {
      await loadDocs(true, { silent: true });
    } catch (err) {
      toast(errorMessage(err), 'err');
    }
    refreshCounts();
  };

  const appendLog = (text: string): number => {
    const id = logId.current++;
    setLog((prev) => [{ id, text }, ...prev].slice(0, 30));
    return id;
  };

  const updateLog = (id: number, patch: Partial<LogLine>) => {
    setLog((prev) => prev.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    for (const file of files) {
      const id = appendLog(
        `⏳ ${file.name} 上传中（切块、算向量${IMAGE_RE.test(file.name) ? '、识别图片文字' : ''}，可能要十几秒）…`,
      );
      try {
        const data = new FormData();
        data.append('file', file);
        const results = await api.postForm<UploadResult[]>('/docs/upload', data);
        const result = results[0];
        if (!result) {
          updateLog(id, { ok: false, text: `❌ ${file.name}：后端没回结果` });
        } else if (result.ok) {
          const state =
            result.state === '跳过'
              ? '内容没变，跳过'
              : `${result.state ?? '已入库'}，${result.chars ?? 0} 字，切成 ${result.chunks ?? 0} 块`;
          updateLog(id, { ok: true, text: `✅ ${file.name}：${state}` });
        } else {
          updateLog(id, { ok: false, text: `❌ ${file.name}：${result.error ?? '上传失败'}` });
        }
      } catch (err) {
        updateLog(id, { ok: false, text: `❌ ${file.name}：${errorMessage(err)}` });
      }
    }
    await refreshAfterChange();
  };

  const fetchUrls = async (raw: string[], options: { keepInput?: boolean } = {}) => {
    if (fetching) return;
    const list = [...new Set(raw.flatMap((value) => value.split(/\s+/)).map((value) => value.trim()).filter(Boolean))];
    if (!list.length) return;

    setFetching(true);
    let anyOk = false;
    try {
      for (const url of list) {
        const id = appendLog(`⏳ ${url} 抓取中（下载、提取正文；别家的文档还要改成灵眸的说法，长页面要一两分钟）…`);
        try {
          const result = await api.post<FetchResult>('/docs/fetch', { url });
          if (result.ok) {
            anyOk = true;
            const state =
              result.state === '跳过'
                ? '内容没变，跳过'
                : `${result.state ?? '已入库'}，${result.chars ?? 0} 字，切成 ${result.chunks ?? 0} 块`;
            const replaced = result.replaced?.length
              ? `，已把 ${result.replaced.join('、')} 换成灵眸（点「打开原件」看改之前的）`
              : '';
            updateLog(id, {
              ok: true,
              text: `✅ ${result.title ?? url}：${state}${replaced}（${result.url}）`,
            });
          } else {
            updateLog(id, { ok: false, text: `❌ ${url}：${result.error ?? '抓取失败'}` });
          }
        } catch (err) {
          updateLog(id, { ok: false, text: `❌ ${url}：${errorMessage(err)}` });
        }
      }
    } finally {
      setFetching(false);
      // 全部抓失败时保留输入框里的网址，用户不用重打；「重新抓」也不清
      if (anyOk && !options.keepInput) setUrls('');
      await refreshAfterChange();
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    void upload(Array.from(event.dataTransfer.files));
  };

  const onFetchKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void fetchUrls([urls]);
    }
  };

  const closeView = () => {
    viewSeq.current += 1;
    setViewing(null);
  };

  const view = async (doc: Doc) => {
    const seq = ++viewSeq.current;
    setViewing({ path: doc.path, chunks: null });
    try {
      const chunks = await api.get<DocChunk[]>(`/docs/chunks?path=${encodeURIComponent(doc.path)}`);
      if (seq === viewSeq.current) setViewing({ path: doc.path, chunks });
    } catch (err) {
      if (seq === viewSeq.current) setViewing({ path: doc.path, chunks: null, error: err });
    }
  };

  const openRaw = async (doc: Doc) => {
    const popup = window.open('', '_blank');
    try {
      const blob = await api.getBlob(`/docs/raw?path=${encodeURIComponent(doc.path)}`);
      const url = URL.createObjectURL(blob);
      if (popup) {
        popup.location.href = url;
      } else {
        window.open(url, '_blank', 'noopener');
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      popup?.close();
      toast(errorMessage(err), 'err');
    }
  };

  const removeDoc = async () => {
    if (busy || !deleting) return;
    const target = deleting;
    setBusy(true);
    try {
      await api.post('/docs/delete', { path: target.path });
      setDeleting(null);
      toast('已删除');
      await refreshAfterChange();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<Doc>[] = [
    {
      key: 'file',
      label: '文件',
      render: (doc) => {
        const source = doc.web_url ? '网页' : doc.uploaded ? '后台上传' : '自动抓取';
        return (
          <div className="q-cell">
            <div className="doc-name-row">
              <span className="q">{doc.name}</span>
              <span className="tag">{source}</span>
            </div>
            <div className="m dim doc-path">{doc.path}</div>
            {doc.web_url ? (
              <a className="doc-url" href={doc.web_url} target="_blank" rel="noreferrer">
                {doc.web_url}
              </a>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'chars',
      label: '字数',
      width: 78,
      numeric: true,
      render: (doc) => <span className="m">{doc.chars.toLocaleString('zh-CN')}</span>,
    },
    {
      key: 'chunks',
      label: '块数',
      width: 58,
      numeric: true,
      render: (doc) => <span className="m">{doc.chunks}</span>,
    },
    {
      key: 'imported_at',
      label: '导入时间',
      width: 150,
      render: (doc) => <span className="m dim">{doc.imported_at}</span>,
    },
    {
      key: 'actions',
      label: '操作',
      width: 190,
      render: (doc) => (
        <div className="acts">
          <button className="link" type="button" aria-label={`查看 ${doc.name} 的内容`} onClick={() => void view(doc)}>
            看内容
          </button>
          {doc.web_url ? (
            <button
              className="link"
              type="button"
              aria-label={`重新抓取 ${doc.name}`}
              disabled={fetching}
              onClick={() => void fetchUrls([doc.web_url], { keepInput: true })}
            >
              重新抓
            </button>
          ) : null}
          {doc.has_raw ? (
            <button
              className="link"
              type="button"
              aria-label={`打开 ${doc.name} 的原件`}
              onClick={() => void openRaw(doc)}
            >
              打开原件
            </button>
          ) : null}
          <button
            className="link danger"
            type="button"
            aria-label={`删除 ${doc.name}`}
            onClick={() => setDeleting(doc)}
          >
            删
          </button>
        </div>
      ),
    },
  ];

  const loading = docs === null && docsError === null;
  const fatalError = docs === null ? docsError : null;

  return (
    <>
      <Card>
        <div className="pad">
          <div
            className={dragActive ? 'drop active' : 'drop'}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              // 鼠标只是掠过拖拽区里的按钮时不取消
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragActive(false);
              }
            }}
            onDrop={onDrop}
          >
            <span className="tag">拖进来</span>
            <button className="btn" type="button" onClick={() => uploadRef.current?.click()}>
              选择文件上传
            </button>
            <span className="d">
              或者把文件拖到这里。支持 txt / md / pdf / docx，以及图片 png / jpg / webp（图片会用 AI
              识别里面的文字）。同名文件会覆盖更新。
            </span>
            <input
              ref={uploadRef}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                void upload(files);
              }}
            />
          </div>

          <div className="field">
            <span className="lab">抓网页</span>
            <div className="fetch-row">
              <div className="box">
                <textarea
                  className="ta url-input"
                  value={urls}
                  onChange={(event) => setUrls(event.target.value)}
                  onKeyDown={onFetchKeyDown}
                  placeholder="https://docs.lmuai.com/docs/guide/getting-started"
                  aria-label="要抓的网页地址"
                  disabled={fetching}
                />
              </div>
              <button
                className="btn quiet"
                type="button"
                disabled={fetching || !urls.trim()}
                onClick={() => void fetchUrls([urls])}
              >
                {fetching ? '抓取中…' : '抓取'}
              </button>
            </div>
            <span className="m dim" style={{ lineHeight: 1.7 }}>
              输网址回车就抓这一页的文字当资料（不会顺着链接爬整站）。几个网址一行一个，同一个网址再抓一次是更新。别家平台的文档会自动改成灵眸的：名称、网址、注册和控制台换成我们的，别家的价格政策删掉。要登录、或者要浏览器跑
              JS 才出内容的页面抓不到
            </span>
          </div>
        </div>
      </Card>

      {log.length > 0 ? (
        <div className="upload-log" aria-live="polite">
          {log.map((line) => (
            <div
              key={line.id}
              className={line.ok === true ? 'log-line ok' : line.ok === false ? 'log-line err' : 'log-line'}
            >
              {line.text}
            </div>
          ))}
        </div>
      ) : null}

      <Card
        title="资料库"
        sub={`${docs?.length ?? 0} 份 · ${totalChunks} 块`}
        footer={
          <>
            「自动抓取」= <code>knowledge/</code> 目录里自己同步进来的；「后台上传」= 这页传的；「网页」=
            上面抓的，能重新抓一次。
          </>
        }
      >
        {loading ? (
          <StateLoading />
        ) : fatalError ? (
          <StateError error={fatalError} onRetry={() => void loadDocs(true).catch(() => undefined)} />
        ) : (
          <Table label="资料列表" columns={columns} rows={docs ?? []} rowKey={(doc) => doc.path} empty="还没有资料" />
        )}
      </Card>

      <Modal
        open={viewing !== null}
        title={viewing ? viewing.path : '看内容'}
        wide
        onClose={closeView}
        footer={
          <button className="btn quiet" type="button" onClick={closeView}>
            关闭
          </button>
        }
      >
        {viewing ? (
          viewing.error ? (
            <StateError error={viewing.error} />
          ) : viewing.chunks === null ? (
            <StateLoading />
          ) : viewing.chunks.length === 0 ? (
            <StateEmpty>没有内容</StateEmpty>
          ) : (
            <div>
              {viewing.chunks.map((chunk, index) => (
                <div className="chunk" key={`${index}-${chunk.title}`}>
                  <h4>
                    {index + 1}. {chunk.title}
                  </h4>
                  <pre>{chunk.body}</pre>
                </div>
              ))}
            </div>
          )
        ) : null}
      </Modal>

      <Confirm
        open={deleting !== null}
        title="删除资料"
        danger
        busy={busy}
        confirmText="删掉"
        message={deleting ? `删除资料「${deleting.path}」？机器人以后就查不到这份资料里的内容了。` : ''}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void removeDoc()}
      />
    </>
  );
}

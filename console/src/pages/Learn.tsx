import { useEffect, useRef, useState, type DragEvent } from 'react';

import { api } from '../api/client';
import type { Draft, DraftActionResponse, LearnAnalyzeResponse, LearnReadResponse } from '../api/types';
import Card from '../components/Card';
import Confirm from '../components/Confirm';
import DraftCard, { type DraftEdit } from '../components/DraftCard';
import { StateError } from '../components/States';
import { useToast } from '../components/Toast';
import { errorMessage, refreshCounts } from '../lib/events';

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

interface Shot {
  id: number;
  name: string;
  /** reading 读着 / ok 抄出来了 / fail 这张没读出来 */
  state: 'reading' | 'ok' | 'fail';
  text: string;
  error?: string;
}

export default function Learn() {
  const [staff, setStaff] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [dragging, setDragging] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<unknown>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [editing, setEditing] = useState<Record<number, DraftEdit>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<Draft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const toast = useToast();

  // 离开页面时取消在途的读图和整理
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => controller.abort();
  }, []);

  const addFiles = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((file) => IMAGE_RE.test(file.name));
    const bad = Array.from(files ?? []).length - list.length;
    if (bad > 0) toast(`${bad} 个文件不是图片，跳过了`, 'err');
    if (list.length === 0) return;

    // 一张一个请求：哪张读不出来不连累别的
    for (const file of list) {
      const id = nextId.current++;
      setShots((prev) => [...prev, { id, name: file.name, state: 'reading', text: '' }]);
      const form = new FormData();
      form.append('file', file);
      if (staff.trim()) form.append('staff', staff.trim());
      try {
        const res = await api.postForm<LearnReadResponse>(
          '/learn/read',
          form,
          abortRef.current?.signal,
        );
        setShots((prev) =>
          prev.map((shot) => (shot.id === id ? { ...shot, state: 'ok', text: res.text } : shot)),
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'ApiError' && errorMessage(err) === '请求已取消') return;
        setShots((prev) =>
          prev.map((shot) =>
            shot.id === id ? { ...shot, state: 'fail', error: errorMessage(err) } : shot,
          ),
        );
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  };

  const ready = shots.filter((shot) => shot.state === 'ok' && shot.text.trim());

  const analyze = async () => {
    if (analyzing || ready.length === 0) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await api.post<LearnAnalyzeResponse>(
        '/learn/analyze',
        { texts: ready.map((shot) => shot.text) },
        abortRef.current?.signal,
      );
      setDrafts(res.drafts);
      setSkipped(res.skipped ?? []);
      if (res.drafts.length === 0) {
        toast('没整理出新的答法 —— 可能跟已有标准答案重复了', 'err');
      } else {
        toast(`整理出 ${res.drafts.length} 条，挑一种说法再采纳`);
      }
      refreshCounts();
    } catch (err) {
      setAnalyzeError(err);
    } finally {
      setAnalyzing(false);
    }
  };

  const keptOf = (draft: Draft): number[] => draft.images.map((image) => image.id);

  const accept = async (draft: Draft) => {
    if (busy !== null) return;
    setBusy(draft.id);
    const edit = editing[draft.id];
    const index = picked[draft.id] ?? 0;
    const body: Record<string, unknown> = {};
    if (edit) {
      body.question = edit.question.trim();
      if (draft.kind !== 'alias') {
        body.answer = edit.answer.trim();
        body.aliases = edit.aliases
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
      }
    } else if (draft.kind !== 'alias' && draft.options.length > 1) {
      body.answer = draft.options[index]?.answer ?? draft.answer;
    }
    try {
      const res = await api.post<DraftActionResponse>(`/drafts/${draft.id}/accept`, body);
      toast(res.message || '采纳了');
      setDrafts((prev) => prev.filter((item) => item.id !== draft.id));
      refreshCounts();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!rejecting || busy !== null) return;
    setBusy(rejecting.id);
    try {
      const res = await api.post<DraftActionResponse>(`/drafts/${rejecting.id}/reject`);
      toast(res.message || '不要了');
      setDrafts((prev) => prev.filter((item) => item.id !== rejecting.id));
      setRejecting(null);
      refreshCounts();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className="note">
        传客服和客户的聊天截图（张数不限），机器人先把对话抄出来，你看一眼抄得对不对、哪句是客服说的；
        再点「整理成答法」，它把「客户问什么、客服怎么答的」整理成标准答案草稿。
        <b>点采纳才生效</b>
        ，采纳之前客户问到了还是按原来的答。回复里只用客服说过的话，号码、链接对不上的会自动扔掉。
      </p>

      <div className="two">
        <Card title="抄出来的对话" sub={shots.length ? `${shots.length} 张` : undefined}>
          <div className="pad">
            {shots.length === 0 ? (
              <p className="m dim">右边传几张截图，抄出来的对话会出现在这儿，能改。</p>
            ) : (
              shots.map((shot) => (
                <div className="field" key={shot.id}>
                  <span className="lab">
                    {shot.name}
                    {shot.state === 'reading' ? ' · 读取中…' : ''}
                    {shot.state === 'fail' ? ' · 这张没读出来' : ''}
                  </span>
                  {shot.state === 'fail' ? (
                    <p className="form-error">{shot.error}</p>
                  ) : (
                    <span className="box">
                      <textarea
                        className="ta"
                        rows={6}
                        value={shot.text}
                        placeholder={shot.state === 'reading' ? '读取中…' : ''}
                        aria-label={`${shot.name} 抄出来的对话`}
                        onChange={(event) =>
                          setShots((prev) =>
                            prev.map((item) =>
                              item.id === shot.id ? { ...item, text: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    </span>
                  )}
                  <div className="acts2">
                    <button
                      className="link danger"
                      type="button"
                      onClick={() => setShots((prev) => prev.filter((item) => item.id !== shot.id))}
                    >
                      这张不要
                    </button>
                  </div>
                </div>
              ))
            )}
            {shots.length > 0 ? (
              <p className="m dim wrap">
                一行一句。谁说的认错了就直接改这段文字（比如把「客服：」改成「客户：」），整理的时候按改完的算。
              </p>
            ) : null}
          </div>
        </Card>

        <Card title="传截图">
          <div className="pad">
            <label className="field">
              <span className="lab">客服昵称（可不填）</span>
              <span className="box">
                <input
                  className="inp"
                  id="learn-staff"
                  value={staff}
                  placeholder="截图里客服的昵称，多个用逗号隔开。认不出谁是客服时填上再传"
                  onChange={(event) => setStaff(event.target.value)}
                />
              </span>
            </label>

            <div
              className={dragging ? 'drop over' : 'drop'}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={onDrop}
            >
              <span className="tag">拖进来</span>
              <span className="t">把聊天截图拖到这里，或者</span>
              <button className="btn quiet" type="button" onClick={() => fileRef.current?.click()}>
                选截图
              </button>
              <span className="d">png jpg webp · 张数不限 · 一张一张读，哪张读不出来不影响别的</span>
              <input
                ref={fileRef}
                type="file"
                hidden
                multiple
                accept=".png,.jpg,.jpeg,.webp"
                onChange={(event) => void addFiles(event.target.files)}
              />
            </div>

            <button
              className="btn key"
              type="button"
              disabled={analyzing || ready.length === 0}
              onClick={() => void analyze()}
            >
              {analyzing ? '整理中…' : `整理成答法（${ready.length} 张）`}
            </button>
            {analyzing ? <p className="m dim">要让模型读一遍对话，几十秒，别关页面。</p> : null}
            {analyzeError ? <StateError error={analyzeError} onRetry={() => void analyze()} /> : null}
            {skipped.length > 0 ? (
              <p className="m dim wrap">跳过的：{skipped.join('；')}</p>
            ) : null}
          </div>
        </Card>
      </div>

      {drafts.length > 0 ? (
        <Card title="整理出来的" sub={`${drafts.length} 条，采纳才生效`}>
          <div className="pad">
            <p className="m dim">
              这些已经存成待审草稿了。在这儿采纳跟去「待审草稿」页采纳是一回事，关了页面也不会丢。
            </p>
          </div>
        </Card>
      ) : null}

      {drafts.map((draft) => (
        <DraftCard
          key={draft.id}
          draft={draft}
          picked={picked[draft.id] ?? 0}
          onPick={(index) => setPicked({ ...picked, [draft.id]: index })}
          keptImages={keptOf(draft)}
          onToggleImage={() => undefined}
          editing={editing[draft.id] ?? null}
          onStartEdit={() =>
            setEditing({
              ...editing,
              [draft.id]: {
                question: draft.question,
                aliases: draft.aliases.join('\n'),
                answer: draft.options[picked[draft.id] ?? 0]?.answer ?? draft.answer,
              },
            })
          }
          onChangeEdit={(edit) => setEditing({ ...editing, [draft.id]: edit })}
          onCancelEdit={() =>
            setEditing((prev) => {
              const next = { ...prev };
              delete next[draft.id];
              return next;
            })
          }
          onAccept={() => void accept(draft)}
          onReject={() => setRejecting(draft)}
          busy={busy === draft.id}
        />
      ))}

      <Confirm
        open={rejecting !== null}
        title="不要这条草稿"
        danger
        busy={busy !== null}
        confirmText="不要"
        message={
          <>
            驳回「{rejecting?.question}」。<b>同样的问法以后复盘不再起草稿。</b>
          </>
        }
        onConfirm={() => void reject()}
        onCancel={() => setRejecting(null)}
      />
    </>
  );
}

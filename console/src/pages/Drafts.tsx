import { useEffect, useState } from 'react';

import { api } from '../api/client';
import type { Draft, DraftActionResponse, DraftListResponse } from '../api/types';
import Card from '../components/Card';
import Confirm from '../components/Confirm';
import DraftCard, { type DraftEdit } from '../components/DraftCard';
import { StateEmpty, StateError, StateLoading } from '../components/States';
import { useToast } from '../components/Toast';
import { errorMessage, refreshCounts } from '../lib/events';

export default function Drafts() {
  const [data, setData] = useState<DraftListResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [kept, setKept] = useState<Record<number, number[]>>({});
  const [editing, setEditing] = useState<Record<number, DraftEdit>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<Draft | null>(null);
  const toast = useToast();

  const load = async (silent = false) => {
    if (!silent) setError(null);
    try {
      setData(await api.get<DraftListResponse>('/drafts'));
    } catch (err) {
      if (silent) toast(errorMessage(err), 'err');
      else setError(err);
      throw err;
    }
  };

  useEffect(() => {
    void load().catch(() => undefined);
  }, []);

  const keptOf = (draft: Draft): number[] =>
    kept[draft.id] ?? draft.images.map((image) => image.id);

  const toggleImage = (draft: Draft, id: number) => {
    const current = keptOf(draft);
    setKept({
      ...kept,
      [draft.id]: current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    });
  };

  const accept = async (draft: Draft) => {
    if (busy !== null) return;
    setBusy(draft.id);
    const edit = editing[draft.id];
    const index = picked[draft.id] ?? 0;
    // 没改过就按挑的那种说法送；改过了送改完的
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
    if (draft.kind === 'new' && draft.images.length > 0) {
      body.images = keptOf(draft);
    }
    try {
      const res = await api.post<DraftActionResponse>(`/drafts/${draft.id}/accept`, body);
      toast(res.message || '采纳了');
      setEditing((prev) => {
        const next = { ...prev };
        delete next[draft.id];
        return next;
      });
      await load(true).catch(() => undefined);
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
      setRejecting(null);
      await load(true).catch(() => undefined);
      refreshCounts();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(null);
    }
  };

  const review = data?.review;

  return (
    <>
      <p className="note">
        机器人每晚 23:00 复盘当天的对话，从人工客服的回答、客户的问法里起草标准答案。
        同事在群里的回答、机器人答不上来的问题、「爬常见问题」爬来的问答，都会整理成几种说法让你挑一种，或者挑了再改。
        意思重复的两条标准答案会起一条「合并」草稿，采纳就留一条、另一条的问法并过来再删掉。
        <b>没采纳之前它用不上这些草稿</b>，客户问到了还是按原来的路子答。
      </p>

      <Card
        title="待审草稿"
        sub={data ? `${data.drafts.length} 条等你审` : undefined}
        right={
          <button className="btn quiet" type="button" onClick={() => void load(true).catch(() => undefined)}>
            刷新
          </button>
        }
        footer={
          <>
            私聊发 <code>/采纳 编号</code>、<code>/不要 编号</code> 效果一样。自己人在日报群也能发。
            {review ? (
              <>
                <br />
                上次复盘 {review.at}
                {review.summary ? ` · ${review.summary}` : ''}
                {review.error ? ` · 出错：${review.error}` : ''}
              </>
            ) : null}
          </>
        }
      >
        {error ? (
          <StateError error={error} onRetry={() => void load().catch(() => undefined)} />
        ) : data === null ? (
          <StateLoading />
        ) : data.drafts.length === 0 ? (
          <StateEmpty>没有待审的草稿。今晚 23:00 复盘完再来看。</StateEmpty>
        ) : null}
      </Card>

      {data?.drafts.map((draft) => (
        <DraftCard
          key={draft.id}
          draft={draft}
          picked={picked[draft.id] ?? 0}
          onPick={(index) => setPicked({ ...picked, [draft.id]: index })}
          keptImages={keptOf(draft)}
          onToggleImage={(id) => toggleImage(draft, id)}
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
            驳回「{rejecting?.question}」。<b>同样的问法以后复盘不再起草稿</b>，客户问到了还是按原来的路子答。
          </>
        }
        onConfirm={() => void reject()}
        onCancel={() => setRejecting(null)}
      />
    </>
  );
}

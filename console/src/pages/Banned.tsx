import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { api } from '../api/client';
import type { BannedResponse, BannedRow } from '../api/types';
import Card from '../components/Card';
import Confirm from '../components/Confirm';
import { StateError, StateLoading } from '../components/States';
import Table, { type TableColumn } from '../components/Table';
import { useToast } from '../components/Toast';
import { errorMessage, refreshCounts } from '../lib/events';

/** source 三种，照 bot/store.py 的 ban(source=...) */
const HOW: Record<string, { text: string; tag: string }> = {
  kick: { text: '被你踢出群', tag: 'tag seal' },
  web: { text: '这里手动加的', tag: 'tag' },
  log: { text: '以前踢的（从日志导入）', tag: 'tag' },
};

export default function Banned() {
  const [rows, setRows] = useState<BannedRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [keyword, setKeyword] = useState('');
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState('');
  const [unbanning, setUnbanning] = useState<BannedRow | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = async (silent = false) => {
    if (!silent) setError(null);
    try {
      const data = await api.get<BannedResponse>('/banned');
      setRows(data.list);
    } catch (err) {
      if (silent) toast(errorMessage(err), 'err');
      else setError(err);
      throw err;
    }
  };

  useEffect(() => {
    void load().catch(() => undefined);
  }, []);

  const shown = useMemo(() => {
    const list = rows ?? [];
    const kw = keyword.trim().toLowerCase();
    if (!kw) return list;
    return list.filter((row) =>
      [String(row.user_id), row.nickname ?? '', row.note].join('\n').toLowerCase().includes(kw),
    );
  }, [rows, keyword]);

  const ban = async (event: FormEvent) => {
    event.preventDefault();
    if (adding) return;
    const id = userId.trim();
    if (!/^\d{5,11}$/.test(id)) {
      setFormError('QQ 号要是 5 到 11 位数字');
      return;
    }
    setFormError('');
    setAdding(true);
    try {
      await api.post('/banned', { user_id: id, note: note.trim() });
      setUserId('');
      setNote('');
      toast('封了，他以后申请哪个群都会被拒');
      await load(true).catch(() => undefined);
      refreshCounts();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const unban = async () => {
    if (!unbanning || busy) return;
    setBusy(true);
    try {
      await api.del(`/banned/${unbanning.user_id}`);
      setUnbanning(null);
      toast('解封了');
      await load(true).catch(() => undefined);
      refreshCounts();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<BannedRow>[] = [
    {
      key: 'user_id',
      label: 'QQ 号',
      width: 132,
      render: (row) => <span className="m">{row.user_id}</span>,
    },
    {
      key: 'who',
      label: '昵称 / 备注',
      render: (row) => {
        // 昵称可能是全角空格（QQ 上有人就这么起名）。只判真值的话会渲染一个
        // 看不见的块级元素，把备注顶到第二行，行高还跟着变 —— 所以先 trim
        const nickname = (row.nickname ?? '').trim();
        const note = row.note.trim();
        return (
          <>
            {nickname ? <span className="q">{nickname}</span> : null}
            {note ? <span className="m dim">{note}</span> : null}
            {!nickname && !note ? <span className="m dim">—</span> : null}
          </>
        );
      },
    },
    {
      key: 'how',
      label: '怎么封的',
      render: (row) => {
        const how = HOW[row.source] ?? { text: row.source || '—', tag: 'tag' };
        return (
          <>
            <span className={how.tag}>{how.text}</span>
            {row.group_id ? <div className="m dim">群 {row.group_id}</div> : null}
          </>
        );
      },
    },
    {
      key: 'banned_at',
      label: '封禁时间',
      width: 158,
      render: (row) => <span className="m dim">{row.banned_at}</span>,
    },
    {
      key: 'ops',
      label: '操作',
      width: 78,
      render: (row) => (
        <div className="acts">
          <button className="link danger" type="button" onClick={() => setUnbanning(row)}>
            解封
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <p className="note">
        你把谁踢出群，机器人就记到这里，<b>以后他申请哪个群都自动拒，永久有效</b>
        。拒的时候回他「请输入正确订单号」，不告诉他被封了，也不私聊你。踢错了在这儿解封；也能在下面手动封一个号。
      </p>

      <Card
        title="被封禁的人"
        sub={rows ? `${rows.length} 个` : undefined}
        right={
          rows ? (
            <label className="search">
              <span className="m dim">搜</span>
              <input
                id="banned-search"
                value={keyword}
                placeholder="QQ 号或昵称"
                aria-label="搜索被封禁的人"
                onChange={(event) => setKeyword(event.target.value)}
              />
            </label>
          ) : undefined
        }
        footer={rows ? '昵称是他最后一次申请进群时填的，库里有才显示。' : undefined}
      >
        {error ? (
          <StateError error={error} onRetry={() => void load().catch(() => undefined)} />
        ) : rows === null ? (
          <StateLoading />
        ) : (
          <>
            <form className="inline-form" onSubmit={ban}>
              <label className="field">
                <span className="lab">QQ 号</span>
                <span className="box">
                  <input
                    className="inp"
                    id="banned-uid"
                    value={userId}
                    inputMode="numeric"
                    placeholder="10 位数字"
                    onChange={(event) => setUserId(event.target.value)}
                  />
                </span>
              </label>
              <label className="field grow-1">
                <span className="lab">备注（为什么封）</span>
                <span className="box">
                  <input
                    className="inp"
                    id="banned-note"
                    value={note}
                    placeholder="广告"
                    onChange={(event) => setNote(event.target.value)}
                  />
                </span>
              </label>
              <button className="btn" type="submit" disabled={adding}>
                {adding ? '封着…' : '封禁'}
              </button>
            </form>
            {formError ? (
              <p className="form-error" role="alert">
                {formError}
              </p>
            ) : null}
            <Table
              label="被封禁的人"
              columns={columns}
              rows={shown}
              rowKey={(row) => row.user_id}
              empty={keyword ? '没有匹配的' : '还没有封过人'}
            />
          </>
        )}
      </Card>

      <Confirm
        open={unbanning !== null}
        title="解封"
        busy={busy}
        confirmText="解封"
        message={
          <>
            放 <b>{unbanning?.user_id}</b>
            {unbanning?.nickname ? `（${unbanning.nickname}）` : ''} 回来？解封之后他申请进群会照常走审批。
          </>
        }
        onConfirm={() => void unban()}
        onCancel={() => setUnbanning(null)}
      />
    </>
  );
}

import { useEffect, useState, type FormEvent } from 'react';

import { api } from '../api/client';
import type { TrustedResponse } from '../api/types';
import Card from '../components/Card';
import Confirm from '../components/Confirm';
import { StateError, StateLoading } from '../components/States';
import Table, { type TableColumn } from '../components/Table';
import { useToast } from '../components/Toast';
import { errorMessage, refreshCounts } from '../lib/events';

/** 表里混着两种行：.env 定死的（改不了）和这页加的（能移除）。 */
interface Row {
  user_id: number;
  note: string;
  created_at: string;
  fixed: boolean;
}

function toRows(data: TrustedResponse): Row[] {
  return [
    // 固定的排最上：超管和 .env 的 TRUSTED 要改得去改 .env
    ...data.fixed.map((item) => ({
      user_id: item.user_id,
      note: item.why,
      created_at: '',
      fixed: true,
    })),
    ...data.list.map((item) => ({ ...item, fixed: false })),
  ];
}

export default function Trusted() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState('');
  const [removing, setRemoving] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = async (silent = false) => {
    if (!silent) setError(null);
    try {
      const data = await api.get<TrustedResponse>('/trusted');
      setRows(toRows(data));
    } catch (err) {
      if (silent) toast(errorMessage(err), 'err');
      else setError(err);
      throw err;
    }
  };

  useEffect(() => {
    void load().catch(() => undefined);
    // 只在进页面时拉一次
  }, []);

  const add = async (event: FormEvent) => {
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
      await api.post('/trusted', { user_id: id, note: note.trim() });
      setUserId('');
      setNote('');
      toast('加好了，30 秒内生效');
      await load(true).catch(() => undefined);
      refreshCounts();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const remove = async () => {
    if (!removing || busy) return;
    setBusy(true);
    try {
      await api.del(`/trusted/${removing.user_id}`);
      setRemoving(null);
      toast('移除了');
      await load(true).catch(() => undefined);
      refreshCounts();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<Row>[] = [
    {
      key: 'user_id',
      label: 'QQ 号',
      width: 132,
      render: (row) => <span className="m">{row.user_id}</span>,
    },
    {
      key: 'note',
      label: '备注',
      render: (row) =>
        row.fixed ? <span className="tag">{row.note}</span> : row.note || <span className="m dim">—</span>,
    },
    {
      key: 'created_at',
      label: '加入时间',
      width: 158,
      render: (row) => <span className="m dim">{row.created_at || '—'}</span>,
    },
    {
      key: 'ops',
      label: '操作',
      width: 96,
      render: (row) =>
        row.fixed ? (
          <span className="m dim">改 .env</span>
        ) : (
          <div className="acts">
            <button className="link danger" type="button" onClick={() => setRemoving(row)}>
              移除
            </button>
          </div>
        ),
    },
  ];

  return (
    <>
      <p className="note">
        这些 QQ 号在群里回客户的话，机器人每晚复盘时会当成「人工客服的答法」来学，起草成标准答案给你审。
        不在名单里的人互相回答的，只当成客户在问什么，不当答案。<b>加了 30 秒内生效</b>
        ；复盘按当晚的名单认人，所以今天加进来的同事，加之前在群里回的话当晚也会学。
        <br />
        他们在<b>日报群</b>里跟你一样能发指令：<code>/答</code> 定答案、<code>/采纳</code> 审草稿、
        <code>/结束</code> 关会话都行。客户群里和私聊还是不行。
      </p>

      <Card title="自己人" sub={rows ? `${rows.length} 个` : undefined}>
        {error ? (
          <StateError error={error} onRetry={() => void load().catch(() => undefined)} />
        ) : rows === null ? (
          <StateLoading />
        ) : (
          <>
            <form className="inline-form" onSubmit={add}>
              <label className="field">
                <span className="lab">QQ 号</span>
                <span className="box">
                  <input
                    className="inp"
                    id="trusted-uid"
                    value={userId}
                    inputMode="numeric"
                    placeholder="10 位数字"
                    onChange={(event) => setUserId(event.target.value)}
                  />
                </span>
              </label>
              <label className="field grow-1">
                <span className="lab">备注（这人是谁）</span>
                <span className="box">
                  <input
                    className="inp"
                    id="trusted-note"
                    value={note}
                    placeholder="同事"
                    onChange={(event) => setNote(event.target.value)}
                  />
                </span>
              </label>
              <button className="btn" type="submit" disabled={adding}>
                {adding ? '加着…' : '加进来'}
              </button>
            </form>
            {formError ? (
              <p className="form-error" role="alert">
                {formError}
              </p>
            ) : null}
            <Table
              label="自己人名单"
              columns={columns}
              rows={rows}
              rowKey={(row) => row.user_id}
              rowClassName={(row) => (row.fixed ? 'row-fixed' : undefined)}
              empty="名单是空的"
            />
          </>
        )}
      </Card>

      <Confirm
        open={removing !== null}
        title="移除自己人"
        danger
        busy={busy}
        confirmText="移除"
        message={
          <>
            把 <b>{removing?.user_id}</b> 从名单里去掉？他之后在群里回客户的话，复盘就不当答案学了。
          </>
        }
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}

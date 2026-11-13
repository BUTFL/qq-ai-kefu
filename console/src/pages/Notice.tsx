import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api/client';
import type {
  AtAllRemainResponse,
  Group,
  GroupNotice,
  GroupsResponse,
  NoticesResponse,
  SendResponse,
  SendResult,
} from '../api/types';
import Card from '../components/Card';
import Confirm from '../components/Confirm';
import { StateEmpty, StateError, StateLoading } from '../components/States';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/events';
import { setQueryParams, useQueryParam } from '../router';

const TABS = [
  { key: 'notice', label: '发公告' },
  { key: 'message', label: '发群消息' },
  { key: 'file', label: '传群文件' },
  { key: 'sent', label: '已发的公告' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function kindTag(kind: string): string {
  return kind === '日报群' ? 'tag jade' : 'tag';
}

export default function Notice() {
  const tabParam = useQueryParam('tab');
  const groupParam = useQueryParam('group');
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'notice';

  const [groups, setGroups] = useState<Group[] | null>(null);
  const [groupsError, setGroupsError] = useState<unknown>(null);
  const [checked, setChecked] = useState<number[]>([]);

  const [content, setContent] = useState('');
  const [pinned, setPinned] = useState(true);
  const [confirmRequired, setConfirmRequired] = useState(false);
  const [noticeImage, setNoticeImage] = useState<File | null>(null);

  const [message, setMessage] = useState('');
  const [atAll, setAtAll] = useState(true);
  const [messageImage, setMessageImage] = useState<File | null>(null);
  const [remain, setRemain] = useState<AtAllRemainResponse['remain']>({});

  const [file, setFile] = useState<File | null>(null);

  const [notices, setNotices] = useState<GroupNotice[] | null>(null);
  const [noticesError, setNoticesError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState<GroupNotice | null>(null);

  const [askSend, setAskSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<SendResult[] | null>(null);

  const noticeImageRef = useRef<HTMLInputElement>(null);
  const messageImageRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const loadGroups = useCallback(async () => {
    setGroupsError(null);
    try {
      const data = await api.get<GroupsResponse>('/groups');
      setGroups(data.groups);
    } catch (err) {
      setGroupsError(err);
    }
  }, []);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const chosen = useMemo(
    () => (groups ?? []).filter((group) => checked.includes(group.group_id)),
    [groups, checked],
  );

  // 切到「发群消息」或者勾的群变了，查一下这几个群今天还能 @全体 几次
  useEffect(() => {
    if (tab !== 'message' || !atAll || chosen.length === 0) return;
    const controller = new AbortController();
    const query = chosen.map((group) => `group_id=${group.group_id}`).join('&');
    void api
      .get<AtAllRemainResponse>(`/groups/at_all_remain?${query}`, controller.signal)
      .then((data) => setRemain(data.remain))
      .catch(() => undefined);
    return () => controller.abort();
  }, [tab, atAll, chosen]);

  // 「已发的公告」一个群一个群看：接口必须带 group_id，没有「所有群」这种查法
  const sentGroup = groupParam ? Number(groupParam) : (chosen[0]?.group_id ?? null);

  useEffect(() => {
    if (tab !== 'sent' || !sentGroup) {
      setNotices(null);
      return;
    }
    const controller = new AbortController();
    setNotices(null);
    setNoticesError(null);
    void api
      .get<NoticesResponse>(`/groups/notices?group_id=${sentGroup}`, controller.signal)
      .then((data) => setNotices(data.notices))
      .catch((err) => {
        if (!controller.signal.aborted) setNoticesError(err);
      });
    return () => controller.abort();
  }, [tab, sentGroup]);

  const toggle = (id: number) => {
    setChecked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const quickPick = (filter: (group: Group) => boolean) => {
    setChecked((groups ?? []).filter(filter).map((group) => group.group_id));
  };

  const canSend =
    chosen.length > 0 &&
    ((tab === 'notice' && content.trim().length > 0) ||
      (tab === 'message' && message.trim().length > 0) ||
      (tab === 'file' && file !== null));

  const send = async () => {
    if (sending) return;
    setSending(true);
    setResults(null);
    try {
      const form = new FormData();
      for (const group of chosen) form.append('group_id', String(group.group_id));
      let path = '/groups/notice';
      if (tab === 'notice') {
        form.append('content', content.trim());
        form.append('pinned', pinned ? '1' : '0');
        form.append('confirm', confirmRequired ? '1' : '0');
        if (noticeImage) form.append('image', noticeImage);
      } else if (tab === 'message') {
        path = '/groups/message';
        form.append('content', message.trim());
        form.append('at_all', atAll ? '1' : '0');
        if (messageImage) form.append('image', messageImage);
      } else {
        path = '/groups/file';
        if (file) form.append('file', file);
      }
      const res = await api.postForm<SendResponse>(path, form);
      setResults(res.results);
      setAskSend(false);
      const ok = res.results.filter((r) => r.ok).length;
      const failed = res.results.length - ok;
      toast(failed ? `${ok} 个群发出去了，${failed} 个没发成` : `${ok} 个群都发出去了`, failed ? 'err' : 'ok');
      if (!failed) {
        if (tab === 'notice') {
          setContent('');
          setNoticeImage(null);
        } else if (tab === 'message') {
          setMessage('');
          setMessageImage(null);
        } else {
          setFile(null);
        }
      }
    } catch (err) {
      setAskSend(false);
      toast(errorMessage(err), 'err');
    } finally {
      setSending(false);
    }
  };

  const removeNotice = async () => {
    if (!deleting || !sentGroup || sending) return;
    setSending(true);
    try {
      await api.post('/groups/notices/delete', {
        group_id: sentGroup,
        notice_id: deleting.notice_id,
      });
      setNotices((prev) => prev?.filter((item) => item.notice_id !== deleting.notice_id) ?? null);
      setDeleting(null);
      toast('删了');
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setSending(false);
    }
  };

  const sendLabel =
    tab === 'file' ? `传到选中的 ${chosen.length} 个群` : `发到选中的 ${chosen.length} 个群`;

  return (
    <>
      <p className="note">
        用机器人的 QQ 往售前、售后群发群公告、发 @全体 的群消息、传文档。先勾要发的群，再写内容，
        <b>点发之前会再让你看一眼发到哪几个群</b>
        。一个群一个群地发，哪个群没发成下面会写原因，别的群不受影响。列的是群名带「售前」「售后」的群和日报群，别的群发不进去。
      </p>

      <Card
        title="发到哪些群"
        right={
          groups ? (
            <>
              <button className="btn quiet" type="button" onClick={() => quickPick(() => true)}>
                全选
              </button>
              <button
                className="btn quiet"
                type="button"
                onClick={() => quickPick((group) => group.kind === '售前')}
              >
                只选售前
              </button>
              <button
                className="btn quiet"
                type="button"
                onClick={() => quickPick((group) => group.kind === '售后')}
              >
                只选售后
              </button>
              <button className="link" type="button" onClick={() => setChecked([])}>
                清空
              </button>
              <span className="m dim">
                已选 {chosen.length} / {groups.length} 个群
              </span>
            </>
          ) : undefined
        }
      >
        {groupsError ? (
          <StateError error={groupsError} onRetry={() => void loadGroups()} />
        ) : groups === null ? (
          <StateLoading />
        ) : groups.length === 0 ? (
          <StateEmpty>没有能发的群。群名要带「售前」「售后」，或者是日报群。</StateEmpty>
        ) : (
          groups.map((group) => (
            <label className="grow" key={group.group_id}>
              <input
                type="checkbox"
                checked={checked.includes(group.group_id)}
                onChange={() => toggle(group.group_id)}
              />
              <span className={kindTag(group.kind)}>{group.kind}</span>
              <span className="nm">{group.name}</span>
              <span className="meta">
                {group.group_id} · {group.members} 人
              </span>
              {group.admin === false ? <span className="tag amber">机器人不是管理员</span> : null}
            </label>
          ))
        )}
      </Card>

      <Card className="tabbed">
        <div className="ch tabs" role="tablist" aria-label="发什么">
          {TABS.map((item) => (
            <button
              key={item.key}
              className="ntab"
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              aria-current={tab === item.key ? 'page' : undefined}
              onClick={() => setQueryParams({ tab: item.key }, { replace: true })}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'notice' ? (
          <div className="pad">
            <label className="field">
              <span className="lab">公告内容</span>
              <span className="box">
                <textarea
                  className="ta"
                  rows={5}
                  value={content}
                  placeholder="比如：国庆期间（10 月 1 日至 7 日）人工客服暂停，机器人照常回答，急事请在群里 @ 管理员。"
                  onChange={(event) => setContent(event.target.value)}
                />
              </span>
            </label>
            <div className="acts2">
              <button className="btn quiet" type="button" onClick={() => noticeImageRef.current?.click()}>
                {noticeImage ? `换一张（${noticeImage.name}）` : '加一张图（可不加）'}
              </button>
              {noticeImage ? (
                <button className="link danger" type="button" onClick={() => setNoticeImage(null)}>
                  不加图
                </button>
              ) : null}
              <input
                ref={noticeImageRef}
                type="file"
                hidden
                accept=".png,.jpg,.jpeg,.webp"
                onChange={(event) => setNoticeImage(event.target.files?.[0] ?? null)}
              />
            </div>
            <div className="sw-row">
              <label className="sw">
                <span>
                  置顶
                  <em>群公告会一直挂在顶上</em>
                </span>
                <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              </label>
              <label className="sw">
                <span>
                  要群成员确认收到
                  <em>没确认的会一直看到红点</em>
                </span>
                <input
                  type="checkbox"
                  checked={confirmRequired}
                  onChange={(e) => setConfirmRequired(e.target.checked)}
                />
              </label>
            </div>
            <button className="btn key" type="button" disabled={!canSend} onClick={() => setAskSend(true)}>
              {sendLabel}
            </button>
          </div>
        ) : null}

        {tab === 'message' ? (
          <div className="pad">
            <label className="field">
              <span className="lab">{atAll ? '消息内容（开头会自动带上 @全体成员）' : '消息内容'}</span>
              <span className="box">
                <textarea
                  className="ta"
                  rows={5}
                  value={message}
                  placeholder="比如：今晚 22:00~22:30 系统维护，期间可能连不上，维护完会在群里说一声。"
                  onChange={(event) => setMessage(event.target.value)}
                />
              </span>
            </label>
            <div className="acts2">
              <button className="btn quiet" type="button" onClick={() => messageImageRef.current?.click()}>
                {messageImage ? `换一张（${messageImage.name}）` : '加一张图（可不加）'}
              </button>
              {messageImage ? (
                <button className="link danger" type="button" onClick={() => setMessageImage(null)}>
                  不加图
                </button>
              ) : null}
              <input
                ref={messageImageRef}
                type="file"
                hidden
                accept=".png,.jpg,.jpeg,.webp"
                onChange={(event) => setMessageImage(event.target.files?.[0] ?? null)}
              />
            </div>
            <label className="sw">
              <span>
                @全体成员
                <em>群里每个人都会收到提醒</em>
              </span>
              <input type="checkbox" checked={atAll} onChange={(e) => setAtAll(e.target.checked)} />
            </label>
            {atAll && chosen.length > 0 ? (
              <div className="field">
                <span className="lab">
                  今天还能 @全体 几次（QQ 按天限次数，用完了消息照发、但不提醒所有人）
                </span>
                {chosen.map((group) => {
                  const r = remain[String(group.group_id)];
                  let note = <span className="m dim">查着…</span>;
                  if (r?.error) note = <span className="m dim">{r.error}</span>;
                  else if (r && r.can === false)
                    note = <span className="tag amber">机器人在这个群不能 @全体（不是管理员）</span>;
                  else if (r && r.left != null) note = <span className="m">还剩 {r.left} 次</span>;
                  return (
                    <div className="remain-row" key={group.group_id}>
                      <span className="nm">{group.name}</span>
                      {note}
                    </div>
                  );
                })}
              </div>
            ) : null}
            <button className="btn key" type="button" disabled={!canSend} onClick={() => setAskSend(true)}>
              {sendLabel}
            </button>
          </div>
        ) : null}

        {tab === 'file' ? (
          <div className="pad">
            <div className="field">
              <span className="lab">要传的文件</span>
              <div className="acts2">
                <button className="btn quiet" type="button" onClick={() => fileRef.current?.click()}>
                  {file ? `换一个（${file.name}）` : '选文件'}
                </button>
                {file ? (
                  <button className="link danger" type="button" onClick={() => setFile(null)}>
                    不传了
                  </button>
                ) : null}
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </div>
            </div>
            <p className="m dim wrap">传到群文件根目录，群里同时会冒出一条文件消息。</p>
            <button className="btn key" type="button" disabled={!canSend} onClick={() => setAskSend(true)}>
              {sendLabel}
            </button>
          </div>
        ) : null}

        {tab === 'sent' ? (
          <div className="pad">
            <label className="field narrow-md">
              <span className="lab">看哪个群的公告</span>
              <span className="box">
                <select
                  className="inp"
                  value={sentGroup ? String(sentGroup) : ''}
                  onChange={(event) => setQueryParams({ group: event.target.value }, { replace: true })}
                >
                  <option value="">{groups?.length ? '选一个群' : '群列表没拿到，选不了'}</option>
                  {(groups ?? []).map((group) => (
                    <option key={group.group_id} value={String(group.group_id)}>
                      {group.name}（{group.group_id}）
                    </option>
                  ))}
                </select>
              </span>
            </label>
            {!sentGroup ? (
              <StateEmpty>选一个群看它现在挂着的公告。接口要带群号，没有「所有群」这种查法。</StateEmpty>
            ) : noticesError ? (
              <StateError error={noticesError} />
            ) : notices === null ? (
              <StateLoading />
            ) : notices.length === 0 ? (
              <StateEmpty>这个群现在没有挂着的公告。</StateEmpty>
            ) : (
              notices.map((item) => (
                <div className="job" key={item.notice_id}>
                  <div className="sum">
                    {item.publish_time}
                    {item.images ? ` · ${item.images} 张图` : ''}
                    {item.read_num != null ? ` · ${item.read_num} 人看过` : ''}
                  </div>
                  <p className="answer-text">{item.text}</p>
                  <div className="acts2">
                    <button className="link danger" type="button" onClick={() => setDeleting(item)}>
                      删
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {results ? (
          <div className="foot">
            {results.map((r) => (
              <div key={r.group_id}>
                {r.ok ? '✓' : '✗'} {r.name}
                {r.ok ? ' 发出去了' : ` —— ${r.error ?? '没发成'}`}
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <Confirm
        open={askSend}
        title={tab === 'file' ? '传群文件' : tab === 'message' ? '发群消息' : '发群公告'}
        busy={sending}
        confirmText={tab === 'file' ? '传出去' : '发出去'}
        message={
          <>
            发到这 {chosen.length} 个群：<b>{chosen.map((group) => group.name).join('、')}</b>
            <br />
            {tab === 'file' ? (
              <>文件：{file?.name}</>
            ) : (
              <span className="answer-text">{tab === 'notice' ? content.trim() : message.trim()}</span>
            )}
            {tab === 'notice' && noticeImage ? <>（带一张图：{noticeImage.name}）</> : null}
            {tab === 'message' && atAll ? (
              <>
                <br />
                开头会带 @全体成员，群里每个人都会收到提醒。
                {chosen.some((g) => remain[String(g.group_id)]?.left === 0)
                  ? '有的群今天次数用完了，消息照样发出去，但不会提醒所有人。'
                  : ''}
              </>
            ) : null}
          </>
        }
        onConfirm={() => void send()}
        onCancel={() => setAskSend(false)}
      />

      <Confirm
        open={deleting !== null}
        title="删掉这条公告"
        danger
        busy={sending}
        confirmText="删掉"
        message={<>群里挂着的这条公告会撤掉：「{deleting?.text.slice(0, 40)}」</>}
        onConfirm={() => void removeNotice()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

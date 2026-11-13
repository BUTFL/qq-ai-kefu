import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { api } from '../api/client';
import type { Entry, EntryImage } from '../api/types';
import AuthImage from '../components/AuthImage';
import Card from '../components/Card';
import Confirm from '../components/Confirm';
import Modal from '../components/Modal';
import { StateError, StateLoading } from '../components/States';
import Table, { type TableColumn } from '../components/Table';
import { useToast } from '../components/Toast';
import { useCounts } from '../lib/counts';
import { errorMessage, refreshCounts } from '../lib/events';

interface EntryForm {
  id?: number;
  question: string;
  aliases: string;
  answer: string;
}

const EMPTY_FORM: EntryForm = { question: '', aliases: '', answer: '' };

export default function Entries() {
  const { entries, entriesError, loadEntries } = useCounts();
  const [keyword, setKeyword] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<EntryForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [formNote, setFormNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [deleteEntry, setDeleteEntry] = useState<Entry | null>(null);
  const [deleteImage, setDeleteImage] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    void loadEntries().catch(() => undefined);
  }, [loadEntries]);

  // 增删改之后静默刷新：失败只在 toast 说一声，别把整张表换成出错面板
  const refreshAfterChange = async () => {
    try {
      await loadEntries(true, { silent: true });
    } catch (err) {
      toast(errorMessage(err), 'err');
    }
    refreshCounts();
  };

  const editingEntry =
    form.id === undefined ? undefined : entries?.find((entry) => entry.id === form.id);

  const rows = useMemo(() => {
    const list = entries ?? [];
    const kw = keyword.trim().toLowerCase();
    if (!kw) return list;
    return list.filter((entry) =>
      [entry.question, entry.answer, ...entry.aliases].join('\n').toLowerCase().includes(kw),
    );
  }, [entries, keyword]);

  const openNew = () => {
    setForm(EMPTY_FORM);
    setFormError('');
    setFormNote('');
    setFormOpen(true);
  };

  const openEdit = (entry: Entry) => {
    setForm({
      id: entry.id,
      question: entry.question,
      aliases: entry.aliases.join('\n'),
      answer: entry.answer,
    });
    setFormError('');
    setFormNote('');
    setFormOpen(true);
  };

  const save = async () => {
    if (saving) return;
    const question = form.question.trim();
    const answer = form.answer.trim();
    if (!question || !answer) {
      setFormError('问题和回复都不能空');
      setFormNote('');
      return;
    }

    setSaving(true);
    setFormError('');
    setFormNote('');
    try {
      const saved = await api.post<Entry>('/entries', {
        ...(form.id === undefined ? {} : { id: form.id }),
        question,
        answer,
        aliases: form.aliases
          .split('\n')
          .map((alias) => alias.trim())
          .filter(Boolean),
      });

      if (form.id === undefined) {
        setForm((prev) => ({ ...prev, id: saved.id }));
        setFormNote('已保存，现在可以上传配图了。');
      } else {
        setFormOpen(false);
      }
      toast(`#${saved.id} 已保存`);
      await refreshAfterChange();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const addImages = async (files: File[]) => {
    if (uploading || !files.length || form.id === undefined) return;
    const entryId = form.id;
    const data = new FormData();
    files.forEach((file) => data.append('file', file));

    setUploading(true);
    setFormError('');
    setFormNote('');
    try {
      const added = await api.postForm<EntryImage[]>(`/entries/${entryId}/images`, data);
      toast(added.length ? `已上传 ${added.length} 张配图` : '没收到图片');
      await refreshAfterChange();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const removeImage = async () => {
    if (busy || deleteImage === null) return;
    setBusy(true);
    try {
      await api.del(`/image/${deleteImage}`);
      setDeleteImage(null);
      toast('配图已删除');
      await refreshAfterChange();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const removeEntry = async () => {
    if (busy || !deleteEntry) return;
    const target = deleteEntry;
    setBusy(true);
    try {
      await api.del(`/entries/${target.id}`);
      setDeleteEntry(null);
      if (form.id === target.id) setFormOpen(false);
      toast('已删除');
      await refreshAfterChange();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<Entry>[] = [
    {
      key: 'id',
      label: '#',
      width: 52,
      render: (entry) => <span className="m dim">{entry.id}</span>,
    },
    {
      key: 'question',
      label: '问题',
      render: (entry) => (
        <div className="q-cell">
          <span className="q">{entry.question}</span>
          {entry.aliases.length > 0 ? (
            <div className="m dim alias-line">也这么问：{entry.aliases.join(' / ')}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'answer',
      label: '回复',
      render: (entry) => (
        <div className="answer-cell">
          <div className="answer-text">{entry.answer}</div>
          {entry.images.length > 0 ? (
            <div className="entry-images">
              {entry.images.map((image) => (
                <AuthImage
                  key={image.id}
                  src={image.url}
                  alt={`#${entry.id} 的配图`}
                  className="entry-thumb"
                />
              ))}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'hits',
      label: '命中',
      width: 56,
      numeric: true,
      render: (entry) => <span className="m">{entry.hits}</span>,
    },
    {
      key: 'actions',
      label: '操作',
      width: 84,
      render: (entry) => (
        <div className="acts">
          <button className="link" type="button" aria-label={`编辑 #${entry.id}`} onClick={() => openEdit(entry)}>
            改
          </button>
          <button
            className="link danger"
            type="button"
            aria-label={`删除 #${entry.id}`}
            onClick={() => setDeleteEntry(entry)}
          >
            删
          </button>
        </div>
      ),
    },
  ];

  const loading = entries === null && entriesError === null;
  const fatalError = entries === null ? entriesError : null;

  return (
    <>
      <p className="note">
        客户的问题和这里的「问题 / 别名」意思相近时，机器人直接按「回复」答（配了图的，文字发完接着发图）。
        <b>改完立即生效</b>，同时写回 <code>data/知识库.md</code>。
      </p>

      <Card
        title="标准答案"
        sub={`${entries?.length ?? 0} 条`}
        right={
          <>
            <label className="search">
              <span className="m dim">搜</span>
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜问题、别名或回复内容"
                aria-label="搜索标准答案"
              />
            </label>
            <button className="btn" type="button" onClick={openNew}>
              + 新增问答
            </button>
          </>
        }
        footer="别名各存一个向量、检索取最高分。改了问题或别名才重算向量，只改回复不重算。"
      >
        {loading ? (
          <StateLoading />
        ) : fatalError ? (
          <StateError error={fatalError} onRetry={() => void loadEntries(true).catch(() => undefined)} />
        ) : (
          <Table
            label="标准答案列表"
            columns={columns}
            rows={rows}
            rowKey={(entry) => entry.id}
            empty={keyword.trim() ? '没有匹配的' : '还没有标准答案'}
          />
        )}
      </Card>

      <Modal
        open={formOpen}
        title={form.id === undefined ? '新增问答' : `编辑问答 #${form.id}`}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <button className="btn quiet" type="button" onClick={() => setFormOpen(false)} disabled={saving}>
              关闭
            </button>
            <button className="btn" type="submit" form="entry-form" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <form
          id="entry-form"
          className="form-stack"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="field">
            <span className="lab">问题（标准问法）</span>
            <span className="box">
              <input
                className="inp"
                value={form.question}
                onChange={(event) => setForm((prev) => ({ ...prev, question: event.target.value }))}
              />
            </span>
          </label>

          <label className="field">
            <span className="lab">别名（其它问法，一行一个，可不填）</span>
            <span className="box">
              <textarea
                className="ta"
                value={form.aliases}
                onChange={(event) => setForm((prev) => ({ ...prev, aliases: event.target.value }))}
              />
            </span>
          </label>

          <label className="field">
            <span className="lab">回复</span>
            <span className="box">
              <textarea
                className="ta"
                value={form.answer}
                onChange={(event) => setForm((prev) => ({ ...prev, answer: event.target.value }))}
              />
            </span>
          </label>

          <div className="field">
            <span className="lab">配图（命中这条时跟在文字后面发）</span>
            {form.id === undefined ? (
              <p className="m dim">先保存这条问答，再上传配图。</p>
            ) : (
              <div className="image-row">
                {(editingEntry?.images ?? []).map((image) => (
                  <div className="image-item" key={image.id}>
                    <AuthImage src={image.url} alt="配图" className="entry-thumb" />
                    <button
                      className="image-x"
                      type="button"
                      aria-label="删除这张配图"
                      onClick={() => setDeleteImage(image.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="btn quiet"
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? '上传中…' : '上传配图'}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,.gif"
                  multiple
                  hidden
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    void addImages(files);
                  }}
                />
              </div>
            )}
          </div>

          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}
          {formNote ? <p className="form-note">{formNote}</p> : null}
        </form>
      </Modal>

      <Confirm
        open={deleteEntry !== null}
        title="删除标准答案"
        danger
        busy={busy}
        confirmText="删掉"
        message={
          deleteEntry
            ? `删除 #${deleteEntry.id}「${deleteEntry.question}」？删了以后这类问题会重新去查资料回答。`
            : ''
        }
        onCancel={() => setDeleteEntry(null)}
        onConfirm={() => void removeEntry()}
      />

      <Confirm
        open={deleteImage !== null}
        title="删除配图"
        danger
        busy={busy}
        confirmText="删掉"
        message="删掉这张配图？命中这条答案时就不会再跟着发它了。"
        onCancel={() => setDeleteImage(null)}
        onConfirm={() => void removeImage()}
      />
    </>
  );
}

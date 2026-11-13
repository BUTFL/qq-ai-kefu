import { useState } from 'react';

import type { Draft } from '../api/types';
import AuthImage from './AuthImage';

/** 三种 kind 的标签，照 6099 那页的原文。 */
function kindTag(draft: Draft): { text: string; cls: string } {
  if (draft.kind === 'alias') {
    return { text: `给答案 #${draft.entry_id} 加问法`, cls: 'tag amber' };
  }
  if (draft.kind === 'merge') {
    return { text: `合并：#${draft.merge_from} 并进 #${draft.entry_id}`, cls: 'tag' };
  }
  return { text: '新答案', cls: 'tag seal' };
}

export interface DraftEdit {
  question: string;
  aliases: string;
  answer: string;
}

interface DraftCardProps {
  draft: Draft;
  /** 选中第几种说法 */
  picked: number;
  onPick: (index: number) => void;
  /** 爬来的截图：采纳时带上哪几张 */
  keptImages: number[];
  onToggleImage: (id: number) => void;
  editing: DraftEdit | null;
  onStartEdit: () => void;
  onChangeEdit: (edit: DraftEdit) => void;
  onCancelEdit: () => void;
  onAccept: () => void;
  onReject: () => void;
  busy: boolean;
}

export default function DraftCard({
  draft,
  picked,
  onPick,
  keptImages,
  onToggleImage,
  editing,
  onStartEdit,
  onChangeEdit,
  onCancelEdit,
  onAccept,
  onReject,
  busy,
}: DraftCardProps) {
  const [showEvidence, setShowEvidence] = useState(false);
  const tag = kindTag(draft);
  const options = draft.options;
  const isAlias = draft.kind === 'alias';
  const acceptText = editing
    ? '用改过的采纳'
    : options.length > 1
      ? `采纳第 ${picked + 1} 种`
      : '采纳';

  return (
    <div className="draft">
      <div className="main">
        <div className="dh">
          <span className="id">#{draft.id}</span>
          <span className={tag.cls}>{tag.text}</span>
          {draft.note ? <span className="m dim">{draft.note}</span> : null}
        </div>

        {editing ? (
          <div className="form-stack">
            <label className="field">
              <span className="lab">{isAlias ? '要加的问法' : '问题'}</span>
              <span className="box">
                <input
                  className="inp"
                  value={editing.question}
                  onChange={(event) => onChangeEdit({ ...editing, question: event.target.value })}
                />
              </span>
            </label>
            {!isAlias ? (
              <>
                <label className="field">
                  <span className="lab">别名（一行一个）</span>
                  <span className="box">
                    <textarea
                      className="ta"
                      rows={2}
                      value={editing.aliases}
                      onChange={(event) => onChangeEdit({ ...editing, aliases: event.target.value })}
                    />
                  </span>
                </label>
                <label className="field">
                  <span className="lab">回复</span>
                  <span className="box">
                    <textarea
                      className="ta"
                      rows={4}
                      value={editing.answer}
                      onChange={(event) => onChangeEdit({ ...editing, answer: event.target.value })}
                    />
                  </span>
                </label>
              </>
            ) : null}
          </div>
        ) : (
          <div>
            <b className="q">{draft.question}</b>
            {draft.aliases.length > 0 ? (
              <div className="alias-line">也这么问：{draft.aliases.join(' / ')}</div>
            ) : null}

            {isAlias ? (
              <p className="m dim wrap">答案 #{draft.entry_id} 的回复不动，只把这个问法加上去。</p>
            ) : options.length === 1 ? (
              <p className="answer-text">{options[0].answer}</p>
            ) : (
              <div className="form-stack opts" role="radiogroup" aria-label="选一种说法">
                <span className="lab">整理了 {options.length} 种说法，点一种再采纳</span>
                {options.map((option, index) => (
                  <button
                    key={index}
                    className="opt"
                    type="button"
                    role="radio"
                    aria-checked={picked === index}
                    onClick={() => onPick(index)}
                  >
                    <span className="rd" aria-hidden />
                    <span className="txt">
                      <em>
                        {index + 1}. {option.label || `第 ${index + 1} 种`}
                      </em>
                      {option.answer}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {draft.kind === 'new' && draft.images.length > 0 ? (
          <div className="form-stack">
            <span className="lab">
              爬来的截图，勾上的采纳后变成这条答案的附图（机器人回答时跟着发）。点图去掉 / 加回：
            </span>
            <div className="image-row">
              {draft.images.map((image) => {
                const on = keptImages.includes(image.id);
                return (
                  <button
                    key={image.id}
                    className={on ? 'thumb-pick on' : 'thumb-pick'}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={`${on ? '去掉' : '加回'}这张图：${image.caption || '截图'}`}
                    onClick={() => onToggleImage(image.id)}
                  >
                    <AuthImage src={image.url} alt={image.caption || '截图'} className="thumb-img" />
                    <span className="thumb-state">{on ? '✓ 带上' : '不带'}</span>
                    {image.caption ? <span className="cap">{image.caption}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {draft.source_url ? (
          <a className="doc-url" href={draft.source_url} target="_blank" rel="noopener noreferrer">
            从这一页来的（原文，可能是别家的说法）：{draft.source_url}
          </a>
        ) : null}

        {draft.evidence ? (
          <div className="ev">
            <button className="link" type="button" onClick={() => setShowEvidence((v) => !v)}>
              {showEvidence ? '收起原话' : '看原话（从哪来的）'}
            </button>
            {showEvidence ? <pre className="logline">{draft.evidence}</pre> : null}
          </div>
        ) : null}
      </div>

      <div className="side">
        {draft.created_at ? <span className="m dim">{draft.created_at}</span> : null}
        <div className="side-acts">
          <button className="btn key" type="button" disabled={busy} onClick={onAccept}>
            {busy ? '处理中…' : acceptText}
          </button>
          {editing ? (
            <button className="btn quiet" type="button" disabled={busy} onClick={onCancelEdit}>
              不改了
            </button>
          ) : (
            <button className="btn quiet" type="button" disabled={busy} onClick={onStartEdit}>
              改一下
            </button>
          )}
          <button className="link danger" type="button" disabled={busy} onClick={onReject}>
            不要
          </button>
        </div>
      </div>
    </div>
  );
}

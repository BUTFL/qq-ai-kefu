import type { ReactNode } from 'react';

import { ApiError, NETWORK_MESSAGE, NO_PASSWORD_MESSAGE, TIMEOUT_MESSAGE } from '../api/client';
import { errorMessage } from '../lib/events';

export function StateLoading({ text = '读取中…' }: { text?: string }) {
  return (
    <div className="state state-loading" role="status">
      {text}
    </div>
  );
}

export function StateEmpty({ children }: { children: ReactNode }) {
  return <div className="state state-empty">{children}</div>;
}

interface StateErrorProps {
  error: unknown;
  onRetry?: () => void;
}

/** 三态里的出错：后端给了 error 就优先显示，前端常量只在没给话时兜底。 */
export function StateError({ error, onRetry }: StateErrorProps) {
  let message = errorMessage(error);
  let hint = '';
  let canRetry = true;

  if (error instanceof ApiError) {
    if (error.code === 'network') {
      message = error.message || NETWORK_MESSAGE;
      hint = '确认 bot 在 127.0.0.1:8090 跑着，再点重试。';
    } else if (error.code === 'timeout') {
      message = error.message || TIMEOUT_MESSAGE;
      hint = '后端可能还在处理长任务，过一会儿再试。';
    } else if (error.code === 'unauthorized') {
      message = error.message || '未登录或登录过期了';
      hint = '正在去登录页…';
      canRetry = false;
    } else if (error.code === 'no-password') {
      // 只有后端明确说 code === 'no-password' 才是没配密码
      message = error.message || NO_PASSWORD_MESSAGE;
      canRetry = false;
    } else if (error.code === 'aborted') {
      message = error.message || '请求已取消';
      canRetry = false;
    }
  }

  return (
    <div className="state state-error" role="alert">
      <p className="msg">{message}</p>
      {hint ? <p className="hint">{hint}</p> : null}
      {onRetry && canRetry ? (
        <button className="btn quiet" type="button" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

import { useState, type FormEvent } from 'react';

import {
  api,
  ApiError,
  setToken,
  NETWORK_MESSAGE,
  NO_PASSWORD_MESSAGE,
  UNAUTHORIZED_MESSAGE,
} from '../api/client';
import type { LoginResponse } from '../api/types';
import { errorMessage } from '../lib/events';

interface LoginProps {
  onSuccess: () => void;
}

export default function Login({ onSuccess }: LoginProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const data = await api.post<LoginResponse>('/console/login', { password });
      setToken(data.token);
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          // 后端说别的话就原样显示，只有确实在说密码时才用前端这句
          const wrongPassword = err.message.includes('密码') || err.message === UNAUTHORIZED_MESSAGE;
          setError(wrongPassword ? '密码不对，再试一次' : err.message);
        } else if (err.code === 'no-password') {
          setError(NO_PASSWORD_MESSAGE);
        } else if (err.code === 'network') {
          setError(NETWORK_MESSAGE);
        } else {
          setError(err.message);
        }
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="console">
      <div className="login-page">
        <form className="login-card" onSubmit={(event) => void submit(event)}>
          <span className="login-mark" aria-hidden="true">
            客
          </span>
          <div>
            <h2>qq-ai-kefu 客服控制台</h2>
            <p>
              输入管理密码（<code>.env</code> 里的 ADMIN_PASSWORD）
            </p>
          </div>

          <label className="field">
            <span className="lab">管理密码</span>
            <span className="box">
              <input
                className="inp"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus
                aria-label="管理密码"
              />
            </span>
          </label>

          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : null}

          <button className="btn key" type="submit" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
          <p className="login-foot">只能从本机和 LAN_HOSTS 里的地址开。</p>
        </form>
      </div>
    </div>
  );
}

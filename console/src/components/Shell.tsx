import { useEffect, useState, type ReactNode } from 'react';

import { api, setToken } from '../api/client';
import type { MeResponse } from '../api/types';
import { useCounts } from '../lib/counts';
import { NAV_ITEMS, navigate, pageTitle, useHashPath } from '../router';

export default function Shell({ children, onLoggedOut }: { children: ReactNode; onLoggedOut: () => void }) {
  const path = useHashPath();
  const { counts } = useCounts();
  const [online, setOnline] = useState<boolean | null>(null);

  // 这一轮先用 /api/console/me 通不通代替协议端健康接口
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        await api.get<MeResponse>('/console/me');
        if (alive) setOnline(true);
      } catch {
        if (alive) setOnline(false);
      }
    };
    void ping();
    const timer = window.setInterval(() => void ping(), 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const logout = () => {
    // 不 await：后端没起也不该卡在退出按钮上，本地先清干净
    void api.post('/console/logout').catch(() => undefined);
    setToken(null);
    onLoggedOut();
    navigate('/login');
  };

  return (
    <div className="console">
      <div className="frame">
        <nav className="rail" aria-label="控制台导航">
          <div className="brand">
            <b>qq-ai-kefu</b>
            <span>客服控制台</span>
          </div>
          <div className="nav">
            {NAV_ITEMS.map((item) => {
              const count = item.countKey ? counts[item.countKey] : undefined;
              const showCount = count !== undefined && (!item.hideZero || count > 0);
              return (
                <button
                  key={item.path}
                  type="button"
                  aria-current={path === item.path ? 'page' : undefined}
                  onClick={() => navigate(item.path)}
                >
                  {item.label}
                  {showCount ? <span className={item.due ? 'n due' : 'n'}>{count}</span> : null}
                </button>
              );
            })}
          </div>
          <div className="rail-foot">
            <span>qq-ai-kefu · console</span>
            <span>bot 8090</span>
          </div>
        </nav>

        <div className="pane">
          <header className="topbar">
            <h2>{pageTitle(path)}</h2>
            <div className="readout">
              <span className={online === true ? 'live' : 'live off'}>
                {online === null ? '协议端检查中' : online ? '协议端在线' : '协议端离线'}
              </span>
              <span>
                资料 <i>{counts.docs ?? '—'}</i> 份 / <i>{counts.chunks ?? '—'}</i> 块
              </span>
              <span>
                标准答案 <i>{counts.entries ?? '—'}</i> 条
              </span>
            </div>
            <button className="who" type="button" onClick={logout} aria-label="退出登录">
              超管 · 退出
            </button>
          </header>
          <main className="page">{children}</main>
        </div>
      </div>
    </div>
  );
}

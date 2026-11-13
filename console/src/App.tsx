import { useEffect, useState } from 'react';

import { getToken, UNAUTHORIZED_EVENT } from './api/client';
import Shell from './components/Shell';
import { CountsProvider } from './lib/counts';
import { ToastProvider } from './components/Toast';
import Banned from './pages/Banned';
import Crawl from './pages/Crawl';
import Docs from './pages/Docs';
import Drafts from './pages/Drafts';
import Entries from './pages/Entries';
import Learn from './pages/Learn';
import Login from './pages/Login';
import Notice from './pages/Notice';
import Trusted from './pages/Trusted';
import { navigate, PAGE_TITLES, pageTitle, useHashPath } from './router';

function renderPage(path: string) {
  switch (path) {
    case '/kb/entries':
      return <Entries />;
    case '/kb/docs':
      return <Docs />;
    case '/kb/crawl':
      return <Crawl />;
    case '/kb/learn':
      return <Learn />;
    case '/kb/drafts':
      return <Drafts />;
    case '/kb/trusted':
      return <Trusted />;
    case '/kb/banned':
      return <Banned />;
    case '/kb/notice':
      return <Notice />;
    default:
      return <Entries />;
  }
}

export default function App() {
  const path = useHashPath();
  const [token, setAuthToken] = useState<string | null>(() => getToken());

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthToken(null);
      navigate('/login');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  useEffect(() => {
    if (!token && path !== '/login') {
      navigate('/login');
    } else if (token && (path === '/login' || !PAGE_TITLES[path])) {
      navigate('/kb/entries');
    }
  }, [token, path]);

  useEffect(() => {
    document.title = `${pageTitle(path)} · qq-ai-kefu 客服控制台`;
  }, [path]);

  const handleLogin = () => {
    setAuthToken(getToken());
    navigate('/kb/entries');
  };

  const showLogin = !token || path === '/login';

  return (
    <ToastProvider>
      {showLogin ? (
        <Login onSuccess={handleLogin} />
      ) : (
        <CountsProvider>
          <Shell onLoggedOut={() => setAuthToken(null)}>{renderPage(path)}</Shell>
        </CountsProvider>
      )}
    </ToastProvider>
  );
}

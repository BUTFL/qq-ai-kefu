import { useEffect, useState } from 'react';

export type CountKey = 'entries' | 'docs' | 'drafts' | 'trusted' | 'banned';

export interface NavItem {
  path: string;
  label: string;
  countKey?: CountKey;
  /** 需要人拍板的数字用朱红 */
  due?: boolean;
  /** 0 时不显示数字 */
  hideZero?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/kb/entries', label: '标准答案', countKey: 'entries' },
  { path: '/kb/docs', label: '资料库', countKey: 'docs' },
  { path: '/kb/crawl', label: '爬常见问题' },
  { path: '/kb/learn', label: '截图学答法' },
  { path: '/kb/drafts', label: '待审草稿', countKey: 'drafts', due: true, hideZero: true },
  { path: '/kb/trusted', label: '自己人', countKey: 'trusted', hideZero: true },
  { path: '/kb/banned', label: '被封禁的人', countKey: 'banned', hideZero: true },
  { path: '/kb/notice', label: '群公告' },
];

export const PAGE_TITLES: Record<string, string> = {
  '/login': '登录',
  '/kb/entries': '标准答案',
  '/kb/docs': '资料库',
  '/kb/crawl': '爬常见问题',
  '/kb/learn': '截图学答法',
  '/kb/drafts': '待审草稿',
  '/kb/trusted': '自己人',
  '/kb/banned': '被封禁的人',
  '/kb/notice': '群公告',
};

const DEFAULT_PATH = '/kb/entries';

export interface HashLocation {
  /** 只含路径，路由匹配用这个 */
  path: string;
  /** 页内状态（标签页、群号）放这里 */
  search: URLSearchParams;
}

/** hash 拆成 path 和 search，`#/kb/notice?tab=sent` 的 path 是 `/kb/notice`。 */
export function readLocation(): HashLocation {
  const raw = window.location.hash.replace(/^#/, '').trim();
  const target = raw ? (raw.startsWith('/') ? raw : `/${raw}`) : DEFAULT_PATH;
  const queryAt = target.indexOf('?');
  const path = queryAt === -1 ? target : target.slice(0, queryAt);
  const search = new URLSearchParams(queryAt === -1 ? '' : target.slice(queryAt + 1));
  return { path, search };
}

export function readPath(): string {
  return readLocation().path;
}

export function navigate(path: string): void {
  const next = path.startsWith('/') ? path : `/${path}`;
  const current = window.location.hash.replace(/^#/, '').trim() || DEFAULT_PATH;
  if (current === next) return;
  window.location.hash = next;
}

export function readQuery(name: string): string | null {
  return readLocation().search.get(name);
}

/**
 * 改 query 不整页重挂：只 replace/push hash，path 没变，App 不会换页面组件。
 * 传 null 或空串就是把参数删掉。
 */
export function setQueryParams(
  patch: Record<string, string | null>,
  options: { replace?: boolean } = {},
): void {
  const { path, search } = readLocation();
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') search.delete(key);
    else search.set(key, value);
  }
  const query = search.toString();
  const nextHash = `#${path}${query ? `?${query}` : ''}`;
  if (window.location.hash === nextHash) return;

  const url = `${window.location.pathname}${window.location.search}${nextHash}`;
  if (options.replace) {
    window.history.replaceState(null, '', url);
    // replaceState 不触发 hashchange，手动通知读 query 的 hook
    window.dispatchEvent(new Event('hashchange'));
  } else {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new Event('hashchange'));
  }
}

export function pageTitle(path: string): string {
  return PAGE_TITLES[path] ?? '客服控制台';
}

export function useHashPath(): string {
  const [path, setPath] = useState<string>(() => readPath());

  useEffect(() => {
    const sync = () => {
      const next = readPath();
      setPath((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  return path;
}

/** 读一个 query 参数；参数变化时只重渲染用它的组件。 */
export function useQueryParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(() => readQuery(name));

  useEffect(() => {
    const sync = () => {
      const next = readQuery(name);
      setValue((prev) => (prev === next ? prev : next));
    };
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [name]);

  return value;
}

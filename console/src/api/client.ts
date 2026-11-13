/**
 * 全站唯一发请求的地方。
 *
 * 错误用 ApiError.code 区分：
 * - network      fetch 直接抛错（bot 没起 / 端口不通）
 * - timeout      超过接口时限（默认 120 秒，长任务 600 秒）
 * - aborted      调用方主动取消（组件卸载）
 * - unauthorized 401（没登录 / 过期），同时清 token 并广播去登录页
 * - no-password  503 且返回体 code === 'no-password'（只有这一种是没配密码）
 * 其它后端错误是 http，message 就是后端 error 字段原样。
 */

const TOKEN_KEY = 'qq-ai-kefu.console.token';
const API_BASE = '/api';

// localStorage 被禁（隐私模式 / 沙箱）时至少这次会话还能用
let memoryToken: string | null = null;

export const NETWORK_MESSAGE = '连不上后端（127.0.0.1:8090），bot 没起？';
export const TIMEOUT_MESSAGE = '等太久了，后端还在忙？';
export const NO_PASSWORD_MESSAGE = '后端没配 ADMIN_PASSWORD，控制台用不了';
export const NOT_FOUND_MESSAGE = '机器人还是旧版本，重新部署后再刷新';
export const UNAUTHORIZED_MESSAGE = '没登录或登录过期了，重新登录';
export const UNAUTHORIZED_EVENT = 'kefu:unauthorized';

// /api/docs/fetch 自己就要一两分钟，/api/learn/* 走视觉模型也要几十秒
const DEFAULT_TIMEOUT_MS = 120_000;
const LONG_TIMEOUT_MS = 600_000;

export type ApiErrorCode = 'network' | 'timeout' | 'aborted' | 'unauthorized' | 'no-password' | 'http';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;

  constructor(message: string, code: ApiErrorCode, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* 隐私模式 / 存储被禁：这次会话里仍然可用，只是刷新后要重登 */
  }
}

function fullPath(path: string): string {
  if (path.startsWith('/api/')) return path;
  return `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
}

function timeoutFor(path: string): number {
  const p = path.startsWith('/api/') ? path.slice('/api'.length) : path;
  return p === '/docs/fetch' || p.startsWith('/learn/') ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

interface ErrorBody {
  message: string;
  code: string | null;
}

async function readErrorBody(res: Response): Promise<ErrorBody> {
  const text = await res.text().catch(() => '');
  let code: string | null = null;
  if (text) {
    try {
      const data = JSON.parse(text) as unknown;
      if (data && typeof data === 'object') {
        const body = data as { error?: unknown; code?: unknown };
        if (typeof body.code === 'string' && body.code.trim()) code = body.code;
        if (typeof body.error === 'string' && body.error.trim()) return { message: body.error, code };
      }
    } catch {
      /* 不是 JSON，按纯文本处理 */
    }
    const clean = text.trim();
    // aiohttp 的「404: Not Found」和 HTML 页面不往用户脸上糊
    if (clean && !clean.startsWith('<') && !/^\d{3}:\s/.test(clean)) {
      return { message: clean.slice(0, 300), code };
    }
  }
  return { message: '', code };
}

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const timeoutSignal = AbortSignal.timeout(timeoutFor(path));
  const callerSignal = init.signal ?? null;
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(fullPath(path), { ...init, headers, signal });
  } catch {
    // 超时和「连不上」分开：超时是后端还在忙，不是 bot 没起
    if (timeoutSignal.aborted && !callerSignal?.aborted) {
      throw new ApiError(TIMEOUT_MESSAGE, 'timeout');
    }
    if (callerSignal?.aborted) {
      throw new ApiError('请求已取消', 'aborted');
    }
    throw new ApiError(NETWORK_MESSAGE, 'network');
  }

  if (res.ok) return res;

  const { message, code } = await readErrorBody(res);

  if (res.status === 401) {
    setToken(null);
    try {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    } catch {
      /* 没有 window 就算了，页面自己也会跳 */
    }
    throw new ApiError(message || UNAUTHORIZED_MESSAGE, 'unauthorized', 401);
  }

  if (res.status === 503) {
    // 503 有六种意思，只有带 code === 'no-password' 的才是没配密码
    if (code === 'no-password') {
      throw new ApiError(message || NO_PASSWORD_MESSAGE, 'no-password', 503);
    }
    throw new ApiError(message || '接口报错（HTTP 503）', 'http', 503);
  }

  // aiohttp 的纯文本 404 不直接给用户看
  if (res.status === 404) {
    throw new ApiError(NOT_FOUND_MESSAGE, 'http', 404);
  }

  throw new ApiError(message || `接口报错（HTTP ${res.status}）`, 'http', res.status);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const res = await rawFetch(path, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('后端回了不是 JSON 的内容', 'http', res.status);
  }
}

export const api = {
  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return request<T>(path, { method: 'GET', signal });
  },

  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  },

  postForm<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
    return request<T>(path, { method: 'POST', body: form, signal });
  },

  del<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
    return request<T>(path, { method: 'DELETE', signal });
  },

  /** 图片、原件这类要带 token 的二进制。 */
  async getBlob(path: string, signal?: AbortSignal): Promise<Blob> {
    const res = await rawFetch(path, { method: 'GET', signal });
    return res.blob();
  },
};

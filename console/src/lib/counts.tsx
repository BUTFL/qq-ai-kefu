import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api } from '../api/client';
import type { BannedResponse, Doc, DraftListResponse, Entry, Stats, TrustedResponse } from '../api/types';
import { REFRESH_COUNTS_EVENT } from './events';

export interface Counts {
  entries?: number;
  docs?: number;
  chunks?: number;
  drafts?: number;
  trusted?: number;
  banned?: number;
}

interface AuxCounts {
  drafts?: number;
  trusted?: number;
  banned?: number;
}

interface LoadOptions {
  /** 静默刷新失败不要动页面级 error（增删改后的后台刷新） */
  silent?: boolean;
}

interface CountsValue {
  stats: Stats | null;
  counts: Counts;
  entries: Entry[] | null;
  docs: Doc[] | null;
  entriesError: unknown;
  docsError: unknown;
  loadEntries: (force?: boolean, options?: LoadOptions) => Promise<Entry[]>;
  loadDocs: (force?: boolean, options?: LoadOptions) => Promise<Doc[]>;
  refreshCounts: () => Promise<void>;
}

const CountsContext = createContext<CountsValue | null>(null);

/**
 * 侧栏 / 顶栏数字的唯一来源，顺带缓存 /entries 和 /docs 全量列表。
 * Shell、标准答案页、资料库页共用同一份结果，谁先拉谁填缓存。
 */
export function CountsProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [aux, setAux] = useState<AuxCounts>({});
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [entriesError, setEntriesError] = useState<unknown>(null);
  const [docsError, setDocsError] = useState<unknown>(null);

  const entriesRef = useRef<Entry[] | null>(null);
  const docsRef = useRef<Doc[] | null>(null);
  const entriesInFlight = useRef<Promise<Entry[]> | null>(null);
  const docsInFlight = useRef<Promise<Doc[]> | null>(null);
  const entriesSeq = useRef(0);
  const docsSeq = useRef(0);
  const statsSeq = useRef(0);

  const loadEntries = useCallback((force = false, options: LoadOptions = {}): Promise<Entry[]> => {
    if (!force) {
      // 有在途请求就先合并，别拿旧缓存盖掉马上要回来的新列表
      if (entriesInFlight.current) return entriesInFlight.current;
      if (entriesRef.current) return Promise.resolve(entriesRef.current);
    }

    const seq = ++entriesSeq.current;
    let request: Promise<Entry[]>;
    request = api
      .get<Entry[]>('/entries')
      .then((list) => {
        if (seq === entriesSeq.current) {
          entriesRef.current = list;
          setEntries(list);
          setEntriesError(null);
        }
        return list;
      })
      .catch((err: unknown) => {
        if (seq === entriesSeq.current && !options.silent) setEntriesError(err);
        throw err;
      })
      .finally(() => {
        if (entriesInFlight.current === request) entriesInFlight.current = null;
      });

    entriesInFlight.current = request;
    return request;
  }, []);

  const loadDocs = useCallback((force = false, options: LoadOptions = {}): Promise<Doc[]> => {
    if (!force) {
      if (docsInFlight.current) return docsInFlight.current;
      if (docsRef.current) return Promise.resolve(docsRef.current);
    }

    const seq = ++docsSeq.current;
    let request: Promise<Doc[]>;
    request = api
      .get<Doc[]>('/docs')
      .then((list) => {
        if (seq === docsSeq.current) {
          docsRef.current = list;
          setDocs(list);
          setDocsError(null);
        }
        return list;
      })
      .catch((err: unknown) => {
        if (seq === docsSeq.current && !options.silent) setDocsError(err);
        throw err;
      })
      .finally(() => {
        if (docsInFlight.current === request) docsInFlight.current = null;
      });

    docsInFlight.current = request;
    return request;
  }, []);

  const refreshCounts = useCallback(async () => {
    // 序号守卫：快速连点 / 连续刷新时，先发后回的旧结果直接丢掉
    const seq = ++statsSeq.current;
    const [statsResult, draftsResult, trustedResult, bannedResult] = await Promise.allSettled([
      api.get<Stats>('/stats'),
      api.get<DraftListResponse>('/drafts'),
      api.get<TrustedResponse>('/trusted'),
      api.get<BannedResponse>('/banned'),
    ]);
    if (seq !== statsSeq.current) return;

    const nextStats = statsResult.status === 'fulfilled' ? statsResult.value : null;
    setStats(nextStats);
    setAux({
      drafts: draftsResult.status === 'fulfilled' ? draftsResult.value.drafts.length : undefined,
      trusted:
        trustedResult.status === 'fulfilled'
          ? trustedResult.value.fixed.length + trustedResult.value.list.length
          : undefined,
      banned: bannedResult.status === 'fulfilled' ? bannedResult.value.list.length : undefined,
    });

    // 新后端 /stats 自带三个数字；老后端才回落拉列表
    if (nextStats?.entries === undefined) {
      void loadEntries().catch(() => undefined);
    }
    if (nextStats?.docs === undefined || nextStats?.chunks === undefined) {
      void loadDocs().catch(() => undefined);
    }
  }, [loadEntries, loadDocs]);

  useEffect(() => {
    void refreshCounts();
    const onRefresh = () => void refreshCounts();
    window.addEventListener(REFRESH_COUNTS_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_COUNTS_EVENT, onRefresh);
  }, [refreshCounts]);

  const counts = useMemo<Counts>(
    () => ({
      entries: stats?.entries ?? entries?.length,
      docs: stats?.docs ?? docs?.length,
      chunks: stats?.chunks ?? (docs ? docs.reduce((sum, doc) => sum + doc.chunks, 0) : undefined),
      drafts: aux.drafts,
      trusted: aux.trusted,
      banned: aux.banned,
    }),
    [stats, entries, docs, aux],
  );

  const value = useMemo<CountsValue>(
    () => ({ stats, counts, entries, docs, entriesError, docsError, loadEntries, loadDocs, refreshCounts }),
    [stats, counts, entries, docs, entriesError, docsError, loadEntries, loadDocs, refreshCounts],
  );

  return <CountsContext.Provider value={value}>{children}</CountsContext.Provider>;
}

export function useCounts(): CountsValue {
  const value = useContext(CountsContext);
  if (!value) throw new Error('useCounts 必须放在 CountsProvider 里');
  return value;
}

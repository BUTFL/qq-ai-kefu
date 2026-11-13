/** 后端真实返回的字段。资料看 /api/docs，标准答案看 /api/entries。 */

export interface Stats {
  line: string;
  /** 新版后端才有的三个数字；老后端只有 line。 */
  docs?: number;
  chunks?: number;
  entries?: number;
}

export interface LoginResponse {
  token: string;
  expires_at: string;
}

export interface MeResponse {
  ok: true;
  expires_at: string;
}

export interface EntryImage {
  id: number;
  url: string;
}

export interface Entry {
  id: number;
  question: string;
  aliases: string[];
  answer: string;
  hits: number;
  updated_at: string;
  source: string;
  images: EntryImage[];
}

export interface Doc {
  path: string;
  name: string;
  chars: number;
  chunks: number;
  imported_at: string;
  uploaded: boolean;
  has_raw: boolean;
  /** 输网址抓的：原网址；别的资料是空字符串。 */
  web_url: string;
}

export interface DocChunk {
  title: string;
  body: string;
}

export interface UploadResult {
  name: string;
  ok: boolean;
  state?: string;
  chunks?: number;
  chars?: number;
  error?: string;
}

export interface FetchResult {
  url: string;
  ok: boolean;
  title?: string;
  path?: string;
  state?: string;
  chunks?: number;
  chars?: number;
  replaced?: string[];
  error?: string;
}

/** 侧栏只需要条数，草稿正文下一轮才用。 */
export interface DraftListResponse {
  drafts: { id: number }[];
  /** reviews 表里 summary / error 可能是 NULL，后端原样透传。 */
  review: { at: string; summary: string | null; error: string | null } | null;
}

export interface TrustedResponse {
  fixed: { user_id: number; why: string }[];
  list: { user_id: number; note: string; created_at: string }[];
}

/** bot/store.py 的 banned 表整行，另带最后一次申请时的昵称（可能没有）。 */
export interface BannedRow {
  user_id: number;
  group_id: number;
  operator_id: number;
  /** kick = 被你踢出群 / web = 这里手动加的 / log = 以前踢的（从日志导入） */
  source: string;
  note: string;
  banned_at: string;
  nickname: string | null;
}

export interface BannedResponse {
  list: BannedRow[];
}

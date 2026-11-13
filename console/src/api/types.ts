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

export interface DraftOption {
  /** 「贴近原话」「简短」「完整」。老草稿可能是空串。 */
  label: string;
  answer: string;
}

export interface DraftImage {
  id: number;
  url: string;
  caption: string;
}

/** kind：new 新答案 / alias 给已有答案加问法 / merge 合并两条 */
export interface Draft {
  id: number;
  kind: string;
  entry_id: number | null;
  merge_from: number | null;
  question: string;
  answer: string;
  options: DraftOption[];
  aliases: string[];
  evidence: string;
  note: string;
  created_at: string;
  source_url: string;
  images: DraftImage[];
}

export interface DraftListResponse {
  drafts: Draft[];
  /** reviews 表里 summary / error 可能是 NULL，后端原样透传。 */
  review: { at: string; summary: string | null; error: string | null } | null;
}

export interface DraftActionResponse {
  ok: true;
  message: string;
}

export interface LearnReadResponse {
  name: string;
  text: string;
}

export interface LearnAnalyzeResponse {
  drafts: Draft[];
  skipped: string[];
}

/** state：running 在爬 / done 爬完了 / stopped 停了 / failed 出错 */
export interface CrawlJob {
  id: number;
  url: string;
  state: string;
  max_pages: number;
  pages: number;
  found: number;
  drafts: number;
  images: number;
  replaced: string[];
  log: string;
  error: string;
  created_at: string;
  finished_at: string;
  /** 队列里还剩几个网址没爬 */
  pending: number;
  can_resume: boolean;
}

export interface CrawlListResponse {
  running: boolean;
  jobs: CrawlJob[];
}

/** kind：售前 / 售后 / 日报群。admin 是 null 表示没查出来。 */
export interface Group {
  group_id: number;
  name: string;
  members: number;
  kind: string;
  admin: boolean | null;
}

export interface GroupsResponse {
  groups: Group[];
}

/** 一个群一个群发，每个群各自成败。 */
export interface SendResult {
  group_id: number;
  name: string;
  ok: boolean;
  error?: string;
}

export interface SendResponse {
  results: SendResult[];
}

export interface AtAllRemain {
  can?: boolean;
  group?: number | null;
  self?: number | null;
  left?: number | null;
  error?: string;
}

export interface AtAllRemainResponse {
  remain: Record<string, AtAllRemain>;
}

export interface GroupNotice {
  notice_id: string;
  text: string;
  images: number;
  sender_id: number | null;
  publish_time: string;
  read_num: number | null;
}

export interface NoticesResponse {
  notices: GroupNotice[];
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

// 桌面壳与界面共用的数据类型。
import type { SizeLines, SizeTier } from "../core/boardSize";

export interface BoardTexts {
  main: string | null;
  bak: string | null;
  version: string | null;
}

/** 画板写入约定：带版本 = 过期保存 409；createOnly = 只新建不覆盖（两页同时建同名）。 */
export interface BoardWriteOptions {
  version?: string;
  createOnly?: boolean;
}

export interface ImageInfo {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  has_alpha: boolean;
}

/** 画板列表的一行（#87）：path 含数据根；bytes 为画板体量，画板读不懂时为 null。 */
export interface BoardListEntry {
  name: string;
  path: string;
  archived: boolean;
  bytes: number | null;
}

/** 本机存储画板列表：画板、画板位已用 / 总数与体量提醒线（都来自本机存储配置）。 */
export interface BoardListing {
  boards: BoardListEntry[];
  slots: { used: number; total: number };
  size_lines: SizeLines;
}

export interface BrowserOptions {
  title?: string;
  kind?: "error" | "info" | "warning";
  okLabel?: string;
  cancelLabel?: string;
}

export interface UsageCandidate {
  dir: string;
  bytes: number;
  last_write: number;
}

export interface Usage {
  total_bytes: number;
  boards_bytes: number;
  meta_bytes: number;
  last_access: number;
  by_date: { date: string; bytes: number }[];
  unreferenced: UsageCandidate[] | null;
  unreadable_board: string | null;
  /** 用量上限（本机存储配置，#88）；留空为 null，此时不提醒。 */
  limit_bytes: number | null;
  /** 提醒档位：达到提醒比例 warn（黄）、达到上限 alert（红）；只提醒、不阻止生成。 */
  limit_level: SizeTier | null;
}

export interface RecycleEntry {
  id: string;
  dir: string;
  bytes: number;
  cleaned_at: number;
  location: string;
  expired: boolean;
}

export interface CleanupResult {
  ok: boolean;
  kind: string;
  message: string;
  moved: UsageCandidate[];
  skipped: string[];
  failed: string[];
}

export interface UsagePort {
  usage(): Promise<Usage>;
  cleanupUnreferenced(dirs: string[]): Promise<CleanupResult>;
  /** 保存容量提醒阈值（字节）；0 表示清除。只提醒，不阻止生成。 */
  setLimit(bytes: number): Promise<void>;
  recycle(): Promise<RecycleEntry[]>;
  restore(id: string): Promise<void>;
  purgeExpired(): Promise<void>;
}
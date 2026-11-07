// Web 壳层端口：UI 只认这些接口，同源 HTTP 与浏览器能力都在 ipc.ts 中实现。
import type { MergeReport, MergeUnit, PackDuplicates, PackEntryFact, PackExportSpec, PackIo } from "../core/boardPack";
import type { SizeLines } from "../core/boardSize";
import type { BoardMeasure } from "../core/tidy";
import type { DirEntry } from "../core/relocate";

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

/** 画板列表的一行（#87）：path 含用户数据根；bytes 为画板体量，画板读不懂时为 null。 */
export interface BoardListEntry {
  name: string;
  path: string;
  archived: boolean;
  bytes: number | null;
}

/** 服务端画板列表：画板、画板位已用 / 总数与体量提醒线（都来自服务端配置）。 */
export interface BoardListing {
  boards: BoardListEntry[];
  slots: { used: number; total: number };
  size_lines: SizeLines;
}

export interface Ipc {
  readBoard(path: string): Promise<BoardTexts>;
  writeBoard(path: string, text: string, options?: BoardWriteOptions): Promise<void>;
  renameBoard(from: string, to: string, version?: string): Promise<void>;
  /** 删除画板：主文件与 .bak 移入回收区（只有管理员能恢复）；带版本时内容已变 409。 */
  deleteBoard(path: string, version?: string): Promise<void>;
  listBoardNames(dir: string): Promise<string[]>;
  /** 画板列表（含体量与画板位），由服务端拼好。 */
  listBoards(): Promise<BoardListing>;
  /** 按任务目录量一块画板（画板原文，可未保存），口径与画板体量一致（#92）；读不懂 400。 */
  measureBoard(text: string): Promise<BoardMeasure>;
  readUiState(): Promise<string | null>;
  writeUiState(text: string): Promise<void>;
  readCapabilityOverride(): Promise<string | null>;
  inspectImage(path: string): Promise<ImageInfo>;
  readSettings(): Promise<string | null>;
  writeSettings(text: string): Promise<void>;
  readModelsCache(): Promise<string | null>;
  writeModelsCache(text: string): Promise<void>;
  logEvent(kind: string, fields: Record<string, unknown>): Promise<void>;
  /** 导出前的 hash 阶段：每个要写的文件的长度与 sha256；取消时以 PACK_CANCELLED reject。 */
  boardPackFacts(spec: Pick<PackExportSpec, "task_dirs" | "files">): Promise<PackEntryFact[]>;
  boardPackExport(target: string, spec: PackExportSpec): Promise<{ task_dirs: number; bytes: number }>;
  boardPackEntries(pack: string): Promise<string[]>;
  boardPackReadTexts(pack: string, names: string[]): Promise<Record<string, string>>;
  boardPackImport(pack: string, units: MergeUnit[], duplicates: PackDuplicates): Promise<MergeReport>;
  boardPackCancel(cancelled: boolean): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  fileSha256(path: string): Promise<string>;
  isFile(path: string): Promise<boolean>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeNewFile(path: string, bytes: Uint8Array): Promise<void>;
}

export interface BrowserOptions {
  title?: string;
  kind?: "error" | "info" | "warning";
  okLabel?: string;
  cancelLabel?: string;
}

export interface BrowserPort {
  ask(message: string, options?: BrowserOptions): Promise<boolean>;
  message(text: string, options?: BrowserOptions): Promise<void>;
  onPackProgress(handler: (progress: { done: number; total: number }) => void): Promise<() => void>;
  openExternal(url: string): void;
  version(): Promise<string>;
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
}

export interface UsagePort {
  usage(): Promise<Usage>;
  cleanupUnreferenced(dirs: string[]): Promise<{ moved: UsageCandidate[]; skipped: string[] }>;
}

/** 结果中转：相对路径都相对用户数据根（虚拟根由实现剥掉）。 */
export interface RelayPort {
  relayResult(args: { url: string; relDir: string; stem: string; signal?: AbortSignal }): Promise<{ file: string; path: string }>;
  commitRelayed(relDir: string, from: string, stem: string): Promise<{ file: string; path: string }>;
  discardRelayed(relDir: string): Promise<void>;
}

export interface TransferPort {
  pickLocalImages(multiple: boolean): Promise<File[]>;
  uploadReference(file: File): Promise<{ path: string; sha256: string }>;
  downloadImage(path: string, name?: string): void;
  downloadBoardResults(boardPath: string): void;
}

export interface PackUploadPort {
  upload(file: File): Promise<string>;
  discard(id: string): Promise<void>;
}

/** 去重上传（#62）：问已有、Worker 里 hash、开暂存、逐份上传、按落盘清单合并；语义见 core/boardPack 的 PackIo。 */
export type PackContentPort = Required<Pick<PackIo, "existing" | "hash" | "stage" | "uploadContent" | "importContent" | "discardStaging">>;

export interface SessionPort {
  login(key: string): Promise<{ fingerprint: string }>;
  current(): Promise<{ fingerprint: string }>;
  logout(): Promise<void>;
  config(): Promise<{ version: string; gateway_url: string }>;
  onExpired(listener: () => void): () => void;
  readStoredKey(): string | null;
  storeKey(key: string): void;
  clearStoredKey(): void;
}

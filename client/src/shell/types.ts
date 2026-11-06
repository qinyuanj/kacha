// Web 壳层端口：UI 只认这些接口，同源 HTTP 与浏览器能力都在 ipc.ts 中实现。
import type { MergeReport, MergeUnit, PackDuplicates, PackEntryFact, PackExportSpec, PackIo } from "../core/boardPack";
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

export interface Ipc {
  readBoard(path: string): Promise<BoardTexts>;
  writeBoard(path: string, text: string, options?: BoardWriteOptions): Promise<void>;
  renameBoard(from: string, to: string, version?: string): Promise<void>;
  listBoardNames(dir: string): Promise<string[]>;
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

// 壳层端口类型：UI 只认这些接口，具体实现见 impl.tauri.ts（旧假壳 e2e）与 impl.web.ts（Web 版）。
import type { FetchLike } from "../core/gateway";
import type { MergeOutcome, MergeUnit, PackExportSpec } from "../core/boardPack";
import type { DirEntry } from "../core/relocate";
import type { UpdateFlowPorts } from "../core/updateFlow";

export interface AppPaths {
  default_output_root: string;
  app_data_dir: string;
}

export interface BoardTexts {
  main: string | null;
  bak: string | null;
  /** 主文件内容版本（Web 版服务端返回）；桌面实现没有版本概念。 */
  version?: string | null;
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

export interface PackageEntry {
  name: string;
  description: string;
  size: number;
  optional: boolean;
  contains_prompt: boolean;
}

export interface Ipc {
  appPaths(): Promise<AppPaths>;
  startupArgs(): Promise<string[]>;
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
  diagnosticsPreview(outputRoot: string | null, openBoards: string[]): Promise<PackageEntry[]>;
  diagnosticsExport(outputRoot: string | null, openBoards: string[], target: string, include: string[]): Promise<PackageEntry[]>;
  boardPackExport(outputRoot: string, target: string, spec: PackExportSpec): Promise<{ task_dirs: number; bytes: number }>;
  boardPackEntries(pack: string): Promise<string[]>;
  boardPackReadTexts(pack: string, names: string[]): Promise<Record<string, string>>;
  boardPackImport(pack: string, outputRoot: string, units: MergeUnit[]): Promise<{ outcomes: { path: string; outcome: MergeOutcome }[]; bytes: number }>;
  boardPackCancel(cancelled: boolean): Promise<void>;
  secretGet(): Promise<string | null>;
  secretSet(key: string): Promise<void>;
  secretDelete(): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  fileSha256(path: string): Promise<string>;
  isFile(path: string): Promise<boolean>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeNewFile(path: string, bytes: Uint8Array): Promise<void>;
}

export interface AskOptions {
  title?: string;
  kind?: "error" | "info" | "warning";
  okLabel?: string;
  cancelLabel?: string;
}

export interface OpenOptions {
  multiple?: boolean;
  directory?: boolean;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/** 系统对话框与窗口行为：桌面是原生 API，Web 由浏览器上传 / 下载与自绘确认替代。 */
export interface DesktopPort {
  ask(message: string, options?: AskOptions): Promise<boolean>;
  message(text: string, options?: AskOptions): Promise<void>;
  open(options?: OpenOptions): Promise<string | string[] | null>;
  save(options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  setWindowSize(size: { width: number; height: number }): Promise<void>;
  /** 尺寸在回调里异步读取（最大化时返回 null）；调用方在 await 之前就把工作纳入更新准备闸。 */
  onResized(handler: (readSize: () => Promise<{ width: number; height: number } | null>) => void): Promise<() => void>;
  destroyWindow(): Promise<void>;
  onCloseRequested(handler: (event: { preventDefault(): void }) => Promise<void>): Promise<() => void>;
  onSecondInstance(handler: (paths: string[]) => void): Promise<() => void>;
  onPackProgress(handler: (progress: { done: number; total: number }) => void): Promise<() => void>;
  /** 拖入画板文件 / 参考图（Web 版由 #28 用 HTML5 drop 实现）。 */
  onDropPaths(handler: (paths: string[], position: { x: number; y: number }) => void): Promise<() => void>;
  openExternal(url: string): void;
  version(): Promise<string>;
}

export interface ShellImpl {
  /** Web 版为 true：禁用自动更新、诊断包等桌面能力。 */
  web: boolean;
  ipc: Ipc;
  httpFetch: FetchLike;
  fileUrl(path: string): string;
  desktop: DesktopPort;
  session: SessionPort;
  /** 结果中转（只有 Web 版有）：url 结果由服务端下载到任务目录暂存区，校验后提交。 */
  relay?: RelayPort;
  /** 浏览器上传 / 下载（只有 Web 版有；桌面仍走系统对话框）。 */
  transfer?: TransferPort;
  updateFlowPorts(protection: Pick<UpdateFlowPorts, "restartGuard" | "restartReleased">): UpdateFlowPorts;
}

/** 结果中转端口：相对路径都相对输出根（虚拟根由实现剥掉）。 */
export interface RelayPort {
  relayResult(args: { url: string; relDir: string; stem: string; signal?: AbortSignal }): Promise<{ file: string; path: string }>;
  commitRelayed(relDir: string, from: string, stem: string): Promise<{ file: string; path: string }>;
  discardRelayed(relDir: string): Promise<void>;
}

/** 浏览器文件传输端口（#28）：本机 → 用户数据根的上传，用户数据根 → 本机的下载。 */
export interface TransferPort {
  /** 选本机图片；取消返回空数组。multiple=false 时最多一张。 */
  pickLocalImages(multiple: boolean): Promise<File[]>;
  /** 上传一张参考图，返回相对用户数据根的落盘路径（`导入参考图/<sha256>.<ext>`）。 */
  uploadReference(file: File): Promise<{ path: string; sha256: string }>;
  /** 下载单张图片：结果带图层时服务端给 zip。 */
  downloadImage(path: string, name?: string): void;
  /** 下载整张画板的全部结果 zip。 */
  downloadBoardResults(boardPath: string): void;
}

/** 进入与身份：只有 Web 版有；桌面实现为占位（旧假壳不经过进入界面）。 */
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

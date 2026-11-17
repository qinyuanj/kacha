// 壳端口：界面通过这组接口使用 MyGo / Go 本机能力（ADR 0023）。
// 缺的能力由 features 提前关掉，
// 或在调用时返回 kind: "unavailable"，界面据此隐藏入口而不是失败得很晚。
import { errorText } from "../core/errors";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import type { ImportOptions, ImportResult, PackEntryFact, PackExportSpec, PackFs, PackIo } from "../core/boardPack";
import type { DirEntry, RelocateFs } from "../core/relocate";
import type { RunDeps } from "../core/run";
import type { SettingsPorts } from "../core/settings";
import type { ImageProbe } from "../core/submission";
import type { TaskFs } from "../core/taskDir";
import type { ClipboardContent } from "../core/clipboardDispatch";
import type { BoardMeasure } from "../core/tidy";
import type { LogKind } from "./log";
import type { BoardListing, BoardTexts, BoardWriteOptions, BrowserOptions, ImageInfo, UsagePort } from "./types";

export type { ImageInfo } from "./types";

// ---- 类型化结局 ----
// 界面不再看 HTTP 状态码与错误码：端口把失败折成下面这些类别，分支只认类别（换实现时语义不变）。

/** 可选能力：桌面壳还没有的，界面按 features 隐藏入口，调用时得到 unavailable。 */
export type FeatureId = "generation" | "usage" | "packExport" | "packImport" | "archive" | "tidy" | "relay" | "copyImage" | "copyText" | "saveImage" | "downloadImage" | "downloadResults";

export interface ShellFeatures {
  /** 生成（网关调用）。 */
  generation: boolean;
  /** 用量统计与未引用清理。 */
  usage: boolean;
  /** 画板包导出（打包并下载）。 */
  packExport: boolean;
  /**
   * 画板包导入：桌面壳交给 Go 在本机解压合并。
   * 未声明时按可用处理；实现不可用时明确写 false。
   */
  readonly packImport?: boolean;
  /**
   * 整理模式（按任务目录量画板体量）：桌面壳本切片还没实现，没做时入口标「尚不可用」。
   * 未声明时按可用处理。
   */
  readonly tidy?: boolean;
}

/** 端口失败的类别：界面只按它分支。 */
export type PortFailureKind =
  | "conflict"
  | "missing"
  | "alreadyExists"
  | "slotsFull"
  | "archived"
  | "cancelled"
  | "notFound"
  | "forbidden"
  | "unauthenticated"
  | "network"
  | "storageFull"
  | "tooLarge"
  | "invalid"
  | "timeout"
  | "unavailable"
  | "failed";

export interface PortFailure {
  kind: PortFailureKind;
  /** 实现的原始错误码（日志与排查用），界面不据此分支。 */
  code: string;
  message: string;
  /** 底层状态码；无对应状态时为 0。 */
  status: number;
  /** kind = unavailable 时是哪个能力。 */
  feature?: FeatureId;
}

/** 端口失败：实现把底层错误折成 PortFailureKind，调用方 catch 后经 portFailureOf 取类别。 */
export class PortError extends Error {
  readonly kind: PortFailureKind;
  readonly code: string;
  readonly status: number;
  readonly feature?: FeatureId;

  constructor(failure: PortFailure) {
    super(failure.message);
    this.name = "PortError";
    this.kind = failure.kind;
    this.code = failure.code;
    this.status = failure.status;
    if (failure.feature) this.feature = failure.feature;
  }
}

/** 任意异常 → 端口失败；不是 PortError 的按 failed 处理（消息保持原文，界面照旧显示）。 */
export function portFailureOf(error: unknown): PortFailure {
  if (error instanceof PortError) {
    return { kind: error.kind, code: error.code, message: error.message, status: error.status, ...(error.feature ? { feature: error.feature } : {}) };
  }
  return { kind: "failed", code: "unknown", message: errorText(error), status: 0 };
}

/**
 * 端口说这项能力还没有时给用户的说法（#127）；不是 unavailable 就返回 null。
 *
 * 桌面壳本切片没有生成、结果下载、画板包导出等能力：调用点拿到 unavailable 时要说清「还没做」，
 * 不能报成功，也不能把内部错误原文丢给用户。其它失败按各自的错误类别显示。
 */
export function unavailableMessage(error: unknown): string | null {
  const failure = portFailureOf(error);
  if (failure.kind !== "unavailable") return null;
  // 端口自己写的消息里已经说了「尚不可用」就照用：它可能更具体（结果下载、画板包导出）。
  if (failure.message.includes(UNAVAILABLE_TEXT)) return failure.message;
  const label = failure.feature ? FEATURE_LABELS[failure.feature] : "";
  return label ? UNAVAILABLE_TEXT + "：" + label : UNAVAILABLE_TEXT;
}

/** 能力名（界面用中文）：与 FeatureId 一一对应；桌面壳与本文件共用这一份（C1）。 */
export const FEATURE_LABELS: Record<FeatureId, string> = {
  generation: "生成",
  usage: "用量统计",
  packExport: "画板包导出",
  packImport: "画板包导入",
  archive: "归档",
  tidy: "整理",
  relay: "结果中转",
  copyImage: "复制图片",
  copyText: "复制文本",
  saveImage: "另存为",
  downloadImage: "下载图片",
  downloadResults: "下载整板结果",
};

// ---- 端口分组 ----

/** 画板文件：打开 / 新建 / 保存 / 改名 / 删除 / 归档 / 列表 / 度量。写失败一律是类型化 PortError。 */
export interface BoardStore {
  /** 画板原文与内容版本（sha256）；主文件与 .bak 都可能为 null（画板不存在）。 */
  read(path: string): Promise<BoardTexts>;
  /** 带 version = 内容已变则 conflict；createOnly = 只新建，同名 alreadyExists；画板位满 slotsFull。 */
  write(path: string, text: string, options?: BoardWriteOptions): Promise<void>;
  rename(from: string, to: string, version?: string): Promise<void>;
  /** 删除：主文件与 .bak 进回收区；带版本时内容已变 conflict。 */
  remove(path: string, version?: string): Promise<void>;
  archive(from: string, to: string, version?: string): Promise<void>;
  unarchive(from: string, to: string): Promise<void>;
  listNames(dir: string): Promise<string[]>;
  list(): Promise<BoardListing>;
  measure(text: string): Promise<BoardMeasure>;
}

/** 数据根里的文件：任务目录、参考图、画板包规划都要它。 */
export interface FileStore {
  readFile(absPath: string): Promise<Uint8Array>;
  /** 原子写新文件；目标已存在 alreadyExists。 */
  writeNewFile(absPath: string, bytes: Uint8Array): Promise<void>;
  isFile(absPath: string): Promise<boolean>;
  listDir(absDir: string): Promise<DirEntry[]>;
  sha256(absPath: string): Promise<string>;
  inspectImage(absPath: string): Promise<ImageInfo>;
}

/** 元数据文本（settings / ui-state / models-cache / capability-override）：原文进出，解析在 core。 */
export interface MetaStore {
  readSettings(): Promise<string | null>;
  writeSettings(text: string): Promise<void>;
  readUiState(): Promise<string | null>;
  writeUiState(text: string): Promise<void>;
  readModelsCache(): Promise<string | null>;
  writeModelsCache(text: string): Promise<void>;
  readCapabilityOverride(): Promise<string | null>;
}

/**
 * 系统剪贴板快照（#129）：桌面适配器直接读系统剪贴板，给出类型化内容；
 * Web 读不到（返回 null），只能靠 paste 事件。类别与 Go 侧 desktop/internal/clipboard 的 Kind 一一对应。
 */
export type { ClipboardContent } from "../core/clipboardDispatch";

/**
 * 复制图片的失败类别（#130）：界面只按类别取文案，不读实现的消息原文。
 *
 * - decode / unavailable：Web 路线解不开这张图、浏览器拒绝写剪贴板；
 * - unsupported：容器不受支持（HEIC、TIFF 等），换一种导出方式还有救；
 * - busy：系统剪贴板正被别的程序占用，可重试；
 * - invalid：内容坏掉，这张图本身解不开；
 * - failed：别的写失败。
 */
export type ImageCopyFailure = "decode" | "unavailable" | "unsupported" | "invalid" | "busy" | "failed";

/**
 * 复制图片的结局：失败只影响这一次复制，不改画板。
 *
 * detail 是失败的具体对象（如认出来的容器名 tiff）：界面据此说「TIFF 不受支持」而不是笼统的
 * 「格式不受支持」。实现没给时界面按 reason 的通用文案收。
 */
export type ImageCopyResult = { ok: true } | { ok: false; reason: ImageCopyFailure; detail?: string };

/**
 * 「另存为」的结局：取消不是失败，也不该提示「已开始下载」。
 * 桌面壳的系统另存为对话框可能被用户取消；Web 的下载一发出就算开始。
 */
export type SaveCopyOutcome = { kind: "saved" } | { kind: "cancelled" };

/** 界面用的媒体能力：图片地址、选文件、上传参考图、系统剪贴板、另存为。 */
export interface MediaStore {
  /** 原图地址（<img src> / 复制图片读源）。 */
  imageUrl(absPath: string): string;
  /** 节点缩略图地址；实现没有缩略图时可回落到 imageUrl。 */
  thumbUrl(absPath: string): string;
  pickImages(multiple: boolean): Promise<File[]>;
  pickPackFile(): Promise<File | null>;
  /** 本机图片进数据根的 导入参考图/，返回相对数据根的路径与 sha256。 */
  uploadReference(file: File): Promise<{ path: string; sha256: string }>;
  copyText(text: string): Promise<void>;
  /** 复制一张图到系统剪贴板；format 是路径扩展名给的提示，实现按字节判断容器。 */
  copyImage(absPath: string, format?: string): Promise<ImageCopyResult>;
  /** 读系统剪贴板；返回 null 表示这一端读不到（Web），调用方改用 paste 事件带的内容。 */
  readClipboard(): Promise<ClipboardContent | null>;
  /** 结果另存为（带图层的结果是 zip）；用户取消时返回 cancelled。 */
  saveCopyAs(absPath: string): Promise<SaveCopyOutcome>;
  downloadImage(path: string, name?: string): void;
  downloadBoardResults(boardPath: string): void;
}

/**
 * 画板包：导入与导出都经这里。
 * import 由 Go 完成本机解压、合并与画板提交；io 只提供取消，选项接收进度与结局。
 */
export interface PackStore {
  readonly io: PackIo;
  import(file: File, options: ImportOptions): Promise<ImportResult>;
  /** 导出前的 hash 阶段：每个要写的文件的长度与 sha256。 */
  facts(spec: Pick<PackExportSpec, "task_dirs" | "files">): Promise<PackEntryFact[]>;
  exportPack(target: string, spec: PackExportSpec): Promise<{ task_dirs: number; bytes: number }>;
}

/** 宿主交互：确认框、提示、下载进度、外链、版本、日志、页面输入判定。 */
export interface UiStore {
  ask(message: string, options?: BrowserOptions): Promise<boolean>;
  message(text: string, options?: BrowserOptions): Promise<void>;
  onPackProgress(handler: (progress: { done: number; total: number }) => void): Promise<() => void>;
  openExternal(url: string): void;
  version(): Promise<string>;
  /** 脱敏日志；实现可以静默丢弃。 */
  log(kind: LogKind, fields: Record<string, unknown>): void;
  /** 焦点 / 点击是否落在可编辑控件里（方向键与编辑类快捷键留给控件）。 */
  isEditableTarget(target: EventTarget | null): boolean;
  /** 装上页面级输入接管（#97），返回卸载函数。 */
  installInputTakeover(): () => void;
}

/** core/ 的端口由壳层组合好交出去：core 的接口不变，界面只从端口取。 */
export interface CorePorts {
  taskFs: TaskFs;
  runDeps: RunDeps;
  relocateFs: RelocateFs;
  packFs: PackFs;
  imageProbe: ImageProbe;
  settingsPorts: SettingsPorts;
}

/** 壳端口：界面唯一依赖的实现接缝；桌面实现见 desktop.ts，测试替身见 testing/fakePort.ts。 */
export interface ShellPort {
  /** 本机数据根的绝对路径，core 据此拼接文件路径。 */
  readonly userRoot: string;
  readonly features: ShellFeatures;
  readonly board: BoardStore;
  readonly files: FileStore;
  readonly meta: MetaStore;
  readonly media: MediaStore;
  readonly pack: PackStore;
  readonly ui: UiStore;
  readonly usage: UsagePort;
  readonly core: CorePorts;
}
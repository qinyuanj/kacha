// 画板包（ADR 0013）的公共类型与常量：导出规划、清单与桌面端口契约共用的形状都放这里。
// boardPack.ts 汇总导出规划、取消编排与公共契约。
import type { Board } from "./board";

/** 本机能导入、也是导出写的包格式版本。v2 = 导出时按内容去重，被省略的路径记在清单的 duplicates 里（ADR 0013 补记）。 */
export const PACK_FORMAT_VERSION = 2;
export const PACK_EXTENSION = ".ugcpack";
export const PACK_MANIFEST = "manifest.json";
/** 不在任务目录里的参考图在包内（及导入后根目录内）的位置：导入参考图/<sha256>.<ext>。 */
export const IMPORTED_REFERENCES_DIR = "导入参考图";
/** 取消时包命令以此失败（壳层把本机存储的 code cancelled 也统一成它）。 */
export const PACK_CANCELLED = "已取消";
/** 路径排序：逐项比较，供各处去重 / 校验按同一顺序处理。 */
export const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface PackFs {
  isFile(absPath: string): Promise<boolean>;
  /** 任意文件的 sha256（不要求是可解码的图片）。 */
  sha256(absPath: string): Promise<string>;
}

export interface ExportPlan {
  /** 写进包里的画板：任务目录外的参考图已改写为导入参考图下的相对路径。 */
  board: Board;
  /** 整目录带上的任务目录，相对根目录（<UTC 日期>/<task_id>），去重排序。 */
  taskDirs: string[];
  /** 单独带上的参考图：本机绝对路径 → 包内路径。 */
  files: { source: string; entry: string }[];
  /** 缺图节点：照常导出，导入后仍为缺图占位。 */
  missing: { nodeId: string; path: string }[];
}

/** 导出规划所需的文件事实：包内路径、长度与 sha256，由壳展开任务目录后提供。 */
export interface PackEntryFact {
  entry: string;
  size: number;
  sha256: string;
}

/** 去重后的包内容：省略路径 → 包内实存路径；bytes = 实存条目字节和（预估大小），totalBytes = 不去重时的字节和。 */
export interface PackContents {
  duplicates: PackDuplicates;
  bytes: number;
  totalBytes: number;
}

/** 交给壳的导出规格：文本条目直接写入，任务目录整目录、参考图逐个流式写入；omitted 里的条目不写（v2 去重）。 */
export interface PackExportSpec {
  texts: { entry: string; text: string }[];
  task_dirs: string[];
  files: { source: string; entry: string }[];
  omitted: string[];
}

/**
 * v2 包的重复路径：被省略的路径 → 包内实存的代表条目。清单与导出规划都用这一种形状（导入时把省略路径
 * 还原为与代表条目内容相同的文件）；按键天然不会有同一省略路径的两条映射。
 */
export type PackDuplicates = Record<string, string>;

export interface ImportSummary {
  /** 移入的任务目录数。 */
  imported: number;
  /** 本机已有且 task.json 一致、跳过的任务目录数。 */
  skipped: number;
  /** 不一致、未覆盖的包内路径（任务目录与参考图）。 */
  conflicts: string[];
  message: string;
}

/** 画板包命令的取消端口。 */
export interface PackIo {
  /** 开始命令前以 false 复位，用户取消时置 true。 */
  cancel(cancelled: boolean): Promise<void>;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; result: "cancelled" | "failed"; error: string };

export type ImportResult =
  | { kind: "newer"; message: string }
  | { kind: "corrupt"; reason: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string }
  /**
   * 本机存储导入请求（合并任务目录并提交画板）失败：画板一块都没写入；请求到达前就失败时什么都没合并，
   * 合并中途失败时已移入的任务目录保留。
   */
  | { kind: "commitFailed"; error: string }
  /** 画板位不够放下包里的画板（#89）：尚未合并或写入画板；message 是统一文案。 */
  | { kind: "slotsFull"; message: string }
  /** 任务目录与画板已由本机存储提交；written = 已打开的实际画板文件名，writeError = 打开画板失败的报错。 */
  | { kind: "done"; summary: ImportSummary; written: string[]; writeError: string | null };

export interface ImportOptions {
  /** 用户选中的画板包文件；桌面壳保存其本机路径。 */
  file: File;
  /** 本机存储已写好的导入画板，仅打开返回的实际路径。 */
  openBoard(path: string): Promise<void>;
  /**
   * 画板位预检（#89）：导入将新增 boards 块画板，放不下时返回给用户看的统一文案，放得下为 null。
   * 供适配器预检；Go 导入在合并时执行实际检查。
   */
  slotsRefusal?(boards: number): Promise<string | null>;
  /** 导入开始时进入进度阶段。 */
  onStage(stage: "progress"): void;
  /** 本机解压合并的各步，供进度对话框展示。 */
  onPhase?(phase: ImportPhase): void;
  /** 脱敏日志：只记类别、文件名与计数，不记提示词与报错原文。 */
  log(kind: "board_pack", fields: Record<string, unknown>): void;
}

/** Go 导入过程的步骤；check 表示开始检查。 */
export type ImportPhase = "check" | "extract" | "restore" | "merge" | "boards";
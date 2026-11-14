// 画板包（ADR 0013）的公共类型与常量：导出规划、清单、导入判定与端口契约共用的形状都放这里。
// boardPack.ts 只做对外出口，判定逻辑分散到 boardPackExport / boardPackInspect / boardPackImport 三个模块。
import type { Board } from "./board";
import type { ZipEntry } from "./zipIndex";

/** 本机能导入、也是导出写的包格式版本。v2 = 导出时按内容去重，被省略的路径记在清单的 duplicates 里（ADR 0013 补记）。 */
export const PACK_FORMAT_VERSION = 2;
export const PACK_EXTENSION = ".ugcpack";
export const PACK_MANIFEST = "manifest.json";
/** 不在任务目录里的参考图在包内（及导入后根目录内）的位置：导入参考图/<sha256>.<ext>。 */
export const IMPORTED_REFERENCES_DIR = "导入参考图";
/** 取消时包命令以此失败（壳层把服务端的 code cancelled 也统一成它）。 */
export const PACK_CANCELLED = "已取消";
/**
 * 单份内容上传的上限，与服务端单文件请求体上限一致（ADR 0018）；包里有更大的条目时回退为整包上传。
 * 服务端 server/src/lib.rs 的 MAX_BODY_BYTES 是它的跨语言副本，改一处要同改另一处。
 */
export const MAX_CONTENT_BYTES = 64 * 1024 * 1024;

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

/** 一个包内文件的字节事实：包内路径、（解压后的）长度与 sha256。导出时由服务端按导出计划给出（任务目录展开后），
 *  导入时由浏览器按条目算出（packHash）。 */
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

/** 合并单元：identity 为目录内用来判定「同一份」的文件；为 null 时单元本身是文件，按整文件比对。 */
export interface MergeUnit {
  path: string;
  identity: string | null;
}

/**
 * v2 包的重复路径：被省略的路径 → 包内实存的代表条目。清单、导出规划与导入检查都用这一种形状（导入时把省略路径
 * 还原为与代表条目内容相同的文件）；按键天然不会有同一省略路径的两条映射。
 */
export type PackDuplicates = Record<string, string>;

export type PackBoard = { entry: string; board: Board };
export type Rejected = { kind: "newer"; message: string } | { kind: "corrupt"; reason: string };

/** checkPack 的结局：通过时给出画板与 duplicates；否则是拒绝原因。 */
export type PackVersions = { kind: "ok"; boards: PackBoard[]; duplicates: PackDuplicates } | Rejected;
export type PackCheck = { kind: "ok"; boards: PackBoard[]; units: MergeUnit[]; duplicates: PackDuplicates } | Rejected;

/** 壳对每个合并单元的处理：移入、本机已有且一致（跳过）、本机已有但不一致（冲突，不覆盖）。 */
export type MergeOutcome = "moved" | "identical" | "conflict";

export interface ImportSummary {
  /** 移入的任务目录数。 */
  imported: number;
  /** 本机已有且 task.json 一致、跳过的任务目录数。 */
  skipped: number;
  /** 不一致、未覆盖的包内路径（任务目录与参考图）。 */
  conflicts: string[];
  message: string;
}

/** 用户数据根里某个合并单元的现状（去重上传前问服务端）。读不出的按冲突处理，与合并时「读不了视为不同」一致。 */
export type ExistingUnit = { path: string } & ({ state: "absent" } | { state: "present"; sha256: string } | { state: "unreadable" });

/** 去重上传的一份内容：包文件里承载它的条目。 */
export interface PackContent {
  file: File;
  entry: ZipEntry;
}

/** 去重上传落盘清单的一项：合并单元里的一个文件与它的内容 sha256（哪个路径对应哪份内容由浏览器给，服务端信任）。 */
export interface PlacedFile {
  path: string;
  sha256: string;
}

/** 服务端合并落盘的报告：每个合并单元的结局与实际写入的字节数。 */
export type MergeReport = { outcomes: { path: string; outcome: MergeOutcome }[]; bytes: number };

/** 画板包命令的端口（壳层 ipc 实现，见 shell/adapters.ts）。 */
export interface PackIo {
  /** 置取消标记；开始导出 / 导入前先以 false 复位。 */
  cancel(cancelled: boolean): Promise<void>;
  /** 用户数据根里已有的合并单元：任务目录给 task.json 的 sha256，参考图给整文件的 sha256；没有、或在但读不出各是一种状态。 */
  existing(units: MergeUnit[]): Promise<ExistingUnit[]>;
  /** 按条目解压并算 sha256（浏览器里在 Web Worker 跑）；带进度，取消时以 PACK_CANCELLED reject。 */
  hash(file: File, entries: ZipEntry[]): Promise<PackEntryFact[]>;
  /** 开一份去重上传暂存，返回暂存 id。 */
  stage(): Promise<string>;
  /**
   * 上传一份内容到暂存（服务端自算 sha256 核对）：内容是包里的一个条目，上传体由端口取出（浏览器里 stored 条目直接切片，
   * deflate 条目在 Web Worker 解压，不进主线程内存）。progress 是本份之前已传的字节与全部要传的字节。取消时以 PACK_CANCELLED reject。
   */
  uploadContent(staging: string, sha256: string, content: PackContent, progress: { done: number; total: number }): Promise<void>;
  /**
   * 按落盘清单把暂存的内容放进合并单元并合并（同一份内容第一份落盘、其余硬链接）；结束后服务端删暂存。
   * boards = 已准备好的画板标题与内容：服务端在同一把锁内检查实际数量、合并任务并提交画板（#89）。
   */
  importContent(staging: string, units: MergeUnit[], files: PlacedFile[], boards: { title: string; text: string }[]): Promise<MergeReport & { boards: string[] }>;
  /** 不再合并就放弃暂存（幂等）。 */
  discardStaging?(staging: string): Promise<void>;
  /** 把选中的包上传到服务端临时位置，返回上传句柄；带进度，取消时中止请求并以 PACK_CANCELLED reject。 */
  upload(file: File): Promise<string>;
  /** 包内条目名（正斜杠）。 */
  entries(pack: string): Promise<string[]>;
  /** 读指定条目的文本；不存在的条目不出现在结果里。 */
  readTexts(pack: string, names: string[]): Promise<Record<string, string>>;
  /**
   * 按合并单元解压合并进用户数据根，先把 duplicates 里被省略的路径还原为与代表条目内容相同的文件（v1 包为空）；
   * 取消时以 PACK_CANCELLED reject，已移入的单元保留。boards 同 importContent。
   */
  importUnits(pack: string, units: MergeUnit[], duplicates: PackDuplicates, boards: { title: string; text: string }[]): Promise<MergeReport & { boards: string[] }>;
  /** 不再合并就放弃：删掉服务端的临时上传文件（幂等）。 */
  discard?(pack: string): Promise<void>;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; result: "cancelled" | "failed"; error: string };

export type ImportResult =
  | { kind: "newer"; message: string }
  | { kind: "corrupt"; reason: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string }
  /**
   * 服务端导入请求（合并任务目录并提交画板）失败：画板一块都没写入；请求到达前就失败时什么都没合并，
   * 合并中途失败时已移入的任务目录保留。
   */
  | { kind: "commitFailed"; error: string }
  /** 画板位不够放下包里的画板（#89）：什么都没上传或合并；message 是统一文案。 */
  | { kind: "slotsFull"; message: string }
  /** 任务目录与画板已由服务端提交；written = 已打开的实际画板文件名，writeError = 打开画板失败的报错。 */
  | { kind: "done"; summary: ImportSummary; written: string[]; writeError: string | null };

export interface ImportOptions {
  /** 用户选中的画板包文件；上传是导入流程的第一个阶段。 */
  file: File;
  /** 服务端已写好的导入画板，仅打开返回的实际路径。 */
  openBoard(path: string): Promise<void>;
  /**
   * 画板位预检（#89）：导入将新增 boards 块画板，放不下时返回给用户看的统一文案，放得下为 null。
   * 在上传与合并之前调用，免得传完几个 GB 才被拒；服务端合并时会再检查一次。不给则不预检。
   */
  slotsRefusal?(boards: number): Promise<string | null>;
  /** 复位取消标记之后进入进度阶段。 */
  onStage(stage: "progress"): void;
  /** 进度阶段内的各步（进度对话框据此显示正在做什么）；整包上传回退时 upload 即整包上传。 */
  onPhase?(phase: ImportPhase): void;
  /** 脱敏日志：只记类别、文件名与计数，不记提示词与报错原文。 */
  log(kind: "board_pack", fields: Record<string, unknown>): void;
}

/**
 * 进度阶段内的各步：本地检查 → 问服务端已有 → hash → 上传 → 服务端落盘合并。
 *
 * 桌面壳（#131）在本机解压合并，走的是 extract / restore / boards 这三步；Web 版不产生它们。
 */
export type ImportPhase = "check" | "existing" | "hash" | "upload" | "merge" | "extract" | "restore" | "boards";

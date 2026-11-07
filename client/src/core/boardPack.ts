// 画板包（ADR 0013）：把一块画板连同它直接引用的任务目录与图片打成单个 .ugcpack，供另一台机器导入。
// 包格式的全部规则在这里：导出计划（带哪些任务目录 / 参考图、画板路径改写）、清单、导入前的版本与布局判定、
// 按内容去重（包格式 v2：据服务端给的逐文件 sha256 与长度选代表条目、生成 duplicates、算预估大小）、
// 合并单元（任务目录按 task.json 比对，参考图按整文件比对）与结果文案。
// server/src/board_pack.rs 只按给定条目与合并单元搬字节。文件系统由调用方注入。
import { copyTaskIds, parseBoard, serializeBoard, type Board, type BoardNode } from "./board";
import { BOARDS_DIR_NAME, basename, resolveFromRoot, toRootRelative } from "./paths";
import { TASK_RECORD_FILE, taskDirOfRelPath, taskDirOfTaskId } from "./taskDir";
import { sha256Hex } from "./sha256";
import { blobSource, readEntryBytes, readZipIndex, type ZipEntry, type ZipSource } from "./zipIndex";

/** 本机能导入、也是导出写的包格式版本。v2 = 导出时按内容去重，被省略的路径记在清单的 duplicates 里（ADR 0013 补记）。 */
export const PACK_FORMAT_VERSION = 2;
export const PACK_EXTENSION = ".ugcpack";
export const PACK_MANIFEST = "manifest.json";
/** 不在任务目录里的参考图在包内（及导入后根目录内）的位置：导入参考图/<sha256>.<ext>。 */
export const IMPORTED_REFERENCES_DIR = "导入参考图";

export interface PackFs {
  isFile(absPath: string): Promise<boolean>;
  /** 任意文件的 sha256（不要求是可解码的图片）。 */
  sha256(absPath: string): Promise<string>;
}

export interface ExportPlan {
  /** 写进包里的画板：任务目录外的参考图已改写为导入参考图下的相对路径。 */
  board: Board;
  /** 整目录带上的任务目录，相对根目录（`<UTC 日期>/<task_id>`），去重排序。 */
  taskDirs: string[];
  /** 单独带上的参考图：本机绝对路径 → 包内路径。 */
  files: { source: string; entry: string }[];
  /** 缺图节点：照常导出，导入后仍为缺图占位。 */
  missing: { nodeId: string; path: string }[];
}

const isAbsolute = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");

function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "png";
}

export async function planExport(board: Board, userRoot: string, fs: PackFs): Promise<ExportPlan> {
  const taskDirs = new Set<string>();
  const files = new Map<string, string>();
  const missing: ExportPlan["missing"] = [];
  const nodes: BoardNode[] = [];
  for (const node of board.nodes) {
    if (node.type !== "result" && node.type !== "reference") {
      // 份数展开的同一次提交：各份的任务目录都带上（失败 / 已取消 / 已中断的份没有结果节点）；本机已不在的由壳跳过。
      // 只有 task_id 的一份提交照旧不带（没有结果节点就不导出它的任务目录）。
      if (node.type === "task")
        for (const id of copyTaskIds(node.last_submitted)) {
          const dir = taskDirOfTaskId(id);
          if (dir) taskDirs.add(dir);
        }
      nodes.push(node);
      continue;
    }
    const rel = toRootRelative(userRoot, node.path);
    const absPath = resolveFromRoot(userRoot, rel);
    const dir = isAbsolute(rel) ? null : taskDirOfRelPath(rel);
    if (dir) {
      taskDirs.add(dir);
      if (!(await fs.isFile(absPath).catch(() => false))) missing.push({ nodeId: node.id, path: node.path });
      // Flash 结果的图层文件也要齐：缺哪层列哪层，照常导出（导入后该层缺失，用到时会明确失败）。
      if (node.type === "result") {
        for (const layer of node.record.layers ?? []) {
          const layerRel = `${dir}/${layer.file}`;
          if (!(await fs.isFile(resolveFromRoot(userRoot, layerRel)).catch(() => false))) missing.push({ nodeId: node.id, path: layerRel });
        }
      }
      nodes.push(rel === node.path ? node : { ...node, path: rel });
      continue;
    }
    // 任务目录外的图（根目录内外都算）：按 sha256 放进导入参考图；读不到（缺图）时原样保留。
    const sha256 = await fs.sha256(absPath).catch(() => null);
    if (sha256 === null) {
      missing.push({ nodeId: node.id, path: node.path });
      nodes.push(node);
      continue;
    }
    const entry = `${IMPORTED_REFERENCES_DIR}/${sha256}.${extensionOf(rel)}`;
    if (![...files.values()].includes(entry)) files.set(absPath, entry);
    nodes.push({ ...node, path: entry, ...(node.type === "reference" ? { sha256 } : {}) });
  }
  return {
    board: { ...board, nodes },
    taskDirs: [...taskDirs].sort(),
    files: [...files].map(([source, entry]) => ({ source, entry })),
    missing,
  };
}

// ---- 按内容去重（包格式 v2） ----

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

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 能被省略的路径：只有任务目录与导入参考图下的条目（清单、画板不行，与 inspectPack 的校验规则一致）。 */
const omittable = (entry: string) => {
  const parts = entry.split("/");
  return taskDirOfRelPath(entry) !== null || (parts.length === 2 && parts[0] === IMPORTED_REFERENCES_DIR);
};

/**
 * 导出规划：内容相同（sha256 与长度都相同）的条目只存一份，代表条目按路径排序取第一个，其余写进 duplicates。
 * 代表条目从不作为键，于是没有链式映射；结果与 facts 的顺序无关。
 */
export function planPackContents(facts: PackEntryFact[]): PackContents {
  const sorted = [...facts].sort((a, b) => byPath(a.entry, b.entry));
  const kept = new Map<string, string>();
  const duplicates: PackDuplicates = {};
  let bytes = 0;
  let totalBytes = 0;
  for (const fact of sorted) {
    totalBytes += fact.size;
    const key = `${fact.sha256}:${fact.size}`;
    const source = kept.get(key);
    if (source !== undefined && omittable(fact.entry)) {
      duplicates[fact.entry] = source;
      continue;
    }
    if (source === undefined && omittable(fact.entry)) kept.set(key, fact.entry);
    bytes += fact.size;
  }
  return { duplicates, bytes, totalBytes };
}

// ---- 清单与导出规格 ----

const packBoardEntry = (boardFileName: string) => `${BOARDS_DIR_NAME}/${boardFileName}`;

export function buildManifest(appVersion: string, boards: string[], duplicates: PackDuplicates = {}): string {
  return `${JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION, app_version: appVersion, boards, duplicates }, null, 2)}\n`;
}

/** 交给壳的导出规格：文本条目直接写入，任务目录整目录、参考图逐个流式写入；omitted 里的条目不写（v2 去重）。 */
export interface PackExportSpec {
  texts: { entry: string; text: string }[];
  task_dirs: string[];
  files: { source: string; entry: string }[];
  omitted: string[];
}

/** 让壳算字节事实用的规格：与导出规格同一组文件，不含文本条目。 */
export function exportSources(plan: ExportPlan): Pick<PackExportSpec, "task_dirs" | "files"> {
  return { task_dirs: plan.taskDirs, files: plan.files };
}

export function buildExportSpec(appVersion: string, boardFileName: string, plan: ExportPlan, contents: PackContents): PackExportSpec {
  const entry = packBoardEntry(boardFileName);
  return {
    texts: [
      { entry: PACK_MANIFEST, text: buildManifest(appVersion, [entry], contents.duplicates) },
      { entry, text: serializeBoard(plan.board) },
    ],
    ...exportSources(plan),
    omitted: Object.keys(contents.duplicates).sort(byPath),
  };
}

// ---- 导入前判定 ----

/** 合并单元：`identity` 为目录内用来判定「同一份」的文件；为 null 时单元本身是文件，按整文件比对。 */
export interface MergeUnit {
  path: string;
  identity: string | null;
}

/**
 * v2 包的重复路径：被省略的路径 → 包内实存的代表条目。清单、导出规划与导入检查都用这一种形状（导入时把省略路径
 * 还原为与代表条目内容相同的文件）；按键天然不会有同一省略路径的两条映射。
 */
export type PackDuplicates = Record<string, string>;

type PackBoard = { entry: string; board: Board };
type Rejected = { kind: "newer"; message: string } | { kind: "corrupt"; reason: string };
export type PackCheck = { kind: "ok"; boards: PackBoard[]; units: MergeUnit[]; duplicates: PackDuplicates } | Rejected;

const UPGRADE = "请升级本工具后再导入";

/**
 * 版本判定：包格式版本或包内画板版本高于本机时拒绝（此时还没写任何文件）。
 * v2 包另读清单的 `duplicates`（省略路径 → 实存路径），这里只判类型；映射是否合法由 inspectPack 对照条目判。
 */
export function checkPack(
  manifestText: string | null,
  boardTexts: Record<string, string>,
): { kind: "ok"; boards: PackBoard[]; duplicates: PackDuplicates } | Rejected {
  if (manifestText === null) return { kind: "corrupt", reason: `缺少 ${PACK_MANIFEST}` };
  let manifest: { pack_format_version?: unknown; app_version?: unknown; boards?: unknown; duplicates?: unknown };
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { kind: "corrupt", reason: `${PACK_MANIFEST} 不是有效的 JSON` };
  }
  const version = manifest?.pack_format_version;
  if (!Number.isInteger(version) || (version as number) < 1) return { kind: "corrupt", reason: `${PACK_MANIFEST} 缺少包格式版本` };
  if ((version as number) > PACK_FORMAT_VERSION) {
    const by = typeof manifest.app_version === "string" ? `（由 ${manifest.app_version} 导出）` : "";
    return { kind: "newer", message: `该画板包的格式版本 ${version} 高于本机支持的 ${PACK_FORMAT_VERSION}${by}，${UPGRADE}` };
  }
  if (typeof manifest.app_version !== "string" || !Array.isArray(manifest.boards) || !manifest.boards.every((b) => typeof b === "string")) {
    return { kind: "corrupt", reason: `${PACK_MANIFEST} 格式无效` };
  }
  let duplicates: PackDuplicates = {};
  if (version === 2 && manifest.duplicates !== undefined) {
    const d = manifest.duplicates;
    if (d === null || typeof d !== "object" || Array.isArray(d) || !Object.values(d).every((v) => typeof v === "string")) {
      return { kind: "corrupt", reason: `${PACK_MANIFEST} 的 duplicates 格式无效` };
    }
    duplicates = d as PackDuplicates;
  }
  const boards: PackBoard[] = [];
  for (const entry of manifest.boards as string[]) {
    const text = boardTexts[entry];
    if (text === undefined) return { kind: "corrupt", reason: `包内缺少画板 ${entry}` };
    const parsed = parseBoard(text);
    if (parsed.kind === "newer") return { kind: "newer", message: `包内画板 ${basename(entry)} 由更新版本保存（format_version ${parsed.version}），${UPGRADE}` };
    if (parsed.kind === "corrupt") return { kind: "corrupt", reason: `包内画板 ${basename(entry)} 已损坏：${parsed.reason}` };
    boards.push({ entry, board: parsed.board });
  }
  return { kind: "ok", boards, duplicates };
}

const isSafeSegment = (s: string) => s !== "" && s !== "." && s !== ".." && !/[\\:\p{Cc}]/u.test(s);

/**
 * 导入前检查：只读清单与画板文本判版本，再按条目名判布局。包内只允许清单、`画板/<文件>`、
 * `<日期>/<task_id>/…`（须含 task.json）与 `导入参考图/<文件>`；其他一律判为损坏，不解压任何内容。
 * v2 包的 duplicates：键须是任务目录或导入参考图下的合法路径且不是实存条目，值须是实存条目（于是不会再作为键，
 * 不允许链式映射）；被省略的路径与实存条目一起计入布局。
 */
export async function inspectPack(entries: string[], readTexts: (names: string[]) => Promise<Record<string, string>>): Promise<PackCheck> {
  const isBoardEntry = (name: string) => {
    const parts = name.split("/");
    return parts.length === 2 && parts[0] === BOARDS_DIR_NAME;
  };
  const texts = await readTexts(entries.filter((name) => name === PACK_MANIFEST || isBoardEntry(name)));
  const versions = checkPack(texts[PACK_MANIFEST] ?? null, texts);
  if (versions.kind !== "ok") return versions;

  const names = new Set(entries);
  const duplicates: PackDuplicates = {};
  for (const [path, source] of Object.entries(versions.duplicates).sort(([a], [b]) => byPath(a, b))) {
    if (!path.split("/").every(isSafeSegment)) return { kind: "corrupt", reason: `duplicates 含无效路径：${path}` };
    if (path === PACK_MANIFEST || isBoardEntry(path)) return { kind: "corrupt", reason: `duplicates 不能省略 ${path}` };
    if (names.has(path)) return { kind: "corrupt", reason: `duplicates 的省略路径 ${path} 同时是包内条目` };
    if (source in versions.duplicates) return { kind: "corrupt", reason: `duplicates 不允许链式映射：${path} → ${source}` };
    if (!names.has(source)) return { kind: "corrupt", reason: `duplicates 指向包内不存在的条目：${path} → ${source}` };
    duplicates[path] = source;
  }

  const taskDirs = new Set<string>();
  const references: string[] = [];
  for (const path of Object.keys(duplicates)) names.add(path);
  for (const name of names) {
    const parts = name.split("/");
    if (!parts.every(isSafeSegment)) return { kind: "corrupt", reason: `包内路径无效：${name}` };
    if (name === PACK_MANIFEST || isBoardEntry(name)) continue;
    const dir = taskDirOfRelPath(name);
    if (dir) taskDirs.add(dir);
    else if (parts.length === 2 && parts[0] === IMPORTED_REFERENCES_DIR) references.push(name);
    else return { kind: "corrupt", reason: `包内含无法识别的路径：${name}` };
  }
  for (const dir of taskDirs) {
    if (!names.has(`${dir}/${TASK_RECORD_FILE}`)) return { kind: "corrupt", reason: `任务目录 ${dir} 缺少 ${TASK_RECORD_FILE}` };
  }
  const units: MergeUnit[] = [
    ...[...taskDirs].sort().map((path) => ({ path, identity: TASK_RECORD_FILE })),
    ...references.sort().map((path) => ({ path, identity: null })),
  ];
  return { kind: "ok", boards: versions.boards, units, duplicates };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** 本地读出的包：判定结果与文件条目（不含目录条目）。 */
type LocalPack = { check: PackCheck; entries: ZipEntry[] };

/**
 * 在浏览器本地检查包（#61）：读中央目录与清单、画板文本，交给 inspectPack 判版本与布局。
 * 返回 null 表示 zip 读取器读不了（其他压缩方法、结构异常、条目数据读不出），调用方回退为整包上传、交服务端判定。
 * 目录条目不计入布局，与服务端列条目一致。
 */
export async function readPackLocally(src: ZipSource): Promise<LocalPack | null> {
  const index = await readZipIndex(src);
  if (index.kind !== "ok") return null;
  const files = index.entries.filter((e) => !e.name.endsWith("/"));
  const byName = new Map(files.map((e) => [e.name, e]));
  try {
    const check = await inspectPack(
      files.map((e) => e.name),
      async (names) => {
        const texts: Record<string, string> = {};
        for (const name of names) {
          const entry = byName.get(name);
          if (entry) texts[name] = utf8.decode(await readEntryBytes(src, entry));
        }
        return texts;
      },
    );
    return { check, entries: files };
  } catch {
    return null;
  }
}

// ---- 导入结果 ----

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

export function importSummary(units: MergeUnit[], outcomes: { path: string; outcome: MergeOutcome }[]): ImportSummary {
  const taskDirs = new Set(units.filter((u) => u.identity !== null).map((u) => u.path));
  const count = (outcome: MergeOutcome) => outcomes.filter((o) => o.outcome === outcome && taskDirs.has(o.path)).length;
  const imported = count("moved");
  const skipped = count("identical");
  const conflicts = outcomes.filter((o) => o.outcome === "conflict").map((o) => o.path);
  const conflictText = conflicts.length ? `，${conflicts.length} 项冲突未覆盖` : "";
  return { imported, skipped, conflicts, message: `导入 ${imported} 个任务，跳过 ${skipped} 个${conflictText}` };
}

// ---- 可取消的包命令 ----

/** 取消时包命令以此失败（壳层把服务端的 code cancelled 也统一成它）。 */
export const PACK_CANCELLED = "已取消";

/**
 * 单份内容上传的上限，与服务端单文件请求体上限一致（ADR 0018）；包里有更大的条目时回退为整包上传。
 * 服务端 server/src/lib.rs 的 `MAX_BODY_BYTES` 是它的跨语言副本，改一处要同改另一处。
 */
export const MAX_CONTENT_BYTES = 64 * 1024 * 1024;

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
  /** 按落盘清单把暂存的内容放进合并单元并合并（同一份内容第一份落盘、其余硬链接）；结束后服务端删暂存。 */
  importContent(staging: string, units: MergeUnit[], files: PlacedFile[]): Promise<MergeReport>;
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
   * 取消时以 PACK_CANCELLED reject，已移入的单元保留。
   */
  importUnits(pack: string, units: MergeUnit[], duplicates: PackDuplicates): Promise<MergeReport>;
  /** 不再合并就放弃：删掉服务端的临时上传文件（幂等）。 */
  discard?(pack: string): Promise<void>;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; result: "cancelled" | "failed"; error: string };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 先复位取消标记，复位之后才进入进度阶段（调用方在此弹进度），再跑命令：进度弹出后立刻点的取消才不会丢。 */
export async function runCancellable<T>(io: Pick<PackIo, "cancel">, onStage: (stage: "progress") => void, run: () => Promise<T>): Promise<Outcome<T>> {
  await io.cancel(false);
  onStage("progress");
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    const error = errorText(e);
    return { ok: false, result: error === PACK_CANCELLED ? "cancelled" : "failed", error };
  }
}

// ---- 导入 ----

export type ImportResult =
  | { kind: "newer"; message: string }
  | { kind: "corrupt"; reason: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string }
  /** 任务目录已合并；written = 实际写入的画板文件名，writeError = 写画板第一个失败的报错（其后的不再写）。 */
  | { kind: "done"; summary: ImportSummary; written: string[]; writeError: string | null };

export interface ImportOptions {
  /** 用户选中的画板包文件；上传是导入流程的第一个阶段。 */
  file: File;
  /** 按同名改名规则写入画板目录（并打开），返回实际写入的路径；会话状态归调用方。 */
  addBoard(board: Board): Promise<string>;
  /** 复位取消标记之后进入进度阶段。 */
  onStage(stage: "progress"): void;
  /** 进度阶段内的各步（进度对话框据此显示正在做什么）；整包上传回退时 upload 即整包上传。 */
  onPhase?(phase: ImportPhase): void;
  /** 脱敏日志：只记类别、文件名与计数，不记提示词与报错原文。 */
  log(kind: "board_pack", fields: Record<string, unknown>): void;
}

/** 进度阶段内的各步：本地检查 → 问服务端已有 → hash → 上传 → 服务端落盘合并。 */
export type ImportPhase = "check" | "existing" | "hash" | "upload" | "merge";

type OkCheck = Extract<PackCheck, { kind: "ok" }>;
type Merged = { check: OkCheck; report: MergeReport };

const isTextEntry = (name: string) => name === PACK_MANIFEST || name.startsWith(`${BOARDS_DIR_NAME}/`);

/**
 * 去重上传（#62，ADR 0018 补记）：先问服务端哪些合并单元已有——已有的任务目录按 ADR 0013 比 task.json 判跳过 / 冲突，
 * 连 hash 都不算；剩下的条目算 sha256，相同内容只上传一份（v1 包在这里按 sha256 合并；v2 包被省略的路径直接用代表条目的内容，
 * 只为代表条目算 hash），再按「路径 → sha256」的落盘清单让服务端落盘合并。导入参考图要整文件比对，已有的也要算 hash（只读本地）。
 */
async function importByContent(io: PackIo, file: File, check: OkCheck, entries: ZipEntry[], phase: (p: ImportPhase) => void): Promise<MergeReport> {
  const src = blobSource(file);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const omitted = new Map(Object.entries(check.duplicates));
  /** 某个路径的内容在包里由哪个条目承载（v2 被省略的路径指向代表条目）。 */
  const contentOf = (path: string) => byName.get(omitted.get(path) ?? path)!;
  const paths = [...byName.keys(), ...omitted.keys()].filter((name) => !isTextEntry(name)).sort(byPath);
  const filesOf = (unit: MergeUnit) => (unit.identity === null ? [unit.path] : paths.filter((p) => p.startsWith(`${unit.path}/`)));

  phase("existing");
  const present = new Map((await io.existing(check.units)).map((p) => [p.path, p]));
  const settled: MergeReport["outcomes"] = [];
  const needed: MergeUnit[] = [];
  const compareAfterHash: { path: string; sha256: string }[] = [];
  for (const unit of check.units) {
    const theirs = present.get(unit.path) ?? { state: "absent" };
    if (theirs.state === "absent") needed.push(unit);
    else if (theirs.state === "unreadable") settled.push({ path: unit.path, outcome: "conflict" });
    else if (unit.identity === null) compareAfterHash.push({ path: unit.path, sha256: theirs.sha256 });
    else {
      const ours = await sha256Hex(await readEntryBytes(src, contentOf(`${unit.path}/${unit.identity}`)));
      settled.push({ path: unit.path, outcome: ours === theirs.sha256 ? "identical" : "conflict" });
    }
  }

  const neededPaths = needed.flatMap(filesOf);
  const toHash = [...new Map([...neededPaths, ...compareAfterHash.map((c) => c.path)].map((p) => [contentOf(p).name, contentOf(p)])).values()].sort((a, b) => byPath(a.name, b.name));
  const shaOf = new Map<string, string>();
  if (toHash.length > 0) {
    phase("hash");
    for (const fact of await io.hash(file, toHash)) shaOf.set(fact.entry, fact.sha256);
  }
  for (const c of compareAfterHash) settled.push({ path: c.path, outcome: shaOf.get(contentOf(c.path).name) === c.sha256 ? "identical" : "conflict" });
  if (needed.length === 0) return { outcomes: settled, bytes: 0 };

  const files: PlacedFile[] = neededPaths.map((path) => ({ path, sha256: shaOf.get(contentOf(path).name)! }));
  const contents = new Map<string, ZipEntry>();
  for (const f of files) if (!contents.has(f.sha256)) contents.set(f.sha256, contentOf(f.path));
  const total = [...contents.values()].reduce((n, e) => n + e.size, 0);

  phase("upload");
  const staging = await io.stage();
  return discardOnError(
    async () => {
      let done = 0;
      for (const [sha256, entry] of contents) {
        await io.uploadContent(staging, sha256, { file, entry }, { done, total });
        done += entry.size;
      }
      phase("merge");
      const report = await io.importContent(staging, needed, files);
      return { outcomes: [...settled, ...report.outcomes], bytes: report.bytes };
    },
    () => io.discardStaging?.(staging),
  );
}

/**
 * 服务端在合并结束时自己删上传的包 / 暂存；合并之前就被取消或失败时由这里放弃（幂等，放弃失败不掩盖原错误），再原样抛出。
 */
async function discardOnError<T>(run: () => Promise<T>, discard: () => Promise<void> | undefined): Promise<T> {
  try {
    return await run();
  } catch (e) {
    await discard()?.catch(() => undefined);
    throw e;
  }
}

/**
 * 导入画板包（#128）：在同一个可取消的进度阶段里依次本地检查（#61）→ 上传 → 合并任务目录，之后逐个写画板。
 * 本地检查判为版本过新或损坏时直接返回，一个字节都不上传；检查通过就按内容去重上传（#62），只传服务端缺少的内容。
 * zip 读取器读不了的包，或有条目超过单份上限的包，整包上传（#59）；读不了的由服务端读条目与文本判定（不合格不合并）。
 * 从「已拿到用户选的包文件」开始；选包、进度、结果弹窗与文案都留在 ui（弹窗不是端口，见 #128），这里只返回结局。
 * 任何一步被取消或失败都不进入后续各步，并放弃已上传的内容。取消或失败时已移入的任务目录保留；写画板第一个失败即停，已写的保留。
 */
export async function importPack(io: PackIo, opts: ImportOptions): Promise<ImportResult> {
  const { file } = opts;
  const phase = (p: ImportPhase) => opts.onPhase?.(p);
  const fields = { action: "import", pack_file: file.name };
  /** 通过检查的包（日志里的画板文件名由它给出）。 */
  let checked: OkCheck | undefined;
  const outcome = await runCancellable(io, opts.onStage, async (): Promise<Rejected | Merged> => {
    phase("check");
    const read = await readPackLocally(blobSource(file));
    const local = read?.check ?? null;
    if (local && local.kind !== "ok") return local;
    if (read && local && read.entries.every((e) => e.size <= MAX_CONTENT_BYTES)) {
      checked = local;
      return { check: local, report: await importByContent(io, file, local, read.entries, phase) };
    }
    phase("upload");
    const pack = await io.upload(file);
    const discard = () => io.discard?.(pack);
    return discardOnError(async (): Promise<Rejected | Merged> => {
      const check =
        local ??
        (await io
          .entries(pack)
          .then((entries) => inspectPack(entries, (names) => io.readTexts(pack, names)))
          .catch((e): Rejected => {
            if (errorText(e) === PACK_CANCELLED) throw e;
            return { kind: "corrupt", reason: errorText(e) };
          }));
      if (check.kind !== "ok") {
        await discard()?.catch(() => undefined);
        return check;
      }
      checked = check;
      phase("merge");
      return { check, report: await io.importUnits(pack, check.units, check.duplicates) };
    }, discard);
  });
  const packBoards = checked?.boards.map((b) => basename(b.entry)).join(", ");
  const boardField = packBoards === undefined ? {} : { board_file: packBoards };
  if (!outcome.ok) {
    opts.log("board_pack", { ...fields, ...boardField, result: outcome.result });
    return outcome.result === "cancelled" ? { kind: "cancelled" } : { kind: "failed", error: outcome.error };
  }
  if (!("report" in outcome.value)) {
    opts.log("board_pack", { ...fields, result: outcome.value.kind });
    return outcome.value;
  }
  const { check, report } = outcome.value;
  const summary = importSummary(check.units, report.outcomes);
  const written: string[] = [];
  let writeError: string | null = null;
  try {
    for (const { board } of check.boards) written.push(basename(await opts.addBoard(board)));
  } catch (e) {
    writeError = errorText(e);
  }
  opts.log("board_pack", {
    ...fields,
    task_dirs: summary.imported,
    skipped: summary.skipped,
    conflicts: summary.conflicts.length,
    bytes: report.bytes,
    board_file: writeError ? packBoards : written.join(", "),
    result: writeError ? "board_write_failed" : "ok",
  });
  return { kind: "done", summary, written, writeError };
}

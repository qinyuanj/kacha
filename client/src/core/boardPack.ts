// 画板包（ADR 0013）：把一块画板连同它直接引用的任务目录与图片打成单个 .ugcpack，供另一台机器导入。
// 包格式的全部规则在这里：导出计划（带哪些任务目录 / 参考图、画板路径改写）、清单、导入前的版本与布局判定、
// 合并单元（任务目录按 task.json 比对，参考图按整文件比对）与结果文案。
// server/src/board_pack.rs 只按给定条目与合并单元搬字节。文件系统由调用方注入。
import { copyTaskIds, parseBoard, serializeBoard, type Board, type BoardNode } from "./board";
import { BOARDS_DIR_NAME, basename, resolveFromRoot, toRootRelative } from "./paths";
import { TASK_RECORD_FILE, taskDirOfRelPath, taskDirOfTaskId } from "./taskDir";

/** 本机能导入的最高包格式版本。v2 = 导出时按内容去重，被省略的路径记在清单的 duplicates 里（ADR 0013 补记）。 */
export const PACK_FORMAT_VERSION = 2;
/** 导出写的包格式版本：导出 v2 落地前仍写 v1，保证导出的包总能被导回来。 */
const EXPORT_PACK_FORMAT_VERSION = 1;
export const PACK_EXTENSION = ".ugcpack";
/** 系统对话框的扩展名过滤器。 */
export const PACK_FILE_FILTER = { name: "画板包", extensions: [PACK_EXTENSION.slice(1)] };
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

// ---- 清单与导出规格 ----

const packBoardEntry = (boardFileName: string) => `${BOARDS_DIR_NAME}/${boardFileName}`;

export function buildManifest(appVersion: string, boards: string[]): string {
  return `${JSON.stringify({ pack_format_version: EXPORT_PACK_FORMAT_VERSION, app_version: appVersion, boards }, null, 2)}\n`;
}

/** 交给壳的导出规格：文本条目直接写入，任务目录整目录、参考图逐个流式写入。 */
export interface PackExportSpec {
  texts: { entry: string; text: string }[];
  task_dirs: string[];
  files: { source: string; entry: string }[];
}

export function buildExportSpec(appVersion: string, boardFileName: string, plan: ExportPlan): PackExportSpec {
  const entry = packBoardEntry(boardFileName);
  return {
    texts: [
      { entry: PACK_MANIFEST, text: buildManifest(appVersion, [entry]) },
      { entry, text: serializeBoard(plan.board) },
    ],
    task_dirs: plan.taskDirs,
    files: plan.files,
  };
}

// ---- 导入前判定 ----

/** 合并单元：`identity` 为目录内用来判定「同一份」的文件；为 null 时单元本身是文件，按整文件比对。 */
export interface MergeUnit {
  path: string;
  identity: string | null;
}

/** v2 包里被省略的路径（path）与包内实存的代表条目（source）：导入时还原为内容相同的文件。 */
export interface PackDuplicate {
  path: string;
  source: string;
}

type PackBoard = { entry: string; board: Board };
type Rejected = { kind: "newer"; message: string } | { kind: "corrupt"; reason: string };
export type PackCheck = { kind: "ok"; boards: PackBoard[]; units: MergeUnit[]; duplicates: PackDuplicate[] } | Rejected;

const UPGRADE = "请升级本工具后再导入";

/**
 * 版本判定：包格式版本或包内画板版本高于本机时拒绝（此时还没写任何文件）。
 * v2 包另读清单的 `duplicates`（省略路径 → 实存路径），这里只判类型；映射是否合法由 inspectPack 对照条目判。
 */
export function checkPack(
  manifestText: string | null,
  boardTexts: Record<string, string>,
): { kind: "ok"; boards: PackBoard[]; duplicates: Record<string, string> } | Rejected {
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
  let duplicates: Record<string, string> = {};
  if (version === 2 && manifest.duplicates !== undefined) {
    const d = manifest.duplicates;
    if (d === null || typeof d !== "object" || Array.isArray(d) || !Object.values(d).every((v) => typeof v === "string")) {
      return { kind: "corrupt", reason: `${PACK_MANIFEST} 的 duplicates 格式无效` };
    }
    duplicates = d as Record<string, string>;
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
  const duplicates: PackDuplicate[] = [];
  for (const [path, source] of Object.entries(versions.duplicates).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!path.split("/").every(isSafeSegment)) return { kind: "corrupt", reason: `duplicates 含无效路径：${path}` };
    if (path === PACK_MANIFEST || isBoardEntry(path)) return { kind: "corrupt", reason: `duplicates 不能省略 ${path}` };
    if (names.has(path)) return { kind: "corrupt", reason: `duplicates 的省略路径 ${path} 同时是包内条目` };
    if (source in versions.duplicates) return { kind: "corrupt", reason: `duplicates 不允许链式映射：${path} → ${source}` };
    if (!names.has(source)) return { kind: "corrupt", reason: `duplicates 指向包内不存在的条目：${path} → ${source}` };
    duplicates.push({ path, source });
  }

  const taskDirs = new Set<string>();
  const references: string[] = [];
  for (const path of duplicates.map((d) => d.path)) names.add(path);
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

/** 与 server/src/board_pack.rs 的 CANCELLED 一致：取消时请求以此失败。 */
export const PACK_CANCELLED = "已取消";

/** 画板包命令的端口（壳层 ipc 实现，见 shell/adapters.ts）。 */
export interface PackIo {
  /** 置取消标记；开始导出 / 导入前先以 false 复位。 */
  cancel(cancelled: boolean): Promise<void>;
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
  importUnits(pack: string, units: MergeUnit[], duplicates: PackDuplicate[]): Promise<{ outcomes: { path: string; outcome: MergeOutcome }[]; bytes: number }>;
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
  /** 脱敏日志：只记类别、文件名与计数，不记提示词与报错原文。 */
  log(kind: "board_pack", fields: Record<string, unknown>): void;
}

type Merged = { check: Extract<PackCheck, { kind: "ok" }>; report: Awaited<ReturnType<PackIo["importUnits"]>> };

/**
 * 导入画板包（#128）：在同一个可取消的进度阶段里依次上传（#59）→ 判版本与布局（不合格不合并）→ 解压合并任务目录，
 * 之后逐个写画板。从「已拿到用户选的包文件」开始；选包、进度、结果弹窗与文案都留在 ui（弹窗不是端口，见 #128），这里只返回结局。
 * 上传被取消或失败时不再读包内容；上传之后的阶段不再合并时放弃上传。取消或失败时已移入的任务目录保留；写画板第一个失败即停，已写的保留。
 */
export async function importPack(io: PackIo, opts: ImportOptions): Promise<ImportResult> {
  const { file } = opts;
  const fields = { action: "import", pack_file: file.name };
  let packBoards: string | undefined;
  const outcome = await runCancellable(io, opts.onStage, async (): Promise<Rejected | Merged> => {
    const pack = await io.upload(file);
    try {
      const check = await io
        .entries(pack)
        .then((entries) => inspectPack(entries, (names) => io.readTexts(pack, names)))
        .catch((e): Rejected => {
          if (errorText(e) === PACK_CANCELLED) throw e;
          return { kind: "corrupt", reason: errorText(e) };
        });
      if (check.kind !== "ok") {
        await io.discard?.(pack).catch(() => undefined);
        return check;
      }
      packBoards = check.boards.map((b) => basename(b.entry)).join(", ");
      return { check, report: await io.importUnits(pack, check.units, check.duplicates) };
    } catch (e) {
      // 服务端在合并结束时自己删临时文件；这里的放弃覆盖合并之前就被取消 / 失败的情况（幂等）。
      await io.discard?.(pack).catch(() => undefined);
      throw e;
    }
  });
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

// 画板包导入前判定（ADR 0013）：版本 / 清单校验、包内布局校验、本地读包。
// 从 boardPack.ts 拆出（#137）：清单判定与布局判定各拆成小函数，inspectPack 只做编排。行为与原实现逐字一致。
import { parseBoard } from "./board";
import { BOARDS_DIR_NAME, basename } from "./paths";
import { TASK_RECORD_FILE, taskDirOfRelPath } from "./taskDir";
import { readEntryBytes, readZipIndex, type ZipEntry, type ZipSource } from "./zipIndex";
import {
  IMPORTED_REFERENCES_DIR,
  PACK_FORMAT_VERSION,
  PACK_MANIFEST,
  byPath,
  type MergeUnit,
  type PackBoard,
  type PackCheck,
  type PackDuplicates,
  type PackVersions,
  type Rejected,
} from "./boardPackTypes";

const UPGRADE = "请升级本工具后再导入";

type Manifest = { pack_format_version?: unknown; app_version?: unknown; boards?: unknown; duplicates?: unknown };

function isBoardEntry(name: string): boolean {
  const parts = name.split("/");
  return parts.length === 2 && parts[0] === BOARDS_DIR_NAME;
}

const isSafeSegment = (s: string) => s !== "" && s !== "." && s !== ".." && !/[\\:\p{Cc}]/u.test(s);

// ---- 清单与版本判断 ----

/** 缺清单或不是 JSON：解码失败。 */
function decodeManifest(manifestText: string | null): { kind: "ok"; manifest: Manifest } | { kind: "corrupt"; reason: string } {
  if (manifestText === null) return { kind: "corrupt", reason: "缺少 " + PACK_MANIFEST };
  try {
    return { kind: "ok", manifest: JSON.parse(manifestText) as Manifest };
  } catch {
    return { kind: "corrupt", reason: PACK_MANIFEST + " 不是有效的 JSON" };
  }
}

/** 包格式版本：须为 >= 1 的整数，否则 null（对应「缺少包格式版本」）。 */
function manifestVersion(manifest: Manifest): number | null {
  const version = (manifest as Manifest | null)?.pack_format_version;
  return Number.isInteger(version) && (version as number) >= 1 ? (version as number) : null;
}

/** 包格式版本高于本机：拒绝并提示升级（带上导出用的 app 版本）。 */
function newerMessage(version: number, appVersion: unknown): Rejected {
  const by = typeof appVersion === "string" ? "（由 " + appVersion + " 导出）" : "";
  return { kind: "newer", message: "该画板包的格式版本 " + version + " 高于本机支持的 " + PACK_FORMAT_VERSION + by + "，" + UPGRADE };
}

/** app_version 须为字符串，boards 须为字符串数组。 */
function manifestShapeValid(manifest: Manifest): boolean {
  return typeof manifest.app_version === "string" && Array.isArray(manifest.boards) && manifest.boards.every((b) => typeof b === "string");
}

/** v2 包读清单的 duplicates（省略路径 → 实存路径）；这里只判类型，映射是否合法由 inspectPack 对照条目判。 */
function readDuplicates(version: number, raw: unknown): { kind: "ok"; duplicates: PackDuplicates } | Rejected {
  if (version !== 2 || raw === undefined) return { kind: "ok", duplicates: {} };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !Object.values(raw).every((v) => typeof v === "string")) {
    return { kind: "corrupt", reason: PACK_MANIFEST + " 的 duplicates 格式无效" };
  }
  return { kind: "ok", duplicates: raw as PackDuplicates };
}

/** 单个画板条目：取文本、解析，判版本过新或损坏。 */
function parseBoardEntry(entry: string, boardTexts: Record<string, string>): PackBoard | Rejected {
  const text = boardTexts[entry];
  if (text === undefined) return { kind: "corrupt", reason: "包内缺少画板 " + entry };
  const parsed = parseBoard(text);
  if (parsed.kind === "newer") return { kind: "newer", message: "包内画板 " + basename(entry) + " 由更新版本保存（format_version " + parsed.version + "），" + UPGRADE };
  if (parsed.kind === "corrupt") return { kind: "corrupt", reason: "包内画板 " + basename(entry) + " 已损坏：" + parsed.reason };
  return { entry, board: parsed.board };
}

function parseBoards(entries: string[], boardTexts: Record<string, string>): PackBoard[] | Rejected {
  const boards: PackBoard[] = [];
  for (const entry of entries) {
    const parsed = parseBoardEntry(entry, boardTexts);
    if ("kind" in parsed) return parsed;
    boards.push(parsed);
  }
  return boards;
}

/**
 * 版本判定：包格式版本或包内画板版本高于本机时拒绝（此时还没写任何文件）。
 * v2 包另读清单的 duplicates（省略路径 → 实存路径），这里只判类型；映射是否合法由 inspectPack 对照条目判。
 */
export function checkPack(manifestText: string | null, boardTexts: Record<string, string>): PackVersions {
  const decoded = decodeManifest(manifestText);
  if (decoded.kind !== "ok") return decoded;
  const manifest = decoded.manifest;
  const version = manifestVersion(manifest);
  if (version === null) return { kind: "corrupt", reason: PACK_MANIFEST + " 缺少包格式版本" };
  if (version > PACK_FORMAT_VERSION) return newerMessage(version, manifest.app_version);
  if (!manifestShapeValid(manifest)) return { kind: "corrupt", reason: PACK_MANIFEST + " 格式无效" };
  const dup = readDuplicates(version, manifest.duplicates);
  if (dup.kind !== "ok") return dup;
  const boards = parseBoards(manifest.boards as string[], boardTexts);
  if (!Array.isArray(boards)) return boards;
  return { kind: "ok", boards, duplicates: dup.duplicates };
}

// ---- 包内布局判断 ----

/** duplicates 的一条映射的问题（键须合法且非清单/画板、非实存条目；值须实存且不成链）。没问题返回 null。 */
function duplicateProblem(path: string, source: string, names: Set<string>, raw: PackDuplicates): Rejected | null {
  if (!path.split("/").every(isSafeSegment)) return { kind: "corrupt", reason: "duplicates 含无效路径：" + path };
  if (path === PACK_MANIFEST || isBoardEntry(path)) return { kind: "corrupt", reason: "duplicates 不能省略 " + path };
  if (names.has(path)) return { kind: "corrupt", reason: "duplicates 的省略路径 " + path + " 同时是包内条目" };
  if (source in raw) return { kind: "corrupt", reason: "duplicates 不允许链式映射：" + path + " → " + source };
  if (!names.has(source)) return { kind: "corrupt", reason: "duplicates 指向包内不存在的条目：" + path + " → " + source };
  return null;
}

function validateDuplicates(raw: PackDuplicates, names: Set<string>): { kind: "ok"; duplicates: PackDuplicates } | Rejected {
  const duplicates: PackDuplicates = {};
  for (const [path, source] of Object.entries(raw).sort(([a], [b]) => byPath(a, b))) {
    const problem = duplicateProblem(path, source, names, raw);
    if (problem) return problem;
    duplicates[path] = source;
  }
  return { kind: "ok", duplicates };
}

/** 一条条目名对布局的问题与归属：任务目录 / 导入参考图 / 清单与画板跳过；其余判损坏。没问题返回 null。 */
function layoutProblem(name: string, taskDirs: Set<string>, references: string[]): Rejected | null {
  const parts = name.split("/");
  if (!parts.every(isSafeSegment)) return { kind: "corrupt", reason: "包内路径无效：" + name };
  if (name === PACK_MANIFEST || isBoardEntry(name)) return null;
  const dir = taskDirOfRelPath(name);
  if (dir) {
    taskDirs.add(dir);
    return null;
  }
  if (parts.length === 2 && parts[0] === IMPORTED_REFERENCES_DIR) {
    references.push(name);
    return null;
  }
  return { kind: "corrupt", reason: "包内含无法识别的路径：" + name };
}

/** 每个任务目录都须含 task.json。 */
function missingTaskRecord(taskDirs: Set<string>, names: Set<string>): Rejected | null {
  for (const dir of taskDirs) if (!names.has(dir + "/" + TASK_RECORD_FILE)) return { kind: "corrupt", reason: "任务目录 " + dir + " 缺少 " + TASK_RECORD_FILE };
  return null;
}

function classifyLayout(names: Set<string>): { kind: "ok"; taskDirs: Set<string>; references: string[] } | Rejected {
  const taskDirs = new Set<string>();
  const references: string[] = [];
  for (const name of names) {
    const problem = layoutProblem(name, taskDirs, references);
    if (problem) return problem;
  }
  const missing = missingTaskRecord(taskDirs, names);
  if (missing) return missing;
  return { kind: "ok", taskDirs, references };
}

async function readPackVersions(entries: string[], readTexts: (names: string[]) => Promise<Record<string, string>>): Promise<PackVersions> {
  const texts = await readTexts(entries.filter((name) => name === PACK_MANIFEST || isBoardEntry(name)));
  return checkPack(texts[PACK_MANIFEST] ?? null, texts);
}

/**
 * 导入前检查：只读清单与画板文本判版本，再按条目名判布局。包内只允许清单、画板/<文件>、
 * <日期>/<task_id>/…（须含 task.json）与 导入参考图/<文件>；其他一律判为损坏，不解压任何内容。
 * v2 包的 duplicates：键须是任务目录或导入参考图下的合法路径且不是实存条目，值须是实存条目（于是不会再作为键，
 * 不允许链式映射）；被省略的路径与实存条目一起计入布局。
 */
export async function inspectPack(entries: string[], readTexts: (names: string[]) => Promise<Record<string, string>>): Promise<PackCheck> {
  const versions = await readPackVersions(entries, readTexts);
  if (versions.kind !== "ok") return versions;

  const names = new Set(entries);
  const dup = validateDuplicates(versions.duplicates, names);
  if (dup.kind !== "ok") return dup;
  const duplicates = dup.duplicates;
  for (const path of Object.keys(duplicates)) names.add(path);

  const layout = classifyLayout(names);
  if (layout.kind !== "ok") return layout;

  const units: MergeUnit[] = [
    ...[...layout.taskDirs].sort().map((path) => ({ path, identity: TASK_RECORD_FILE })),
    ...layout.references.sort().map((path) => ({ path, identity: null })),
  ];
  return { kind: "ok", boards: versions.boards, units, duplicates };
}

// ---- 本地读包 ----

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** 本地读出的包：判定结果与文件条目（不含目录条目）。 */
export type LocalPack = { check: PackCheck; entries: ZipEntry[] };

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

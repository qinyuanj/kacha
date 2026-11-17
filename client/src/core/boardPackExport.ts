// 画板包导出（ADR 0013）：导出计划（带哪些任务目录 / 参考图、画板路径改写）、清单、按内容去重的规划与导出规格。
// 从 boardPack.ts 拆出（#137）：判定按节点 / 按条目拆成小函数，文件只留编排。行为与原实现逐字一致。
import { copyTaskIds, serializeBoard, type Board, type BoardNode, type ReferenceNode, type ResultNode } from "./board";
import { BOARDS_DIR_NAME, basename, resolveFromRoot, toRootRelative } from "./paths";
import { taskDirOfRelPath, taskDirOfTaskId } from "./taskDir";
import {
  IMPORTED_REFERENCES_DIR,
  PACK_FORMAT_VERSION,
  PACK_MANIFEST,
  byPath,
  type ExportPlan,
  type PackContents,
  type PackEntryFact,
  type PackDuplicates,
  type PackExportSpec,
  type PackFs,
} from "./boardPackTypes";

const isAbsolute = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");

function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "png";
}

/** 一个节点导出时的归属：普通节点 / 任务节点（带份数目录）/ 任务目录内的节点 / 任务目录外的图。 */
interface NodePlanResult {
  node: BoardNode;
  taskDirs: string[];
  files: { source: string; entry: string }[];
  missing: { nodeId: string; path: string }[];
}

/**
 * 单个节点的导出归属（除 isFile / sha256 外无副作用）：普通节点原样带上；任务节点带上份数展开的各任务目录；
 * result / reference 落在任务目录内则带上该目录并核对文件（含 Flash 图层），落在任务目录外则按 sha256 放进导入参考图。
 */
async function planNode(node: BoardNode, userRoot: string, fs: PackFs): Promise<NodePlanResult> {
  if (node.type !== "result" && node.type !== "reference") {
    const taskDirs = node.type === "task" ? copyTaskIds(node.last_submitted).map(taskDirOfTaskId).filter((dir): dir is string => dir !== null) : [];
    return { node, taskDirs, files: [], missing: [] };
  }
  const rel = toRootRelative(userRoot, node.path);
  const absPath = resolveFromRoot(userRoot, rel);
  const dir = isAbsolute(rel) ? null : taskDirOfRelPath(rel);
  if (dir) return planDirNode(node, rel, absPath, dir, userRoot, fs);
  return planExternalNode(node, rel, absPath, fs);
}

/** 任务目录内的节点：核对自身文件与 Flash 图层文件是否在盘上，缺的列入 missing；路径写法不改的保持原对象。 */
async function planDirNode(node: ResultNode | ReferenceNode, rel: string, absPath: string, dir: string, userRoot: string, fs: PackFs): Promise<NodePlanResult> {
  const missing: NodePlanResult["missing"] = [];
  if (!(await fs.isFile(absPath).catch(() => false))) missing.push({ nodeId: node.id, path: node.path });
  if (node.type === "result") {
    for (const layer of node.record.layers ?? []) {
      const layerRel = dir + "/" + layer.file;
      if (!(await fs.isFile(resolveFromRoot(userRoot, layerRel)).catch(() => false))) missing.push({ nodeId: node.id, path: layerRel });
    }
  }
  const mapped = rel === node.path ? node : { ...node, path: rel };
  return { node: mapped, taskDirs: [dir], files: [], missing };
}

/** 任务目录外的图：按 sha256 放进导入参考图；读不到（缺图）时原样保留并列入 missing。 */
async function planExternalNode(node: ResultNode | ReferenceNode, rel: string, absPath: string, fs: PackFs): Promise<NodePlanResult> {
  const sha256 = await fs.sha256(absPath).catch(() => null);
  if (sha256 === null) return { node, taskDirs: [], files: [], missing: [{ nodeId: node.id, path: node.path }] };
  const entry = IMPORTED_REFERENCES_DIR + "/" + sha256 + "." + extensionOf(rel);
  const mapped: BoardNode = node.type === "reference" ? { ...node, path: entry, sha256 } : { ...node, path: entry };
  return { node: mapped, taskDirs: [], files: [{ source: absPath, entry }], missing: [] };
}

/** 导出计划：逐节点判定归属并汇总任务目录、参考图、缺图清单；画板路径按需改写，原画板不被改动。 */
export async function planExport(board: Board, userRoot: string, fs: PackFs): Promise<ExportPlan> {
  const taskDirs = new Set<string>();
  const files = new Map<string, string>();
  const missing: ExportPlan["missing"] = [];
  const nodes: BoardNode[] = [];
  for (const node of board.nodes) {
    const planned = await planNode(node, userRoot, fs);
    planned.taskDirs.forEach((dir) => taskDirs.add(dir));
    for (const file of planned.files) if (![...files.values()].includes(file.entry)) files.set(file.source, file.entry);
    missing.push(...planned.missing);
    nodes.push(planned.node);
  }
  return {
    board: { ...board, nodes },
    taskDirs: [...taskDirs].sort(),
    files: [...files].map(([source, entry]) => ({ source, entry })),
    missing,
  };
}

// ---- 按内容去重（包格式 v2） ----

/** 能被省略的路径：只有任务目录与导入参考图下的条目（清单、画板不省略）。 */
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
    const key = fact.sha256 + ":" + fact.size;
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

const packBoardEntry = (boardFileName: string) => BOARDS_DIR_NAME + "/" + boardFileName;

export function buildManifest(appVersion: string, boards: string[], duplicates: PackDuplicates = {}): string {
  return JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION, app_version: appVersion, boards, duplicates }, null, 2) + "\n";
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

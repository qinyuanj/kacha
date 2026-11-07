// 移出为新画板（#93）：把一个阶段整体拆成一块新画板。这里只算新画板的内容；原画板删去这些节点是画板变更
// moveOutStage（edit），两边按同一组节点（movedIds）。画板位检查、写新画板文件、读上游结果图的 sha256 由界面先做完。
import { BOARD_FORMAT_VERSION, stagesOf, type Board, type BoardEdge, type BoardNode, type ReferenceNode } from "./board";
import { imageKey, imagePortIndex, layerRelPath, removeNodes, sourceLayerRecord } from "./graph";
import { basename } from "./paths";

/** 移出的节点严格限于阶段成员。按画板顺序；阶段不存在为 null。 */
export function movedIds(board: Board, stageId: string): string[] | null {
  const stage = stagesOf(board).find((s) => s.id === stageId);
  return stage ? board.nodes.filter((n) => stage.nodes.includes(n.id)).map((n) => n.id) : null;
}

/** 原画板移出阶段：阶段外的结果仍保留，只断开跨阶段的系统连线，避免普通删除任务的级联规则带走它们。 */
export function removeMovedStage(board: Board, stageId: string): Board {
  const ids = movedIds(board, stageId);
  if (!ids?.length) return board;
  const moved = new Set(ids);
  const edges = board.edges.filter((e) => !(e.system && moved.has(e.from[0]) && !moved.has(e.to[0])));
  return removeNodes({ ...board, edges }, ids).board;
}

/** 阶段外、经图片连线接进移出节点的上游图片：一张图（节点 + 图层）一项。 */
interface Upstream {
  key: string;
  node: BoardNode;
  path: string;
  /** 参考图自带；结果图要界面先读文件算。 */
  sha256: string | null;
}

function upstreams(board: Board, moved: ReadonlySet<string>): Map<string, Upstream> {
  const out = new Map<string, Upstream>();
  for (const e of board.edges) {
    if (e.system || moved.has(e.from[0]) || !moved.has(e.to[0]) || imagePortIndex(e.to[1]) === null) continue;
    const key = imageKey(e.from[0], e.source_layer);
    if (out.has(key)) continue;
    const src = board.nodes.find((n) => n.id === e.from[0]);
    if (src?.type === "reference") out.set(key, { key, node: src, path: src.path, sha256: src.sha256 });
    else if (src?.type === "result") {
      // 图层身份无效时不猜路径（与提交同口径），这条连线随之断开。
      const layer = e.source_layer === null ? null : sourceLayerRecord(src.record, e.source_layer);
      if (e.source_layer !== null && !layer) continue;
      out.set(key, { key, node: src, path: layer ? layerRelPath(src, layer.file) : src.path, sha256: null });
    }
  }
  return out;
}

/** 拆分前要先读 sha256 的文件（相对用户数据根）：阶段外接进来的结果图（底图或图层）。 */
export function moveOutSources(board: Board, stageId: string): string[] {
  const moved = movedIds(board, stageId);
  if (!moved) return [];
  return [...upstreams(board, new Set(moved)).values()].filter((u) => u.sha256 === null).map((u) => u.path);
}

export interface SplitOptions {
  /** moveOutSources 列出的文件的 sha256；读不到为 null（参考图照建，之后按缺图处理）。 */
  sha256: (path: string) => string | null;
  newId: () => string;
}

/**
 * 新画板：标题为阶段名；含移出的节点（换新 id，撤销后原节点回来也不重 id）与两端都在其中的连线，阶段整体带过去（展开）。
 * 指向阶段外节点的连线断开；阶段外接进来的上游图片成为参考图节点（落在原图位置、指向同一文件、标注来源画板名），
 * 接回原端口并保留区域。阶段不存在为 null。
 */
export function splitStage(board: Board, stageId: string, opts: SplitOptions): Board | null {
  const stage = stagesOf(board).find((s) => s.id === stageId);
  const movedList = movedIds(board, stageId);
  if (!stage || !movedList) return null;
  const moved = new Set(movedList);
  const ids = new Map(movedList.map((id) => [id, opts.newId()]));
  const nodes: BoardNode[] = board.nodes.flatMap((n) => (moved.has(n.id) ? [{ ...n, id: ids.get(n.id)! } as BoardNode] : []));
  const refIds = new Map<string, string>();
  for (const u of upstreams(board, moved).values()) {
    const src = u.node as Extract<BoardNode, { type: "reference" | "result" }>;
    const ref: ReferenceNode = {
      id: opts.newId(),
      type: "reference",
      pos: src.pos,
      size: src.size,
      extra: {},
      path: u.path,
      sha256: u.sha256 ?? opts.sha256(u.path) ?? "",
      display_name: src.type === "reference" ? src.display_name : basename(u.path),
      source_board: board.title,
    };
    refIds.set(u.key, ref.id);
    nodes.push(ref);
  }
  const edges = board.edges.flatMap((e): BoardEdge[] => {
    const to = ids.get(e.to[0]);
    if (!to) return [];
    const from = ids.get(e.from[0]);
    if (from) return [{ ...e, from: [from, e.from[1]], to: [to, e.to[1]] }];
    const ref = refIds.get(imageKey(e.from[0], e.source_layer));
    return ref && !e.system ? [{ ...e, from: [ref, e.from[1]], to: [to, e.to[1]], source_layer: null }] : [];
  });
  const members = stage.nodes.flatMap((id) => (ids.has(id) ? [ids.get(id)!] : []));
  return {
    format_version: BOARD_FORMAT_VERSION,
    title: stage.name,
    viewport: board.viewport,
    nodes,
    edges,
    ...(board.last_model ? { last_model: board.last_model } : {}),
    stages: [{ ...stage, id: opts.newId(), nodes: members, collapsed: false }],
    extra: {},
  };
}

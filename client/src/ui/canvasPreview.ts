// 放大预览与「框选修改区域」的请求构造：从画板与能力表拼出弹窗要的标题、绝对路径、图层、
// 扇出任务的可编辑区域与本次编辑的区域轮廓。纯构造，不碰 React；画布动作把结果交给弹窗状态。
import type { Board, BoardEdge, BoardNode } from "../core/board";
import { findModel, type CapabilityTable } from "../core/capabilities";
import type { EdgeRef } from "../core/edit";
import { firstRegionOfEdge, imagePortIndex } from "../core/graph";
import { producerOf } from "../core/iterate";
import { dirname, joinPath, resolveFromRoot } from "../core/paths";
import { coordinateRegionAvailable, effectiveRegionRender } from "../core/region";
import type { SnapshotImage } from "../core/submission";
import { REGION_TEXT } from "./boardText";
import type { PreviewRequest, RegionTarget } from "./PreviewDialog";

/** 画板上能放大预览的节点：参考图与结果。 */
export type ImageNode = Extract<BoardNode, { type: "reference" | "result" }>;

/** 是不是能放大预览 / 重定位的图片节点。 */
const isImageNode = (n: BoardNode): n is ImageNode => n.type === "reference" || n.type === "result";

/** 按 id 找参考图 / 结果节点；提示词、任务与不认识的节点都没有可预览的图片。 */
export function imageNodeOf(board: Board, nodeId: string): ImageNode | undefined {
  return board.nodes.find((n): n is ImageNode => n.id === nodeId && isImageNode(n));
}

/** 一条图片线上的可编辑区域目标；不是图片端口、目标不是任务、模型不支持区域指示的线不给目标。 */
function regionTargetOfEdge(board: Board, table: CapabilityTable, nodeId: string, e: BoardEdge): RegionTarget | null {
  if (e.from[0] !== nodeId || imagePortIndex(e.to[1]) === null) return null;
  const task = board.nodes.find((n) => n.id === e.to[0]);
  if (task?.type !== "task") return null;
  const model = findModel(table, task.model);
  const render = effectiveRegionRender(model);
  if (!render) return null;
  const port = imagePortIndex(e.to[1])! + 1;
  const modelName = model?.display_name ?? task.model;
  const firstRegion = firstRegionOfEdge(board, task.id, e.to[1]);
  return {
    label: REGION_TEXT.targetLabel(modelName, port),
    edgeRef: { from: e.from, to: e.to },
    rects: e.region?.rects ?? [],
    render: e.region?.render ?? render,
    coordinateKind: e.region?.coordinate_kind,
    coordinateAvailable: coordinateRegionAvailable(model),
    firstRegion,
  };
}

/**
 * 参考图 / 结果节点扇出到「支持区域指示」任务的图片线，作为弹窗里可编辑区域的目标。
 * 一条线一个目标，顺序与画板里的连线顺序一致；没有可编辑区域时为空。
 */
export function regionTargetsOf(board: Board, table: CapabilityTable, nodeId: string): RegionTarget[] {
  return board.edges.flatMap((e): RegionTarget[] => {
    const target = regionTargetOfEdge(board, table, nodeId, e);
    return target ? [target] : [];
  });
}

/**
 * 放大预览的请求：参考图 / 结果节点才有，其余节点为 null。
 * 结果节点带上图层侧栏要的记录与绝对路径、resultId（可「加为参考图 / 以此继续编辑」），
 * 以及本次编辑用到的区域轮廓（产出任务的提交快照；任务已删 / 快照无区域 = 没有可回显的轮廓）。
 */
export function nodePreviewRequest(board: Board, table: CapabilityTable, userRoot: string, nodeId: string): PreviewRequest | null {
  const node = imageNodeOf(board, nodeId);
  if (!node) return null;
  const abs = resolveFromRoot(userRoot, node.path);
  const recordLayers = node.type === "result" ? (node.record.layers ?? []) : [];
  const producer = node.type === "result" ? producerOf(board, node.id) : undefined;
  const snapshotImages = (producer?.last_submitted as { images?: SnapshotImage[] } | null)?.images ?? [];
  const regionOutlines = snapshotImages.flatMap((img) => img.region?.rects ?? []);
  return {
    title: node.type === "reference" ? node.display_name : node.file,
    absPath: abs,
    layers: recordLayers.map((record) => ({ record, absPath: joinPath(dirname(abs), record.file) })),
    resultId: node.type === "result" ? node.id : undefined,
    regionTargets: regionTargetsOf(board, table, nodeId),
    regionOutlines,
  };
}

/**
 * 「框选修改区域」的结果：
 * preview = 可以弹窗；refuse = 这条线上没有可编辑目标（模型不支持框选区域，调用方给拒绝原因）；
 * ignore = 目标在、但源节点不是参考图 / 结果节点（拆分前是静默返回，不提示）。
 */
export type RegionEditResult = { kind: "preview"; req: PreviewRequest } | { kind: "refuse" } | { kind: "ignore" };

/**
 * 「框选修改区域」的请求：任务端口行要编辑的那条连线。
 * 判定顺序与拆分前一致：先找目标（找不到 = 拒绝），再看源节点（不是图片节点 = 静默）。
 */
export function regionEditRequest(board: Board, table: CapabilityTable, userRoot: string, taskId: string, ref: EdgeRef): RegionEditResult {
  const target = regionTargetsOf(board, table, ref.from[0]).find((t) => t.edgeRef.to[0] === taskId && t.edgeRef.to[1] === ref.to[1]);
  if (!target) return { kind: "refuse" };
  const src = imageNodeOf(board, ref.from[0]);
  if (!src) return { kind: "ignore" };
  const name = src.type === "reference" ? src.display_name : src.file;
  return {
    kind: "preview",
    req: {
      title: REGION_TEXT.previewTitle(name),
      absPath: resolveFromRoot(userRoot, src.path),
      edit: target,
      regionTargets: [target],
    },
  };
}

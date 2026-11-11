// 画布连线：画板连线逐条展开成 React Flow 的边数据（id、端点、选中、区域徽标与类名）。
// 只做派生，不写盘；选中与拖线态由画布组件给。
import type { Edge } from "@xyflow/react";
import type { Board, BoardEdge } from "../core/board";
import { edgeHoverInfo } from "../core/hoverInfo";
import { edgeClassName } from "../core/ports";
import { REGION_TEXT } from "./boardText";
import { edgeIdOf } from "./canvasPoint";

/** 画布连线派生要用的事实：画板连线与当前选区 / 谱系 / 拖线态。 */
export interface CanvasEdgeInput {
  board: Board;
  /** 当前选中的连线 id（见 edgeIdOf）。 */
  selectedEdges: ReadonlySet<string>;
  /** 当前选中的节点：有选中时非谱系连线去强调。 */
  selectedNodes: ReadonlySet<string>;
  /** 谱系高亮：选中任一点时其上下游连线（见 core/iterate 的 lineage）。 */
  lineageEdges: ReadonlySet<BoardEdge>;
  /** 正在拖线：所有连线去强调。 */
  dragging: boolean;
}

/** 一条画板连线：id 与画板端点一一对应，系统连线不可删、不可选，带区域的显示「N 区域」徽标。 */
function edgeOf(input: CanvasEdgeInput, e: BoardEdge): Edge {
  return {
    id: edgeIdOf(e),
    source: e.from[0],
    sourceHandle: e.from[1],
    target: e.to[0],
    targetHandle: e.to[1],
    selected: input.selectedEdges.has(edgeIdOf(e)),
    label: (e.region?.rects.length ?? 0) > 0 ? REGION_TEXT.edgeLabel(e.region!.rects.length) : undefined,
    deletable: !e.system,
    selectable: !e.system,
    className: edgeClassName(e, { lineage: input.lineageEdges.has(e), selecting: input.selectedNodes.size > 0, dragging: input.dragging }),
    data: { hover: edgeHoverInfo(e) },
  };
}

/** 画布连线列表：顺序与画板连线一致（系统连线也在内）。 */
export function canvasEdges(input: CanvasEdgeInput): Edge[] {
  return input.board.edges.map((e) => edgeOf(input, e));
}

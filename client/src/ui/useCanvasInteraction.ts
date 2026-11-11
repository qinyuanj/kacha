// 画板选取、编辑键与导航：左键拖框选 / Shift 加选、右键 / 中键拖平移、平移缩放、Esc 清选区、
// 方向键微移、Ctrl+J 原地偏移复制、Alt + 拖复制。React Flow 的相关配置与这些键位收在这里，BoardCanvas 只接线。
// 撤销 / 重做、复制的 Ctrl 键在 canvasKeyboard / useBoardKeyboard（粘贴走页面级 paste 接管，见 canvasPaste），两边键位不重叠。
// 判定与状态推演都在 canvasKeys / canvasFlowProps / altDrag 里（各有单测），这里只接线：挂监听、调 apply、留 ref。
import { useReactFlow, useStoreApi, type Node } from "@xyflow/react";
import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { Board } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { applySelection, type SelectChange } from "../core/selection";
import { isEditableTarget } from "../shell/pageInput";
import { altDragPending, altDragSettle, altDragStart, type AltDrag } from "./altDrag";
import { canvasFlowProps, ZOOM_DURATION_MS } from "./canvasFlowProps";
import { canvasKeyCommand, pointerKeepsSelection, wheelPansCanvas, type CanvasKeyCommand, type KeyContext } from "./canvasKeys";

type Ids = ReadonlySet<string>;

/** 画布的选区：节点与连线各一份。 */
export interface Selection {
  nodes: MutableRefObject<Ids>;
  edges: MutableRefObject<Ids>;
  setNodes: Dispatch<SetStateAction<Ids>>;
  setEdges: Dispatch<SetStateAction<Ids>>;
}

interface Options {
  wrapper: RefObject<HTMLDivElement | null>;
  boardRef: MutableRefObject<Board>;
  selection: Selection;
  /** 弹窗开着时画布键位不响应。 */
  dialogOpen: MutableRefObject<boolean>;
  /** 画板写入（见 core/edit），由调用方照建议选中切换选区。 */
  apply: (change: BoardChange) => EditResult | null;
}

const NONE: { nodes: Ids; edges: Ids } = { nodes: new Set(), edges: new Set() };

type Flow = ReturnType<typeof useReactFlow>;

/** 视图类命令落到 React Flow 上（动画时长与快捷键共用 ZOOM_DURATION_MS）。 */
const ZOOM_ACTIONS: Record<"fitView" | "actualSize" | "zoomIn" | "zoomOut", (flow: Flow) => void> = {
  fitView: (flow) => void flow.fitView({ duration: ZOOM_DURATION_MS }),
  actualSize: (flow) => void flow.zoomTo(1, { duration: ZOOM_DURATION_MS }),
  zoomIn: (flow) => void flow.zoomIn({ duration: ZOOM_DURATION_MS }),
  zoomOut: (flow) => void flow.zoomOut({ duration: ZOOM_DURATION_MS }),
};

/** 键位命令的落点：视图类只动视口，微移 / 原地复制写画板，Esc 只清选区。 */
interface KeyCommandDeps {
  flow: Flow;
  apply: (change: BoardChange) => EditResult | null;
  selected: readonly string[];
  setNodes: Dispatch<SetStateAction<Ids>>;
  setEdges: Dispatch<SetStateAction<Ids>>;
}

/**
 * 执行一条画布键位命令。除 Esc 外都 preventDefault：缩放键不吞掉会触发 WebView 自身的缩放，
 * 微移不吞掉会滚动页面。Esc 的默认行为交给页面级 / 菜单的处理器（它们各自 preventDefault）。
 */
function runKeyCommand(cmd: NonNullable<CanvasKeyCommand>, e: KeyboardEvent, deps: KeyCommandDeps): void {
  if (cmd.kind !== "clearSelection") e.preventDefault();
  if (cmd.kind === "nudge") {
    deps.apply({ kind: "nudge", ids: cmd.ids, delta: cmd.delta });
    return;
  }
  if (cmd.kind === "duplicate") {
    deps.apply({ kind: "duplicate", ids: [...deps.selected], drag: null });
    return;
  }
  if (cmd.kind === "clearSelection") {
    deps.setNodes(new Set());
    deps.setEdges(new Set());
    return;
  }
  ZOOM_ACTIONS[cmd.kind](deps.flow);
}

/** .nowheel 区域（任务参数、提示词文本等）自己处理滚轮：双指平移让给它们。 */
function insideNoWheel(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".nowheel") !== null;
}

/** 按下处是画布空白（React Flow 的 pane）：Shift 只在空白上按下时才算 Shift 框选加选。 */
function onPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.classList.contains("react-flow__pane");
}

/** 有变更才写画板：不复制（change = null）时连 apply 都不调。 */
function applyChange(apply: (change: BoardChange) => EditResult | null, change: BoardChange | null): EditResult | null {
  return change ? apply(change) : null;
}

export function useCanvasInteraction({ wrapper, boardRef, selection, dialogOpen, apply }: Options) {
  const flow = useReactFlow();
  const store = useStoreApi();

  // Shift + 框选：React Flow 框选开始时会先清空选区，按下时记下原选区并忽略对它的取消选中。
  const keep = useRef(NONE);
  const onPointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      keep.current = pointerKeepsSelection(e.shiftKey, onPane(e.target)) ? { nodes: selection.nodes.current, edges: selection.edges.current } : NONE;
    },
    [selection],
  );
  const onPointerUpCapture = useCallback(() => {
    keep.current = NONE;
  }, []);
  const selectNodes = useCallback((changes: SelectChange[]) => selection.setNodes((s) => applySelection(s, changes, keep.current.nodes)), [selection]);
  const selectEdges = useCallback((changes: SelectChange[]) => selection.setEdges((s) => applySelection(s, changes, keep.current.edges)), [selection]);

  // Alt + 拖：开始时在原处叠一份副本，松手时与原节点对调位置（被拖走的是副本）；复制、拖动、对调合为一步。
  const altDrag = useRef<AltDrag | null>(null);
  /** 拖动开始；dragId = 这次拖动的编号（归并键）。返回 Alt + 拖复制出的节点数（非 Alt 复制为 0）。 */
  const startDrag = useCallback(
    (event: { altKey: boolean }, dragged: Node[], dragId: number): number => {
      const before = boardRef.current;
      const start = altDragStart(event.altKey, dragged.map((n) => n.id), before, dragId);
      const r = applyChange(apply, start.change);
      const pending = altDragPending(before, start.originals, r);
      altDrag.current = pending;
      // 副本没落账（apply 被拒 / 没有撤销步）时按普通拖动处理：copies 必须是 0。
      return pending?.pairs.length ?? 0;
    },
    [boardRef, apply],
  );
  const stopDrag = useCallback(
    (dragId: number) => {
      const change = altDragSettle(altDrag.current, dragId);
      altDrag.current = null;
      applyChange(apply, change);
    },
    [apply],
  );

  // 触控板双指 = 平移（React Flow 默认滚轮一律缩放）。
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!wheelPansCanvas(e, insideNoWheel(e.target))) return;
      e.preventDefault();
      e.stopPropagation();
      const vp = flow.getViewport();
      void flow.setViewport({ x: vp.x - e.deltaX, y: vp.y - e.deltaY, zoom: vp.zoom });
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [wrapper, flow]);

  useEffect(() => {
    // 可编辑焦点、弹窗开着、wrapper 已卸载这三道前置不进 canvasKeyCommand：它们与键位语义无关，
    // 只决定这次 keydown 归不归画布管。
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || dialogOpen.current || !wrapper.current?.isConnected) return;
      const ctx: KeyContext = { selected: [...selection.nodes.current], connectionInProgress: store.getState().connection.inProgress };
      const cmd = canvasKeyCommand(e, ctx);
      if (!cmd) return;
      runKeyCommand(cmd, e, { flow, apply, selected: ctx.selected, setNodes: selection.setNodes, setEdges: selection.setEdges });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wrapper, flow, store, selection, dialogOpen, apply]);

  return { flowProps: canvasFlowProps, selectNodes, selectEdges, startDrag, stopDrag, onPointerDownCapture, onPointerUpCapture };
}

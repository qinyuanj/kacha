// 画布的 React Flow 事件处理：节点 / 连线变更落成画板变更，拖动与拖角缩放的合并编号记账，
// 拖线松手的三种落点（端口 / 任务卡片 / 空白）、删除前的「先取消再删除」确认、视口变更与跳转居中。
// 画布组件只把当前画板、选区 / 拖拽句柄与写入入口接进来（见 flowHandlers）。
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Edge, EdgeChange, Node, NodeChange, Viewport } from "@xyflow/react";
import type { Board } from "../core/board";
import type { CapabilityTable } from "../core/capabilities";
import type { BoardAction } from "../core/contextMenu";
import { cardDropConnection, dragCreateItems } from "../core/dragCreate";
import type { BoardChange, EditResult, EdgeRef } from "../core/edit";
import { canConnect } from "../core/graph";
import { LOCKED_HINT } from "../core/iterate";
import type { DragFrom } from "../core/ports";
import type { SelectChange } from "../core/selection";
import { browser } from "../shell/ipc";
import { DELETE_TASK_TEXT } from "./boardText";
import { clientPointOf, dropTargetAt, edgeIdOf, nodeDims, type DropTarget } from "./canvasPoint";
import { toConnection } from "./canvasFrame";

/** 连线端口的 handle：节点 id、handle id（React Flow 的 Handle.id 可缺省）与方向。 */
type HandleEnd = { nodeId: string; id?: string | null; type: "source" | "target" };

/** 松手处的另一端：判定用不到方向。 */
type PlainHandleEnd = { nodeId: string; id?: string | null };

/** 拖线松手时的连接状态：@xyflow/react 的 FinalConnectionState 里画布用到的部分（测试不必造完整对象）。 */
export interface DropState {
  isValid: boolean | null;
  fromHandle: HandleEnd | null;
  toHandle: PlainHandleEnd | null;
  fromNode: unknown;
  toNode: unknown;
}

/** 一条连接请求的端点（React Flow 保证的字段；缺失的 handle 记空串）。 */
type ConnectEnds = { source: string; sourceHandle: string | null; target: string; targetHandle: string | null };

/** 运行指示的跳转请求：nodeId 变化或 nonce 变化即再跳一次。 */
type FocusRequest = { nodeId: string; nonce: number };

/** 画布选区 / 拖拽句柄：useCanvasInteraction 的返回值里画布事件要用的部分。 */
export interface FlowNav {
  selectNodes: (changes: SelectChange[]) => void;
  selectEdges: (changes: SelectChange[]) => void;
  /** 拖动开始：返回 Alt + 拖复制出的节点数（非 Alt 复制为 0）。 */
  startDrag: (event: { altKey: boolean }, dragged: Node[], dragId: number) => number;
  stopDrag: (dragId: number) => void;
}

/** 事件处理之间要跨渲染记住的编号与删除确认：画布组件用 useRef 持有这一份。 */
export interface FlowBookkeeping {
  /** 进行中的拖动编号（0 = 没在拖）；每次拖动一个新合并键。 */
  dragId: number;
  /** 拖动编号的自增计数。 */
  dragSeq: number;
  /** Alt + 拖复制出的节点数（复制与移动合为一步）；0 = 普通拖动。 */
  dragCopies: number;
  /** 进行中的拖角缩放编号（0 = 没在缩放）；一次缩放从按下到松开合为一步。 */
  resizeId: number;
  /** 缩放编号的自增计数。 */
  resizeSeq: number;
  /** onBeforeDelete 确认过「先取消再删除」的任务，交给紧随的 onDelete 豁免锁定。 */
  cancelled: string[];
}

/** 新建一份跨渲染记账；画布组件用 `useRef(flowBookkeeping())` 持有。 */
export function flowBookkeeping(): FlowBookkeeping {
  return { dragId: 0, dragSeq: 0, dragCopies: 0, resizeId: 0, resizeSeq: 0, cancelled: [] };
}

/** 画布事件处理的依赖：画板当前值（每次渲染新建一份 handlers）、选区句柄、测量状态与写入入口。 */
export interface FlowHandlerDeps {
  board: Board;
  table: CapabilityTable;
  /** 排队 / 执行中的任务节点：连线与删除要确认。 */
  locked: ReadonlySet<string>;
  /** 画板写入（画布组件里那层：只读拒绝、提示原因、按建议选中）。 */
  apply: (change: BoardChange) => void;
  /** 按当前画板试算一次变更，不写入：删除前的整体拒绝判定。 */
  check: (change: BoardChange) => EditResult | null;
  toast: (message: string) => void;
  /** 已确认「先取消再删除」时逐个取消任务。 */
  onCancelTask: (taskId: string) => void;
  nav: FlowNav;
  setMeasured: Dispatch<SetStateAction<Record<string, { width?: number; height?: number }>>>;
  setSelectedNodes: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /** 拖线建节点：候选动作与落点交给画布的新建类动作。 */
  performDragCreate: MutableRefObject<(action: BoardAction, from: DragFrom, at: { x: number; y: number }) => void>;
  /** 窗口坐标 → 画布坐标。 */
  screenToFlowPosition: (client: { x: number; y: number }) => { x: number; y: number };
  /** 视口跳到指定画布坐标居中（React Flow 实例的方法）。 */
  setCenter: (x: number, y: number, options: { zoom: number; duration: number }) => Promise<boolean>;
  getZoom: () => number;
  /** 画布根元素：算视口中央（新建类动作的缺省落点）。 */
  wrapper: MutableRefObject<HTMLDivElement | null>;
  /** 节点 id → 已测到的显示尺寸（跳转居中用）。 */
  measured: Readonly<Record<string, { width?: number; height?: number }>>;
  refs: FlowBookkeeping;
  /** 落点命中检测（缺省用 document.elementFromPoint；测试注入替身）。 */
  elementAt?: (x: number, y: number) => Element | null;
}

/** 一批节点变更里与画板（及选区）有关的事实。 */
interface NodeChangeFacts {
  selects: SelectChange[];
  moves: Map<string, { x: number; y: number }>;
  measured: Map<string, { width?: number; height?: number }>;
  resized: Map<string, { width: number; height: number }>;
  /** 松手时报了一次 resizing: false：这次缩放结束。 */
  resizeEnded: boolean;
}

/** 把一批 NodeChange 分成选区、位置、测量与拖角缩放四类（remove 由 onBeforeDelete / onDelete 统一处理）。 */
function nodeChangeFacts(changes: NodeChange[]): NodeChangeFacts {
  const facts: NodeChangeFacts = { selects: [], moves: new Map(), measured: new Map(), resized: new Map(), resizeEnded: false };
  for (const c of changes) {
    if (c.type === "select") facts.selects.push(c);
    else if (c.type === "position" && c.position) facts.moves.set(c.id, c.position);
    else if (c.type === "dimensions" && c.dimensions) {
      // 测量结果存下来、在重建节点时回传（见 nodes 的 measured）：只渲染可见节点的前提。
      facts.measured.set(c.id, nodeDims(c.dimensions.width, c.dimensions.height));
      // NodeResizer 拖动中带 resizing: true，松开时报一次 resizing: false；普通测量不带 resizing。
      if (c.resizing) facts.resized.set(c.id, c.dimensions);
      else if (c.resizing === false) facts.resizeEnded = true;
    }
  }
  return facts;
}

/** 测量结果并进画布 state：值没变就保留原对象（不触发重渲染）。 */
function mergeMeasured(deps: FlowHandlerDeps, measured: NodeChangeFacts["measured"]): void {
  deps.setMeasured((m) => {
    let next = m;
    for (const [id, dims] of measured) {
      if (next[id]?.width === dims.width && next[id]?.height === dims.height) continue;
      next = { ...next, [id]: dims };
    }
    return next;
  });
}

/** 拖角缩放：从左 / 上角缩放时同一批带位置变更，与尺寸一起写，不另算移动。 */
function applyResize(deps: FlowHandlerDeps, facts: NodeChangeFacts): void {
  if (!deps.refs.resizeId) deps.refs.resizeId = ++deps.refs.resizeSeq;
  const at = new Map([...facts.resized.keys()].flatMap((id) => (facts.moves.has(id) ? [[id, facts.moves.get(id)!] as const] : [])));
  facts.resized.forEach((_, id) => facts.moves.delete(id));
  const boxes = [...facts.resized].map(([id, { width, height }]) => {
    const p = at.get(id);
    return { id, width, height, pos: p ? ([p.x, p.y] as [number, number]) : null };
  });
  deps.apply({ kind: "resize", resize: deps.refs.resizeId, boxes });
}

/** 拖动中的位置：一次拖动（含多选、Alt + 拖复制）从开始到 onNodeDragStop 合为一步。 */
function applyMove(deps: FlowHandlerDeps, moves: NodeChangeFacts["moves"]): void {
  const drag = deps.refs.dragId ? { id: deps.refs.dragId, copies: deps.refs.dragCopies } : null;
  deps.apply({ kind: "move", moves: [...moves].map(([id, p]) => [id, [p.x, p.y]]), drag });
}

/** 节点变更：选区、测量、拖角缩放、拖动位置；一段变更可以同时带后两类。 */
function nodesChangeAction(deps: FlowHandlerDeps): (changes: NodeChange[]) => void {
  return (changes) => {
    const facts = nodeChangeFacts(changes);
    deps.nav.selectNodes(facts.selects);
    if (facts.measured.size) mergeMeasured(deps, facts.measured);
    if (facts.resizeEnded) deps.refs.resizeId = 0;
    if (facts.resized.size) applyResize(deps, facts);
    if (facts.moves.size) applyMove(deps, facts.moves);
  };
}

/** 连线变更：只有选中在这里处理（删除走 onBeforeDelete / onDelete）。 */
function edgesChangeAction(deps: FlowHandlerDeps): (changes: EdgeChange[]) => void {
  return (changes) => deps.nav.selectEdges(changes.flatMap((c) => (c.type === "select" ? [c] : [])));
}

/** 拖动开始：新编号，Alt + 拖时在开始处叠一份副本（由 useCanvasInteraction 记账）。 */
function dragStartAction(deps: FlowHandlerDeps): (event: { altKey: boolean }, ...rest: [Node, Node[]] | [Node[]]) => void {
  return (event, ...rest) => {
    deps.refs.dragId = ++deps.refs.dragSeq;
    deps.refs.dragCopies = deps.nav.startDrag(event, rest.length === 2 ? rest[1] : rest[0], deps.refs.dragId);
  };
}

/** 拖动结束：结算 Alt + 拖的副本与原节点，清掉这次拖动的编号。 */
function dragStopAction(deps: FlowHandlerDeps): () => void {
  return () => {
    deps.nav.stopDrag(deps.refs.dragId);
    deps.refs.dragId = 0;
    deps.refs.dragCopies = 0;
  };
}

/** 连线生效：画板变更的 connect（合法性由 isValidConnection 保证）。 */
function connectAction(deps: FlowHandlerDeps): (c: ConnectEnds) => void {
  return (c) => deps.apply({ kind: "connect", connection: toConnection(c) });
}

/** 拖线起点端口 → DragFrom（缺失的 handle 记空串）。 */
function dragFromHandle(h: HandleEnd): DragFrom {
  return { nodeId: h.nodeId, handleId: h.id ?? "", type: h.type };
}

/** 落在端口上却不合法：锁定任务提示锁定，其余给 canConnect 的原因。 */
function rejectPortDrop(deps: FlowHandlerDeps, fromHandle: HandleEnd, toHandle: PlainHandleEnd): void {
  const [src, dst] = fromHandle.type === "source" ? [fromHandle, toHandle] : [toHandle, fromHandle];
  if (deps.locked.has(dst.nodeId)) return deps.toast(LOCKED_HINT);
  const verdict = canConnect(deps.board, deps.table, { source: src.nodeId, sourceHandle: src.id ?? "", target: dst.nodeId, targetHandle: dst.id ?? "" });
  if (!verdict.ok) deps.toast(verdict.reason);
}

/** 落在任务卡片上（非端口）：接到下一个空图片端口，提示词线接正向端口。 */
function dropOnCard(deps: FlowHandlerDeps, from: DragFrom, cardId: string, onConnect: (c: ConnectEnds) => void): void {
  const r = cardDropConnection(deps.board, deps.table, from, cardId, deps.locked);
  if (!r) return;
  if (!r.ok) return deps.toast(r.reason);
  onConnect(r.connection);
}

/** 落在空白处：拖线建节点（图片 → 以此继续编辑、提示词 → 新建任务、任务空端口 → 添加参考图）。 */
function dropOnCanvas(deps: FlowHandlerDeps, from: DragFrom, client: { x: number; y: number }, onConnect: (c: ConnectEnds) => void): void {
  const hit: DropTarget | null = dropTargetAt(client, deps.elementAt);
  if (hit?.kind === "node") return dropOnCard(deps, from, hit.nodeId, onConnect);
  if (hit?.kind !== "pane") return;
  const [item] = dragCreateItems(deps.board, from);
  if (item) deps.performDragCreate.current(item.action, from, deps.screenToFlowPosition(client));
}

/**
 * 松手：落在端口上却不合法时告诉原因；落在任务卡片上（非端口）接到下一个空端口；
 * 落在空白处建节点（拖线建节点）。
 */
function connectEndAction(deps: FlowHandlerDeps, onConnect: (c: ConnectEnds) => void) {
  return (event: MouseEvent | TouchEvent, state: DropState) => {
    if (state.isValid || !state.fromHandle) return;
    if (state.toHandle && state.fromNode && state.toNode) return rejectPortDrop(deps, state.fromHandle, state.toHandle);
    dropOnCanvas(deps, dragFromHandle(state.fromHandle), clientPointOf(event), onConnect);
  };
}

/** React Flow 报来的连线 → 画板连线端点（系统连线也在内，画板编辑只断开用户连线）。 */
function edgeRefsOf(board: Board, es: Edge[]): EdgeRef[] {
  const ids = new Set(es.map((e) => e.id));
  return board.edges.filter((e) => ids.has(edgeIdOf(e))).map((e) => ({ from: e.from, to: e.to }));
}

/**
 * 删除前的确认：删除不设禁删、一般不弹确认（靠撤销兜底），只有删排队 / 执行中的任务节点要确认先取消。
 * 先按「连同取消」试算：动到其余锁定任务（断开其输入连线，级联断开的也算）就整体拒绝，不必再问。
 */
function beforeDeleteAction(deps: FlowHandlerDeps): (input: { nodes: Node[]; edges: Edge[] }) => Promise<boolean | { nodes: Node[]; edges: Edge[] }> {
  return async ({ nodes: ns, edges: es }) => {
    const ids = ns.map((n) => n.id);
    const running = ids.filter((id) => deps.locked.has(id));
    const trial = deps.check({ kind: "delete", nodes: ids, edges: edgeRefsOf(deps.board, es), cancelled: running });
    if (trial && !trial.step && trial.hint) {
      deps.toast(trial.hint);
      return false;
    }
    if (running.length) {
      const confirmed = await browser.ask(DELETE_TASK_TEXT.confirm(running.length), {
        title: DELETE_TASK_TEXT.title,
        kind: "warning",
        okLabel: DELETE_TASK_TEXT.ok,
        cancelLabel: DELETE_TASK_TEXT.cancel,
      });
      if (!confirmed) return false;
      running.forEach((id) => deps.onCancelTask(id));
    }
    deps.refs.cancelled = running;
    return { nodes: ns, edges: es };
  };
}

/** 删除：连同 onBeforeDelete 记下的「已确认取消」的锁定任务一起写进画板。 */
function deleteAction(deps: FlowHandlerDeps): (input: { nodes: Node[]; edges: Edge[] }) => void {
  return ({ nodes: ns, edges: es }) => {
    const cancelled = deps.refs.cancelled;
    deps.refs.cancelled = [];
    deps.apply({ kind: "delete", nodes: ns.map((n) => n.id), edges: edgeRefsOf(deps.board, es), cancelled });
  };
}

/** 视口变更：平移与缩放都记为视图变更（不构成撤销步，归档画板也不提示）。 */
function moveEndAction(deps: FlowHandlerDeps): (_: unknown, vp: Viewport) => void {
  return (_event, vp) => deps.apply({ kind: "viewport", viewport: { x: vp.x, y: vp.y, zoom: vp.zoom } });
}

/** 视口中央：偏左上一点，让新建节点的左上角落在视口中间。 */
function centerPositionAction(deps: FlowHandlerDeps): () => { x: number; y: number } {
  return () => {
    const rect = deps.wrapper.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return deps.screenToFlowPosition({ x: rect.left + rect.width / 2 - 120, y: rect.top + rect.height / 2 - 80 });
  };
}

/** 运行指示跳转：居中并选中该节点（跳转请求变化时由画布的 effect 调用）。 */
function focusNodeAction(deps: FlowHandlerDeps): (focus: FocusRequest | null) => void {
  return (focus) => {
    if (!focus) return;
    const node = deps.board.nodes.find((n) => n.id === focus.nodeId);
    if (!node || node.type === "unknown") return;
    const size = deps.measured[node.id];
    void deps.setCenter(node.pos[0] + (size?.width ?? node.size[0]) / 2, node.pos[1] + (size?.height ?? node.size[1]) / 2, { zoom: Math.max(deps.getZoom(), 0.8), duration: 300 });
    deps.setSelectedNodes(new Set([node.id]));
  };
}

/** 画布的全部 React Flow 事件、跳转与中央落点：按当前渲染的画板组装，直接交给画布的 props。 */
export function flowHandlers(deps: FlowHandlerDeps) {
  const onConnect = connectAction(deps);
  return {
    onNodesChange: nodesChangeAction(deps),
    onEdgesChange: edgesChangeAction(deps),
    onNodeDragStart: dragStartAction(deps),
    onNodeDragStop: dragStopAction(deps),
    onConnect,
    onConnectEnd: connectEndAction(deps, onConnect),
    onBeforeDelete: beforeDeleteAction(deps),
    onDelete: deleteAction(deps),
    onMoveEnd: moveEndAction(deps),
    centerPosition: centerPositionAction(deps),
    focusNode: focusNodeAction(deps),
  };
}

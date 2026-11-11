// 画布这一层的零碎接线判定：连线 id 的选中、右键菜单条目与查看过滤、删除键的开关、连线拖动态的着色、
// 拖线合法判定、另存为、选图加参考图、边悬浮。判定都做成模块顶层的纯函数 / 显式注入的小函数，
// 画布组件只把它们接进 React Flow 的 props 与事件。
import type { ConnectionState, Edge, ReactFlowProps } from "@xyflow/react";
import type { Board } from "../core/board";
import type { CapabilityTable } from "../core/capabilities";
import { menuItems, selectionForMenu, type BoardAction, type MenuFacts, type MenuItem, type MenuTarget } from "../core/contextMenu";
import { readOnlyMenu } from "../core/archive";
import { errorText } from "../core/errors";
import { canConnect, type Connection } from "../core/graph";
import type { HoverInfo } from "../core/hoverInfo";
import { resolveFromRoot } from "../core/paths";
import { dragKind, type DragFrom, type DragState } from "../core/ports";
import { isEditableTarget } from "../shell/pageInput";
import type { CSSProperties } from "react";
import { SAVE_TEXT } from "./boardText";
import { canvasFlowProps } from "./canvasFlowProps";
import { edgeIdOf } from "./canvasPoint";
import type { CanvasMenuState, MenuOpenEvent } from "./useCanvasOverlaysState";

/** 拖线起点：useConnection 的选择器。只取起点，指针移动不触发重渲染（浅比较）。 */
export function dragFromOf(c: ConnectionState): DragFrom | null {
  if (!c.inProgress) return null;
  return { nodeId: c.fromHandle.nodeId, handleId: c.fromHandle.id ?? "", type: c.fromHandle.type };
}

/** 画布内屏蔽 WebView 默认右键菜单；可编辑元素保留原生菜单（复制粘贴）。 */
export function blockNativeContextMenu(e: { target: EventTarget | null; preventDefault: () => void }): void {
  if (!isEditableTarget(e.target)) e.preventDefault();
}

/** 归档画板的菜单 / 动作条过滤：只读时把条目换成查看类，可编辑时原样返回。 */
export function menuViewFor(readOnly: boolean): (items: MenuItem[]) => MenuItem[] {
  return readOnly ? readOnlyMenu : (items) => items;
}

/** 打开着的上下文菜单该显示哪些条目：右键目标未选中时按它单选给条目，否则按当前选区。 */
export function menuEntriesOf(
  menu: CanvasMenuState | null,
  factsOf: (selected: ReadonlySet<string>) => MenuFacts,
  selected: ReadonlySet<string>,
  view: (items: MenuItem[]) => MenuItem[],
): MenuItem[] {
  if (!menu) return [];
  return view(menuItems(menu.target, factsOf(selectionOfMenuTarget(menu.target, selected))));
}

/** 菜单作用的选区：右键落在未选中的节点上换成该节点，其余（连线、空白）沿用当前选区。 */
function selectionOfMenuTarget(target: MenuTarget, selected: ReadonlySet<string>): ReadonlySet<string> {
  return target.kind === "node" ? selectionForMenu(selected, target.nodeId) : selected;
}

/** 弹窗 / 菜单开着或归档画板时关掉 React Flow 自带的删除键（键位交给画布自己的快捷键判定）。 */
export function deleteKeyCodeFor(dialogOpen: boolean, readOnly: boolean): ReactFlowProps["deleteKeyCode"] {
  return dialogOpen || readOnly ? null : canvasFlowProps.deleteKeyCode ?? null;
}

/** 拖线中的连线按起点端口着色（端口类型色见 core/ports）。 */
export function connectionLineStyle(board: Board, drag: DragState | null): CSSProperties | undefined {
  return drag ? { stroke: `var(--port-${dragKind(board, drag.from)})` } : undefined;
}

/** 端点形状：React Flow 给的 handle 可能为 null，画板连接判定用空串。 */
export function toConnection(c: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }): Connection {
  return { source: c.source, sourceHandle: c.sourceHandle ?? "", target: c.target, targetHandle: c.targetHandle ?? "" };
}

/** 这条连接现在是否连得上：锁定任务不接受连线，其余按画板连接规则。 */
export function connectionAllowed(board: Board, table: CapabilityTable, locked: ReadonlySet<string>, c: Edge | { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }): boolean {
  return !locked.has(c.target) && canConnect(board, table, toConnection(c)).ok;
}

/** 边悬浮：没有按键按下时把这条线的悬浮信息交给悬浮层（拖拽中不弹）。 */
export function edgeHoverMove(
  e: { buttons: number; clientX: number; clientY: number },
  fe: { id: string; data?: unknown },
  hover: { move: (key: string, info: HoverInfo, x: number, y: number) => void },
): void {
  if (e.buttons !== 0 || !fe.data) return;
  hover.move(`edge:${fe.id}`, (fe.data as { hover: HoverInfo }).hover, e.clientX, e.clientY);
}

/** 「另存为」：参考图 / 结果节点才有；结果带图层时下载的是 zip。 */
export async function saveNodeAsOf(
  nodeId: string,
  deps: { board: Board; userRoot: string; toast: (message: string) => void; save: (absPath: string) => Promise<unknown> },
): Promise<void> {
  const node = deps.board.nodes.find((n) => n.id === nodeId);
  if (node?.type !== "reference" && node?.type !== "result") return;
  try {
    await deps.save(resolveFromRoot(deps.userRoot, node.path));
    deps.toast(SAVE_TEXT.started);
  } catch (e) {
    deps.toast(SAVE_TEXT.failed(errorText(e)));
  }
}

/** 选图加参考图：attachTo = 任务节点 id 时只选一张并接到该任务的空图片端口。 */
export async function pickReferencesOf(
  deps: { pickLocalImages: (multiple: boolean) => Promise<File[]>; importFiles: (files: File[], at: { x: number; y: number }, attach?: { taskId: string; place: "asIs" | "left" }) => Promise<void>; centerPosition: () => { x: number; y: number } },
  at?: { x: number; y: number },
  attachTo?: string,
): Promise<void> {
  const files = await deps.pickLocalImages(!attachTo);
  if (!files.length) return;
  await deps.importFiles(files, at ?? deps.centerPosition(), attachTo ? { taskId: attachTo, place: "asIs" } : undefined);
}

/** 上下文菜单里点一条：菜单开着时按它记下的目标与落点执行（命令表见 canvasCommands）。 */
export function pickMenuAction(action: BoardAction, menu: CanvasMenuState | null, commands: CommandTable): void {
  if (!menu) return;
  commands[action]?.(menu.target, menu.at);
}

/** 悬浮动作条里点一条：目标就是悬浮的那个节点（多选时动作条在选区上方，但目标仍是悬浮节点）。 */
export function pickActionBarAction(action: BoardAction, hovered: string | null, commands: CommandTable): void {
  if (hovered === null) return;
  commands[action]?.({ kind: "node", nodeId: hovered });
}

/** 动作分派表：由 canvasCommands 生成，这里只按 action 取（画布不管的动作是 undefined）。 */
export type CommandTable = Readonly<Record<BoardAction, ((target: MenuTarget, at?: { x: number; y: number }) => void) | undefined>>;

/** 右键事件里画布用到的部分：菜单打开要的字段（MenuOpenEvent，原生 MouseEvent 与 React 合成事件都满足），
 *  加上节点右键时要判的可编辑目标。 */
type MenuEvent = MenuOpenEvent & { target?: EventTarget | null };

/** 打开上下文菜单的接线（useCanvasOverlaysState 的 openMenu）。 */
type OpenMenu = (e: MenuEvent, target: MenuTarget) => void;

/** 画布空白右键。 */
export function openPaneContextMenu(openMenu: OpenMenu, e: MenuEvent): void {
  openMenu(e, { kind: "pane" });
}

/** 节点右键：落在可编辑元素（节点里的输入框）上时保留原生菜单。 */
export function openNodeContextMenu(openMenu: OpenMenu, e: MenuEvent, nodeId: string): void {
  if (isEditableTarget(e.target ?? null)) return;
  openMenu(e, { kind: "node", nodeId });
}

/** 多选右键：菜单目标取选中的第一个节点。 */
export function openSelectionContextMenu(openMenu: OpenMenu, e: MenuEvent, ids: readonly { id: string }[]): void {
  const first = ids[0];
  if (first) openMenu(e, { kind: "node", nodeId: first.id });
}

/** 连线右键：按 React Flow 的连线 id 找回画板连线（系统连线也在这里被认出，菜单按 system 过滤条目）。 */
export function openEdgeMenu(openMenu: OpenMenu, board: Board, e: MenuEvent, edgeId: string): void {
  const target = board.edges.find((be) => edgeIdOf(be) === edgeId);
  if (target) openMenu(e, { kind: "edge", edge: target });
}

/** 悬浮到图片节点上才显示动作条（提示词 / 任务节点没有这套动作）。 */
export function hoveredActionBarOf(showActionBar: (id: string) => void, node: { id: string; type?: string }): void {
  if (node.type === "reference" || node.type === "result") showActionBar(node.id);
}

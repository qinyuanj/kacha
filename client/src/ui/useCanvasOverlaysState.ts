// 画布浮层的状态接线：上下文菜单（目标、窗口坐标、画布坐标）、放大预览弹窗（请求 + nonce），
// 以及「弹窗 / 菜单开着时快捷键不作用于背后的画板」的标记。右键换选区、关菜单、视口开始移动时清
// 「以此继续编辑」的一次性聚焦请求。判定都在模块顶层的函数里，hook 里只留接线。
import { useCallback, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { selectionForMenu, type MenuTarget } from "../core/contextMenu";
import type { PreviewRequest } from "./PreviewDialog";

/** 上下文菜单：client = 弹出处的窗口坐标，at = 同一点的画布坐标（新建节点落点）。 */
export interface CanvasMenuState {
  target: MenuTarget;
  client: { x: number; y: number };
  at: { x: number; y: number };
}

/** 放大预览弹窗：nonce 每次打开递增，作 key 让同一节点再打开时状态从头开始。 */
export interface CanvasPreviewState {
  req: PreviewRequest;
  nonce: number;
}

/** 右键事件里只用到的部分：原生 MouseEvent 与 React 合成事件都满足。 */
export interface MenuOpenEvent {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
}

/** 屏幕坐标 → 画布坐标（useReactFlow().screenToFlowPosition）。 */
export type ScreenToFlow = { screenToFlowPosition: (client: { x: number; y: number }) => { x: number; y: number } };

export interface CanvasOverlaysStateInput {
  /** useReactFlow()：右键处的窗口坐标换成画布坐标（新建节点落点）。 */
  flow: ScreenToFlow;
  /** 当前选区（同步视图）：右键落在未选中的节点上时换选区。 */
  selectedRef: RefObject<ReadonlySet<string>>;
  setSelectedNodes: (next: ReadonlySet<string>) => void;
  /** 清掉「以此继续编辑」的一次性聚焦请求（视口开始移动时）。 */
  clearPromptFocus: () => void;
}

export interface CanvasOverlaysState {
  menu: CanvasMenuState | null;
  preview: CanvasPreviewState | null;
  /** 弹窗 / 上下文菜单开着：背后画板的快捷键不生效（菜单自己处理 Esc）。 */
  dialogOpen: boolean;
  /** 同上，供事件回调同步读。 */
  dialogOpenRef: MutableRefObject<boolean>;
  openMenu: (e: MenuOpenEvent, target: MenuTarget) => void;
  closeMenu: () => void;
  /** 打开放大预览：每次调用递增 nonce（同一个节点再打开时弹窗从头开始）。 */
  openPreview: (req: PreviewRequest) => void;
  closePreview: () => void;
  /** 视口开始移动：收起菜单并清掉提示词聚焦请求（视口外的节点挂载时不该抢焦点）。 */
  onMoveStart: () => void;
}

/** 右键落在未选中的节点上时换成该节点；落在选区内 / 空白处保持原选区。返回 null = 选区不变。 */
function menuSelectionOf(selected: ReadonlySet<string>, target: MenuTarget): ReadonlySet<string> | null {
  if (target.kind !== "node") return null;
  const next = selectionForMenu(selected, target.nodeId);
  return next === selected ? null : next;
}

/** openMenu 要用到的接线：选区、换选区、屏幕坐标换算、菜单的 state setter。 */
type OpenMenuDeps = Pick<CanvasOverlaysStateInput, "flow" | "selectedRef" | "setSelectedNodes"> & { setMenu: (menu: CanvasMenuState) => void };

/** 打开上下文菜单：记下右键处的窗口坐标与画布坐标（新建节点落点），并按需换选区。 */
function openMenuAt(deps: OpenMenuDeps, e: MenuOpenEvent, target: MenuTarget): void {
  e.preventDefault();
  const next = menuSelectionOf(deps.selectedRef.current, target);
  if (next) deps.setSelectedNodes(next);
  const client = { x: e.clientX, y: e.clientY };
  deps.setMenu({ target, client, at: deps.flow.screenToFlowPosition(client) });
}

/** 弹窗 / 上下文菜单是否有开着的：开着时快捷键不作用于背后的画板。 */
function anyOpen(...states: readonly (object | null)[]): boolean {
  return states.some((state) => state !== null);
}

export function useCanvasOverlaysState({ flow, selectedRef, setSelectedNodes, clearPromptFocus }: CanvasOverlaysStateInput): CanvasOverlaysState {
  const [menu, setMenu] = useState<CanvasMenuState | null>(null);
  const [preview, setPreview] = useState<CanvasPreviewState | null>(null);
  const previewNonce = useRef(0);
  const dialogOpen = anyOpen(menu, preview);
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;

  const closeMenu = useCallback(() => setMenu(null), []);
  const closePreview = useCallback(() => setPreview(null), []);
  const openPreview = useCallback((req: PreviewRequest) => setPreview({ req, nonce: ++previewNonce.current }), []);
  const openMenu = useCallback((e: MenuOpenEvent, target: MenuTarget) => openMenuAt({ flow, selectedRef, setSelectedNodes, setMenu }, e, target), [flow, selectedRef, setSelectedNodes]);
  const onMoveStart = useCallback(() => {
    closeMenu();
    clearPromptFocus();
  }, [closeMenu, clearPromptFocus]);

  return { menu, preview, dialogOpen, dialogOpenRef, openMenu, closeMenu, openPreview, closePreview, onMoveStart };
}

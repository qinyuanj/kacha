// 单个画板的画布：React Flow 视图完全由画板文件模型派生；选中、测量尺寸只在本地，不落盘。
// 这里是接线层：状态、判定、渲染数据与浮层都在 canvas* / useCanvas* 模块里（各有单测），
// 本文件只把它们的产物交给 React Flow 与各浮层，自己不做判定。
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useConnection,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Board } from "../core/board";
import type { CapabilityTable } from "../core/capabilities";
import type { BoardAction, MenuFacts } from "../core/contextMenu";
import type { BoardChange, EditResult, ImportedImage } from "../core/edit";
import { toggleExpanded } from "../core/expand";
import { lineage } from "../core/iterate";
import { connectablePorts, type DragFrom, type DragState } from "../core/ports";
import type { NodeRunState } from "../core/runner";
import type { Discovery } from "../core/settings";
import type { EffectiveTheme } from "../core/theme";
import { canvasBoardActions } from "./canvasBoardActions";
import { canvasCommands, canvasDragCreate, type CanvasCommandDeps } from "./canvasCommands";
import { addImportedReferences, importImages, importPastedImages } from "./canvasDrop";
import { canvasEdges } from "./canvasEdges";
import { flowBookkeeping, flowHandlers } from "./canvasFlowHandlers";
import {
  blockNativeContextMenu,
  connectionAllowed,
  connectionLineStyle,
  deleteKeyCodeFor,
  dragFromOf,
  edgeHoverMove,
  menuEntriesOf,
  menuViewFor,
  openEdgeMenu,
  openNodeContextMenu,
  openPaneContextMenu,
  openSelectionContextMenu,
  pickMenuAction,
  pickReferencesOf,
  saveNodeAsOf,
} from "./canvasFrame";
import { canvasNodes } from "./canvasNodes";
import { CanvasOverlays } from "./canvasOverlays";
import { useCanvasPaste } from "./canvasPaste";
import { canvasClassName, posOf } from "./canvasPoint";
import { canvasThemeProps } from "./canvasTheme";
import { CanvasToolbar } from "./canvasToolbar";
import { BoardContext, primeImageInfo, type BoardActions } from "./context";
import { useShell } from "./shell";
import { unavailableMessage } from "../shell/port";
import { errorText } from "../core/errors";
import { edgeTypes } from "./edges";
import { HoverProvider, useHoverLayer } from "./hoverInfo";
import { nodeTypes } from "./nodes";
import { DragContext } from "./ports";
import { useBoardKeyboard } from "./useBoardKeyboard";
import { useCanvasApply } from "./useCanvasApply";
import { useCanvasData } from "./useCanvasData";
import { imageImportPorts, useCanvasDrop } from "./useCanvasDrop";
import { useCanvasInteraction } from "./useCanvasInteraction";
import { useCanvasOverlaysState } from "./useCanvasOverlaysState";
import { useCanvasSelectionState } from "./useCanvasSelectionState";

/** 拖线建节点的落点处理：松手处建哪类节点（见 core/dragCreate）。 */
type DragCreate = (action: BoardAction, from: DragFrom, at: { x: number; y: number }) => void;

interface Props {
  board: Board;
  /** 画板文件名，只用于日志。 */
  boardFile: string;
  table: CapabilityTable;
  userRoot: string;
  /** 画板写入的唯一入口（见 core/edit）；会话不可编辑时为 null。 */
  apply: (change: BoardChange) => EditResult | null;
  /** 按当前画板试算一次变更，不写入。 */
  check: (change: BoardChange) => EditResult | null;
  /** 排队 / 执行中的任务节点：参数与连线锁定。 */
  locked: ReadonlySet<string>;
  /** 撤销 / 重做一步（锁定任务按当前状态保留）。 */
  onUndo: () => void;
  onRedo: () => void;
  /** 可撤销 / 可重做的那一步的描述；无则为 null。 */
  undoLabel: string | null;
  redoLabel: string | null;
  toast: (message: string) => void;
  discovery: Discovery;
  /** 页面当前的并发上限：份数控件的可选上界。 */
  concurrency: number;
  /** 运行器快照里本画板各任务节点的各份。 */
  runNodes: ReadonlyMap<string, NodeRunState>;
  /** 本次程序运行期间队列经手过的提交；其余无结果的提交按任务目录推导失败 / 已取消 / 已中断。 */
  handled: ReadonlySet<string>;
  /** 点「运行」：传当前选中的节点 id。 */
  onRun: (selectedIds: string[]) => void;
  onCancelTask: (taskId: string) => void;
  /** fromTaskId：生成变体时按该结果的任务目录重跑；缺省 = 按上次提交。 */
  onRegenerate: (taskId: string, fromTaskId?: string) => void;
  /** 任务节点「查看发送文本」。 */
  onViewSendText: (taskId: string) => void;
  /** 顶部第二行左侧的工具栏容器：画布把 BoardToolbar 经 portal 渲染进去。 */
  toolbarSlot: HTMLElement | null;
  /** 运行指示跳转：居中并选中该节点；nonce 变化即再跳一次。 */
  focus: { nodeId: string; nonce: number } | null;
  /** 归档画板（#90）：能看、放大、下载结果，不能编辑（不拖动、不连线、不删、菜单只剩查看与下载）。 */
  readOnly?: boolean;
  /** 页面级模态开着（设置、更新说明、画板列表、运行确认、发送文本、画板包对话框）：粘贴放行给它们，不落到背后的画板（#96）。 */
  modalOpen?: boolean;
  /** 当前有效主题（暗色 / 浅色）：画布点阵背景、迷你地图与 React Flow 色彩模式跟着它走（#223）。 */
  theme: EffectiveTheme;
}

export function BoardCanvas({
  board,
  boardFile,
  table,
  userRoot,
  apply: applyChange,
  check,
  locked,
  onUndo,
  onRedo,
  undoLabel,
  redoLabel,
  toast,
  discovery,
  concurrency,
  runNodes,
  handled,
  onRun,
  onCancelTask,
  onRegenerate,
  onViewSendText,
  toolbarSlot,
  focus,
  readOnly = false,
  modalOpen = false,
  theme,
}: Props) {
  const port = useShell();
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<Record<string, { width?: number; height?: number }>>({});
  const boardRef = useRef(board);
  boardRef.current = board;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const canvasSelection = useCanvasSelectionState(board);
  const {
    selectedNodes, selectedEdges, setSelectedNodes, setSelectedEdges, selectedRef, selection,
    expanded, setExpandOverrides, focusPrompt, focusPromptRef, requestPromptFocus, promptDrafts, setPromptDrafts,
  } = canvasSelection;
  const apply = useCanvasApply({ applyChange, toast, readOnly, setSelectedNodes, setSelectedEdges });
  const canvasData = useCanvasData({ board, boardFile, userRoot, table, locked, handled, runNodes, applyChange });
  const overlays = useCanvasOverlaysState({ flow, selectedRef, setSelectedNodes, clearPromptFocus: () => requestPromptFocus(null) });
  const nav = useCanvasInteraction({ wrapper, boardRef, selection, dialogOpen: overlays.dialogOpenRef, apply, isEditableTarget: port.ui.isEditableTarget });
  const hover = useHoverLayer();

  // 选中任一节点即高亮其谱系。
  const highlighted = useMemo(() => lineage(board, [...selectedNodes]), [board, selectedNodes]);
  const menuFacts = useCallback(
    (selected: ReadonlySet<string>): MenuFacts => ({ board, table, selected, locked, expanded, undoLabel, redoLabel }),
    [board, table, locked, expanded, undoLabel, redoLabel],
  );
  // 拖线态：起点来自 useConnection，合法落点与 isValidConnection 同一判定。
  const isValidConnection = useCallback((c: Edge | Connection) => connectionAllowed(board, table, locked, c), [board, table, locked]);
  const dragFrom = useConnection(dragFromOf);
  const drag = useMemo<DragState | null>(() => (dragFrom ? { from: dragFrom, ports: connectablePorts(board, dragFrom, isValidConnection) } : null), [dragFrom, board, isValidConnection]);
  const dragging = drag !== null;

  const nodes = useMemo<Node[]>(
    () =>
      canvasNodes({
        board, table, userRoot, selected: selectedNodes, measured,
        lineageNodes: highlighted.nodes, drag, focusPrompt, promptDrafts, missing: canvasData.missing,
        imageInfos: canvasData.imageInfos, alphaByNode: canvasData.alphaByNode, discovery, concurrency, expanded, locked,
        runStateOf: canvasData.runStateOf, statusOf: canvasData.statusOf, menuFacts,
      }),
    [board, table, userRoot, selectedNodes, measured, highlighted, drag, focusPrompt, promptDrafts, canvasData.missing, canvasData.imageInfos, canvasData.alphaByNode, discovery, concurrency, expanded, locked, canvasData.runStateOf, canvasData.statusOf, menuFacts],
  );
  const edges = useMemo<Edge[]>(
    () => canvasEdges({ board, selectedEdges, selectedNodes, lineageEdges: highlighted.edges, dragging }),
    [board.edges, selectedEdges, selectedNodes, highlighted, dragging],
  );

  // 跨渲染记账：拖动 / 缩放的合并编号与「先取消再删除」的确认（画布事件之间记住，见 canvasFlowHandlers）。
  const bookkeeping = useRef(flowBookkeeping());
  const performDragCreateRef = useRef<DragCreate>(() => {});
  const handlers = flowHandlers({
    board, table, locked, apply, check, toast, ask: port.ui.ask, onCancelTask, nav, setMeasured, setSelectedNodes,
    performDragCreate: performDragCreateRef,
    screenToFlowPosition: (client) => flow.screenToFlowPosition(client),
    setCenter: (x, y, options) => flow.setCenter(x, y, options),
    getZoom: () => flow.getZoom(),
    wrapper, measured, refs: bookkeeping.current,
  });

  // perform 依赖每次渲染重建的新建类函数，经 ref 取最新一版，actions 保持稳定。
  const performRef = useRef<BoardActions["perform"]>(() => {});
  const actions = useMemo(
    () =>
      canvasBoardActions({
        table, boardFile, userRoot, discovery, concurrency, apply, boardRef, selectedRef, lockedRef,
        focusPromptRef, requestPromptFocus, setPromptDrafts, setExpandOverrides,
        showPreview: overlays.openPreview, primeImageInfo, onRegenerate, toast, performRef, port,
      }),
    [table, boardFile, userRoot, discovery, concurrency, apply, requestPromptFocus, setPromptDrafts, setExpandOverrides, overlays.openPreview, onRegenerate, toast, port],
  );

  // 本机图片先上传到数据根的 导入参考图/，再按本机存储给出的路径导入（端口见 canvasDrop 的 ImagePorts）。
  const importLocalFiles = useCallback(
    async (files: File[], at: { x: number; y: number }, attach?: { taskId: string; place: "asIs" | "left" }) => {
      const images: ImportedImage[] = await importImages(files, { userRoot, toast, ports: imageImportPorts(port) });
      addImportedReferences(images, at, attach, apply);
    },
    [apply, userRoot, toast, port],
  );
  // 粘贴进来的图片（#96）：超限的当场提示、不发请求；显示名按「粘贴-年月日-时分」算，一次粘多张仍算一个撤销步。
  const pasteImages = useCallback(
    (files: File[], at: { x: number; y: number }) =>
      void importPastedImages(files, at, { board: boardRef.current, userRoot, toast, ports: imageImportPorts(port), apply }),
    [apply, userRoot, toast, port],
  );

  const center = handlers.centerPosition;
  // 新建类动作：at = 节点左上角的画布坐标（上下文菜单的点击处）；缺省 = 视口中央（工具栏）。
  const addPrompt = useCallback((at = center()) => void apply({ kind: "newPrompt", at: posOf(at) }), [apply, center]);
  /** promptId = 从该提示词拖出（拖线建节点），接新任务的正向端口，与建节点同一步。 */
  const addTask = useCallback((at = center(), promptId?: string) => void apply({ kind: "newTask", at: posOf(at), promptId: promptId ?? null }), [apply, center]);
  /** attachTo = 任务节点 id：只选一张，接到该任务的空图片端口（从图片端口反向拖线建节点）。 */
  const pickReferences = useCallback(
    (at?: { x: number; y: number }, attachTo?: string) =>
      void pickReferencesOf({ pickImages: (multiple) => port.media.pickImages(multiple), importFiles: importLocalFiles, centerPosition: center }, at, attachTo).catch((e) => {
        // 端口说这项能力还没有（桌面壳本切片没有文件选择器）：说清「尚不可用」，不冒成未捕获异常。
        toast(unavailableMessage(e) ?? `选择参考图失败：${errorText(e)}`);
      }),
    [center, importLocalFiles, port, toast],
  );
  const saveNodeAs = useCallback(
    (nodeId: string) =>
      saveNodeAsOf(nodeId, { board: boardRef.current, userRoot, toast, save: (absPath) => port.media.saveCopyAs(absPath) }).catch((e) => {
        // 同上：另存为在桌面壳本切片还没有，说清「尚不可用」。
        toast(unavailableMessage(e) ?? `另存失败：${errorText(e)}`);
      }),
    [userRoot, toast, port],
  );

  const commandDeps: CanvasCommandDeps = {
    apply, flow, selectedRef, lockedRef, actions, onUndo, onRedo, onRun, onCancelTask, onRegenerate, onViewSendText,
    addPrompt, addTask, pickReferences, saveNodeAs, toast, readOnly,
    toggleExpand: (nodeId) => setExpandOverrides((o) => toggleExpanded(o, selectedRef.current, nodeId)),
  };
  const commands = canvasCommands(commandDeps);
  performRef.current = (action, target, at) => commands[action]?.(target, at);
  performDragCreateRef.current = canvasDragCreate(commandDeps);

  // 键盘菜单与右键空白菜单共用同一目标与落点判定；焦点先落在画布，关菜单后由菜单返还。
  const openKeyboardMenu = useCallback(
    (client: { x: number; y: number }) => overlays.openMenu({ clientX: client.x, clientY: client.y, preventDefault: () => undefined }, { kind: "pane" }),
    [overlays.openMenu],
  );
  useBoardKeyboard({ wrapper, boardRef, selectedRef, dialogOpen: overlays.dialogOpenRef, onUndo, onRedo, onOpenMenu: openKeyboardMenu, toast, port });
  useCanvasDrop({ wrapper, boardRef, screenToFlowPosition: (client) => flow.screenToFlowPosition(client), apply, toast, userRoot, readOnly, port });
  // 页面级粘贴接管（#96）：分派在 core/pageInput（纯逻辑），这里只把落点、模态与图片导入接上。
  useCanvasPaste({
    wrapper,
    dialogOpen: overlays.dialogOpenRef,
    modalOpen,
    readOnly,
    screenToFlowPosition: (client) => flow.screenToFlowPosition(client),
    centerPosition: center,
    apply,
    toast,
    importPastedImages: pasteImages,
    isEditableTarget: port.ui.isEditableTarget,
    readClipboard: port.media.readClipboard,
  });
  useEffect(() => handlers.focusNode(focus), [focus]);

  const menuView = menuViewFor(readOnly);
  const canvasTheme = canvasThemeProps(theme);

  return (
    <BoardContext.Provider value={actions}>
      <HoverProvider value={hover.controller}>
        <DragContext.Provider value={drag}>
          {/* 画布内屏蔽 WebView 默认右键菜单；可编辑元素保留原生菜单（复制粘贴）。 */}
          <div
            className={canvasClassName(dragging)}
            ref={wrapper}
            tabIndex={-1}
            onContextMenu={(e) => blockNativeContextMenu(port.ui.isEditableTarget, e)}
            onPointerDownCapture={nav.onPointerDownCapture}
            onPointerUpCapture={nav.onPointerUpCapture}
          >
            <CanvasToolbar
              toolbarSlot={toolbarSlot}
              readOnly={readOnly}
              onUndo={onUndo}
              onRedo={onRedo}
              undoLabel={undoLabel}
              redoLabel={redoLabel}
              selectedCount={selectedNodes.size}
              onRun={() => onRun([...selectedNodes])}
            />
            <ReactFlow
              {...nav.flowProps}
              colorMode={canvasTheme.colorMode}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              proOptions={{ hideAttribution: true }}
              // 只渲染视口内的节点与连线：DOM、布局与解码开销随视口而不随画板总量（#66）。依赖 measured 的回传。
              onlyRenderVisibleElements
              deleteKeyCode={deleteKeyCodeFor(overlays.dialogOpen, readOnly)}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              defaultViewport={board.viewport}
              isValidConnection={isValidConnection}
              connectionLineStyle={connectionLineStyle(board, drag)}
              onNodesChange={handlers.onNodesChange}
              onEdgesChange={handlers.onEdgesChange}
              onConnect={handlers.onConnect}
              onConnectEnd={handlers.onConnectEnd}
              onBeforeDelete={handlers.onBeforeDelete}
              onDelete={handlers.onDelete}
              onMoveEnd={handlers.onMoveEnd}
              onNodeDragStart={handlers.onNodeDragStart}
              onNodeDragStop={handlers.onNodeDragStop}
              onSelectionDragStart={handlers.onNodeDragStart}
              onSelectionDragStop={handlers.onNodeDragStop}
              onMoveStart={overlays.onMoveStart}
              onPaneContextMenu={(e) => openPaneContextMenu(overlays.openMenu, e)}
              onNodeContextMenu={(e, n) => openNodeContextMenu(overlays.openMenu, port.ui.isEditableTarget, e, n.id)}
              onSelectionContextMenu={(e, ns) => openSelectionContextMenu(overlays.openMenu, e, ns)}
              onEdgeContextMenu={(e, fe) => openEdgeMenu(overlays.openMenu, board, e, fe.id)}
              onEdgeMouseMove={(e, fe) => edgeHoverMove(e, fe, hover.controller)}
              onEdgeMouseLeave={(_, fe) => hover.controller.leave(`edge:${fe.id}`)}
              minZoom={0.1}
            >
              <Background {...canvasTheme.background} />
              <Controls />
              <MiniMap {...canvasTheme.minimap} />
            </ReactFlow>
            <CanvasOverlays
              menu={overlays.menu}
              menuEntries={menuEntriesOf(overlays.menu, menuFacts, selectedNodes, menuView)}
              onPickMenu={(action) => pickMenuAction(action, overlays.menu, commands)}
              onCloseMenu={overlays.closeMenu}
              preview={overlays.preview}
              onClosePreview={overlays.closePreview}
              toast={toast}
              hoverLayer={hover.layer}
            />
          </div>
        </DragContext.Provider>
      </HoverProvider>
    </BoardContext.Provider>
  );
}

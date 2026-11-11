// 画板动作的分派表：上下文菜单、悬浮动作条、节点按钮与拖线建节点共用一套 BoardAction 语义。
// 原来这些判定堆在 BoardCanvas 的 performAction 里；这里给每个动作一个模块顶层的小函数，画布侧只查表调用。
// 只读画板的前置（readOnly && !isReadOnlyAction(action) → ARCHIVE_TEXT.readOnly）留在查表层 guard() 里：
// 每个动作入口都先过这一层，顺序与今天的 performAction 首行逐字一致。
import type { Board, BoardEdge } from "../core/board";
import { isReadOnlyAction } from "../core/archive";
import { selectionForMenu, type BoardAction, type MenuTarget } from "../core/contextMenu";
import type { BoardChange } from "../core/edit";
import { LOCKED_HINT } from "../core/iterate";
import type { DragFrom } from "../core/ports";
import { finalToggle } from "../core/stages";
import { ARCHIVE_TEXT } from "./boardText";
import { edgeIdOf } from "./canvasPoint";
import type { BoardActions } from "./context";

/** 一个画板动作：target = 右键 / 悬浮动作条指向的对象，at = 新建类动作的落点（画布坐标，缺省 = 视口中央）。 */
type CanvasCommand = (target: MenuTarget, at?: { x: number; y: number }) => void;

/** 以 action 查表：画布不处理的动作（标签页上的导出 / 下载 / 导入画板包）为 undefined。 */
type CanvasCommandTable = Readonly<Record<BoardAction, CanvasCommand | undefined>>;

/** 一个动作的实现：由 deps 生成，决策点计入本函数。 */
type CommandFactory = (deps: CanvasCommandDeps) => CanvasCommand;

/**
 * 执行画板动作需要的一切：原来 performAction 从组件闭包里取的东西，这里全部显式注入。
 * 全部写成回调 / ref，画布侧改动这些值时不需要重建查表。
 */
export interface CanvasCommandDeps {
  /** 画板写入的唯一入口（见 core/edit）：被拒或需告知时提示原因。 */
  apply: (change: BoardChange) => unknown;
  /** 删除节点 / 断开连线走 React Flow 的删除流程（与 Delete 键同一套规则）。 */
  flow: { deleteElements: (params: { nodes?: { id: string }[]; edges?: { id: string }[] }) => Promise<unknown> };
  /** 当前画板：取结果节点两态（finalToggle）用。 */
  boardRef: { readonly current: Board };
  /** 当前选区：作用于整个选区的动作（删除、建阶段、定稿）用。 */
  selectedRef: { readonly current: ReadonlySet<string> };
  /** 排队 / 执行中的任务节点：拖线建节点的「加为参考图」据此拒绝。 */
  lockedRef: { readonly current: ReadonlySet<string> };
  /** 节点上已有的迭代动作（放大预览、继续编辑、加为参考图、生成变体、框选修改区域）。 */
  actions: BoardActions;
  onUndo: () => void;
  onRedo: () => void;
  /** 点「运行」：传当前选中的节点 id。 */
  onRun: (selectedIds: string[]) => void;
  onCancelTask: (taskId: string) => void;
  onRegenerate: (taskId: string) => void;
  /** 任务节点「查看发送文本」。 */
  onViewSendText: (taskId: string) => void;
  /** 新建类动作：at = 节点左上角的画布坐标，缺省 = 视口中央（工具栏）。 */
  addPrompt: (at?: { x: number; y: number }) => void;
  /** promptId = 从该提示词拖出（拖线建节点），接新任务的正向端口。 */
  addTask: (at?: { x: number; y: number }, promptId?: string) => void;
  /** attachTo = 任务节点 id：只选一张，接到该任务的空图片端口。 */
  pickReferences: (at?: { x: number; y: number }, attachTo?: string) => void;
  saveNodeAs: (nodeId: string) => void | Promise<void>;
  /** 把选区节点建为阶段（新阶段标题进入改名）。 */
  newStage: (ids: string[]) => void;
  /** 任务节点参数的原地展开切换：画布侧 = setExpandOverrides((o) => toggleExpanded(o, selectedRef.current, nodeId))。 */
  toggleExpand: (nodeId: string) => void;
  toast: (message: string) => void;
  /** 归档画板（#90）：只读，菜单只剩查看与下载；缺省 = 可编辑。 */
  readOnly?: boolean;
}

/** 只读前置：归档画板只放行查看类动作，其余提示只读（原 performAction 的首行）。 */
function guard(deps: CanvasCommandDeps, action: BoardAction, run: CanvasCommand): CanvasCommand {
  return (target, at) => {
    if (deps.readOnly && !isReadOnlyAction(action)) {
      deps.toast(ARCHIVE_TEXT.readOnly);
      return;
    }
    run(target, at);
  };
}

/** 只对节点目标生效的动作：菜单指向空白处或连线时不做。 */
function onNode(deps: CanvasCommandDeps, act: (deps: CanvasCommandDeps, id: string) => void): CanvasCommand {
  return (target) => {
    if (target.kind !== "node") return;
    act(deps, target.nodeId);
  };
}

/** 作用于整个选区的节点动作：右键落在未选中节点上时选区就是该节点。 */
function onSelection(deps: CanvasCommandDeps, act: (deps: CanvasCommandDeps, ids: string[]) => void): CanvasCommand {
  return (target) => {
    if (target.kind !== "node") return;
    act(deps, [...selectionForMenu(deps.selectedRef.current, target.nodeId)]);
  };
}

/** 只对连线目标生效的动作。 */
function onEdge(deps: CanvasCommandDeps, act: (deps: CanvasCommandDeps, edge: BoardEdge) => void): CanvasCommand {
  return (target) => {
    if (target.kind !== "edge") return;
    act(deps, target.edge);
  };
}

/** 标记 / 取消定稿：选区里没有结果节点时无可切换（菜单也不会给这一项）。 */
function applyFinalToggle(deps: CanvasCommandDeps, ids: string[]): void {
  const toggle = finalToggle(deps.boardRef.current, ids);
  if (!toggle) return;
  void deps.apply({ kind: "setFinal", ...toggle });
}

const newPromptCommand: CommandFactory = (deps) => (_target, at) => deps.addPrompt(at);
const newTaskCommand: CommandFactory = (deps) => (_target, at) => deps.addTask(at);
const addReferencesCommand: CommandFactory = (deps) => (_target, at) => void deps.pickReferences(at);
const undoCommand: CommandFactory = (deps) => () => deps.onUndo();
const redoCommand: CommandFactory = (deps) => () => deps.onRedo();

const previewCommand: CommandFactory = (deps) => onNode(deps, (d, id) => d.actions.previewNode(id));
const saveAsCommand: CommandFactory = (deps) => onNode(deps, (d, id) => void d.saveNodeAs(id));
const continueEditingCommand: CommandFactory = (deps) => onNode(deps, (d, id) => d.actions.continueEditing(id));
const addAsReferenceCommand: CommandFactory = (deps) => onNode(deps, (d, id) => d.actions.addAsReference(id));
const generateVariantCommand: CommandFactory = (deps) => onNode(deps, (d, id) => d.actions.generateVariant(id));
const runCommand: CommandFactory = (deps) => onNode(deps, (d, id) => d.onRun([id]));
const cancelCommand: CommandFactory = (deps) => onNode(deps, (d, id) => d.onCancelTask(id));
const regenerateCommand: CommandFactory = (deps) => onNode(deps, (d, id) => d.onRegenerate(id));
const viewSendTextCommand: CommandFactory = (deps) => onNode(deps, (d, id) => d.onViewSendText(id));
const toggleSettingsCommand: CommandFactory = (deps) => onNode(deps, (d, id) => d.toggleExpand(id));

// 删除、断开都走 React Flow 的删除流程：删除 / 断开的规则（锁定确认、系统连线）与 Delete 键同一套。
const deleteCommand: CommandFactory = (deps) => onSelection(deps, (d, ids) => void d.flow.deleteElements({ nodes: ids.map((id) => ({ id })) }));
const newStageCommand: CommandFactory = (deps) => onSelection(deps, (d, ids) => d.newStage(ids));
const removeFromStageCommand: CommandFactory = (deps) => onSelection(deps, (d, ids) => void d.apply({ kind: "removeFromStage", nodes: ids }));
const toggleFinalCommand: CommandFactory = (deps) => onSelection(deps, (d, ids) => applyFinalToggle(d, ids));

const disconnectCommand: CommandFactory = (deps) => onEdge(deps, (d, edge) => void d.flow.deleteElements({ edges: [{ id: edgeIdOf(edge) }] }));
const editRegionCommand: CommandFactory = (deps) => onEdge(deps, (d, edge) => d.actions.editRegion(edge.to[0], { from: edge.from, to: edge.to }));

/**
 * 按 action 执行：与工具栏 / 节点按钮同一套逻辑（删除、断开走 React Flow 删除流程，规则同 Delete 键）。
 * 画布侧只做 commands[action]?.(target, at)；只读前置也在查表这一层（guard），任何入口都绕不过，
 * 所以归档画板上只有放大预览与另存为会执行。
 */
export function canvasCommands(deps: CanvasCommandDeps): CanvasCommandTable {
  /** 查表项：绑定 deps 并套上只读前置。 */
  const entry = (action: BoardAction, make: CommandFactory) => guard(deps, action, make(deps));
  return {
    newPrompt: entry("newPrompt", newPromptCommand),
    newTask: entry("newTask", newTaskCommand),
    addReferences: entry("addReferences", addReferencesCommand),
    undo: entry("undo", undoCommand),
    redo: entry("redo", redoCommand),
    preview: entry("preview", previewCommand),
    saveAs: entry("saveAs", saveAsCommand),
    continueEditing: entry("continueEditing", continueEditingCommand),
    addAsReference: entry("addAsReference", addAsReferenceCommand),
    generateVariant: entry("generateVariant", generateVariantCommand),
    delete: entry("delete", deleteCommand),
    run: entry("run", runCommand),
    cancel: entry("cancel", cancelCommand),
    regenerate: entry("regenerate", regenerateCommand),
    toggleSettings: entry("toggleSettings", toggleSettingsCommand),
    viewSendText: entry("viewSendText", viewSendTextCommand),
    disconnect: entry("disconnect", disconnectCommand),
    editRegion: entry("editRegion", editRegionCommand),
    newStage: entry("newStage", newStageCommand),
    removeFromStage: entry("removeFromStage", removeFromStageCommand),
    toggleFinal: entry("toggleFinal", toggleFinalCommand),
    // 导出画板包 / 整板下载结果 / 导入画板包属于标签页，画布不处理（与今天的 performAction 一致）。
    exportPack: undefined,
    downloadResults: undefined,
    importPack: undefined,
  };
}

/** 拖线建节点的一项：from = 拖线起点，at = 松手处的画布坐标。 */
type DragCreateCommand = (from: DragFrom, at: { x: number; y: number }) => void;

/** 拖线建节点的实现：由 deps 生成，决策点计入本函数。 */
type DragCreateFactory = (deps: CanvasCommandDeps) => DragCreateCommand;

const dragContinueEditing: DragCreateFactory = (deps) => (from, at) => deps.actions.continueEditing(from.nodeId, null, at);
const dragNewTask: DragCreateFactory = (deps) => (from, at) => deps.addTask(at, from.nodeId);
// 从任务节点的图片端口反向拖线：只接一张，接到该端口；锁定的任务不接。
const dragAddReferences: DragCreateFactory = (deps) => (from, at) => {
  if (deps.lockedRef.current.has(from.nodeId)) {
    deps.toast(LOCKED_HINT);
    return;
  }
  void deps.pickReferences(at, from.nodeId);
};

/**
 * 拖线建节点：at = 松手处的画布坐标，新节点左上角落在这里。
 * 这里不套只读前置：只读画板不能连线，拖不出这个流程（照原 performDragCreateRef）。
 */
export function canvasDragCreate(deps: CanvasCommandDeps): (action: BoardAction, from: DragFrom, at: { x: number; y: number }) => void {
  const table: Partial<Record<BoardAction, DragCreateCommand>> = {
    continueEditing: dragContinueEditing(deps),
    newTask: dragNewTask(deps),
    addReferences: dragAddReferences(deps),
  };
  return (action, from, at) => table[action]?.(from, at);
}

// 画布的顶部工具栏：经 portal 渲染进页面第二行左侧的槽位——画板工具栏 + 新建生成任务用的模型下拉。
// 只接状态与回调；槽位为空（页面还没给出容器）时不渲染。归档画板给一整块置灰的工具栏，没有模型下拉。
import type { Board } from "../core/board";
import type { CapabilityTable, ModelCapability } from "../core/capabilities";
import type { BoardChange } from "../core/edit";
import { defaultTaskModel, type Discovery } from "../core/settings";
import { createPortal } from "react-dom";
import { BoardToolbar } from "./BoardToolbar";
import { FLASH_UNAVAILABLE_TEXT } from "./boardText";
import { ModelOptions } from "./nodes";

export interface CanvasToolbarProps {
  /** 顶部第二行左侧的工具栏容器：画布把工具栏 portal 进去；null = 页面没有这个槽位（不渲染）。 */
  toolbarSlot: HTMLElement | null;
  /** 归档画板：工具栏整块置灰，不接新建类动作。 */
  readOnly: boolean;
  /** 画板：新建任务用的模型取它的上次选择（board.last_model）。 */
  board: Board;
  table: CapabilityTable;
  discovery: Discovery;
  /** 模型下拉的可选项：网关发现 ∩ 上架清单（见 core/settings 的 availableModels）。 */
  availableModels: ModelCapability[];
  /** 画板写入的唯一入口（见 core/edit）：换新建任务模型走 { kind: "lastModel" }。 */
  apply: (change: BoardChange) => void;
  onNewPrompt: () => void;
  onAddReferences: () => void;
  onNewTask: () => void;
  onUndo: () => void;
  onRedo: () => void;
  undoLabel: string | null;
  redoLabel: string | null;
  /** 当前选中节点数：> 0 时运行按钮写「运行选中」。 */
  selectedCount: number;
  onRun: () => void;
  /** 是否在整理模式：工具栏按钮按下态。 */
  tidying: boolean;
  /** 进入 / 退出整理模式。 */
  onTidyChange: (tidying: boolean) => void;
}

export function CanvasToolbar(props: CanvasToolbarProps) {
  if (!props.toolbarSlot) return null;
  return createPortal(<ToolbarBody {...props} />, props.toolbarSlot);
}

/** 工具栏本体：归档画板只给置灰的一整块（连模型下拉都没有，BoardToolbar 自己补占位）。 */
function ToolbarBody(props: CanvasToolbarProps) {
  if (props.readOnly) return <BoardToolbar disabled />;
  return (
    <BoardToolbar
      modelSelect={
        <ToolbarModelSelect table={props.table} discovery={props.discovery} lastModel={props.board.last_model} available={props.availableModels} apply={props.apply} />
      }
      onNewPrompt={props.onNewPrompt}
      onAddReferences={props.onAddReferences}
      onNewTask={props.onNewTask}
      onUndo={props.onUndo}
      onRedo={props.onRedo}
      undoLabel={props.undoLabel}
      redoLabel={props.redoLabel}
      selectedCount={props.selectedCount}
      onRun={props.onRun}
      tidying={props.tidying}
      onTidy={() => props.onTidyChange(!props.tidying)}
    />
  );
}

/** 新建生成任务用的模型（board.last_model）：是偏好不是画板编辑，不进撤销。 */
function ToolbarModelSelect({ table, discovery, lastModel, available, apply }: { table: CapabilityTable; discovery: Discovery; lastModel: string | null | undefined; available: ModelCapability[]; apply: (change: BoardChange) => void }) {
  const toolbarModel = defaultTaskModel(table, discovery, lastModel);
  return (
    <select
      className="toolbar-model"
      value={toolbarModel ?? ""}
      onChange={(e) => apply({ kind: "lastModel", model: e.target.value })}
      aria-label="新建任务模型"
    >
      <MissingModelOption model={toolbarModel} available={available} />
      <ModelOptions table={table} available={available} />
    </select>
  );
}

/** 默认模型（Flash）不在可用列表时补一个置灰占位项，免得下拉显示成空白。 */
function MissingModelOption({ model, available }: { model: string | null; available: ModelCapability[] }) {
  if (available.some((m) => m.model_id === model)) return null;
  return (
    <option disabled value={model ?? ""}>
      {FLASH_UNAVAILABLE_TEXT}
    </option>
  );
}

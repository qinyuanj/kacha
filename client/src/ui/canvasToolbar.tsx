// 画布的顶部工具栏：经 portal 渲染进页面第二行左侧的槽位——只有撤销 / 重做 / 运行。
// 只接状态与回调；槽位为空（页面还没给出容器）时不渲染。归档画板复用同一份置灰工具栏。
import { createPortal } from "react-dom";
import { BoardToolbar } from "./BoardToolbar";
import { useShell } from "./shell";

export interface CanvasToolbarProps {
  /** 顶部第二行左侧的工具栏容器：画布把工具栏 portal 进去；null = 页面没有这个槽位（不渲染）。 */
  toolbarSlot: HTMLElement | null;
  /** 归档画板：工具栏置灰，不接动作。 */
  readOnly: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** 当前选中节点数：> 0 时运行按钮写「运行选中」。 */
  selectedCount: number;
  onUndo: () => void;
  onRedo: () => void;
  onRun: () => void;
}

export function CanvasToolbar(props: CanvasToolbarProps) {
  if (!props.toolbarSlot) return null;
  return createPortal(<ToolbarBody {...props} />, props.toolbarSlot);
}

function ToolbarBody(props: CanvasToolbarProps) {
  const port = useShell();
  // 运行能力按端口开关说话；新建按钮已移走，这里的开关不再影响别的入口。
  const generationOff = !port.features.generation;
  return (
    <BoardToolbar
      disabled={props.readOnly}
      onUndo={props.onUndo}
      onRedo={props.onRedo}
      undoLabel={props.undoLabel}
      redoLabel={props.redoLabel}
      selectedCount={props.selectedCount}
      onRun={props.onRun}
      generationUnavailable={generationOff}
    />
  );
}

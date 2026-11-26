// 画板工具栏（顶部第二行左侧）：撤销 / 重做、运行。只负责摆放与置灰；
// 有画板时由画布经 portal 渲染并接上动作，没有画板时由 App 渲染同一份置灰工具栏（布局不跳）。
// 新建节点继续走右键、拖线、粘贴与文件拖入；文案与提示在 ui/boardToolbarText.ts。
import { textHoverInfo } from "../core/hoverInfo";
import { HoverButton } from "./hoverInfo";
import { redoHint, runHint, runSuffix, toolbarHint, undoHint } from "./boardToolbarText";

interface Props {
  /** 没有打开的画板 / 归档画板：三个入口一起置灰。 */
  disabled?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  undoLabel?: string | null;
  redoLabel?: string | null;
  /** 当前选中节点数：> 0 时运行按钮写「运行选中」。 */
  selectedCount?: number;
  onRun?: () => void;
  /** 生成尚不可用：只影响运行按钮。 */
  generationUnavailable?: boolean;
}

export function BoardToolbar({
  disabled = false,
  onUndo,
  onRedo,
  undoLabel = null,
  redoLabel = null,
  selectedCount = 0,
  onRun,
  generationUnavailable = false,
}: Props) {
  const hint = (text: string) => textHoverInfo(toolbarHint(disabled, text));
  return (
    <div className="board-toolbar-left" role="toolbar" aria-label="画板工具栏">
      <div className="toolbar-group">
        <HoverButton className="toolbar-icon" onClick={onUndo} disabled={disabled || !undoLabel} info={hint(undoHint(undoLabel))} aria-label="撤销">
          ↶
        </HoverButton>
        <HoverButton className="toolbar-icon" onClick={onRedo} disabled={disabled || !redoLabel} info={hint(redoHint(redoLabel))} aria-label="重做">
          ↷
        </HoverButton>
      </div>
      <div className="toolbar-group">
        <HoverButton
          className="primary"
          disabled={disabled || generationUnavailable}
          onClick={onRun}
          info={hint(runHint(generationUnavailable))}
        >
          ▶ 运行{runSuffix(selectedCount, generationUnavailable)}
        </HoverButton>
      </div>
    </div>
  );
}

// 画板工具栏（顶部第二行左侧）：新建节点、撤销 / 重做、运行。只负责摆放与置灰；
// 有画板时由画布经 portal 渲染并接上动作，没有画板时由 App 渲染置灰占位（布局不跳）。
import type { ReactNode } from "react";
import { textHoverInfo } from "../core/hoverInfo";
import { HoverButton } from "./hoverInfo";
import { PASTE_TEXT, TIDY_TEXT } from "./boardText";

interface Props {
  /** 没有打开的画板：全部置灰。 */
  disabled?: boolean;
  /** 新建生成任务用的模型下拉；没有画板时为空。 */
  modelSelect?: ReactNode;
  onNewPrompt?: () => void;
  onAddReferences?: () => void;
  onNewTask?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  undoLabel?: string | null;
  redoLabel?: string | null;
  /** 当前选中节点数：> 0 时运行按钮写「运行选中」。 */
  selectedCount?: number;
  onRun?: () => void;
  /** 生成尚不可用：运行与新建任务入口标「尚不可用」并置灰。 */
  generationUnavailable?: boolean;
  /** 是否在整理模式；按钮按下态。 */
  tidying?: boolean;
  /** 整理尚不可用：整理入口标「尚不可用」并置灰。 */
  tidyUnavailable?: boolean;
  /** 进入 / 退出整理模式。 */
  onTidy?: () => void;
}

const NO_BOARD = "没有打开的画板";

/** 本切片还没做的能力：入口标「尚不可用」，不假装能点（#127）。 */
const UNAVAILABLE_TEXT = "尚不可用";

export function BoardToolbar({
  disabled = false,
  modelSelect,
  onNewPrompt,
  onAddReferences,
  onNewTask,
  onUndo,
  onRedo,
  undoLabel = null,
  redoLabel = null,
  selectedCount = 0,
  onRun,
  generationUnavailable = false,
  tidying = false,
  tidyUnavailable = false,
  onTidy,
}: Props) {
  const hint = (text: string) => textHoverInfo(disabled ? NO_BOARD : text);
  return (
    <div className="board-toolbar-left" role="toolbar" aria-label="画板工具栏">
      <div className="toolbar-group">
        <HoverButton disabled={disabled} onClick={onNewPrompt} info={hint("在视口中央新建一个提示词节点")}>
          ＋ 提示词
        </HoverButton>
        <HoverButton disabled={disabled} onClick={onAddReferences} info={hint(PASTE_TEXT.toolbarHint)}>
          ＋ 参考图…
        </HoverButton>
        <span className="toolbar-pair">
          <HoverButton
            disabled={disabled || generationUnavailable}
            onClick={onNewTask}
            info={hint(generationUnavailable ? "生成尚不可用" : "用右侧模型在视口中央新建一个生成任务节点")}
          >
            ＋ 生成任务{generationUnavailable ? "（" + UNAVAILABLE_TEXT + "）" : ""}
          </HoverButton>
          {modelSelect ?? <select className="toolbar-model" disabled aria-label="新建任务模型" />}
        </span>
      </div>
      <div className="toolbar-group">
        <HoverButton onClick={onUndo} disabled={disabled || !undoLabel} info={hint(undoLabel ? `撤销 ${undoLabel}（Ctrl+Z）` : "没有可撤销的操作")} aria-label="撤销">
          ↶
        </HoverButton>
        <HoverButton onClick={onRedo} disabled={disabled || !redoLabel} info={hint(redoLabel ? `重做 ${redoLabel}（Ctrl+Shift+Z）` : "没有可重做的操作")} aria-label="重做">
          ↷
        </HoverButton>
      </div>
      <div className="toolbar-group">
        <HoverButton
          className="primary"
          disabled={disabled || generationUnavailable}
          onClick={onRun}
          info={hint(generationUnavailable ? "生成尚不可用" : "有选中时只运行选中子图，否则运行整个画板中需要运行的任务")}
        >
          ▶ 运行{selectedCount > 0 ? "选中" : ""}
          {generationUnavailable ? "（" + UNAVAILABLE_TEXT + "）" : ""}
        </HoverButton>
      </div>
      <div className="toolbar-group">
        <HoverButton
          className={tidying ? "toolbar-tidy active" : "toolbar-tidy"}
          disabled={disabled || tidyUnavailable}
          onClick={onTidy}
          aria-pressed={tidying}
          info={hint(tidyUnavailable ? "整理尚不可用" : tidying ? "退出整理模式" : "整理模式：看各阶段体量，收掉未定稿的结果")}
        >
          {TIDY_TEXT.enter}
          {tidyUnavailable ? "（" + UNAVAILABLE_TEXT + "）" : ""}
        </HoverButton>
      </div>
    </div>
  );
}

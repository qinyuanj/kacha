// 整理模式（#92）：画布的一种界面状态，不是弹窗。进入后按任务目录量画板（服务端，口径与画板体量一致），
// 顶部显示整理前后的体量对比、「自动划分阶段」与「完成」；阶段框上显示各阶段体量与「收掉未定稿」（见 stages.tsx）。
// 进入整理模式不写画板：自动划分阶段是整理条上的按钮，点了才写（#143）。其它编辑照常可用。
import { useEffect, useRef, useState } from "react";
import { TidyMeter } from "../core/tidyMeter";
import { autoStageGroups } from "../core/autoStages";
import { serializeBoard, type Board } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { boardBytes, type BoardMeasure } from "../core/tidy";
import { TIDY_TEXT } from "./boardText";
import { useShell } from "./shell";

/** 节点变化后等这么久再量：连续拖动只量一次。 */
const REMEASURE_DELAY_MS = 800;

export interface TidyMeasure {
  /** 最近一次的度量；还没量到或量不了为 null。 */
  measure: BoardMeasure | null;
  /** 进入整理模式时的画板体量。 */
  before: number | null;
}

/** 整理模式期间量当前画板（含未保存的改动）；只看节点，平移缩放不重量。退出即清空。 */
export function useTidyMeasure(board: Board, tidying: boolean): TidyMeasure {
  const port = useShell();
  const [state, setState] = useState<TidyMeasure>({ measure: null, before: null });
  const meter = useRef<TidyMeter | null>(null);
  const boardRef = useRef(board);
  boardRef.current = board;
  useEffect(() => {
    if (!tidying) {
      setState({ measure: null, before: null });
      return;
    }
    const active = new TidyMeter(serializeBoard(boardRef.current), port.board.measure, setState);
    meter.current = active;
    active.update(serializeBoard(boardRef.current));
    return () => { active.dispose(); meter.current = null; };
  }, [tidying]);
  useEffect(() => {
    if (!tidying) return;
    const text = serializeBoard(boardRef.current);
    const timer = setTimeout(() => meter.current?.update(text), REMEASURE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [board.nodes, tidying]);
  return state;
}

/** 整理条：前后体量对比、自动划分阶段（#143）与「完成」。 */
export function TidyBar({
  measure,
  before,
  board,
  readOnly,
  apply,
  onDone,
}: TidyMeasure & { board: Board; readOnly: boolean; apply: (change: BoardChange) => EditResult | null; onDone: () => void }) {
  // 会建几个阶段按当前画板现算；算不出与体量量不到是两回事，按钮照样可用。
  const stages = autoStageGroups(board).length;
  return (
    <div className="tidy-bar" role="status" aria-label="整理模式">
      <span>{measure && before !== null ? TIDY_TEXT.compare(before, boardBytes(measure)) : TIDY_TEXT.measuring}</span>
      <button
        type="button"
        className="auto-stages"
        disabled={readOnly || stages === 0}
        title={stages === 0 ? TIDY_TEXT.autoStagesEmpty : undefined}
        onClick={() => apply({ kind: "autoStages" })}
      >
        {TIDY_TEXT.autoStages(stages)}
      </button>
      <button className="primary" onClick={onDone}>
        {TIDY_TEXT.done}
      </button>
    </div>
  );
}

// 阶段框与整理模式（#92、#93）的画布侧接线：收起成员、阶段框尺寸、各阶段体量与「移出为新画板」。
// 判定与体量计算都在 core/stages 与 core/tidy，这里只接状态与写入口。
import { useMemo, useState } from "react";
import type { Board } from "../core/board";
import { stagesOf } from "../core/board";
import { errorText } from "../core/errors";
import { collapsedMembers, stageBoxes, suggestKeep, type StageBox } from "../core/stages";
import { nodesBytes } from "../core/tidy";
import { TIDY_TEXT } from "./boardText";
import type { StageTidy } from "./stages";
import { useTidyMeasure, type TidyMeasure } from "./tidy";

/** 不在整理模式时没有建议保留：共用同一个空集，省得每次渲染都新建。 */
const NO_SUGGESTIONS: ReadonlySet<string> = new Set();

interface StageTidyOptions {
  board: Board;
  tidying: boolean;
  tidyMeasure: TidyMeasure;
  toast: (message: string) => void;
  onMoveOutStage: (stageId: string) => Promise<string>;
}

/** 整理模式下阶段框多出的内容：各阶段体量与移出为新画板。不在整理模式为 null。 */
export function useStageTidy({ board, tidying, tidyMeasure, toast, onMoveOutStage }: StageTidyOptions): StageTidy | null {
  const [movingOut, setMovingOut] = useState(false);
  return useMemo((): StageTidy | null => {
    if (!tidying) return null;
    const { measure } = tidyMeasure;
    const stageNodes = (id: string) => stagesOf(board).find((s) => s.id === id)?.nodes ?? [];
    return {
      bytes: (id) => (measure ? nodesBytes(measure, stageNodes(id)) : null),
      sizeFailed: tidyMeasure.failed === true,
      movingOut,
      onMoveOut: (id) => {
        setMovingOut(true);
        void onMoveOutStage(id)
          .then(toast, (e) => toast(TIDY_TEXT.moveOutFailed(errorText(e))))
          .finally(() => setMovingOut(false));
      },
    };
  }, [tidying, tidyMeasure, board, toast, movingOut, onMoveOutStage]);
}

interface Options {
  board: Board;
  readOnly: boolean;
  measured: Record<string, { width?: number; height?: number }>;
  tidying: boolean;
  toast: (message: string) => void;
  onMoveOutStage: (stageId: string) => Promise<string>;
}

export interface CanvasStageView {
  /** 收起的阶段的成员节点：React Flow 里连同其连线一起隐藏。 */
  hidden: ReadonlySet<string>;
  /** 阶段框：按成员的显示尺寸画。 */
  boxes: StageBox[];
  /** 整理模式的度量（整理前后体量对比，顶部整理条用）。 */
  tidyMeasure: TidyMeasure;
  /** 整理模式下的阶段框附加内容；不在整理模式为 null。 */
  stageTidy: StageTidy | null;
  /** 建议保留的结果：只在整理模式里有，退出整理模式即消失（不写画板、不进撤销步）。 */
  suggestKeep: ReadonlySet<string>;
}

export function useCanvasStageView({ board, readOnly, measured, tidying, toast, onMoveOutStage }: Options): CanvasStageView {
  // 阶段：收起的成员不显示；框按成员的显示尺寸画。
  const hidden = useMemo(() => collapsedMembers(board, readOnly), [board, readOnly]);
  const boxes = useMemo(() => stageBoxes(board, (id) => measured[id], readOnly), [board, measured, readOnly]);
  // 整理模式：各阶段体量（按任务目录，本机存储量）。
  const tidyMeasure = useTidyMeasure(board, tidying);
  // 建议保留（#144）：渲染时现算，退出整理模式即空集——不写画板、不进撤销步，因此不参与脏判据。
  const suggested = useMemo(() => (tidying ? suggestKeep(board) : NO_SUGGESTIONS), [board, tidying]);
  const stageTidy = useStageTidy({ board, tidying, tidyMeasure, toast, onMoveOutStage });
  return { hidden, boxes, tidyMeasure, stageTidy, suggestKeep: suggested };
}

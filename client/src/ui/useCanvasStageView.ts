// 阶段框与整理模式（#92、#93）的画布侧接线：收起成员、阶段框尺寸、改名入口、各阶段体量与
// 「收掉未定稿 / 移出为新画板」。判定与体量计算都在 core/stages 与 core/tidy，这里只接状态与写入口。
import { useMemo, useState, type MutableRefObject } from "react";
import type { Board } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { stagesOf } from "../core/board";
import { errorText } from "../core/errors";
import { collapsedMembers, nextStageName, prunableResults, stageBoxes, suggestKeep, type StageBox } from "../core/stages";
import { nodesBytes, pruneSavings } from "../core/tidy";
import { TIDY_TEXT } from "./boardText";
import { useShell } from "./shell";
import type { StageTidy } from "./stages";
import { useTidyMeasure, type TidyMeasure } from "./tidy";

/** 不在整理模式时没有建议保留：共用同一个空集，省得每次渲染都新建。 */
const NO_SUGGESTIONS: ReadonlySet<string> = new Set();

interface StageTidyOptions {
  board: Board;
  boardRef: MutableRefObject<Board>;
  tidying: boolean;
  tidyMeasure: TidyMeasure;
  apply: (change: BoardChange) => EditResult | null;
  toast: (message: string) => void;
  onMoveOutStage: (stageId: string) => Promise<string>;
  /** 建议保留的结果（#144）：只在整理模式里有。 */
  suggested: ReadonlySet<string>;
}

/** 整理模式下阶段框多出的内容：各阶段体量、「收掉未定稿」张数、建议保留与移出为新画板。不在整理模式为 null。 */
export function useStageTidy({ board, boardRef, tidying, tidyMeasure, apply, toast, onMoveOutStage, suggested }: StageTidyOptions): StageTidy | null {
  const port = useShell();
  const [movingOut, setMovingOut] = useState(false);
  return useMemo((): StageTidy | null => {
    if (!tidying) return null;
    const { measure } = tidyMeasure;
    const stageNodes = (id: string) => stagesOf(board).find((s) => s.id === id)?.nodes ?? [];
    return {
      bytes: (id) => (measure ? nodesBytes(measure, stageNodes(id)) : null),
      prunable: (id) => prunableResults(board, [id]).length,
      keepable: (id) => stageNodes(id).filter((nodeId) => suggested.has(nodeId)).length,
      onKeep: (id) => {
        // 与「标记定稿」同一个变更：一步撤销。
        const ids = stageNodes(id).filter((nodeId) => suggested.has(nodeId));
        if (ids.length) apply({ kind: "setFinal", nodes: ids, final: true });
      },
      onPrune: (id) => {
        const ids = prunableResults(boardRef.current, [id]);
        if (!ids.length) return toast(TIDY_TEXT.nothingToPrune);
        const saved = measure ? pruneSavings(measure, ids) : null;
        const keep = ids.filter((nodeId) => suggested.has(nodeId)).length;
        void port.ui.ask(TIDY_TEXT.pruneConfirm(ids.length, saved, keep), { title: TIDY_TEXT.pruneTitle, okLabel: TIDY_TEXT.pruneOk, cancelLabel: TIDY_TEXT.cancelLabel }).then((ok) => {
          if (ok) apply({ kind: "pruneUnfinal", stageIds: [id] });
        });
      },
      movingOut,
      onMoveOut: (id) => {
        setMovingOut(true);
        void onMoveOutStage(id)
          .then(toast, (e) => toast(TIDY_TEXT.moveOutFailed(errorText(e))))
          .finally(() => setMovingOut(false));
      },
    };
  }, [tidying, tidyMeasure, board, toast, apply, movingOut, onMoveOutStage, boardRef, suggested]);
}

interface Options {
  board: Board;
  boardRef: MutableRefObject<Board>;
  readOnly: boolean;
  measured: Record<string, { width?: number; height?: number }>;
  tidying: boolean;
  apply: (change: BoardChange) => EditResult | null;
  toast: (message: string) => void;
  onMoveOutStage: (stageId: string) => Promise<string>;
}

export interface CanvasStageView {
  /** 收起的阶段的成员节点：React Flow 里连同其连线一起隐藏。 */
  hidden: ReadonlySet<string>;
  /** 阶段框：按成员的显示尺寸画。 */
  boxes: StageBox[];
  /** 刚建好的阶段：标题直接进入改名。 */
  editingStage: string | null;
  onEditingDone: () => void;
  /** 把选区建为新阶段；新阶段直接进入改名。 */
  newStage: (ids: string[]) => void;
  /** 整理模式的度量（整理前后体量对比，顶部整理条用）。 */
  tidyMeasure: TidyMeasure;
  /** 整理模式下的阶段框附加内容；不在整理模式为 null。 */
  stageTidy: StageTidy | null;
  /** 建议保留的结果：只在整理模式里有，退出整理模式即消失（不写画板、不进撤销步）。 */
  suggestKeep: ReadonlySet<string>;
}

export function useCanvasStageView({ board, boardRef, readOnly, measured, tidying, apply, toast, onMoveOutStage }: Options): CanvasStageView {
  // 阶段：收起的成员不显示；框按成员的显示尺寸画。
  const hidden = useMemo(() => collapsedMembers(board, readOnly), [board, readOnly]);
  const boxes = useMemo(() => stageBoxes(board, (id) => measured[id], readOnly), [board, measured, readOnly]);
  const [editingStage, setEditingStage] = useState<string | null>(null);
  // 整理模式：各阶段体量、「收掉未定稿」的张数与预计减少的体量（按任务目录，本机存储量）。
  const tidyMeasure = useTidyMeasure(board, tidying);
  // 建议保留（#144）：渲染时现算，退出整理模式即空集——不写画板、不进撤销步，因此不参与脏判据。
  const suggested = useMemo(() => (tidying ? suggestKeep(board) : NO_SUGGESTIONS), [board, tidying]);
  const stageTidy = useStageTidy({ board, boardRef, tidying, tidyMeasure, apply, toast, onMoveOutStage, suggested });
  const newStage = (ids: string[]) => {
    const before = new Set(stagesOf(boardRef.current).map((s) => s.id));
    const r = apply({ kind: "newStage", name: nextStageName(boardRef.current), nodes: ids });
    const created = r?.step && stagesOf(r.board).find((s) => !before.has(s.id));
    if (created) setEditingStage(created.id);
  };
  const onEditingDone = () => setEditingStage(null);
  return { hidden, boxes, editingStage, onEditingDone, newStage, tidyMeasure, stageTidy, suggestKeep: suggested };
}

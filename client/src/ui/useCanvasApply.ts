// 画板变更的唯一入口接线：只读画板拒绝写入（视口移动不提示），被拒原因与撤销提示照样提示，
// 有建议选中就照选。拒绝语义与文案都在 core（画板会话层同样拒绝写入），这里只把结果转成界面动作。
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { BoardChange, EditResult } from "../core/edit";
import { ARCHIVE_TEXT } from "./boardText";

interface Options {
  applyChange: (change: BoardChange) => EditResult | null;
  toast: (message: string) => void;
  readOnly: boolean;
  setSelectedNodes: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setSelectedEdges: Dispatch<SetStateAction<ReadonlySet<string>>>;
}

export type ApplyChange = (change: BoardChange) => EditResult | null;

/** 应用一次画板变更：有话要说（被拒原因、删除后的撤销提示）就提示，有建议选中就照选。 */
export function useCanvasApply({ applyChange, toast, readOnly, setSelectedNodes, setSelectedEdges }: Options): ApplyChange {
  return useCallback(
    (change: BoardChange) => {
      // 归档画板：视口移动不提示，其余编辑说明只读。画板会话层同样拒绝写入。
      if (readOnly) {
        if (change.kind !== "viewport") toast(ARCHIVE_TEXT.readOnly);
        return null;
      }
      const r = applyChange(change);
      if (r?.hint) toast(r.hint);
      if (r?.selection) {
        setSelectedNodes(new Set(r.selection));
        setSelectedEdges(new Set());
      }
      return r;
    },
    [applyChange, toast, readOnly, setSelectedNodes, setSelectedEdges],
  );
}

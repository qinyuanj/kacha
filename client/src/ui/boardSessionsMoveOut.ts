// 移出为新画板的最后两步（#137）：从 ui/boardSessionsOps.ts 拆出的模块级函数，便于单测。
import type { Board } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { errorText } from "../core/errors";
import { TIDY_TEXT } from "./boardText";

/** 写新画板；写不进去时给一句说明（成功为 null）。 */
export async function writeMovedOut(
  ports: { board: { write(path: string, text: string, options?: { createOnly?: boolean }): Promise<void> } },
  path: string,
  fresh: Board,
): Promise<string | null> {
  try {
    await ports.board.write(path, fresh as never, { createOnly: true });
    return null;
  } catch (e) {
    return errorText(e);
  }
}

/** 写好新画板之后：从原画板删去这些节点。 */
export function finishMoveOut(
  boardOf: () => Board | null,
  apply: (key: string, change: BoardChange) => EditResult | null,
  key: string,
  stageId: string,
  fresh: Board,
  latest: Board,
): string {
  if (boardOf() !== latest) return TIDY_TEXT.movedOutKept(fresh.title, "移出期间本画板有了新的改动");
  const result = apply(key, { kind: "moveOutStage", stageId });
  // 写好之后才被拒（期间有任务开始运行）：新画板已在列表里，原画板不动。
  return result?.step ? TIDY_TEXT.movedOut(fresh.title) : TIDY_TEXT.movedOutKept(fresh.title, result?.hint ?? null);
}

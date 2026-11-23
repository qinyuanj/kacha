// 移出为新画板的最后两步（#137）：从 ui/boardSessionsOps.ts 拆出的模块级函数，便于单测。
import { serializeBoard, type Board } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { newId } from "../core/ids";
import { errorText } from "../core/errors";
import { prepareStageSplit } from "../core/moveOut";
import { slotsRefusal, TIDY_TEXT } from "./boardText";
import { moveOutBlockedText } from "./boardSessions";

/** 移出前的画板位预检：读不到列表时不拦（本机存储新建时仍会检查）。 */
export interface SlotsPort {
  board: { list(): Promise<{ slots: { used: number; total: number } }> };
}

export async function moveOutRefusal(ports: SlotsPort): Promise<string | null> {
  const slots = await ports.board.list().then((l) => l.slots, () => null);
  return slots ? slotsRefusal(slots, 1) : null;
}

/** 移出：查画板位、拆出新画板并写好，最后才在原画板删去这些节点。 */
export async function moveOutWrite(
  deps: {
    /** 新画板的目标路径。 */
    freePathIn(title: string): Promise<string>;
    /** 读文件的 sha256。 */
    sha256(path: string): Promise<string>;
    /** 写新画板。 */
    write(path: string, fresh: Board): Promise<string | null>;
    /** 当前画板（判断移出期间有没有新改动）。 */
    boardOf(): Board | null;
    /** 试算删掉这些节点。 */
    tryRemove(): EditResult | null;
    /** 真正删掉这些节点。 */
    apply(key: string, change: BoardChange): EditResult | null;
    /** 画板位预检用。 */
    board: { list(): Promise<{ slots: { used: number; total: number } }> };
  },
  stageId: string,
  key: string,
): Promise<string> {
  // 读不到列表时不拦：本机存储新建时仍会检查。
  const refusal = await moveOutRefusal(deps as unknown as SlotsPort);
  if (refusal) return refusal;
  const prepared = await prepareStageSplit(deps.boardOf, stageId, deps.sha256, newId);
  const check = deps.tryRemove();
  if (!prepared || !check?.step) return moveOutBlockedText("stageGone", check?.hint);
  const { source: latest, board: fresh } = prepared;
  const path = await deps.freePathIn(fresh.title);
  if (deps.boardOf() !== latest) return TIDY_TEXT.moveOutFailed("移出期间本画板有了新的改动，请重试");
  const written = await deps.write(path, fresh);
  if (written) return written;
  return finishMoveOut(deps.boardOf, deps.apply, key, stageId, fresh, latest);
}

/** 写新画板；写不进去时给一句说明（成功为 null）。 */
export async function writeMovedOut(
  ports: { board: { write(path: string, text: string, options?: { createOnly?: boolean }): Promise<void> } },
  path: string,
  fresh: Board,
): Promise<string | null> {
  try {
    // 端口只收文本：与其余三处写盘一样先序列化，不把画板对象塞进只认文本的通道。
    await ports.board.write(path, serializeBoard(fresh), { createOnly: true });
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

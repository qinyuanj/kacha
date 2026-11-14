// 画板列表的各个动作（#137）：从 ui/BoardListDialog.tsx 拆出的模块级函数，便于单测。
import { errorText } from "../core/errors";
import type { BoardListEntry } from "../shell/types";

/** 正在确认的一行。 */
export interface PendingAction {
  entry: BoardListEntry;
  busy: boolean;
  error: string | null;
}

/** 确认动作的结果。 */
export type ConfirmResult = { ok: true } | { ok: false; error: string };

/** 跑一次确认动作：成功关掉确认框，失败把错误留在框里。 */
export async function runConfirm(
  pending: PendingAction | null,
  run: (entry: BoardListEntry) => Promise<void>,
): Promise<ConfirmResult> {
  if (!pending || pending.busy) return { ok: false, error: "" };
  try {
    await run(pending.entry);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** 取消归档 / 复制为新画板：被拒（画板位满）或失败时给一句说明。 */
export async function runArchivedAction(action: (path: string) => Promise<string | null>, entry: BoardListEntry): Promise<string | null> {
  try {
    return await action(entry.path);
  } catch (e) {
    return errorText(e);
  }
}

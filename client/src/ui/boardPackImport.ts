// 画板包导入结局的可见判定（#137）：从 ui/useBoardPack.ts 拆出的纯逻辑，便于单测。
import type { ImportResult } from "../core/boardPack";
import { isSlotsFullText, PACK_IMPORT_TEXT } from "./boardText";
import type { PackDialogState } from "./BoardPackDialog";

/** 导入结局之后界面该怎么反应。 */
export type ImportOutcome =
  /** 关掉对话框，给用户一句话提示。 */
  | { kind: "toast"; text: string }
  /** 弹窗说明结局（服务端导入失败、打开画板失败、有冲突）。 */
  | { kind: "dialog"; state: PackDialogState };

/** 导入结局 → 界面的反应。 */
export function importOutcome(result: ImportResult): ImportOutcome {
  switch (result.kind) {
    case "newer":
      return { kind: "toast", text: result.message };
    case "corrupt":
      return { kind: "toast", text: `无法导入画板包：${result.reason}` };
    case "cancelled":
      return { kind: "toast", text: PACK_IMPORT_TEXT.cancelled };
    case "slotsFull":
      return { kind: "toast", text: result.message };
    case "failed":
      // 服务端合并前按画板位拒绝（两页抢最后的位）：它的报错就是统一文案，不加前缀，此时什么都没合并。
      return { kind: "toast", text: isSlotsFullText(result.error) ? result.error : PACK_IMPORT_TEXT.failed(result.error) };
    case "commitFailed":
      // 导入请求失败时任务目录可能已移入一部分：用弹窗说明画板没有写入，而不是一闪而过的提示。
      if (isSlotsFullText(result.error)) return { kind: "toast", text: result.error };
      return { kind: "dialog", state: { stage: "importDone", message: PACK_IMPORT_TEXT.failed(result.error), conflicts: [], notice: PACK_IMPORT_TEXT.commitFailed } };
    case "done": {
      const { summary, writeError } = result;
      if (writeError || summary.conflicts.length) {
        return { kind: "dialog", state: { stage: "importDone", message: summary.message, conflicts: summary.conflicts, notice: writeError ? PACK_IMPORT_TEXT.openFailed(writeError) : null } };
      }
      return { kind: "toast", text: summary.message };
    }
  }
}

/** 导入进度对话框里各步的说明（#62）。 */
export const IMPORT_PHASES: Record<"check" | "existing" | "hash" | "upload" | "merge", string> = {
  check: "正在检查画板包…",
  existing: "正在比对服务端已有的任务目录…",
  hash: "正在计算内容校验值…",
  upload: "正在上传缺少的内容…",
  merge: "正在合并任务目录…",
};

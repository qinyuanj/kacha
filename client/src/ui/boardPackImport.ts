// 画板包导入结局的可见判定（#137）：从 ui/useBoardPack.ts 拆出的纯逻辑，便于单测。
import type { ImportPhase, ImportResult } from "../core/boardPack";
import { isSlotsFullText, PACK_IMPORT_TEXT } from "./boardText";
import type { PackDialogState } from "./BoardPackDialog";

/** 导入结局之后界面该怎么反应。 */
export type ImportOutcome =
  /** 关掉对话框，给用户一句话提示。 */
  | { kind: "toast"; text: string }
  /** 弹窗说明结局（服务端导入失败、打开画板失败、有冲突）。 */
  | { kind: "dialog"; state: PackDialogState };

/** 一句话提示。 */
const toast = (text: string): ImportOutcome => ({ kind: "toast", text });

/** 弹窗说明结局。 */
const dialog = (message: string, conflicts: string[], notice: string | null): ImportOutcome => ({
  kind: "dialog",
  state: { stage: "importDone", message, conflicts, notice },
});

/** 导入成功之后的反应：有冲突或打开失败就弹窗，否则一句话。 */
export function doneOutcome(result: Extract<ImportResult, { kind: "done" }>): ImportOutcome {
  const { summary, writeError } = result;
  if (writeError || summary.conflicts.length) {
    return dialog(summary.message, summary.conflicts, writeError ? PACK_IMPORT_TEXT.openFailed(writeError) : null);
  }
  return toast(summary.message);
}

/** 合并失败之后的反应：画板位满是一句话，其他情况弹窗。 */
export function commitFailedOutcome(error: string): ImportOutcome {
  if (isSlotsFullText(error)) return toast(error);
  return dialog(PACK_IMPORT_TEXT.failed(error), [], PACK_IMPORT_TEXT.commitFailed);
}

/** 导入结局 → 界面的反应。 */
export function importOutcome(result: ImportResult): ImportOutcome {
  switch (result.kind) {
    case "newer":
      return toast(result.message);
    case "corrupt":
      return toast(`无法导入画板包：${result.reason}`);
    case "cancelled":
      return toast(PACK_IMPORT_TEXT.cancelled);
    case "slotsFull":
      return toast(result.message);
    case "failed":
      // 服务端合并前按画板位拒绝（两页抢最后的位）：它的报错就是统一文案，不加前缀，此时什么都没合并。
      return toast(isSlotsFullText(result.error) ? result.error : PACK_IMPORT_TEXT.failed(result.error));
    case "commitFailed":
      // 导入请求失败时任务目录可能已移入一部分：用弹窗说明画板没有写入，而不是一闪而过的提示。
      return commitFailedOutcome(result.error);
    case "done":
      return doneOutcome(result);
  }
}

/**
 * 导入进度对话框里各步的说明（#62）。
 *
 * 前五步是 Web 版（服务端合并）；后三步是桌面壳（#131）在本机解压合并时走的。
 */
export const IMPORT_PHASES: Record<ImportPhase, string> = {
  check: "正在检查画板包…",
  existing: "正在比对服务端已有的任务目录…",
  hash: "正在计算内容校验值…",
  upload: "正在上传缺少的内容…",
  merge: "正在合并任务目录…",
  extract: "正在解压画板包…",
  restore: "正在还原重复内容…",
  boards: "正在写入画板…",
};

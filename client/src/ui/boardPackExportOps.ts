// 画板包导出的各个提示文案（#137）：从 ui/useBoardPack.ts 拆出的模块级常量与纯函数，便于单测。
import { BOARD_EXTENSION } from "../core/board";
import { PACK_EXTENSION, type ExportPlan, type PackContents } from "../core/boardPack";

/** 算导出计划失败时的提示。 */
export const planFailedText = (reason: string) => `无法导出画板包：${reason}`;

/** hash 阶段取消时的提示。 */
export const exportCancelledText = "已取消导出画板包";

/** hash 阶段失败时的提示。 */
export const exportHashFailedText = (reason: string) => `无法导出画板包：${reason}`;

/** 导出成功时的提示。 */
export const exportDoneText = (target: string) => `已导出画板包 ${target}`;

/** 导出失败时的提示。 */
export const exportFailedText = (reason: string) => `导出画板包失败：${reason}`;

/** 导出目标的文件名：画板名加 .ugcpack。 */
export const exportTargetOf = (boardFile: string) => {
  const stem = boardFile.slice(0, -BOARD_EXTENSION.length);
  return { stem, target: `${stem}${PACK_EXTENSION}` };
};

/** 导出的日志字段（不含提示词与报错原文）。 */
export function exportLogFields(boardFile: string, plan: ExportPlan, contents: PackContents): Record<string, unknown> {
  return {
    action: "export",
    board_file: boardFile,
    task_dirs: plan.taskDirs.length,
    missing: plan.missing.length,
    duplicates: contents.bytes < contents.totalBytes ? 1 : 0,
    estimated_bytes: contents.bytes,
  };
}
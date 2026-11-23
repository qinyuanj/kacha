// 画板包对话框的可见判定（#137）：从 ui/BoardPackDialog.tsx 拆出的纯逻辑，便于单测。
import type { PackDialogState } from "./BoardPackDialog";

/** 进度字节的可读大小。 */
const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** 进度那一行：还没拿到总量时说「准备中…」，有了就说已用 / 总量。 */
export function progressText(progress: { done: number; total: number }): string {
  return progress.total ? `${formatSize(progress.done)} / ${formatSize(progress.total)}` : "准备中…";
}

/** 进度条的总量：没有总量时给 1（浏览器不接受 0 作为 max）。 */
export function progressMax(progress: { done: number; total: number }): number {
  return progress.total || 1;
}

/** 预估大小那一行：重复内容省下的字节也说出来。 */
export function estimateText(bytes: number, totalBytes: number): string {
  const saved = totalBytes - bytes;
  return saved > 0 ? `预估大小：${formatSize(bytes)}（重复内容只存一份，省去 ${formatSize(saved)}）` : `预估大小：${formatSize(bytes)}`;
}

/** 导出确认时的说明：打包画板与它引用的任务目录、参考图。 */
export function exportSummary(taskDirs: number, files: number): string {
  const refs = files > 0 ? `、${files} 张参考图` : "";
  return `将打包画板与它引用的 ${taskDirs} 个任务目录${refs}。`;
}

/** 导出按钮的文字：有缺图时说「仍然导出…」。 */
export function exportButtonLabel(missing: number): string {
  return missing ? "仍然导出…" : "导出并下载…";
}

/** 进度阶段不响应点背景关闭：只能点「取消」。 */
export function dismissible(state: PackDialogState): boolean {
  return state.stage !== "progress";
}

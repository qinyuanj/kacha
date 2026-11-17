// 预览弹窗的导出接线（#137）：从 ui/PreviewDialog.tsx 拆出的模块级函数，便于单测。
import { errorText } from "../core/errors";
import type { SaveCopyOutcome } from "../shell/port";

/** 导出用的端口。 */
export interface PreviewExportPort {
  saveCopyAs(absPath: string): Promise<SaveCopyOutcome>;
  downloadImage(path: string): Promise<SaveCopyOutcome>;
}

/** 导出失败时的提示。 */
export const exportFailedText = (reason: string) => `导出失败：${reason}`;

/** 单张图导出完成的提示。 */
export const exportOneText = "已开始下载";

/** 全部图层导出完成的提示。 */
export const exportAllText = "已保存：底图、全部图层与 layers.json（zip）";

/** 跑一次导出：成功给提示，失败给失败提示。 */
export async function runExport(
  toast: (message: string) => void,
  setBusy: (busy: boolean) => void,
  fn: () => Promise<string | null>,
): Promise<void> {
  setBusy(true);
  try {
    const done = await fn();
    if (done) toast(done);
  } catch (e) {
    toast(exportFailedText(errorText(e)));
  } finally {
    setBusy(false);
  }
}

/** 导出单张图（图层或底图）。 */
export async function exportOneImage(port: PreviewExportPort, toast: (message: string) => void, setBusy: (busy: boolean) => void, absPath: string): Promise<void> {
  await runExport(toast, setBusy, async () => {
    const outcome = await port.saveCopyAs(absPath);
    // 取消系统「另存为」时没有可说的：不提示「已开始下载」。
    return outcome.kind === "cancelled" ? null : exportOneText;
  });
}

/** 导出底图 + 全部图层 + layers.json（zip）。 */
export async function exportAllImages(port: PreviewExportPort, toast: (message: string) => void, setBusy: (busy: boolean) => void, absPath: string): Promise<void> {
  await runExport(toast, setBusy, async () => {
    const outcome = await port.downloadImage(absPath);
    // 系统「另存为」被取消时没有产物，不报成功。
    return outcome.kind === "cancelled" ? null : exportAllText;
  });
}
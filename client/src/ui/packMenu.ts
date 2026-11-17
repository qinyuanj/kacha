// 画板包菜单的动作（#127）：下载整板结果。
//
// 端口可能说这项能力还没有（桌面壳还没有整板结果下载）：这时说清「尚不可用」，
// 不能报成功，也不能让拒绝冒成未捕获异常。成功才说「已开始下载」。
import { errorText } from "../core/errors";
import { unavailableMessage, type ShellPort } from "../shell/port";

/** 是不是一个会拒绝的 promise：端口的实现可以同步抛，也可以异步拒。 */
function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/** 下载整板结果（zip）：端口拒绝时按类别给原因，成功才报「已开始下载」。 */
export function downloadBoardResults(port: ShellPort, path: string, toast: (message: string) => void): void {
  const started = (): void => toast("已开始下载整板结果（含各结果的图层），缺失的结果列在包内 缺失文件.txt");
  const failed = (e: unknown): void => toast(unavailableMessage(e) ?? `下载整板结果失败：${errorText(e)}`);
  try {
    const result: unknown = port.media.downloadBoardResults(path);
    if (isPromise(result)) {
      void result.then(started, failed);
      return;
    }
    started();
  } catch (e) {
    failed(e);
  }
}

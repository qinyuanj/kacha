// 真实桌面桥（#127）：把 MyGo 绑定折成 DesktopBridge。
//
// 走 mygo-runtime 的 call 而不是生成的 client/src/mygo.ts：生成文件是构建产物（gitignore），
// 源码与单测在没有它时也要能编译。调用名与 Go 侧绑定名一致（Shell.Info / Local.WriteBoard）。
import { call } from "mygo-runtime";

import type { DesktopBridge, DesktopClipboardBridge, DesktopClipboardSnapshot, DesktopImageCopy, DesktopInfo, DesktopLocalBridge } from "./desktop";

/** camelCase 的页面侧方法名 → Go 侧的 PascalCase 绑定名。 */
function goName(method: string): string {
  return method.charAt(0).toUpperCase() + method.slice(1);
}

/** 生成的客户端没在手边时也能用：直接按方法名调用。 */
export function mygoBridge(callFn: (method: string, ...args: unknown[]) => Promise<unknown> = (method, ...args) => call(method, ...args)): DesktopBridge {
  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_target, prop: string) => (...args: unknown[]) => callFn(`Local.${goName(prop)}`, ...args),
  });
  // 系统剪贴板（#129）：与 Go 侧 BindAs("Clipboard", clipboard.Service{}) 对齐。
  // 少这一项时 desktop.ts 的 readClipboard 恒为 null，粘贴会静默退回 paste 事件。
  const clipboard: DesktopClipboardBridge = {
    read: () => callFn("Clipboard.Read") as Promise<DesktopClipboardSnapshot>,
    // 复制图片（#130）：Go 侧自己按路径读字节并归一化成 PNG，页面只给路径与格式提示。
    copyImage: (path, format) => callFn("Clipboard.CopyImage", path, format) as Promise<DesktopImageCopy>,
  };
  return {
    info: () => callFn("Shell.Info") as Promise<DesktopInfo>,
    local,
    clipboard,
  };
}

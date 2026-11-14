// 真实桌面桥（#127）：把 MyGo 绑定折成 DesktopBridge。
//
// 走 mygo-runtime 的 call 而不是生成的 client/src/mygo.ts：生成文件是构建产物（gitignore），
// 源码与单测在没有它时也要能编译。方法名与 Go 侧的绑定名一致（Shell.Info / Local.*）。
import { call } from "mygo-runtime";

import type { DesktopBridge, DesktopInfo, DesktopLocalBridge } from "./desktop";

/** 生成的客户端没在手边时也能用：直接按方法名调用。 */
export function mygoBridge(callFn: (method: string, ...args: unknown[]) => Promise<unknown> = (method, ...args) => call(method, ...args)): DesktopBridge {
  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_target, prop: string) => (...args: unknown[]) => callFn(`Local.${prop}`, ...args),
  });
  return {
    info: () => callFn("Shell.Info") as Promise<DesktopInfo>,
    local,
  };
}

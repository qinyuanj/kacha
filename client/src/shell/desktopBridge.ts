// 真实桌面桥（#127）：把 MyGo 生成的绑定调用折成 DesktopBridge。
//
// 不用生成文件 client/src/mygo.ts 里的 Shell.Info，而是直接走 mygo-runtime 的 call：
// 生成文件是构建产物（gitignore），源码与单测在没有它时也要能编译。方法名与 Go 侧绑定名一致。
import { call } from "mygo-runtime";

import type { DesktopBridge, DesktopInfo } from "./desktop";

export function mygoBridge(callFn: (method: string) => Promise<DesktopInfo> = (method) => call<DesktopInfo>(method)): DesktopBridge {
  return { info: () => callFn("Shell.Info") };
}

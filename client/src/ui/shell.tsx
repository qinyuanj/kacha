// 壳端口的 React 接缝（#126）：界面组件与 hook 从这里取端口，不直接 import shell/ipc、shell/adapters。
// 默认值是 Web 实现（同源 HTTP + 浏览器能力）；测试用 testing/fakePort 造替身经 ShellProvider 注入。
import { createContext, useContext, type ReactNode } from "react";
import type { ShellPort } from "../shell/port";
import { webPort } from "../shell/webPort";

const ShellContext = createContext<ShellPort>(webPort);

export function ShellProvider({ port, children }: { port: ShellPort; children: ReactNode }) {
  return <ShellContext.Provider value={port}>{children}</ShellContext.Provider>;
}

/** 当前壳端口：换实现只换 Provider 的 value。 */
export function useShell(): ShellPort {
  return useContext(ShellContext);
}

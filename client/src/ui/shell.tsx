// 壳端口由组合根显式注入；测试通过 ShellProvider 注入内存端口。
import { createContext, type ReactNode } from "react";
import type { ShellPort } from "../shell/port";
import { useRequiredContext } from "./requiredContext";

const ShellContext = createContext<ShellPort | null>(null);

export function ShellProvider({ port, children }: { port: ShellPort; children: ReactNode }) {
  return <ShellContext.Provider value={port}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellPort {
  return useRequiredContext(ShellContext, "桌面壳端口尚未注入");
}

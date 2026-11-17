// 桌面壳启动（#127）：在 MyGo 窗口里造出桌面壳端口，交给界面用。
// 缺少 MyGo runtime 时明确拒绝启动。
import { isMyGo } from "mygo-runtime";

import { createDesktopPort, type DesktopShell } from "./desktop";
import { mygoBridge } from "./desktopBridge";

let current: DesktopShell | null = null;

/**
 * 启动桌面壳：在 MyGo 窗口里读一次壳信息并造出端口，之后返回同一份。
 * 不在 MyGo 窗口里时报告启动失败。
 */
export async function bootDesktop(): Promise<DesktopShell> {
  if (current) return current;
  if (!isMyGo()) throw new Error("请使用 MyGo 桌面客户端打开 Kacha");
  current = await createDesktopPort(mygoBridge());
  return current;
}

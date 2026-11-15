// 桌面壳启动（#127）：在 MyGo 窗口里造出桌面壳端口，交给界面用。
//
// 普通浏览器里（Web 路线、单测、e2e）什么也不做：没有 MyGo runtime 就没有桌面壳，
// 界面仍走 Web 实现（main.tsx 按这个结果选注入哪个端口）。
import { isMyGo } from "mygo-runtime";

import { createDesktopPort, type DesktopShell } from "./desktop";
import { mygoBridge } from "./desktopBridge";

let current: DesktopShell | null = null;

/**
 * 启动桌面壳：在 MyGo 窗口里读一次壳信息并造出端口，之后返回同一份。
 * 不在 MyGo 窗口里时返回 null。
 */
export async function bootDesktop(): Promise<DesktopShell | null> {
  if (current) return current;
  if (!isMyGo()) return null;
  current = await createDesktopPort(mygoBridge());
  return current;
}

// 桌面壳启动（#127）：页面在 MyGo 窗口里时解析出桌面壳，交给界面用。
//
// 在普通浏览器里（Web 路线、单测、e2e）什么也不做：没有 MyGo runtime 就没有桌面壳，
// 界面仍走 Web 实现。
import { isMyGo } from "mygo-runtime";

import { openDesktopShell, type DesktopShell } from "./desktop";
import { mygoBridge } from "./desktopBridge";

let current: DesktopShell | null = null;

/**
 * 启动桌面壳：在 MyGo 窗口里读一次壳信息并记住，返回它；普通浏览器里返回 null。
 * 重复调用返回同一份（壳信息在启动后不再变）。
 */
export async function bootDesktop(): Promise<DesktopShell | null> {
  if (current) return current;
  if (!isMyGo()) return null;
  current = await openDesktopShell(mygoBridge());
  return current;
}

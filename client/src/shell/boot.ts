// 壳端口的选择（#127）：界面与组合根唯一要问的接缝。
//
// main.tsx 只调这一个函数：它在 MyGo 窗口里给出桌面端口（本地文件与本机身份），
// 在普通浏览器里给出 Web 端口（同源 HTTP）。MyGo runtime 的探测与绑定调用都在这一层里，
// 界面与 main.tsx 都不直接依赖 mygo-runtime 或生成的绑定（ADR 0023）。
import { bootDesktop } from "./desktopBoot";
import type { ShellPort } from "./port";
import { webPort } from "./webPort";

/**
 * 选出本次运行的壳端口。
 *
 * 在 MyGo 窗口里读一次壳信息并造出桌面端口；桌面壳起不来（用户数据根不可用等）时退回 Web 端口，
// 页面仍能起来，错误由调用方看到。普通浏览器里直接给 Web 端口。
 */
export async function selectShellPort(): Promise<ShellPort> {
  try {
    const desktop = await bootDesktop();
    if (desktop) return desktop.port;
  } catch (e) {
    console.error("桌面壳启动失败，改用 Web 端口", e);
  }
  return webPort;
}

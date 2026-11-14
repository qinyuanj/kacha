import "@xyflow/react/dist/style.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootDesktop } from "./shell/desktopBoot";
import { webPort } from "./shell/webPort";
import { Root } from "./ui/Root";
import { ShellProvider } from "./ui/shell";
import type { ShellPort } from "./shell/port";

// 壳端口的唯一注入点（#126）：Web 实现（同源 HTTP + 浏览器能力）；
// 在 MyGo 窗口里换成桌面实现（#127）：本地文件与本机身份，不连服务端。
// 桌面壳是异步的（要读一次壳信息），所以这里等它落定再挂载；普通浏览器里立刻就用 Web 端口。
void (async () => {
  let port: ShellPort = webPort;
  try {
    const desktop = await bootDesktop();
    if (desktop) port = desktop.port;
  } catch (e) {
    // 壳读不出来（用户数据根不可用等）：退回 Web 端口，页面仍能起来，错误在界面上可见。
    console.error("桌面壳启动失败，改用 Web 端口", e);
  }

  // 页面输入接管（#97）：与画板冲突的浏览器默认行为由本应用吞掉，判定见 core/pageInput。
  // Ctrl+W / Ctrl+T / Ctrl+N 这类浏览器自己处理的组合拦不住，写在 README 的已知限制里。
  port.ui.installInputTakeover();

  // 屏蔽画布上的浏览器右键菜单；文本输入里保留以便复制粘贴。
  document.addEventListener("contextmenu", (e) => {
    if (!port.ui.isEditableTarget(e.target)) e.preventDefault();
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ShellProvider port={port}>
        <Root />
      </ShellProvider>
    </StrictMode>,
  );
})();

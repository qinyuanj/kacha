import "@xyflow/react/dist/style.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { selectShellPort } from "./shell/boot";
import { Root } from "./ui/Root";
import { ShellProvider } from "./ui/shell";

// 壳端口的唯一注入点（#126）：选端口这件事只有壳层知道（#127）：
// MyGo 窗口里是桌面实现（本地文件与本机身份），普通浏览器里是 Web 实现（同源 HTTP）。
// 桌面壳要异步读一次壳信息，所以这里等它落定再挂载。
void (async () => {
  const port = await selectShellPort();

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

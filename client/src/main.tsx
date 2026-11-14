import "@xyflow/react/dist/style.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createShellPort } from "./shell/webPort";
import { Root } from "./ui/Root";
import { ShellProvider } from "./ui/shell";

// 壳端口的唯一注入点：Web 实现（同源 HTTP + 浏览器能力）；桌面壳换成自己的实现即可（ADR 0023）。
const port = createShellPort();

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

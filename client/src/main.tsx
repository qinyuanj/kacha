import "@xyflow/react/dist/style.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootDesktop } from "./shell/desktopBoot";
import { installPageInputTakeover, isEditableTarget } from "./shell/pageInput";
import { Root } from "./ui/Root";

// 页面输入接管（#97）：与画板冲突的浏览器默认行为由本应用吞掉，判定见 core/pageInput。
// Ctrl+W / Ctrl+T / Ctrl+N 这类浏览器自己处理的组合拦不住，写在 README 的已知限制里。
installPageInputTakeover();

// 桌面壳（#127）：在 MyGo 窗口里读一次壳信息（用户数据根、版本、能力开关）；普通浏览器里什么也不做。
void bootDesktop();

// 屏蔽画布上的浏览器右键菜单；文本输入里保留以便复制粘贴。
document.addEventListener("contextmenu", (e) => {
  if (!isEditableTarget(e.target)) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode><Root /></StrictMode>,
);

import "@xyflow/react/dist/style.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./ui/Root";

// 屏蔽画布上的浏览器右键菜单；文本输入里保留以便复制粘贴。
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest("input, textarea, [contenteditable='true']")) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode><Root /></StrictMode>,
);

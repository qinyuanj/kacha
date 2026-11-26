// e2e 启动入口：把内存壳端口注入 ShellProvider，再挂真实的 Root。
// 浏览器里没有 MyGo 运行时，所以 e2e 自己造一个替身（同一个 createFakePort 单测已在用）。
//
// 这两行样式导入不是脚手架，别删：e2e.html 只加载这个文件，src/main.tsx 的样式不会被加载。
// 少了它们，e2e 页面零样式，「.canvas 可见」就退化成「DOM 存在」，CSS 崩溃或整页白屏抓不住。
import "@xyflow/react/dist/style.css";
import "../src/styles/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createFakePort } from "../src/shell/testing/fakePort";
import { Root } from "../src/ui/Root";
import { ShellProvider } from "../src/ui/shell";

// 长名称画板：列表弹层要在 960px 窗口里截断显示，不能用名称把弹层撑出屏幕。
const longBoardName = "一个非常非常长的画板名称用来验证顶部第二行弹层在窄窗口下不会溢出".repeat(3);
const port = createFakePort({
  boards: [{ path: `/~/画板/${longBoardName}.ugcboard.json`, main: null, version: null, bytes: 12345 }],
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShellProvider port={port}>
      <Root />
    </ShellProvider>
  </StrictMode>,
);

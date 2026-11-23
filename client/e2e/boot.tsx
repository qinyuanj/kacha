// e2e 启动入口：把内存壳端口注入 ShellProvider，再挂真实的 Root。
// 浏览器里没有 MyGo 运行时，所以 e2e 自己造一个替身（同一个 createFakePort 单测已在用）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createFakePort } from "../src/shell/testing/fakePort";
import { Root } from "../src/ui/Root";
import { ShellProvider } from "../src/ui/shell";

const port = createFakePort();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShellProvider port={port}>
      <Root />
    </ShellProvider>
  </StrictMode>,
);

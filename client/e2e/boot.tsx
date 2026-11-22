// e2e 启动入口：把内存壳端口注入 ShellProvider，再挂真实的 Root。
// 与 src/main.tsx 的唯一区别是端口来源——src/shell/boot.ts 只会走 MyGo 桌面桥，
// 浏览器里没有它，所以 e2e 自己造一个替身（同一个 createFakePort 单测已在用）。
import "@xyflow/react/dist/style.css";
import "../src/styles/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createFakePort, type FakePortOptions } from "../src/shell/testing/fakePort";
import { Root } from "../src/ui/Root";
import { ShellProvider } from "../src/ui/shell";

// 用例可以在加载后改 window.__kachaE2E.options 再触发挂载，
// 也可以在 URL 上带 ?missing=update 这样的开关决定哪些能力缺席。
export interface E2EHandle {
  options: FakePortOptions;
  calls: ReturnType<typeof createFakePort>["calls"];
}

const missing = new URLSearchParams(window.location.search).get("missing");
const options: FakePortOptions = missing ? { missing: missing.split(",") as FakePortOptions["missing"] } : {};

const port = createFakePort(options);
(window as unknown as { __kachaE2E: E2EHandle }).__kachaE2E = { options, calls: port.calls };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShellProvider port={port}>
      <Root />
    </ShellProvider>
  </StrictMode>,
);

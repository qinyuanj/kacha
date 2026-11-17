// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
vi.mock("../shell/boot", () => ({ selectShellPort: async () => { throw new Error("数据根不可用"); } }));
import { startDesktop } from "./startDesktop";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("桌面初始化失败显示原因，不挂载工作台", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => startDesktop(container));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("数据根不可用");
  expect(container.textContent).toContain("无法启动 Kacha 桌面客户端");
  expect(container.querySelector(".app")).toBeNull();
  container.remove();
});

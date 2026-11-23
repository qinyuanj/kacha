// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
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

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  vi.unstubAllGlobals();
});

// #221：挂载前（这里连壳端口都没就绪）就按首帧镜像把主题写到文档根，启动不闪反向主题。
it("挂载前先按首帧镜像写文档根主题", async () => {
  localStorage.setItem("kacha.theme", "system");
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => startDesktop(container));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  container.remove();
});

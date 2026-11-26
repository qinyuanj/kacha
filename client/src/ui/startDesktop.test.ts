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

// #265：挂载前按首帧镜像写文档根主题；旧 system 镜像直接落浅色，系统配色监听器不起作用。
it("首帧镜像是旧 system 时按浅色写文档根，不监听系统配色", async () => {
  const subscribe = vi.fn();
  localStorage.setItem("kacha.theme", "system");
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: subscribe, removeEventListener: vi.fn() }));
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => startDesktop(container));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.style.colorScheme).toBe("light");
  expect(subscribe).not.toHaveBeenCalled();
  container.remove();
});

it("首帧镜像是显式深色时保持深色", async () => {
  localStorage.setItem("kacha.theme", "dark");
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => startDesktop(container));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  container.remove();
});

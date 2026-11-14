// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopRoot } from "./DesktopRoot";
import { bootDesktop } from "./desktopBoot";

vi.mock("./desktopBoot", () => ({ bootDesktop: vi.fn() }));
vi.mock("../ui/Root", () => ({ Root: () => <div>web-root</div> }));
vi.mock("../App", () => ({ App: ({ version }: { version?: string }) => <div>app-{version}</div> }));

const boot = vi.mocked(bootDesktop);
let container: HTMLDivElement;
let root: ReactRoot;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  boot.mockReset();
});

/** 渲染并等启动时的壳解析落定。 */
async function render() {
  await act(async () => {
    root.render(<DesktopRoot />);
  });
}

describe("桌面入口", () => {
  it("在 MyGo 窗口里直接进工作台，带壳版本，不经过登录", async () => {
    boot.mockResolvedValue({ version: "0.1.0" } as Awaited<ReturnType<typeof bootDesktop>>);
    await render();
    expect(container.textContent).toContain("app-0.1.0");
    expect(container.textContent).not.toContain("web-root");
  });

  it("普通浏览器里照旧渲染 Root", async () => {
    boot.mockResolvedValue(null);
    await render();
    expect(container.textContent).toContain("web-root");
  });

  it("壳读不出来时退回 Root，不让页面白屏", async () => {
    boot.mockRejectedValue(new Error("用户数据根不可用"));
    await render();
    expect(container.textContent).toContain("web-root");
  });
});

// @vitest-environment jsdom
// 进入界面的可见行为（#137）：正在加载、粘贴密钥、密钥无效的提示、桌面壳直接进工作台。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { Root } from "./Root";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Root 里渲染 App；测试只关心进入界面这一段，把 App 替掉。
vi.mock("../App", () => ({ App: () => createElement("div", { className: "app" }, "工作台") }));

let container: HTMLDivElement;
let dom: ReactRoot;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  dom = createRoot(container);
});

afterEach(async () => {
  await act(async () => dom.unmount());
  container.remove();
});

async function show(port: FakePort): Promise<void> {
  await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(Root) })));
}

describe("桌面工作台启动", () => {
  it("读取版本期间显示加载状态", async () => {
    const port = createFakePort();
    port.ui.version = () => new Promise(() => undefined);
    await show(port);
    expect(container.textContent).toContain("正在加载…");
  });
  it("版本读取失败时显示本地启动错误", async () => {
    const port = createFakePort();
    port.ui.version = async () => { throw new Error("本机壳信息不可用"); };
    await show(port);
    expect(container.textContent).toContain("无法启动 Kacha 桌面客户端");
    expect(container.textContent).toContain("本机壳信息不可用");
    expect(container.querySelector(".app")).toBeNull();
  });
  it("不要求密钥，直接进入工作台", async () => {
    await show(createFakePort());
    expect(container.querySelector(".app")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });
});

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

/** 像用户键入一样改受控文本框的值。 */
async function typeInto(textarea: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("进入界面", () => {
  it("读壳信息期间：显示正在加载", async () => {
    const port = createFakePort();
    port.session.config = () => new Promise(() => undefined);
    await show(port);
    expect(container.textContent).toContain("正在加载…");
  });

  it("连不上服务端：显示致命错误", async () => {
    const port = createFakePort();
    port.session.config = async () => {
      throw new Error("offline");
    };
    await show(port);
    expect(container.textContent).toContain("无法连接 Kacha 服务端");
  });

  it("没有本地密钥：要粘贴密钥", async () => {
    const port = createFakePort();
    port.session.readStoredKey = () => null;
    await show(port);
    expect(container.querySelector("textarea[aria-label='API 密钥']")).not.toBeNull();
    expect(container.textContent).toContain("进入工作台");
  });

  it("桌面壳（不需要登录）：直接进工作台", async () => {
    const port = createFakePort();
    Object.defineProperty(port.session, "requiresLogin", { value: false });
    await show(port);
    expect(container.querySelector(".app")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("密钥无效：显示错误，进不了工作台", async () => {
    const port = createFakePort();
    port.session.readStoredKey = () => null;
    port.session.login = async () => {
      throw new Error("密钥无效");
    };
    await show(port);
    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    await typeInto(input, "sk-bad");
    await act(async () => {
      (container.querySelector("button.primary") as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain("密钥无效");
    expect(container.querySelector(".app")).toBeNull();
  });

  it("密钥有效：进工作台", async () => {
    const port = createFakePort();
    port.session.readStoredKey = () => null;
    await show(port);
    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    await typeInto(input, "sk-good");
    await act(async () => {
      (container.querySelector("button.primary") as HTMLButtonElement).click();
    });
    expect(container.querySelector(".app")).not.toBeNull();
  });
});

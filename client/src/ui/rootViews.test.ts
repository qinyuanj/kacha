// @vitest-environment jsdom
// 进入界面的各个区块（#137）：密钥表单、会话失效模态与聚焦。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyEntryForm, SessionExpiredModal, fatalText, useKeyFocus } from "./rootViews";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("密钥表单", () => {
  it("没有密钥：不能进入", async () => {
    await act(async () => dom.render(createElement(KeyEntryForm, { apiKey: "", busy: false, error: null, version: null, onChange: vi.fn(), onSubmit: vi.fn(), inputRef: { current: null } })));
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("进入工作台"));
    expect(button?.disabled).toBe(true);
  });

  it("有密钥：可以进入", async () => {
    const onSubmit = vi.fn();
    await act(async () => dom.render(createElement(KeyEntryForm, { apiKey: "sk-x", busy: false, error: null, version: null, onChange: vi.fn(), onSubmit, inputRef: { current: null } })));
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("进入工作台"));
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(onSubmit).toHaveBeenCalled();
  });

  it("忙：不能进入", async () => {
    await act(async () => dom.render(createElement(KeyEntryForm, { apiKey: "sk-x", busy: true, error: null, version: null, onChange: vi.fn(), onSubmit: vi.fn(), inputRef: { current: null } })));
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("正在向网关验证"));
    expect(button?.disabled).toBe(true);
  });

  it("有错误：显示出来", async () => {
    await act(async () => dom.render(createElement(KeyEntryForm, { apiKey: "sk-x", busy: false, error: "密钥无效", version: null, onChange: vi.fn(), onSubmit: vi.fn(), inputRef: { current: null } })));
    expect(container.textContent).toContain("密钥无效");
  });

  it("回车提交（Shift+回车换行）", async () => {
    const onSubmit = vi.fn();
    await act(async () => dom.render(createElement(KeyEntryForm, { apiKey: "sk-x", busy: false, error: null, version: null, onChange: vi.fn(), onSubmit, inputRef: { current: null } })));
    const area = container.querySelector("textarea");
    await act(async () => {
      area?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalled();
  });

  it("版本号：显示出来", async () => {
    await act(async () => dom.render(createElement(KeyEntryForm, { apiKey: "sk-x", busy: false, error: null, version: "1.2.3", onChange: vi.fn(), onSubmit: vi.fn(), inputRef: { current: null } })));
    expect(container.textContent).toContain("Kacha 版本 1.2.3");
  });
});

describe("会话失效模态", () => {
  it("盖住工作台但保留里面的内容", async () => {
    await act(async () => dom.render(createElement(SessionExpiredModal, { children: createElement("span", null, "工作台") })));
    expect(container.textContent).toContain("会话已失效");
    expect(container.textContent).toContain("工作台");
  });
});

describe("聚焦", () => {
  it("进入界面时聚焦到密钥输入框", async () => {
    const input = document.createElement("textarea");
    document.body.append(input);
    const ref = { current: input };
    const Probe = () => {
      useKeyFocus("enter", false, ref as never);
      return null;
    };
    await act(async () => dom.render(createElement(Probe)));
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});

describe("连不上服务端", () => {
  it("给一句说明", () => {
    expect(fatalText("offline")).toContain("offline");
  });
});

// @vitest-environment jsdom
// 高级设置面板的可见行为（#137）：地址错误、明文 HTTP 提示、连接测试按钮、并发上限钳制、保存禁用。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { SettingsPanel } from "./SettingsPanel";
import type { SettingsState } from "./useSettingsOps";

// React 19 的 act() 要在测试环境里显式打开。
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

type PanelSettings = SettingsState & {
  save(next: unknown, apiKey: string): Promise<string | null>;
  testConnection(baseUrl: string, apiKey: string): Promise<{ ok: true; count: number } | { ok: false; message: string }>;
};

function settings(overrides: Partial<SettingsState> = {}): PanelSettings {
  return {
    loaded: true,
    file: "ok",
    fileProblem: null,
    settings: DEFAULT_SETTINGS,
    apiKey: "sk-x",
    keyPersistence: "persisted",
    discovery: { source: "none" },
    save: vi.fn(async () => null),
    testConnection: vi.fn(async () => ({ ok: true as const, count: 3 })),
    ...overrides,
  } as unknown as PanelSettings;
}

async function show(port: FakePort, state = settings()): Promise<void> {
  await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(SettingsPanel, { settings: state, onClose: vi.fn() }) })));
}

/** 密钥输入框（密码框，不把密钥显示成普通文本）。 */
function keyInput(): HTMLInputElement {
  const el = container.querySelector("input[type='password']");
  if (!el) throw new Error("没有找到 API 密钥输入框");
  return el as HTMLInputElement;
}

/** 按文字找按钮。 */
function buttonWithText(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`没有找到按钮 ${text}`);
  return el as HTMLButtonElement;
}

/** 像用户键入一样改受控输入框的值。 */
async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}


describe("API 密钥管理（#152）", () => {
  it("密钥框是密码输入，状态只说受系统保护，不把密钥显示成正文", async () => {
    await show(createFakePort(), settings({ apiKey: "sk-visible-only-in-input" }));
    expect(keyInput().type).toBe("password");
    expect(keyInput().value).toBe("sk-visible-only-in-input");
    expect(container.textContent).toContain("Windows 系统保护");
    expect(container.textContent).not.toContain("当前无法设置 API 密钥");
  });

  it("输入新密钥后测试连接：用草稿密钥，不用旧值", async () => {
    const state = settings({ apiKey: "sk-old" });
    await show(createFakePort(), state);
    await typeInto(keyInput(), "sk-new-draft");
    await act(async () => buttonWithText("测试连接并刷新模型").click());
    expect(state.testConnection).toHaveBeenCalledWith(DEFAULT_SETTINGS.base_url, "sk-new-draft");
  });

  it("保存：把草稿里的新密钥交给 save，替换即可生效", async () => {
    const state = settings({ apiKey: "sk-old" });
    await show(createFakePort(), state);
    await typeInto(keyInput(), "sk-replacement");
    await act(async () => buttonWithText("保存").click());
    expect(state.save).toHaveBeenCalledWith(DEFAULT_SETTINGS, "sk-replacement");
  });

  it("清除密钥：显式调用 save 写入空密钥", async () => {
    const state = settings({ apiKey: "sk-old" });
    await show(createFakePort(), state);
    await act(async () => buttonWithText("清除密钥").click());
    expect(state.save).toHaveBeenCalledWith(DEFAULT_SETTINGS, "");
    await act(async () => undefined);
    expect(keyInput().value).toBe("");
  });

  it("没有有效发现时明确说明模型不可选，不拿上架清单冒充成功", async () => {
    await show(createFakePort(), settings({ discovery: { source: "none" } }));
    expect(container.textContent).toContain("模型不可选");
  });
});
describe("高级设置面板", () => {
  it("地址非法：显示错误，保存与连接测试都不可用", async () => {
    const port = createFakePort();
    await show(port);
    const input = container.querySelector("input") as HTMLInputElement;
    await typeInto(input, "不是地址");
    expect(container.textContent).toContain("地址格式无效");
    expect(buttonWithText("保存").disabled).toBe(true);
    expect(buttonWithText("测试连接并刷新模型").disabled).toBe(true);
  });

  it("明文 HTTP：给出风险提示", async () => {
    const port = createFakePort();
    await show(port);
    expect(container.textContent).toContain("明文 HTTP");
  });

  it("没有密钥：连接测试不可用，保存仍可用", async () => {
    const port = createFakePort();
    await show(port, settings({ apiKey: "" }));
    expect(buttonWithText("测试连接并刷新模型").disabled).toBe(true);
    expect(buttonWithText("保存").disabled).toBe(false);
  });

  it("连接测试：点一下调 testConnection 并显示结果", async () => {
    const port = createFakePort();
    const state = settings();
    await show(port, state);
    await act(async () => buttonWithText("测试连接并刷新模型").click());
    expect(state.testConnection).toHaveBeenCalled();
    expect(container.textContent).toContain("连接成功，网关提供 3 个模型");
  });

  it("并发上限：失焦时钳到范围", async () => {
    const port = createFakePort();
    await show(port);
    const number = container.querySelector("input[type='number']") as HTMLInputElement;
    await typeInto(number, "99");
    await act(async () => number.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(number.value).toBe("10");
  });

  it("settings.json 是新版：保存置灰（不能覆盖）", async () => {
    const port = createFakePort();
    await show(port, settings({ file: "newer" }));
    expect(buttonWithText("保存").disabled).toBe(true);
  });

  it("文件有问题：给出提示", async () => {
    const port = createFakePort();
    await show(port, settings({ fileProblem: "settings.json 已损坏" }));
    expect(container.textContent).toContain("settings.json 已损坏");
  });
});

describe("诊断包导出（#162）", () => {
  it("有诊断能力时显示导出入口，点一次只导出一次", async () => {
    const port = createFakePort();
    await show(port);
    await act(async () => buttonWithText("导出诊断包").click());
    expect(port.calls.exportDiagnostics).toBe(1);
  });

  it("没有诊断能力时不显示入口，不用空按钮冒充交付", async () => {
    const port = createFakePort({ missing: ["diagnostics"] });
    await show(port);
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "导出诊断包")).toBe(false);
  });

  it("用户取消没有成功提示，只给中性说明", async () => {
    const port = createFakePort({ diagnosticsOutcome: { kind: "cancelled" } });
    await show(port);
    await act(async () => buttonWithText("导出诊断包").click());
    await act(async () => undefined);
    expect(container.textContent).not.toContain("已导出");
    expect(container.textContent).not.toContain("已保存");
    expect(container.textContent).toContain("已取消");
  });

  it("目标不可写或采集失败：显示明确原因", async () => {
    const port = createFakePort({ diagnosticsOutcome: { kind: "failed", message: "写入诊断包失败：拒绝访问" } });
    await show(port);
    await act(async () => buttonWithText("导出诊断包").click());
    await act(async () => undefined);
    expect(container.textContent).toContain("写入诊断包失败：拒绝访问");
  });
});

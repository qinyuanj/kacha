// @vitest-environment jsdom
// 首屏反馈表单（#206）：受控输入、发送前预览、取消语义与成功回执都从可见界面验证。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { FeedbackDialog } from "./FeedbackDialog";
import type { FeedbackAttachment, FeedbackSpec } from "../shell/port";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function byText<T extends Element>(selector: string, text: string): T {
  const el = [...container.querySelectorAll<T>(selector)].find((node) => node.textContent?.includes(text));
  if (!el) throw new Error(`没有找到元素：${text}`);
  return el;
}

async function show(port: FakePort): Promise<void> {
  await act(async () => root.render(createElement(ShellProvider, { port, children: createElement(FeedbackDialog, { version: "1.8.0", build: "42", boardName: "/tmp/boards/项目 A.kacha", onClose: () => undefined }) })));
}

async function setInput(label: string, value: string): Promise<void> {
  const input = byText<HTMLLabelElement>("label", label).querySelector("input, textarea");
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) throw new Error(`没有找到输入框：${label}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(text: string): Promise<void> {
  await act(async () => byText<HTMLButtonElement>("button", text).click());
}

describe("反馈对话框（#206）", () => {
  it("填写正文、取消与关闭都不调用 Feedback 端口", async () => {
    const port = createFakePort();
    await show(port);
    await setInput("正文", "在 C:/secret/项目 里生成失败");
    await click("取消");
    expect(port.calls.feedback).toHaveLength(0);
  });

  it("预览显示版本、构建、系统、仅名字的画板名与脱敏正文", async () => {
    await show(createFakePort());
    await setInput("正文", "打开 C:/secret/项目 时失败，密钥 sk-abcdef");
    await click("预览");
    expect(container.textContent).toContain("1.8.0");
    expect(container.textContent).toContain("42");
    expect(container.textContent).toContain(navigator.userAgent);
    expect(container.textContent).toContain("项目 A");
    expect(container.textContent).not.toContain("/tmp/boards/");
    expect(container.textContent).toContain("<本地路径>");
    expect(container.textContent).not.toContain("sk-abcdef");
  });

  it("确认后通过 Feedback 端口发送并显示 issue 编号与可点击链接", async () => {
    const port = createFakePort();
    await show(port);
    await setInput("标题", "生成失败");
    await setInput("正文", "无法生成");
    await click("预览");
    await click("确认发送");
    expect(port.calls.feedback).toHaveLength(1);
    expect(port.calls.feedback[0]).toEqual(expect.objectContaining({ title: "生成失败", category: "缺陷", body: "无法生成", version: "1.8.0", build: "42", board_name: "项目 A" }));
    const link = byText<HTMLAnchorElement>("a", "#17");
    expect(link.href).toBe("https://gitea.test/kacha-feedback/issues/17");
  });

  it("选择截图后预览列出图片并随 Feedback 端口发送", async () => {
    const shot = new File([new Uint8Array([137, 80, 78, 71])], "画面.png", { type: "image/png" });
    const port = createFakePort({ pickImages: [[shot]] });
    await show(port);
    await setInput("正文", "截图里的错误");
    await click("选择截图");
    expect(container.textContent).toContain("画面.png");
    await click("预览");
    await click("确认发送");
    const sent = port.calls.feedback[0] as FeedbackSpec & { screenshots?: FeedbackAttachment[] };
    expect(sent.screenshots?.map((a) => a.name)).toEqual(["画面.png"]);
    expect(sent.screenshots?.[0]?.data).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("粘贴剪贴板截图后也能附上", async () => {
    const shot = new File([new Uint8Array([137, 80, 78, 71])], "剪贴板.png", { type: "image/png" });
    const port = createFakePort();
    await show(port);
    await setInput("正文", "粘贴截图");
    const dialog = container.querySelector("[role=dialog]")!;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [shot], items: [] } });
    await act(async () => dialog.dispatchEvent(event));
    await click("预览");
    await click("确认发送");
    const sent = port.calls.feedback[0] as FeedbackSpec & { screenshots?: FeedbackAttachment[] };
    expect(sent.screenshots?.map((a) => a.name)).toEqual(["剪贴板.png"]);
  });

  it("非图片、超过 10MB 与超过 5 张都有可操作提示", async () => {
    const notImage = new File(["x"], "说明.txt", { type: "text/plain" });
    const big = new File(["x"], "很大.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
    const many = Array.from({ length: 6 }, (_, i) => new File(["x"], `shot-${i}.png`, { type: "image/png" }));
    const port = createFakePort({ pickImages: [[notImage], [big], many] });
    await show(port);
    await setInput("正文", "检查附件");
    await click("选择截图");
    expect(container.textContent).toContain("只支持 PNG/JPG");
    await click("选择截图");
    expect(container.textContent).toContain("超过 10MB");
    await click("选择截图");
    expect(container.textContent).toContain("最多 5 张");
    expect(port.calls.feedback).toHaveLength(0);
  });

  it("勾选诊断包时附上脱敏包并在失败时明确报错", async () => {
    const pack = { kind: "saved" as const, name: "diagnostics.zip", contentType: "application/zip", data: "UEsDBA==" };
    const port = createFakePort({ diagnosticsPackOutcome: pack });
    await show(port);
    await setInput("正文", "需要诊断包");
    await click("附带脱敏诊断包");
    await click("预览");
    await click("确认发送");
    const sent = port.calls.feedback[0] as FeedbackSpec & { diagnostics_pack?: FeedbackAttachment };
    expect(sent.diagnostics_pack).toEqual({ name: pack.name, content_type: pack.contentType, data: pack.data });

  });

  it("诊断包生成失败时明确报错且不发送", async () => {
    const failed = createFakePort({ diagnosticsPackOutcome: { kind: "failed", message: "采集失败" } });
    await show(failed);
    await setInput("正文", "需要诊断包");
    await click("附带脱敏诊断包");
    expect(container.textContent).toContain("采集失败");
    expect(failed.calls.feedback).toHaveLength(0);
  });
  it("端口未配置时显示暂不可用并可重新发送", async () => {
    const port = createFakePort({ missing: ["feedback"] });
    await show(port);
    await setInput("正文", "无法生成");
    await click("预览");
    await click("确认发送");
    expect(container.textContent).toContain("反馈暂不可用");
    await click("重试");
    expect(port.calls.feedback).toHaveLength(2);
  });
});

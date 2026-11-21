// @vitest-environment jsdom
// 首屏反馈表单（#206）：受控输入、发送前预览、取消语义与成功回执都从可见界面验证。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { FeedbackDialog } from "./FeedbackDialog";
import type { FeedbackAttachment, FeedbackOutcome, FeedbackSpec } from "../shell/port";

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

async function show(port: FakePort, onClose: () => void = () => undefined): Promise<void> {
  await act(async () => root.render(createElement(ShellProvider, { port, children: createElement(FeedbackDialog, { version: "1.8.0", build: "42", boardName: "/tmp/boards/项目 A.kacha", onClose }) })));
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

function findButton(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(text));
}

async function field(labelText: string): Promise<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> {
  const control = byText<HTMLLabelElement>("label", labelText).querySelector("input, textarea, select");
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) {
    throw new Error(`没有找到控件：${labelText}`);
  }
  return control;
}

async function setSelect(labelText: string, value: string): Promise<void> {
  const select = await field(labelText);
  if (!(select instanceof HTMLSelectElement)) throw new Error(`没有找到下拉框：${labelText}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
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

describe("反馈预览、结局与重试（#208）", () => {
  const SUCCESS: FeedbackOutcome = {
    ok: true,
    kind: "ok",
    message: "已提交 #17",
    number: 17,
    url: "https://gitea.test/kacha-feedback/issues/17",
  };
  const FAILURE_CASES = [
    { kind: "unreachable" as const, expected: "网络不可达" },
    { kind: "rejected" as const, expected: "服务器拒绝" },
    { kind: "invalid" as const, expected: "内容无效" },
    { kind: "too_large" as const, expected: "内容过大" },
    { kind: "duplicate" as const, expected: "刚刚已提交过 #17" },
  ];

  it("预览里可直接修改标题、分类和正文后再确认发送", async () => {
    const port = createFakePort();
    await show(port);
    await setInput("标题", "旧标题");
    await setInput("正文", "旧正文");
    await click("预览");
    await setInput("标题", "新标题");
    await setSelect("分类", "建议");
    await setInput("正文", "新正文");
    await click("确认发送");
    expect(port.calls.feedback[0]).toEqual(expect.objectContaining({ title: "新标题", category: "建议", body: "新正文" }));
  });

  it.each(FAILURE_CASES)("$kind 映射为独立文案，不显示笼统失败", async ({ kind, expected }) => {
    const outcome: FeedbackOutcome = {
      ok: false,
      kind,
      message: "后端统一错误",
      ...(kind === "duplicate" ? { number: 17, url: SUCCESS.url } : {}),
    };
    const port = createFakePort({ feedbackOutcome: outcome });
    await show(port);
    await setInput("正文", "统一正文");
    await click("预览");
    await click("确认发送");

    expect(byText<HTMLElement>("[role=alert]", expected).textContent).toContain(expected);
    expect(container.textContent).not.toContain("后端统一错误");
    expect(container.textContent).not.toContain("提交失败，请稍后重试");
    expect(findButton("复制内容")).not.toBeUndefined();
    if (kind === "duplicate") {
      expect(findButton("重试")).toBeUndefined();
      const link = byText<HTMLAnchorElement>("a", "#17");
      expect(link.href).toBe(SUCCESS.url);
    } else {
      expect(findButton("重试")).not.toBeUndefined();
    }
  });

  it("失败后返回修改保留标题、分类、正文与附件", async () => {
    const shot = new File([new Uint8Array([137, 80, 78, 71])], "画面.png", { type: "image/png" });
    const port = createFakePort({
      pickImages: [[shot]],
      diagnosticsPackOutcome: { kind: "saved", name: "diagnostics.zip", contentType: "application/zip", data: "UEsDBA==" },
      feedbackOutcome: { ok: false, kind: "unreachable", message: "不可达" },
    });
    await show(port);
    await setInput("标题", "原样标题");
    await setInput("正文", "原样正文");
    await setSelect("分类", "建议");
    await click("选择截图");
    await click("附带脱敏诊断包");
    await click("预览");
    expect(container.textContent).toContain("附件摘要");
    expect(container.textContent).toContain("画面.png");
    expect(container.textContent).toContain("diagnostics.zip");
    await click("确认发送");
    expect(container.textContent).toContain("网络不可达");

    await click("返回修改");
    expect((await field("标题") as HTMLInputElement).value).toBe("原样标题");
    expect((await field("分类") as HTMLSelectElement).value).toBe("建议");
    expect((await field("正文") as HTMLTextAreaElement).value).toBe("原样正文");
    expect(container.textContent).toContain("画面.png");
    expect(findButton("取消附带脱敏诊断包")).not.toBeUndefined();
    expect(port.calls.feedback).toHaveLength(1);
  });

  it("重试直接复用首次提交的完整内容", async () => {
    let call = 0;
    const port = createFakePort({
      feedbackSend: async () => (call++ === 0 ? { ok: false, kind: "unreachable", message: "不可达" } : SUCCESS),
    });
    await show(port);
    await setInput("标题", "重试标题");
    await setInput("正文", "重试正文");
    await click("预览");
    await click("确认发送");
    expect(port.calls.feedback).toHaveLength(1);

    await click("重试");
    expect(port.calls.feedback).toHaveLength(2);
    expect(port.calls.feedback[1]).toEqual(port.calls.feedback[0]);
    expect(byText<HTMLAnchorElement>("a", "#17").href).toBe(SUCCESS.url);
  });

  it("失败后一键复制脱敏内容并禁用已复制按钮", async () => {
    const port = createFakePort({ feedbackOutcome: { ok: false, kind: "unreachable", message: "不可达" } });
    await show(port);
    await setInput("标题", "可复制标题");
    await setInput("正文", "打开 C:/secret/项目 失败，api_key: sk-abcdef");
    await click("预览");
    await click("确认发送");
    await click("复制内容");

    expect(port.calls.copyText).toHaveLength(1);
    const copied = port.calls.copyText[0];
    expect(copied).toContain("可复制标题");
    expect(copied).toContain("<本地路径>");
    expect(copied).not.toContain("C:/secret/项目");
    expect(copied).not.toContain("sk-abcdef");
    expect(findButton("已复制内容")?.disabled).toBe(true);
  });

  it("发送中禁用确认按钮，结局回来后显示回执", async () => {
    let resolveSend: (outcome: FeedbackOutcome) => void = () => undefined;
    const port = createFakePort({ feedbackSend: () => new Promise<FeedbackOutcome>((resolve) => { resolveSend = resolve; }) });
    await show(port);
    await setInput("正文", "等待发送");
    await click("预览");
    await click("确认发送");
    expect(byText<HTMLButtonElement>("button", "确认发送").disabled).toBe(true);
    await act(async () => resolveSend(SUCCESS));
    expect(container.textContent).toContain("已提交 #17");
  });

  it("预览取消不发送，失败后关闭只回调一次且不重复发送", async () => {
    const onClose = vi.fn();
    const port = createFakePort({ feedbackOutcome: { ok: false, kind: "unreachable", message: "不可达" } });
    await show(port, onClose);
    await setInput("正文", "取消语义");
    await click("预览");
    await click("取消");
    expect(port.calls.feedback).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);

    await click("确认发送");
    expect(port.calls.feedback).toHaveLength(1);
    onClose.mockClear();
    await click("关闭");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(port.calls.feedback).toHaveLength(1);
  });
});

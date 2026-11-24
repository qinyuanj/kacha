// @vitest-environment jsdom
// 首屏反馈表单（#206）：受控输入、发送前预览、取消语义与成功回执都从可见界面验证。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { FeedbackDialog, redactFeedbackText } from "./FeedbackDialog";
import { FEEDBACK_AUTH_REQUIRED, FEEDBACK_TOKEN_NOTICE, FEEDBACK_TOKEN_SCOPE } from "../core/feedback";
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

async function show(port: FakePort, onClose: () => void = () => undefined, relayUrl?: string): Promise<void> {
  await act(async () => root.render(createElement(ShellProvider, { port, children: createElement(FeedbackDialog, { version: "1.8.0", build: "42", boardName: "/tmp/boards/项目 A.kacha", relayUrl, onClose }) })));
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

/** 「将要提交」的只读展示块：脱敏结果只允许出现在这里，不在可编辑控件里。 */
function submitPreview(): Element {
  const block = container.querySelector(".feedback-preview-submit");
  if (!block) throw new Error("没有找到「将要提交」展示块");
  return block;
}

/** 按用户看得到的中文选项选择，返回真正交给端口的稳定 code。 */
async function setSelectByVisibleLabel(labelText: string, optionText: string): Promise<string> {
  const select = await field(labelText);
  if (!(select instanceof HTMLSelectElement)) throw new Error(`没有找到下拉框：${labelText}`);
  const option = [...select.options].find((item) => item.textContent?.trim() === optionText);
  if (!option) throw new Error(`没有找到选项：${optionText}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, option.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return option.value;
}

describe("反馈对话框（#206）", () => {
  it("填写正文后取消或关闭都不调用 Feedback 端口", async () => {
    const port = createFakePort();
    const onClose = vi.fn();
    await show(port, onClose);
    await setInput("正文", "在 C:/secret/项目 里生成失败");
    await click("取消");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(port.calls.feedback).toHaveLength(0);
    onClose.mockClear();
    await act(async () => (container.querySelector('[aria-label="关闭反馈"]') as HTMLButtonElement).click());
    await act(async () => undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
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
    // 脱敏只属于「将要提交」那一块：可编辑正文里是用户原文，不能拿整页文本判定。
    const willSubmit = submitPreview();
    expect(willSubmit.textContent).toContain("<本地路径>");
    expect(willSubmit.textContent).not.toContain("sk-abcdef");
  });

  it("预览里的可编辑控件绑定原文，只有「将要提交」的展示才是脱敏值", async () => {
    // #229 复审必修 1：可编辑控件曾绑定脱敏后的 props.spec.title，onChange 却写入原始 state。
    // 用户看到「<已隐藏>」，一编辑就把原文写回去，输入框随即回弹/错位。
    // 契约：输入框显示并可编辑原文；脱敏结果只出现在「将要提交」展示与最终 spec。
    const port = createFakePort();
    const bareToken = "0123456789abcdef0123456789abcdef01234567";
    await show(port);
    await setInput("标题", `泄露 ${bareToken}`);
    await setInput("正文", "正文照常");
    await click("预览");

    expect((await field("标题")) as HTMLInputElement).toMatchObject({ value: `泄露 ${bareToken}` });

    const willSubmit = submitPreview();
    expect(willSubmit.textContent).toContain("泄露 <已隐藏>");
    expect(willSubmit.textContent).not.toContain(bareToken);

    await click("确认发送");
    expect(port.calls.feedback[0]).toEqual(expect.objectContaining({ title: "泄露 <已隐藏>" }));
  });

  it("确认后通过 Feedback 端口发送并显示 issue 编号与可点击链接", async () => {
    const port = createFakePort();
    await show(port);
    await setInput("标题", "生成失败");
    await setInput("正文", "无法生成");
    await click("预览");
    await click("确认发送");
    expect(port.calls.feedback).toHaveLength(1);
    expect(port.calls.feedback[0]).toEqual(expect.objectContaining({ title: "生成失败", category: "bug", body: "无法生成", version: "1.8.0", build: "42", board_name: "项目 A" }));
    const link = byText<HTMLAnchorElement>("a", "#17");
    expect(link.href).toBe("https://gitea.test/kacha-feedback/issues/17");
  });

  it("分类下拉显示中文标签，发送时用稳定英文 code", async () => {
    const port = createFakePort();
    await show(port);
    const select = await field("分类") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["缺陷", "需求", "建议", "其他"]);
    expect(await setSelectByVisibleLabel("分类", "需求")).toBe("feature");
    await setInput("正文", "分类契约");
    await click("预览");
    expect(container.textContent).toContain("分类：需求");
    await click("确认发送");
    expect(port.calls.feedback[0]).toEqual(expect.objectContaining({ category: "feature" }));
  });

  it("没有显式高级覆盖时不向 Feedback 端口发送 relay_url", async () => {
    const port = createFakePort();
    await show(port);
    await setInput("正文", "使用 Go 默认中继");
    await click("预览");
    await click("确认发送");
    expect(port.calls.feedback[0]).not.toHaveProperty("relay_url");
  });

  it("高级设置解析出的反馈中继地址随每次发送进入 Feedback 端口", async () => {
    const port = createFakePort();
    await show(port, undefined, "http://relay.test:3105");
    await setInput("正文", "无法生成");
    await click("预览");
    await click("确认发送");
    expect(port.calls.feedback).toHaveLength(1);
    expect(port.calls.feedback[0]).toEqual(expect.objectContaining({ relay_url: "http://relay.test:3105" }));
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

  it("勾选诊断包时附上脱敏包", async () => {
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
  it("诊断能力关闭时不显示附带诊断包入口", async () => {
    const port = createFakePort({ missing: ["diagnostics"] });
    await show(port);
    expect(findButton("附带脱敏诊断包")).toBeUndefined();
    expect(findButton("取消附带脱敏诊断包")).toBeUndefined();
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
    { kind: "unreachable" as const, expected: "反馈中继不可达" },
    { kind: "unauthorized" as const, expected: "Gitea token 无效或权限不足" },
    { kind: "rejected" as const, expected: "反馈被中继拒绝" },
    { kind: "invalid" as const, expected: "反馈内容不合法" },
    { kind: "too_large" as const, expected: "反馈内容过大" },
    { kind: "duplicate" as const, expected: "刚刚已提交过 #17" },
  ];

  it("预览里可直接修改标题、分类和正文后再确认发送", async () => {
    const port = createFakePort();
    await show(port);
    await setInput("标题", "旧标题");
    await setInput("正文", "旧正文");
    await click("预览");
    await setInput("标题", "新标题");
    expect(await setSelectByVisibleLabel("分类", "建议")).toBe("suggestion");
    await setInput("正文", "新正文");
    await click("确认发送");
    expect(port.calls.feedback[0]).toEqual(expect.objectContaining({ title: "新标题", category: "suggestion", body: "新正文" }));
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
    await setSelectByVisibleLabel("分类", "建议");
    await click("选择截图");
    await click("附带脱敏诊断包");
    await click("预览");
    expect(container.textContent).toContain("附件摘要");
    expect(container.textContent).toContain("画面.png");
    expect(container.textContent).toContain("diagnostics.zip");
    await click("确认发送");
    expect(container.textContent).toContain("反馈中继不可达");

    await click("返回修改");
    expect((await field("标题") as HTMLInputElement).value).toBe("原样标题");
    expect((await field("分类") as HTMLSelectElement).value).toBe("suggestion");
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

  it("失败后一键复制脱敏内容、不复制正文里的密钥并禁用已复制按钮", async () => {
    const port = createFakePort({ feedbackOutcome: { ok: false, kind: "unreachable", message: "不可达" } });
    await show(port);
    await setInput("标题", "可复制标题");
    await setInput("正文", "打开 C:/secret/项目 失败，api_key: user-api-key-abc");
    await click("预览");
    await click("确认发送");
    await click("复制内容");

    expect(port.calls.copyText).toHaveLength(1);
    const copied = port.calls.copyText[0];
    expect(copied).toContain("可复制标题");
    expect(copied).toContain("<本地路径>");
    expect(copied).not.toContain("C:/secret/项目");
    expect(copied).not.toContain("user-api-key-abc");
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

describe("Gitea 一键授权（#242）", () => {
  it("未授权时显示一键授权按钮，拦下预览且不发送", async () => {
    const port = createFakePort({ feedbackAuthStatus: { authorized: false, pending: false, message: "" } });
    await show(port);
    await setInput("正文", "未授权正文");
    expect(findButton("一键授权 Gitea")).not.toBeUndefined();
    expect(findButton("预览")!.disabled).toBe(true);
    expect(container.textContent).toContain(FEEDBACK_AUTH_REQUIRED);
    expect(port.calls.feedback).toHaveLength(0);
  });

  it("点击授权后轮询到已授权即可预览和发送", async () => {
    const port = createFakePort({ feedbackAuthStatus: { authorized: false, pending: false, message: "" } });
    await show(port);
    const original = port.feedback.authStatus;
    port.feedback.authStatus = async () => {
      port.feedback.authStatus = original;
      return { authorized: true, pending: false, message: "已授权" };
    };
    await click("一键授权 Gitea");
    expect(port.calls.feedbackAuthStart).toBe(1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    await setInput("正文", "授权后正文");
    expect(findButton("预览")!.disabled).toBe(false);
    await click("预览");
    await click("确认发送");
    expect(port.calls.feedback).toHaveLength(1);
    expect(port.calls.feedback[0]).not.toHaveProperty("gitea_token");
  });

  it("一键授权失败时显示可操作原因，不进入等待状态", async () => {
    const port = createFakePort({
      feedbackAuthStatus: { authorized: false, pending: false, message: "" },
      feedbackAuthStart: { ok: false, url: "", message: "本机回调端口不可用" },
    });
    await show(port);
    await click("一键授权 Gitea");
    await act(async () => undefined);
    expect(container.textContent).toContain("本机回调端口不可用");
    expect(findButton("等待授权…")).toBeUndefined();
  });

  it("浏览器没自动打开时给出可点击的授权地址", async () => {
    const port = createFakePort({
      feedbackAuthStatus: { authorized: false, pending: false, message: "" },
      feedbackAuthStart: { ok: true, url: "https://gitea.test/oauth/authorize", message: "请在浏览器完成授权" },
    });
    await show(port);
    await click("一键授权 Gitea");
    await act(async () => undefined);
    const link = [...container.querySelectorAll("a")].find((node) => node.textContent === "打开授权页面") as HTMLAnchorElement;
    expect(link.href).toContain("https://gitea.test/oauth/authorize");
  });

  it("授权状态读取失败时不崩，仍给出一键授权入口", async () => {
    const port = createFakePort();
    port.feedback.authStatus = async () => { throw new Error("status failure"); };
    await show(port);
    expect(findButton("一键授权 Gitea")).not.toBeUndefined();
  });
  it("预览只说明本机授权去向与权限范围", async () => {
    await show(createFakePort());
    await setInput("正文", "权限说明");
    await click("预览");
    expect(container.textContent).toContain("使用本机 Gitea 授权提交到 kacha-feedback");
    expect(container.textContent).toContain("建 issue");
    expect(container.textContent).toContain("评论");
    expect(container.textContent).toContain("打标签");
    expect(container.textContent).toContain("上传附件");
  });

  // #229：脱敏断言必须和输入指向同一个值。逐条先证明它真的在输入里，再证明脱敏后不在了，
  // 任何一类规则被删掉，对应断言都会变红。
  const prefixedSecrets = ["abc123", "def456", "ghi789", "ghp_synthetic1234567890"];
  // 裸 Gitea token 的典型形态：40 位十六进制，没有 key= 前缀。
  const bareHexToken = "0123456789abcdef0123456789abcdef01234567";
  // 裸占位符按片段拼出来，保证运行时得到的就是这段字面量，而不是被替换成别的值。
  const bareSecretPlaceholder = "{{SECRET" + "_fixture}}";

  it("正文脱敏隐藏带前缀凭据、裸 40 位 token 与裸占位符", () => {
    const input = [
      `token=${prefixedSecrets[0]}`,
      `api_key=${prefixedSecrets[1]}`,
      `gateway_key=${prefixedSecrets[2]}`,
      prefixedSecrets[3],
      bareHexToken,
      bareSecretPlaceholder,
    ].join(" ");
    const redacted = redactFeedbackText(input);
    for (const secret of [...prefixedSecrets, bareHexToken, bareSecretPlaceholder]) {
      expect(input).toContain(secret);
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("<已隐藏>");
  });

});

describe("裸凭据脱敏（#229）", () => {
  // 与上面同一组值：输入里放什么，就断言什么，界面、发送与复制三处都不许出现。
  const bareHexToken = "0123456789abcdef0123456789abcdef01234567";
  const bareSecretPlaceholder = "{{SECRET" + "_fixture}}";

  it("裸 40 位 token 与裸占位符在预览、发送正文与复制内容中都不出现", async () => {
    const port = createFakePort({ feedbackOutcome: { ok: false, kind: "unreachable", message: "不可达" } });
    await show(port);
    await setInput("标题", `同步失败 ${bareHexToken}`);
    await setInput("正文", `令牌 ${bareSecretPlaceholder} 与预期不一致`);
    await click("预览");
    // 预览的可编辑控件绑定的是原文（复审必修 1），脱敏证据只取「将要提交」那一块。
    const willSubmit = submitPreview();
    expect(willSubmit.textContent).not.toContain(bareHexToken);
    expect(willSubmit.textContent).not.toContain(bareSecretPlaceholder);

    await click("确认发送");
    expect(port.calls.feedback).toHaveLength(1);
    expect(port.calls.feedback[0].title).not.toContain(bareHexToken);
    expect(port.calls.feedback[0].body).not.toContain(bareSecretPlaceholder);

    await click("复制内容");
    expect(port.calls.copyText).toHaveLength(1);
    expect(port.calls.copyText[0]).toContain("标题：");
    expect(port.calls.copyText[0]).not.toContain(bareHexToken);
    expect(port.calls.copyText[0]).not.toContain(bareSecretPlaceholder);
  });
});

describe("弹窗语义结构（#219）", () => {
  it("反馈弹窗用可见标题作为无障碍名称，字段标签走语义类名而不是位置选择器", async () => {
    await show(createFakePort());
    const dialog = container.querySelector<HTMLElement>("[role=dialog]")!;
    const labelledBy = dialog.getAttribute("aria-labelledby")!;
    const heading = container.querySelector<HTMLElement>(`#${labelledBy}`)!;
    expect(heading.textContent).toBe("反馈");
    expect(dialog.contains(heading)).toBe(true);
    const labels = [...dialog.querySelectorAll(".form-row > .form-row-label")].map((el) => el.textContent);
    expect(labels).toEqual(expect.arrayContaining(["标题（可选）", "分类", "正文"]));
  });

  it("截图说明行把标签与「选择截图」按钮各自成元素，不再压成窄条", async () => {
    await show(createFakePort());
    const label = [...container.querySelectorAll(".form-row-label")].find((el) => el.textContent?.includes("截图"));
    expect(label).toBeDefined();
    expect(label!.parentElement!.querySelector("button")?.textContent).toBe("选择截图");
  });

  it("附件以列表项渲染，移除按钮按名字可辨且能移除该项", async () => {
    const shot = new File([new Uint8Array([137, 80, 78, 71])], "画面.png", { type: "image/png" });
    const port = createFakePort({ pickImages: [[shot]] });
    await show(port);
    await click("选择截图");
    const list = container.querySelector("ul.feedback-attachments")!;
    expect(list).not.toBeNull();
    expect(list.querySelectorAll("li.feedback-attachment")).toHaveLength(1);
    const remove = list.querySelector<HTMLButtonElement>("button.feedback-attachment-remove")!;
    expect(remove.getAttribute("aria-label")).toBe("移除 画面.png");
    await act(async () => remove.click());
    expect(container.querySelector("ul.feedback-attachments")).toBeNull();
  });

  it("预览把令牌说明、权限范围与元数据说明分成独立块", async () => {
    await show(createFakePort());
    await setInput("正文", "语义块");
    await click("预览");
    expect(container.querySelector(".feedback-token-notice")?.textContent).toBe(FEEDBACK_TOKEN_NOTICE);
    expect(container.querySelector(".feedback-token-scope")?.textContent).toBe(FEEDBACK_TOKEN_SCOPE);
    expect(container.querySelector(".feedback-preview-meta")?.textContent).toContain("只含画板名字");
  });

  it("提交成功的回执块给出可点击外链与独立地址行", async () => {
    await show(createFakePort());
    await setInput("正文", "回执结构");
    await click("预览");
    await click("确认发送");
    const receipt = container.querySelector<HTMLElement>(".feedback-receipt")!;
    expect(receipt.querySelector("a")?.getAttribute("href")).toBe("https://gitea.test/kacha-feedback/issues/17");
    expect(receipt.querySelector(".feedback-url")?.textContent).toContain("gitea.test");
  });

  it("失败回执把返回链接放在独立行，错误说明是可读的提示块", async () => {
    const outcome: FeedbackOutcome = { ok: false, kind: "duplicate", message: "重复", number: 17, url: "https://gitea.test/kacha-feedback/issues/17" };
    await show(createFakePort({ feedbackOutcome: outcome }));
    await setInput("正文", "重复提交");
    await click("预览");
    await click("确认发送");
    expect(container.querySelector(".feedback-return-link a")?.getAttribute("href")).toBe("https://gitea.test/kacha-feedback/issues/17");
    expect(container.querySelector(".form-alert")?.textContent).toContain("刚刚已提交过 #17");
  });
});

// @vitest-environment jsdom
// 工作台的可见行为（#137）：没有画板时的空工作台、提示条、设置面板入口、画板包菜单的禁用。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardListing } from "../shell/types";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { emptySnapshot, type UpdateSnapshot } from "../core/update";
import { ShellProvider } from "./shell";
import { App } from "../App";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 画布太重（React Flow），测试里替掉：断言工作台这一层的接线。
vi.mock("./BoardCanvas", () => ({ BoardCanvas: () => createElement("div", { className: "canvas" }) }));

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

function listing(boards: BoardListing["boards"] = []): BoardListing {
  return { boards, slots: { used: 0, total: 10 }, size_lines: { warn: 100, alert: 200 } };
}

/** 更新快照（#180）：默认是已下载并验签的 1.6.2。 */
const updateSnapshot = (patch: Partial<UpdateSnapshot>): UpdateSnapshot => ({
  ...emptySnapshot(),
  version: "1.6.2",
  verified: true,
  installable: true,
  downloaded: 100,
  total: 100,
  ...patch,
});

async function show(port: FakePort, props: { version?: string | null } = {}): Promise<void> {
  await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(App, { ...props }) })));
}

describe("工作台", () => {
  it("启动后新建一块画板：标签页上有它", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    await vi.waitFor(() => expect(container.textContent).toContain("未命名画板"));
  });

  it("顶栏：画板包、设置与版本入口都在", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, { version: "1.2.3" });
    expect(container.textContent).toContain("画板包");
    expect(container.textContent).toContain("高级设置");
    expect(container.textContent).toContain("Kacha 1.2.3");
  });

  it("工具栏：画板打开时给可用的工具栏", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    await vi.waitFor(() => expect(container.querySelector(".board-toolbar-slot")).not.toBeNull());
  });

  it("画板包菜单：没有画板时导出与下载置灰", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    const packButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("画板包"));
    await act(async () => packButton?.click());
    expect(container.textContent).toContain("导入画板包…");
  });

  it("用量提醒：到了上限时给出提醒与管理画板入口", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.usage.usage = async () => ({
      total_bytes: 200,
      boards_bytes: 100,
      meta_bytes: 100,
      last_access: 0,
      by_date: [],
      unreferenced: null,
      unreadable_board: null,
      limit_bytes: 100,
      limit_level: "alert",
    });
    await show(port);
    await vi.waitFor(() => expect(container.textContent).toContain("用量已满"));
    expect(container.textContent).toContain("管理画板");
  });

  it("没有用量提醒：不显示那条提示", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.usage.usage = async () => ({
      total_bytes: 10,
      boards_bytes: 10,
      meta_bytes: 0,
      last_access: 0,
      by_date: [],
      unreferenced: null,
      unreadable_board: null,
      limit_bytes: null,
      limit_level: null,
    });
    await show(port);
    expect(container.textContent).not.toContain("用量已满");
  });

  it("高级设置：点开后面板出现，关掉后消失", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    const settingsButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("高级设置"));
    await act(async () => settingsButton?.click());
    const settingsPanel = container.querySelector("[aria-label='高级设置']");
    expect(settingsPanel).not.toBeNull();
    const close = [...(settingsPanel?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "关闭");
    await act(async () => close?.click());
    expect(container.querySelector("[aria-label='高级设置']")).toBeNull();
  });

  it("画板列表：点开列表后显示画板", async () => {
    const port = createFakePort();
    port.board.list = async () => listing([{ name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: 10 }]);
    await show(port);
    const listButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("画板"));
    await act(async () => listButton?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("a"));
  });

  it("更新已就绪：主界面提示条就看得见，不用进高级设置（#180）", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.update.status = async () => updateSnapshot({ phase: "ready" });
    await show(port);
    await vi.waitFor(() => expect(container.querySelector(".update-status")?.getAttribute("data-update-phase")).toBe("ready"));
  });

  it("下载中：提示条带着进度", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.update.status = async () => updateSnapshot({ phase: "downloading", downloaded: 40, total: 100 });
    await show(port);
    await vi.waitFor(() => expect(container.querySelector(".update-status")?.textContent).toContain("正在下载 1.6.2（40%）"));
  });

  it("点「稍后」：本轮不再自动装", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    let snapshot = updateSnapshot({ phase: "downloading", downloaded: 0 });
    port.update.status = async () => snapshot;
    await show(port);
    await vi.waitFor(() => expect(container.textContent).toContain("正在下载"));
    // 下载完成：倒计时开始，主界面出现「稍后」。
    snapshot = updateSnapshot({ phase: "ready" });
    await vi.waitFor(() => expect(container.textContent).toContain("稍后"));
    const later = [...container.querySelectorAll("button")].find((b) => b.textContent === "稍后");
    await act(async () => later?.click());
    expect(container.textContent).toContain("本次不再自动安装");
    expect(port.calls.updateInstall).toBe(0);
  });

  it("首屏反馈预览使用真实产品版本作为 build，不显示未知", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, { version: "1.9.9" });
    const feedback = [...container.querySelectorAll("button")].find((button) => button.textContent === "反馈");
    await act(async () => feedback?.click());
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "真实构建标识");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const preview = [...container.querySelectorAll("button")].find((button) => button.textContent === "预览");
    await act(async () => preview?.click());
    expect(container.textContent).toContain("build 1.9.9");
    expect(container.textContent).not.toContain("build 未知");
  });

  it("反馈能力关闭：入口标暂不可用，打开后发送给出不可用并可重试", async () => {
    const port = createFakePort({ missing: ["feedback"] });
    port.board.list = async () => listing();
    await show(port);
    const feedback = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("反馈"));
    expect(feedback?.textContent).toContain("暂不可用");
    await act(async () => feedback?.click());
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "能力关闭也要能重试");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const preview = [...container.querySelectorAll("button")].find((button) => button.textContent === "预览");
    await act(async () => preview?.click());
    const send = [...container.querySelectorAll("button")].find((button) => button.textContent === "确认发送");
    await act(async () => send?.click());
    expect(container.textContent).toContain("反馈暂不可用");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "重试");
    await act(async () => retry?.click());
    expect(port.calls.feedback).toHaveLength(2);
  });

  it("首屏反馈入口：打开表单后可以关闭", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    const feedback = [...container.querySelectorAll("button")].find((button) => button.textContent === "反馈");
    await act(async () => feedback?.click());
    expect(container.textContent).toContain("标题（可选）");
    const cancel = [...container.querySelectorAll("button")].find((button) => button.textContent === "取消");
    await act(async () => cancel?.click());
    expect(container.textContent).not.toContain("标题（可选）");
  });

  it("已有画板：从列表打开后进入画板工作台", async () => {
    const port = createFakePort();
    port.board.list = async () => listing([{ name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: 10 }]);
    await show(port);
    const listButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("画板"));
    await act(async () => listButton?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("a"));
    const boardButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("a"));
    await act(async () => boardButton?.click());
    await vi.waitFor(() => expect(container.querySelector(".board-toolbar-slot")).not.toBeNull());
  });

  it("顶栏与用量提醒里的入口都能打开对应弹层", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.usage.usage = async () => ({
      total_bytes: 200,
      boards_bytes: 100,
      meta_bytes: 100,
      last_access: 0,
      by_date: [],
      unreferenced: null,
      unreadable_board: null,
      limit_bytes: 100,
      limit_level: "alert",
    });
    await show(port);
    await vi.waitFor(() => expect(container.textContent).toContain("管理画板"));
    for (const label of ["管理画板", "高级设置", "反馈", "画板包", "检查更新"]) {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
      await act(async () => button?.click());
    }
    for (const button of [...container.querySelectorAll<HTMLButtonElement>("button[aria-label*='关闭']")]) {
      await act(async () => button.click());
    }
  });

  it("已归档画板：取消归档与复制入口都能点", async () => {
    const port = createFakePort();
    port.board.list = async () => listing([{ name: "old.ugcboard.json", path: "/~/old.ugcboard.json", archived: true, bytes: 10 }]);
    await show(port);
    const listButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("画板列表"));
    await act(async () => listButton?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("old"));
    for (const label of ["取消归档", "复制为新画板"]) {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
      await act(async () => button?.click());
    }
  });

  it("版本入口打开更新说明后可关闭", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, { version: "1.2.3" });
    const versionButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Kacha 1.2.3"));
    await act(async () => versionButton?.click());
    const close = [...container.querySelectorAll("button")].find((button) => button.textContent === "关闭");
    await act(async () => close?.click());
  });
});

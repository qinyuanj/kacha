// @vitest-environment jsdom
// 画板列表对话框的可见行为（#137）：列表内容、已打开标记、归档分组、删除确认与失败提示、画板位满。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardListing } from "../shell/types";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { BoardListDialog } from "./BoardListDialog";

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

function listing(patch: Partial<BoardListing> = {}): BoardListing {
  return {
    boards: [
      { name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: 1024 },
      { name: "b.ugcboard.json", path: "/~/b.ugcboard.json", archived: true, bytes: null },
    ],
    slots: { used: 1, total: 10 },
    size_lines: { warn: 100, alert: 200 },
    ...patch,
  };
}

async function show(port: FakePort, props: Partial<Parameters<typeof BoardListDialog>[0]> = {}): Promise<void> {
  const base = {
    openPaths: [],
    onOpen: vi.fn(),
    onDelete: vi.fn(async () => undefined),
    onExport: vi.fn(),
    onClose: vi.fn(),
    onArchive: vi.fn(async () => undefined),
    onUnarchive: vi.fn(async () => null),
    onCopy: vi.fn(async () => null),
    ...props,
  };
  await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(BoardListDialog, base) })));
}

/** 按文字找按钮（在整个对话框里找第一个）。 */
function buttonWithText(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`没有找到按钮 ${text}`);
  return el as HTMLButtonElement;
}

/** 确认框（盖在列表之上的那层模态）里的按钮：避免和列表里的同名按钮混淆。 */
function confirmButton(text: string): HTMLButtonElement {
  const modals = container.querySelectorAll(".modal-backdrop > .modal");
  const last = modals[modals.length - 1];
  const el = [...last.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`确认框里没有找到按钮 ${text}`);
  return el as HTMLButtonElement;
}

describe("画板列表", () => {
  it("列出画板：标题去扩展名，体量写「约 X」", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    expect(container.textContent).toContain("a");
    expect(container.textContent).toContain("约 1.0 KiB");
    expect(container.textContent).toContain("大小未知");
  });

  it("本页已打开的画板标注「已打开」", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, { openPaths: ["/~/a.ugcboard.json"] });
    expect(container.textContent).toContain("已打开");
  });

  it("归档画板分组显示，且给取消归档与复制入口", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    expect(container.textContent).toContain("已归档");
    expect(buttonWithText("取消归档")).toBeDefined();
    expect(buttonWithText("复制为新画板")).toBeDefined();
  });

  it("普通列表：照存储端口给的顺序，不重排", async () => {
    const port = createFakePort();
    port.board.list = async () => listing({ boards: [
      { name: "z.ugcboard.json", path: "/~/z.ugcboard.json", archived: false, bytes: 1 },
      { name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: 9999 },
    ] });
    await show(port);
    expect([...container.querySelectorAll(".board-list-open")].map((b) => b.textContent)).toEqual(["z", "a"]);
  });

  it("列表说明：普通与管理各一句", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    expect(container.textContent).toContain("画板保存在这台电脑的数据根中");
    await show(port, { manage: true });
    expect(container.textContent).toContain("按画板体量从大到小排列");
  });

  it("超出画板位：顶部给出提醒", async () => {
    const port = createFakePort();
    port.board.list = async () => listing({ slots: { used: 11, total: 10 } });
    await show(port);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("删除不再需要的画板后才能新建");
  });

  it("体量档位：高于阈值才有档位", async () => {
    const port = createFakePort();
    port.board.list = async () => listing({ boards: [
      { name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: 50 },
      { name: "b.ugcboard.json", path: "/~/b.ugcboard.json", archived: false, bytes: 150 },
      { name: "c.ugcboard.json", path: "/~/c.ugcboard.json", archived: false, bytes: 2048 },
    ] });
    await show(port);
    const tiers = [...container.querySelectorAll("[data-size-tier]")].map((n) => n.getAttribute("data-size-tier"));
    expect(tiers).toEqual(["none", "warn", "alert"]);
  });

  it("取消归档 / 复制成功：不留在错误说明里", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, { onUnarchive: async () => null, onCopy: async () => null });
    await act(async () => buttonWithText("取消归档").click());
    await act(async () => buttonWithText("复制为新画板").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("取消归档 / 复制失败：显示原因", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, {
      onUnarchive: async () => { throw new Error("offline"); },
      onCopy: async () => { throw new Error("offline"); },
    });
    await act(async () => buttonWithText("取消归档").click());
    expect(container.textContent).toContain("offline");
    await act(async () => buttonWithText("复制为新画板").click());
    expect(container.textContent).toContain("offline");
  });

  it("删除 / 归档成功：确认框关闭", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    const onDelete = vi.fn(async () => undefined);
    await show(port, { onDelete });
    await act(async () => buttonWithText("删除").click());
    await act(async () => confirmButton("删除").click());
    expect(container.textContent).not.toContain("删除画板「a」？");
  });

  it("点画板名：打开并关闭列表", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    await show(port, { onOpen, onClose });
    await act(async () => buttonWithText("a").click());
    expect(onOpen).toHaveBeenCalledWith("/~/a.ugcboard.json");
    expect(onClose).toHaveBeenCalled();
  });

  it("删除：先弹确认框，确认后调删除", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    const onDelete = vi.fn(async () => undefined);
    await show(port, { onDelete });
    await act(async () => buttonWithText("删除").click());
    expect(container.textContent).toContain("删除画板「a」？");
    await act(async () => confirmButton("删除").click());
    expect(onDelete).toHaveBeenCalledWith("/~/a.ugcboard.json");
  });

  it("删除失败：错误留在确认框里", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    const onDelete = vi.fn(async () => {
      throw new Error("删除不掉了");
    });
    await show(port, { onDelete });
    await act(async () => buttonWithText("删除").click());
    await act(async () => confirmButton("删除").click());
    expect(container.textContent).toContain("删除失败：删除不掉了");
  });

  it("归档：先弹确认框，确认后调归档", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    const onArchive = vi.fn(async () => undefined);
    await show(port, { onArchive });
    await act(async () => buttonWithText("归档").click());
    expect(container.textContent).toContain("归档画板「a」？");
    await act(async () => confirmButton("归档").click());
    expect(onArchive).toHaveBeenCalledWith("/~/a.ugcboard.json");
  });

  it("画板位满：标出来", async () => {
    const port = createFakePort();
    port.board.list = async () => listing({ slots: { used: 10, total: 10 } });
    await show(port);
    expect(container.querySelector("[data-slots-full='true']")).not.toBeNull();
  });

  it("读列表失败：显示错误", async () => {
    const port = createFakePort();
    port.board.list = async () => {
      throw new Error("offline");
    };
    await show(port);
    expect(container.textContent).toContain("读取画板列表失败：offline");
  });

  it("管理画板：标题换掉，按体量从大到小", async () => {
    const port = createFakePort();
    port.board.list = async () => listing({ boards: [{ name: "s.ugcboard.json", path: "/~/s", archived: false, bytes: 10 }, { name: "l.ugcboard.json", path: "/~/l", archived: false, bytes: 900 }] });
    await show(port, { manage: true });
    expect(container.textContent).toContain("管理画板");
    const names = [...container.querySelectorAll(".board-list-open")].map((b) => b.textContent);
    expect(names).toEqual(["l", "s"]);
  });
});

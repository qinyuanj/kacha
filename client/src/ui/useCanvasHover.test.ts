// @vitest-environment jsdom
// 悬浮动作条：条目推导（悬浮节点还在不在画板、菜单开着、只读过滤、多选只出一条）与 150ms 宽限收起。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyMenu } from "../core/archive";
import { newBoard, type Board, type BoardNode } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import type { MenuFacts, MenuItem } from "../core/contextMenu";
import { actionBarView, useActionBarHover } from "./useCanvasHover";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reference = (id: string): BoardNode => ({ id, type: "reference", pos: [0, 0], size: [240, 160], path: `refs/${id}.png`, sha256: `sha-${id}`, display_name: id, extra: {} });
const boardOf = (...nodes: BoardNode[]): Board => ({ ...newBoard("画板"), nodes });

/** 画布的菜单事实：选区换过后由调用方传进来（原 menuFacts(selectedNodes)）。 */
function factsOf(board: Board, selected: ReadonlySet<string>): MenuFacts {
  return { board, table: BUILTIN_TABLE, selected, locked: new Set(), expanded: new Set(), undoLabel: null, redoLabel: null };
}

/** 可编辑画板的条目过滤：原样返回（readOnly ? readOnlyMenu : 这个）。 */
const identity = (items: MenuItem[]): MenuItem[] => items;

function view(board: Board, hovered: string | null, options: { selected?: string[]; menuOpen?: boolean; readOnly?: boolean } = {}) {
  return actionBarView({
    hovered,
    nodes: board.nodes,
    menuOpen: options.menuOpen ?? false,
    menuView: options.readOnly ? readOnlyMenu : identity,
    facts: factsOf(board, new Set(options.selected ?? [])),
  });
}

describe("actionBarView", () => {
  const board = boardOf(reference("r1"), reference("r2"));

  it("悬浮的图片节点还在画板上：条目按该节点给，挂在它自己身上", () => {
    const result = view(board, "r1");
    expect(result.present).toBe(true);
    expect(result.nodes).toEqual(["r1"]);
    expect(result.items.map((i) => i.action)).toEqual(["preview", "saveAs", "continueEditing"]);
  });

  it("没有悬浮、或悬浮的节点已不在画板上（撤销 / 删除后）都不显示", () => {
    expect(view(board, null)).toEqual({ present: false, nodes: [], items: [] });
    expect(view(board, "gone")).toEqual({ present: false, nodes: [], items: [] });
  });

  it("上下文菜单开着：动作条让位，但挂载节点照算", () => {
    const result = view(board, "r1", { menuOpen: true });
    expect(result.present).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.nodes).toEqual(["r1"]);
  });

  it("只读画板：条目只剩查看与下载，挂载节点不变", () => {
    const result = view(board, "r1", { readOnly: true });
    expect(result.items.map((i) => i.action)).toEqual(["preview", "saveAs"]);
    expect(result.nodes).toEqual(["r1"]);
  });

  it("悬浮在多选内的节点上：挂到整条选区上（选区上方只出一条）", () => {
    expect(view(board, "r1", { selected: ["r1", "r2"] }).nodes).toEqual(["r1", "r2"]);
    // 悬浮的节点不在选区里：仍然只挂悬浮的那个。
    expect(view(board, "r1", { selected: ["r2"] }).nodes).toEqual(["r1"]);
  });

  it("过滤后恰好一个条目：仍显示动作条", () => {
    const result = actionBarView({ hovered: "r1", nodes: board.nodes, menuOpen: false, menuView: (items) => items.slice(0, 1), facts: factsOf(board, new Set()) });
    expect(result.present).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.nodes).toEqual(["r1"]);
  });

  it("过滤后没有条目：不显示，挂载节点照算", () => {
    const result = actionBarView({ hovered: "r1", nodes: board.nodes, menuOpen: false, menuView: () => [], facts: factsOf(board, new Set()) });
    expect(result.present).toBe(false);
    expect(result.nodes).toEqual(["r1"]);
  });
});

describe("useActionBarHover", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let hover: ReturnType<typeof useActionBarHover>;

  function Probe(): null {
    hover = useActionBarHover();
    return null;
  }

  async function run(action: () => void): Promise<void> {
    await act(async () => action());
  }

  async function unmount(): Promise<void> {
    await act(async () => root?.unmount());
    root = null;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Probe)));
  });

  afterEach(async () => {
    await unmount();
    container.remove();
    vi.useRealTimers();
  });

  it("初始不显示；showActionBar(id) 显示，showActionBar(null) 只取消待收起", async () => {
    expect(hover.hovered).toBeNull();
    await run(() => hover.showActionBar("r1"));
    expect(hover.hovered).toBe("r1");
    await run(() => hover.showActionBar(null));
    expect(hover.hovered).toBe("r1");
  });

  it("离开后留 150ms 宽限才收起", async () => {
    await run(() => hover.showActionBar("r1"));
    await run(() => hover.hideActionBarSoon());
    // 宽限期间仍然显示（光标可以从节点移到动作条上）。
    expect(hover.hovered).toBe("r1");
    await run(() => vi.advanceTimersByTime(149));
    expect(hover.hovered).toBe("r1");
    await run(() => vi.advanceTimersByTime(1));
    expect(hover.hovered).toBeNull();
  });

  it("宽限期间回到节点 / 动作条：待收起被取消", async () => {
    await run(() => hover.showActionBar("r1"));
    await run(() => hover.hideActionBarSoon());
    await run(() => hover.showActionBar("r1"));
    await run(() => vi.advanceTimersByTime(500));
    expect(hover.hovered).toBe("r1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unhoverNode 只收起它自己，收不到别人的", async () => {
    await run(() => hover.showActionBar("r1"));
    await run(() => hover.unhoverNode("r2"));
    expect(hover.hovered).toBe("r1");
    await run(() => hover.unhoverNode("r1"));
    expect(hover.hovered).toBeNull();
  });

  it("卸载时清掉待收起的定时器", async () => {
    await run(() => hover.showActionBar("r1"));
    await run(() => hover.hideActionBarSoon());
    expect(vi.getTimerCount()).toBe(1);
    await unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

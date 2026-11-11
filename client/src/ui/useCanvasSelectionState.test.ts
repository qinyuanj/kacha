// @vitest-environment jsdom
// 画布选区与本地状态：丢弃不在画板上的选中 / 草稿 / 展开，聚焦请求与手动展开跟随选区。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newBoard, type Board, type BoardNode } from "../core/board";
import { toggleExpanded } from "../core/expand";
import { useCanvasSelectionState, type CanvasSelectionState } from "./useCanvasSelectionState";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prompt = (id: string): BoardNode => ({ id, type: "prompt", pos: [0, 0], size: [240, 120], text: id, extra: {} });
const boardOf = (...ids: string[]): Board => ({ ...newBoard("画板"), nodes: ids.map(prompt) });

let container: HTMLDivElement;
let root: Root;
let state: CanvasSelectionState;

function Probe({ board }: { board: Board }) {
  state = useCanvasSelectionState(board);
  return null;
}

async function show(board: Board): Promise<void> {
  await act(async () => root.render(createElement(Probe, { board })));
}

async function run(action: () => void): Promise<void> {
  await act(async () => action());
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("选区", () => {
  it("初始为空，选中经 state 与 ref 两处同步", async () => {
    await show(boardOf("a", "b"));
    expect(state.selectedNodes.size).toBe(0);
    expect(state.selectedEdges.size).toBe(0);

    await run(() => state.setSelectedNodes(new Set(["a"])));
    expect(state.selectedNodes).toEqual(new Set(["a"]));
    expect(state.selectedRef.current).toEqual(new Set(["a"]));

    await run(() => state.setSelectedEdges(new Set(["e1"])));
    expect(state.selection.edges.current).toEqual(new Set(["e1"]));
  });

  it("交给 useCanvasInteraction 的句柄把 setter 与 ref 都接出去", async () => {
    await show(boardOf("a"));
    expect(state.selection.nodes).toBe(state.selectedRef);
    // 连线选区 ref 只在 hook 内部（拼 selection），对外不单独暴露。
    expect(state.selection.edges.current).toEqual(new Set());
    await run(() => state.selection.setNodes(new Set(["a"])));
    expect(state.selectedRef.current).toEqual(new Set(["a"]));
  });

  it("撤销 / 删除后丢掉不在画板上的选中；没有变化时保留原对象", async () => {
    await show(boardOf("a", "b"));
    await run(() => state.setSelectedNodes(new Set(["a", "b"])));

    await show(boardOf("a"));
    expect(state.selectedNodes).toEqual(new Set(["a"]));

    // 再渲染同一份（新对象但节点 id 相同）画板：没有可丢的，保持原引用不触发重渲染。
    const stable = state.selectedNodes;
    await show(boardOf("a"));
    expect(state.selectedNodes).toBe(stable);
  });
});

describe("提示词草稿", () => {
  it("不在画板上的提示词不留未提交文本", async () => {
    await show(boardOf("p1", "p2"));
    await run(() => state.setPromptDrafts(new Map([["p1", "一"], ["p2", "二"]])));
    expect(state.promptDrafts.get("p2")).toBe("二");

    await show(boardOf("p1"));
    expect([...state.promptDrafts.keys()]).toEqual(["p1"]);
  });
});

describe("聚焦请求", () => {
  it("set 与清都同时写 ref 与 state（ref 是权威值）", async () => {
    await show(boardOf("p1"));
    await run(() => state.requestPromptFocus("p1"));
    expect(state.focusPrompt).toBe("p1");
    expect(state.focusPromptRef.current).toBe("p1");

    await run(() => state.requestPromptFocus(null));
    expect(state.focusPrompt).toBeNull();
    expect(state.focusPromptRef.current).toBeNull();
  });
});

describe("任务节点展开", () => {
  it("默认跟随选中", async () => {
    await show(boardOf("t1", "t2"));
    await run(() => state.setSelectedNodes(new Set(["t1"])));
    expect(state.expanded).toEqual(new Set(["t1"]));
  });

  it("手动切换覆盖默认，并在该节点选中状态变化后忘掉", async () => {
    await show(boardOf("t1", "t2"));
    await run(() => state.setSelectedNodes(new Set(["t1"])));
    await run(() => state.setExpandOverrides((o) => toggleExpanded(o, new Set(["t1"]), "t1")));
    // 选中却手动收起
    expect(state.expanded).toEqual(new Set());

    await run(() => state.setSelectedNodes(new Set(["t2"])));
    // t1 的选中状态变了：手动收起被忘掉，回到默认（未选中 → 折叠），t2 跟随选中
    expect(state.expanded).toEqual(new Set(["t2"]));
  });

  it("不在画板上的任务不留展开状态", async () => {
    await show(boardOf("t1", "t2"));
    await run(() => state.setSelectedNodes(new Set(["t2"])));
    await run(() => state.setExpandOverrides((o) => toggleExpanded(o, new Set(), "t1")));
    expect(state.expanded).toEqual(new Set(["t1", "t2"]));

    await show(boardOf("t2"));
    expect(state.expanded).toEqual(new Set(["t2"]));
  });
});

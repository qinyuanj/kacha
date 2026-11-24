// @vitest-environment jsdom
// useCanvasStageView 的接线：阶段收起 / 框尺寸、整理模式的度量，以及整理模式下阶段框上的体量。
// 壳层（确认框、存储端口度量）用替身。
import { act, createElement, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newBoard, serializeBoard, type Board, type BoardNode, type Stage } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { boardBytes, type BoardMeasure } from "../core/tidy";
import { useCanvasStageView, type CanvasStageView } from "./useCanvasStageView";
import { createFakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 壳端口替身：确认框与度量都走内存端口（不发请求）。
const shell = {
  ask: vi.fn(),
  measureBoard: vi.fn(),
};
let port = createFakePort();

// ---- 画板与渲染脚手架 ----

const promptNode = (id: string, pos: [number, number] = [0, 0], size: [number, number] = [100, 100]): BoardNode => ({
  type: "prompt",
  id,
  pos,
  size,
  text: id,
  extra: {},
});

const resultNode = (id: string, final = false): BoardNode => ({
  type: "result",
  id,
  pos: [0, 0],
  size: [100, 100],
  task_id: `task-${id}`,
  file: "out.png",
  path: `2026-01-01/${id}/out.png`,
  layer_count: 0,
  record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: null, ratio: null, width: null, height: null }, submitted_at: "" },
  ...(final ? { final: true as const } : {}),
  extra: {},
});

const stage = (id: string, nodes: string[], collapsed = false): Stage => ({ id, name: `阶段 ${id}`, nodes, collapsed, extra: {} });

const boardOf = (nodes: BoardNode[], stages?: Stage[]): Board => ({ ...newBoard("测试"), nodes, ...(stages ? { stages } : {}) });

/** 存储端口量出的体量：d1 被两个节点共用（同一次只算一次）。 */
const MEASURE: BoardMeasure = { nodes: { a: ["d1"], b: ["d1", "d2"], r1: ["d3"] }, dirs: { d1: 1000, d2: 500, d3: 200 } };

interface ProbeProps {
  board: Board;
  boardRef: MutableRefObject<Board>;
  readOnly: boolean;
  measured: Record<string, { width?: number; height?: number }>;
  tidying: boolean;
  apply: (change: BoardChange) => EditResult | null;
  toast: (message: string) => void;
}

let container: HTMLDivElement;
let root: Root;
let view: CanvasStageView;
/** 交出去的画板变更与提示。 */
let applied: BoardChange[];
let toasts: string[];
/** apply 的返回值（每个用例自己摆）。 */
let applyResult: EditResult | null;

const apply = (change: BoardChange): EditResult | null => {
  applied.push(change);
  return applyResult;
};
const toast = (message: string): void => {
  toasts.push(message);
};

function Probe(props: ProbeProps) {
  view = useCanvasStageView(props);
  return null;
}

async function show(props: ProbeProps): Promise<void> {
  await act(async () => root.render(createElement(ShellProvider, { port, children: createElement(Probe, props) })));
  await act(async () => {});
  await act(async () => {});
}

/** boardRef.current 默认就是 board；用例可以单独给一个更新的画板。 */
function propsOf(board: Board, overrides: Partial<ProbeProps> = {}): ProbeProps {
  return {
    board,
    boardRef: { current: board },
    readOnly: false,
    measured: {},
    tidying: false,
    apply,
    toast,
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  applied = [];
  toasts = [];
  applyResult = null;
  shell.ask.mockReset();
  shell.ask.mockResolvedValue(true);
  shell.measureBoard.mockReset();
  shell.measureBoard.mockResolvedValue(MEASURE);
  port = createFakePort();
  port.ui.ask = shell.ask;
  port.board.measure = shell.measureBoard;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("收起的阶段与阶段框", () => {
  it("收起阶段的成员隐藏；只读查看默认展开", async () => {
    const board = boardOf([promptNode("a"), promptNode("b"), promptNode("c")], [stage("s1", ["a", "b"], true), stage("s2", ["c"])]);
    await show(propsOf(board));
    expect(view.hidden).toEqual(new Set(["a", "b"]));

    await show(propsOf(board, { readOnly: true }));
    expect(view.hidden.size).toBe(0);
  });

  it("阶段框只接住 core 算出的尺寸集合，不重放尺寸矩阵", async () => {
    const board = boardOf(
      [promptNode("a", [10, 20], [100, 100]), promptNode("b", [200, 300], [50, 50])],
      [stage("s1", ["a", "b"], true), stage("s2", ["已删掉的节点"])],
    );
    await show(propsOf(board, { measured: { a: { width: 300, height: 200 } } }));

    expect(view.boxes.map((b) => b.stage.id)).toEqual(["s1"]);
    expect(view.boxes[0].count).toBe(2);
    expect(view.hidden).toEqual(new Set(["a", "b"]));
  });
});

describe("整理模式的度量", () => {
  it("不在整理模式不量；进入后量出当前体量与入场体量，退出即清空", async () => {
    const board = boardOf([promptNode("a"), promptNode("b")]);
    await show(propsOf(board));
    expect(view.tidyMeasure).toEqual({ measure: null, before: null });
    expect(shell.measureBoard).not.toHaveBeenCalled();

    await show(propsOf(board, { tidying: true }));
    expect(shell.measureBoard).toHaveBeenCalledWith(serializeBoard(board));
    // 进入整理只是量：不写画板，不产生撤销步。
    expect(applied).toEqual([]);
    expect(view.tidyMeasure.measure).toEqual(MEASURE);
    expect(view.tidyMeasure.before).toBe(boardBytes(MEASURE));

    await show(propsOf(board, { tidying: false }));
    expect(view.tidyMeasure).toEqual({ measure: null, before: null });
  });
});

describe("阶段框上的整理附加内容", () => {
  it("不在整理模式为 null", async () => {
    await show(propsOf(boardOf([promptNode("a")], [stage("s1", ["a"])])));
    expect(view.stageTidy).toBeNull();
  });

  it("阶段体量按任务目录算，不在画板上的阶段为 0", async () => {
    const board = boardOf([promptNode("a"), promptNode("b")], [stage("s1", ["a", "b"])]);
    await show(propsOf(board, { tidying: true }));

    // d1 被两个成员共用，只算一次。
    expect(view.stageTidy!.bytes("s1")).toBe(1500);
    expect(view.stageTidy!.bytes("不在画板上的阶段")).toBe(0);
  });

  it("量不出来时阶段体量为 null", async () => {
    shell.measureBoard.mockRejectedValue(new Error("断网"));
    const board = boardOf([promptNode("a")], [stage("s1", ["a"])]);
    await show(propsOf(board, { tidying: true }));

    expect(view.tidyMeasure.measure).toBeNull();
    expect(view.stageTidy!.bytes("s1")).toBeNull();
  });

});

// ---- 建议保留（#144）----

/** 同一结果列（task_id 相同）的另一张：用来锁住「只取最新一张」。 */
const sameColumn = (base: BoardNode): BoardNode => ({ ...base, task_id: "task-r1" }) as BoardNode;

describe("建议保留", () => {
  it("不在整理模式没有标记；进入整理模式才标出每条结果列最新的一张", async () => {
    const board = boardOf([promptNode("p"), resultNode("r1"), sameColumn(resultNode("r2")), resultNode("r3", true)], [stage("s1", ["r1", "r2", "r3"])]);
    await show(propsOf(board));
    expect(view.suggestKeep.size).toBe(0);

    await show(propsOf(board, { tidying: true }));
    // r2 是这条结果列的最新一张；r3 已定稿，不打标记。
    expect([...view.suggestKeep]).toEqual(["r2"]);
  });

});

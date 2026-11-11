// @vitest-environment jsdom
// useCanvasStageView 的接线：阶段收起 / 框尺寸、新建阶段进入改名、整理模式的度量，
// 以及整理模式下阶段框上的体量 / 收掉未定稿 / 移出为新画板。壳层（确认框、服务端度量）用替身。
import { act, createElement, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newBoard, serializeBoard, type Board, type BoardNode, type Stage } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { nextStageName, STAGE_PADDING } from "../core/stages";
import { boardBytes, type BoardMeasure } from "../core/tidy";
import { TIDY_TEXT } from "./boardText";
import { useCanvasStageView, type CanvasStageView } from "./useCanvasStageView";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 壳层替身：确认框与服务端度量（vi.mock 先于 import 执行，替身用 vi.hoisted 提前造好）。
const shell = vi.hoisted(() => ({
  ask: vi.fn(),
  measureBoard: vi.fn(),
}));

vi.mock("../shell/ipc", () => ({
  ipc: { measureBoard: shell.measureBoard },
  browser: { ask: shell.ask },
}));

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

/** 服务端量出的体量：d1 被两个节点共用（同一次只算一次）。 */
const MEASURE: BoardMeasure = { nodes: { a: ["d1"], b: ["d1", "d2"], r1: ["d3"] }, dirs: { d1: 1000, d2: 500, d3: 200 } };

interface ProbeProps {
  board: Board;
  boardRef: MutableRefObject<Board>;
  readOnly: boolean;
  measured: Record<string, { width?: number; height?: number }>;
  tidying: boolean;
  apply: (change: BoardChange) => EditResult | null;
  toast: (message: string) => void;
  onMoveOutStage: (stageId: string) => Promise<string>;
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
  await act(async () => root.render(createElement(Probe, props)));
  await act(async () => {});
  await act(async () => {});
}

async function run(action: () => void): Promise<void> {
  await act(async () => action());
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
    onMoveOutStage: async () => "新画板",
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

  it("框按成员显示尺寸画：量到的用实测、没量到的用存的尺寸，成员都不在画板上的阶段不画", async () => {
    const board = boardOf(
      [promptNode("a", [10, 20], [100, 100]), promptNode("b", [200, 300], [50, 50])],
      [stage("s1", ["a", "b"], true), stage("s2", ["已删掉的节点"])],
    );
    await show(propsOf(board, { measured: { a: { width: 300, height: 200 } } }));

    expect(view.boxes).toEqual([
      {
        stage: board.stages![0],
        // a 按实测 300×200（10,20 → 310,220），b 按存的 50×50（200,300 → 250,350），外留边距。
        x: 10 - STAGE_PADDING,
        y: 20 - STAGE_PADDING,
        width: 310 + STAGE_PADDING - (10 - STAGE_PADDING),
        height: 350 + STAGE_PADDING - (20 - STAGE_PADDING),
        count: 2,
      },
    ]);
  });

  it("只读查看时框强制展开（不按收起画成小块）", async () => {
    const board = boardOf([promptNode("a", [10, 20])], [stage("s1", ["a"], true)]);
    await show(propsOf(board, { readOnly: true }));

    expect(view.boxes).toHaveLength(1);
    expect(view.boxes[0].stage.collapsed).toBe(false);
    expect(view.boxes[0].width).toBe(100 + 2 * STAGE_PADDING);
  });
});

describe("新建阶段", () => {
  it("建好后新阶段直接进入改名，改名结束清除", async () => {
    const stale = boardOf([promptNode("a")]);
    // 环境取最新画板：ref 里已有一个阶段，所以新阶段名是「阶段 2」。
    const latest = boardOf([promptNode("a")], [stage("s0", ["a"])]);
    const created = stage("s-new", ["a"]);
    applyResult = { board: boardOf([promptNode("a")], [latest.stages![0], created]), step: { label: "建阶段" } };

    await show(propsOf(stale, { boardRef: { current: latest } }));
    await run(() => view.newStage(["a"]));

    expect(applied).toEqual([{ kind: "newStage", name: nextStageName(latest), nodes: ["a"] }]);
    expect(view.editingStage).toBe("s-new");

    await run(() => view.onEditingDone());
    expect(view.editingStage).toBeNull();
  });

  it("apply 返回 null（被拒）时不进入改名", async () => {
    await show(propsOf(boardOf([promptNode("a")])));
    applyResult = null;
    await run(() => view.newStage(["a"]));
    expect(applied).toHaveLength(1);
    expect(view.editingStage).toBeNull();
  });

  it("没有撤销步或没有新阶段时不进入改名", async () => {
    const board = boardOf([promptNode("a")], [stage("s0", ["a"])]);
    await show(propsOf(board));

    applyResult = { board, step: null };
    await run(() => view.newStage(["a"]));
    expect(view.editingStage).toBeNull();

    // 有撤销步，但返回的画板没有新阶段（拿不到要改名的 id）。
    applyResult = { board, step: { label: "建阶段" } };
    await run(() => view.newStage(["a"]));
    expect(view.editingStage).toBeNull();
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

  it("「收掉未定稿」只数未定稿且没被下游用的结果", async () => {
    const board = boardOf([promptNode("p"), resultNode("r1"), resultNode("r2", true)], [stage("s1", ["r1", "r2"])]);
    await show(propsOf(board, { tidying: true }));

    // r2 已定稿，保留。
    expect(view.stageTidy!.prunable("s1")).toBe(1);
    expect(view.stageTidy!.prunable("不在画板上的阶段")).toBe(0);
  });

  it("有可收掉的结果：确认后发 pruneUnfinal，确认框带张数与预计减少的体量", async () => {
    const board = boardOf([promptNode("p"), resultNode("r1")], [stage("s1", ["r1"])]);
    await show(propsOf(board, { tidying: true }));

    await run(() => view.stageTidy!.onPrune("s1"));
    await act(async () => {});

    // 预计减少的体量 = r1 独占的 d3（200）——d1 / d2 仍被别的节点引用。
    // cancelLabel 在源码里是字面量（没有对应文案常量），这里照抄一份，就当作与源码独立的期望值。
    expect(shell.ask).toHaveBeenCalledWith(TIDY_TEXT.pruneConfirm(1, 200), {
      title: TIDY_TEXT.pruneTitle,
      okLabel: TIDY_TEXT.pruneOk,
      cancelLabel: TIDY_TEXT.cancelLabel,
    });
    expect(applied).toEqual([{ kind: "pruneUnfinal", stageIds: ["s1"] }]);
  });

  it("确认框取消时不动画板", async () => {
    shell.ask.mockResolvedValue(false);
    const board = boardOf([promptNode("p"), resultNode("r1")], [stage("s1", ["r1"])]);
    await show(propsOf(board, { tidying: true }));

    await run(() => view.stageTidy!.onPrune("s1"));
    await act(async () => {});

    expect(shell.ask).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([]);
  });

  it("量不出体量时确认框说明体量暂时算不出", async () => {
    shell.measureBoard.mockRejectedValue(new Error("断网"));
    const board = boardOf([promptNode("p"), resultNode("r1")], [stage("s1", ["r1"])]);
    await show(propsOf(board, { tidying: true }));

    await run(() => view.stageTidy!.onPrune("s1"));
    await act(async () => {});

    expect(shell.ask).toHaveBeenCalledWith(TIDY_TEXT.pruneConfirm(1, null), expect.anything());
  });

  it("没有可收掉的结果：只提示，不问也不写", async () => {
    const board = boardOf([promptNode("p"), resultNode("r1", true)], [stage("s1", ["r1"])]);
    await show(propsOf(board, { tidying: true }));

    await run(() => view.stageTidy!.onPrune("s1"));
    await act(async () => {});

    expect(toasts).toEqual([TIDY_TEXT.nothingToPrune]);
    expect(shell.ask).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
  });

  it("移出为新画板：过程中置灰，成功后提示", async () => {
    let resolveMove!: (title: string) => void;
    const onMoveOutStage = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveMove = resolve;
        }),
    );
    const board = boardOf([promptNode("a")], [stage("s1", ["a"])]);
    await show(propsOf(board, { tidying: true, onMoveOutStage }));
    expect(view.stageTidy!.movingOut).toBe(false);

    await run(() => view.stageTidy!.onMoveOut("s1"));
    expect(onMoveOutStage).toHaveBeenCalledWith("s1");
    expect(view.stageTidy!.movingOut).toBe(true);

    await act(async () => resolveMove("阶段一"));
    await act(async () => {});
    expect(toasts).toEqual(["阶段一"]);
    expect(view.stageTidy!.movingOut).toBe(false);
  });

  it("移出失败时提示原因", async () => {
    const onMoveOutStage = vi.fn(async () => {
      throw new Error("画板位已满");
    });
    const board = boardOf([promptNode("a")], [stage("s1", ["a"])]);
    await show(propsOf(board, { tidying: true, onMoveOutStage }));

    await run(() => view.stageTidy!.onMoveOut("s1"));
    await act(async () => {});

    expect(toasts).toEqual([TIDY_TEXT.moveOutFailed("画板位已满")]);
    expect(view.stageTidy!.movingOut).toBe(false);
  });
});

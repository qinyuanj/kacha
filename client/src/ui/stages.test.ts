// @vitest-environment jsdom
// 阶段框标题栏上的动作：#92 的体量与「收掉未定稿」、#93 的移出，以及 #144 的「保留这 N 张」。
// 这里只测标题栏：框本身画在画布坐标里，ViewportPortal 用替身（vitest 的 include 只收 *.test.ts，所以用 createElement）。
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Stage } from "../core/board";
import type { BoardChange } from "../core/edit";
import type { StageBox } from "../core/stages";
import { SUGGEST_KEEP_TEXT } from "./boardText";
import { StageLayer, type StageTidy } from "./stages";

// 本文件只关心标题栏：阶段框的坐标换算与 ViewportPortal 在别的用例里（useCanvasStageView.test.ts）。
vi.mock("@xyflow/react", () => ({ ViewportPortal: ({ children }: { children: ReactNode }) => children }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let applied: BoardChange[];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  applied = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const stage = (id: string, nodes: string[] = ["a"]): Stage => ({ id, name: `阶段 ${id}`, nodes, collapsed: false, extra: {} });

const box = (s: Stage): StageBox => ({ stage: s, x: 0, y: 0, width: 300, height: 200, count: s.nodes.length });

/** 整理附加内容的替身：张数由用例摆，动作只记下被点了哪个阶段。 */
function tidyOf(overrides: Partial<StageTidy> = {}): StageTidy & { kept: string[]; pruned: string[]; moved: string[] } {
  const kept: string[] = [];
  const pruned: string[] = [];
  const moved: string[] = [];
  return {
    bytes: () => 1536,
    prunable: () => 2,
    onPrune: (id) => void pruned.push(id),
    keepable: () => 2,
    onKeep: (id) => void kept.push(id),
    onMoveOut: (id) => void moved.push(id),
    movingOut: false,
    kept,
    pruned,
    moved,
    ...overrides,
  };
}

async function showStage(s: Stage, tidy: StageTidy | null): Promise<void> {
  await act(async () =>
    root.render(
      createElement(StageLayer, {
        boxes: [box(s)],
        selected: new Set<string>(),
        apply: (c: BoardChange) => void applied.push(c),
        editing: null,
        onEditingDone: () => undefined,
        tidy,
      }),
    ),
  );
}

const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>(".stage-header button")];
const buttonAt = (className: string): HTMLButtonElement => container.querySelector(`.${className}`) as HTMLButtonElement;

describe("阶段框上的「保留这 N 张」（#144）", () => {
  it("按钮文案带这个阶段的建议保留张数，点击交回该阶段", async () => {
    const tidy = tidyOf({ keepable: () => 3 });
    await showStage(stage("s1"), tidy);

    const keep = buttonAt("stage-keep");
    expect(keep.textContent).toBe(SUGGEST_KEEP_TEXT.keep(3));
    expect(keep.disabled).toBe(false);
    expect(keep.title).toBe("");

    await act(async () => keep.click());
    expect(tidy.kept).toEqual(["s1"]);
  });

  it("没有建议保留时置灰并说明原因", async () => {
    const tidy = tidyOf({ keepable: () => 0 });
    await showStage(stage("s1"), tidy);

    const keep = buttonAt("stage-keep");
    expect(keep.textContent).toBe(SUGGEST_KEEP_TEXT.keep(0));
    expect(keep.disabled).toBe(true);
    expect(keep.title).toBe(SUGGEST_KEEP_TEXT.nothingToKeep);
  });

  it("不在整理模式时几个整理动作都不出现，阶段自己的动作照旧", async () => {
    await showStage(stage("s1"), null);

    expect(buttons().map((b) => b.textContent)).toEqual(["收起", "删除阶段"]);
    expect(container.querySelector(".stage-keep")).toBeNull();
    expect(container.querySelector(".stage-prune")).toBeNull();
    expect(applied).toEqual([]);
  });
});

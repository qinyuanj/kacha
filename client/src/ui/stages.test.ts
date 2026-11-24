// @vitest-environment jsdom
// 阶段框标题栏剩下的内容：标题、收起时的成员数、整理模式下的体量与「移出为新画板」（#93）。
// 框本身画在画布坐标里，ViewportPortal 用替身（vitest 的 include 只收 *.test.ts，所以用 createElement）。
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Stage } from "../core/board";
import type { StageBox } from "../core/stages";
import { approxSizeText, STAGE_TEXT, TIDY_TEXT } from "./boardText";
import { StageLayer, type StageTidy } from "./stages";

// 本文件只关心标题栏：阶段框的坐标换算与 ViewportPortal 在别的用例里（useCanvasStageView.test.ts）。
vi.mock("@xyflow/react", () => ({ ViewportPortal: ({ children }: { children: ReactNode }) => children }));

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

const stage = (id: string, nodes: string[] = ["a"]): Stage => ({ id, name: `阶段 ${id}`, nodes, collapsed: false, extra: {} });

const box = (s: Stage): StageBox => ({ stage: s, x: 0, y: 0, width: 300, height: 200, count: s.nodes.length });

/** 整理附加内容的替身：体量由用例摆，移出只记下被点了哪个阶段。 */
function tidyOf(overrides: Partial<StageTidy> = {}): StageTidy & { moved: string[] } {
  const moved: string[] = [];
  return {
    bytes: () => 1536,
    sizeFailed: false,
    onMoveOut: (id) => void moved.push(id),
    movingOut: false,
    moved,
    ...overrides,
  };
}

async function showStage(s: Stage, tidy: StageTidy | null): Promise<void> {
  await act(async () => root.render(createElement(StageLayer, { boxes: [box(s)], tidy })));
}

const header = (): HTMLElement => container.querySelector(".stage-header") as HTMLElement;
const frame = (): HTMLElement => container.querySelector(".stage-frame") as HTMLElement;
const buttonAt = (className: string): HTMLButtonElement => container.querySelector(`.${className}`) as HTMLButtonElement;

describe("阶段框标题栏", () => {
  it("展开时只显示阶段名，不显示成员数", async () => {
    await showStage(stage("s1"), null);

    expect(header().textContent).toBe("阶段 s1");
    expect(container.querySelector(".stage-count")).toBeNull();
    expect(frame().className).not.toContain("collapsed");
    expect(frame().style.width).toBe("300px");
  });

  it("收起时只剩标题栏大小的一块，显示成员数", async () => {
    await showStage({ ...stage("s1", ["a", "b"]), collapsed: true }, null);

    expect(frame().className).toContain("collapsed");
    expect(frame().style.width).toBe("");
    expect(container.querySelector(".stage-count")?.textContent).toBe(STAGE_TEXT.count(2));
  });
});

describe("整理模式下标题栏上的体量与「移出为新画板」", () => {
  it("不在整理模式时没有整理动作", async () => {
    await showStage(stage("s1"), null);

    expect(container.querySelector(".stage-size")).toBeNull();
    expect(container.querySelector(".stage-move-out")).toBeNull();
  });

  it("体量按算出的字节显示；算不出时留占位", async () => {
    await showStage(stage("s1"), tidyOf({ bytes: () => 1536 }));
    expect(container.querySelector(".stage-size")?.textContent).toBe(approxSizeText(1536));

    await showStage(stage("s1"), tidyOf({ bytes: () => null }));
    expect(container.querySelector(".stage-size")?.textContent).toBe("…");

    // 量不出来时说未知，不留一个会被读成 0 的占位。
    await showStage(stage("s1"), tidyOf({ bytes: () => null, sizeFailed: true }));
    expect(container.querySelector(".stage-size")?.textContent).toBe(TIDY_TEXT.sizeUnknown);
  });

  it("「移出为新画板」点了交回该阶段；正在移出时置灰", async () => {
    const tidy = tidyOf();
    await showStage(stage("s1"), tidy);

    const move = buttonAt("stage-move-out");
    expect(move.textContent).toBe(TIDY_TEXT.moveOut);
    expect(move.title).toBe(TIDY_TEXT.moveOutHint);
    await act(async () => move.click());
    expect(tidy.moved).toEqual(["s1"]);

    await showStage(stage("s1"), tidyOf({ movingOut: true }));
    expect(buttonAt("stage-move-out").disabled).toBe(true);
  });
});

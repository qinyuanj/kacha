// @vitest-environment jsdom
// 阶段框标题栏上的动作：#92 的体量与「收掉未定稿」、#93 的移出，以及 #144 的「保留这 N 张」。
// 这里只测标题栏：框本身画在画布坐标里，ViewportPortal 用替身（vitest 的 include 只收 *.test.ts，所以用 createElement）。
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Stage } from "../core/board";
import type { BoardChange } from "../core/edit";
import type { StageBox } from "../core/stages";
import { approxSizeText, STAGE_TEXT, SUGGEST_KEEP_TEXT, TIDY_TEXT } from "./boardText";
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
    sizeFailed: false,
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

interface ShowOptions {
  /** 当前选中的节点：「加入所选」用。 */
  selected?: ReadonlySet<string>;
  /** 刚建好的阶段：标题直接进入改名。 */
  editing?: string | null;
  onEditingDone?: () => void;
  readOnly?: boolean;
}

async function showStage(s: Stage, tidy: StageTidy | null, opts: ShowOptions = {}): Promise<void> {
  await act(async () =>
    root.render(
      createElement(StageLayer, {
        boxes: [box(s)],
        selected: opts.selected ?? new Set<string>(),
        apply: (c: BoardChange) => void applied.push(c),
        editing: opts.editing ?? null,
        onEditingDone: opts.onEditingDone ?? (() => undefined),
        tidy,
        readOnly: opts.readOnly,
      }),
    ),
  );
}

const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>(".stage-header button")];
const buttonAt = (className: string): HTMLButtonElement => container.querySelector(`.${className}`) as HTMLButtonElement;
const buttonWith = (text: string): HTMLButtonElement => {
  const found = buttons().find((b) => b.textContent === text);
  if (!found) throw new Error(`标题栏上没有「${text}」`);
  return found;
};

const header = (): HTMLElement => container.querySelector(".stage-header") as HTMLElement;
const nameInput = (): HTMLInputElement | null => container.querySelector<HTMLInputElement>(".stage-name-input");
const nameText = (): string | null => container.querySelector(".stage-name")?.textContent ?? null;
const frame = (): HTMLElement => container.querySelector(".stage-frame") as HTMLElement;

/** 双击标题栏进入改名，交回已经聚焦的输入框（往里写 value 就是用户在打字）。 */
async function openRename(): Promise<HTMLInputElement> {
  await act(async () => header().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const input = nameInput();
  if (!input) throw new Error("双击标题栏后应当进入改名");
  await act(async () => input.focus());
  return input;
}

const keyDown = (el: HTMLElement, key: string): void => void el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

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

describe("阶段框标题栏上的改名", () => {
  it("双击标题栏进入改名，Enter 提交，输入框换回标题", async () => {
    const done: number[] = [];
    await showStage(stage("s1"), null, { onEditingDone: () => void done.push(1) });
    expect(nameText()).toBe("阶段 s1");

    const input = await openRename();
    expect(input.getAttribute("aria-label")).toBe("阶段名");
    expect(input.value).toBe("阶段 s1");
    input.value = "第一稿";
    await act(async () => keyDown(input, "Enter"));

    // 名字的处理（去首尾空白、空名不成步）在 core/edit；这里只看标题栏交回了什么。
    expect(applied).toEqual([{ kind: "renameStage", stageId: "s1", name: "第一稿" }]);
    expect(done).toHaveLength(1);
    expect(nameInput()).toBeNull();
  });

  it("刚建好的阶段直接进入改名", async () => {
    await showStage(stage("s1"), null, { editing: "s1" });

    expect(nameInput()).not.toBeNull();
    expect(nameText()).toBeNull();
  });

  it("Esc 放弃改名；之后输入框卸载时再报一次 blur 也只认第一次", async () => {
    const done: number[] = [];
    await showStage(stage("s1"), null, { onEditingDone: () => void done.push(1) });
    const input = await openRename();
    input.value = "改到一半";
    // Esc 与紧随其后的 blur 发生在同一帧里：只算放弃，不发出改名。
    await act(async () => {
      keyDown(input, "Escape");
      input.blur();
    });

    expect(applied).toEqual([]);
    expect(done).toHaveLength(1);
    expect(nameInput()).toBeNull();
    expect(nameText()).toBe("阶段 s1");
  });

  it("点到别处（blur）按输入框里的名字提交", async () => {
    await showStage(stage("s1"), null);
    const input = await openRename();
    input.value = "第二稿";
    await act(async () => input.blur());

    expect(applied).toEqual([{ kind: "renameStage", stageId: "s1", name: "第二稿" }]);
  });
});

describe("阶段框标题栏上的「加入所选」「删除阶段」「收起 / 展开」", () => {
  it("有还没进这个阶段的选中节点时才出现「加入所选」，点了把这些节点加进来", async () => {
    await showStage(stage("s1", ["a"]), null, { selected: new Set(["a", "x", "y"]) });

    await act(async () => buttonWith(STAGE_TEXT.addSelected).click());
    expect(applied).toEqual([{ kind: "addToStage", stageId: "s1", nodes: ["x", "y"] }]);
  });

  it("选中的节点都已经在阶段里时不出「加入所选」", async () => {
    await showStage(stage("s1", ["a"]), null, { selected: new Set(["a"]) });

    expect(buttons().map((b) => b.textContent)).toEqual([STAGE_TEXT.collapse, STAGE_TEXT.delete]);
  });

  it("删除阶段：点一下发出删除该阶段的变更", async () => {
    await showStage(stage("s1"), null);

    await act(async () => buttonWith(STAGE_TEXT.delete).click());
    expect(applied).toEqual([{ kind: "deleteStage", stageId: "s1" }]);
  });

  it("收起时只剩标题栏大小的一块、显示成员数与「展开」，不放「加入所选」", async () => {
    await showStage({ ...stage("s1", ["a", "b"]), collapsed: true }, null, { selected: new Set(["x"]) });

    expect(frame().className).toContain("collapsed");
    expect(frame().style.width).toBe("");
    expect(container.querySelector(".stage-count")?.textContent).toBe(STAGE_TEXT.count(2));
    expect(buttons().map((b) => b.textContent)).toEqual([STAGE_TEXT.expand, "删除阶段"]);

    await act(async () => buttonWith(STAGE_TEXT.expand).click());
    expect(applied).toEqual([{ kind: "setStageCollapsed", stageId: "s1", collapsed: false }]);
  });

  it("展开时按框的大小画，点「收起」发出收起", async () => {
    await showStage(stage("s1"), null);

    expect(frame().className).not.toContain("collapsed");
    expect(frame().style.width).toBe("300px");
    expect(container.querySelector(".stage-count")).toBeNull();

    await act(async () => buttonWith(STAGE_TEXT.collapse).click());
    expect(applied).toEqual([{ kind: "setStageCollapsed", stageId: "s1", collapsed: true }]);
  });
});

describe("整理模式下标题栏上的体量与「收掉未定稿」「移出为新画板」", () => {
  it("体量按算出的字节显示；算不出时留占位", async () => {
    await showStage(stage("s1"), tidyOf({ bytes: () => 1536 }));
    expect(container.querySelector(".stage-size")?.textContent).toBe(approxSizeText(1536));

    await showStage(stage("s1"), tidyOf({ bytes: () => null }));
    expect(container.querySelector(".stage-size")?.textContent).toBe("…");

    // 量不出来时说未知，不留一个会被读成 0 的占位。
    await showStage(stage("s1"), tidyOf({ bytes: () => null, sizeFailed: true }));
    expect(container.querySelector(".stage-size")?.textContent).toBe(TIDY_TEXT.sizeUnknown);
  });

  it("「收掉未定稿」带上张数，点了交回该阶段", async () => {
    const tidy = tidyOf({ prunable: () => 5 });
    await showStage(stage("s1"), tidy);

    const prune = buttonAt("stage-prune");
    expect(prune.textContent).toBe(TIDY_TEXT.prune(5));
    expect(prune.disabled).toBe(false);
    expect(prune.title).toBe("");
    await act(async () => prune.click());
    expect(tidy.pruned).toEqual(["s1"]);
  });

  it("没有可收的结果时「收掉未定稿」置灰并说明原因", async () => {
    await showStage(stage("s1"), tidyOf({ prunable: () => 0 }));

    expect(buttonAt("stage-prune").disabled).toBe(true);
    expect(buttonAt("stage-prune").title).toBe(TIDY_TEXT.nothingToPrune);
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

describe("只读画板上的阶段框", () => {
  it("阶段自己的按钮都不出现，整理模式的整理动作照旧", async () => {
    await showStage(stage("s1"), tidyOf(), { readOnly: true });

    expect(buttons().map((b) => b.className)).toEqual(["stage-keep", "stage-prune", "stage-move-out"]);
  });

  it("只读时双击标题栏不进入改名", async () => {
    await showStage(stage("s1"), null, { readOnly: true });

    await act(async () => header().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(nameInput()).toBeNull();
  });
});

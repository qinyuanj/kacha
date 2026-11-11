// 画布键位与指针判定（纯逻辑）：方向键微移、视图缩放、Ctrl+J 原地复制、Esc 清选区、触控板平移、Shift 框选加选。
import { describe, expect, it } from "vitest";
import { canvasKeyCommand, pointerKeepsSelection, wheelPansCanvas, type CanvasKeyCommand, type KeyContext, type KeyInput } from "./canvasKeys";

const SELECTED: KeyContext = { selected: ["a", "b"], connectionInProgress: false };

/** 造一次 keydown：不带修饰键，可逐项覆盖。 */
function key(k: string, patch: Partial<KeyInput> = {}): KeyInput {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, ...patch };
}

describe("方向键微移", () => {
  const ctx = SELECTED;

  it("四个方向各 1px，Shift 时 10px", () => {
    expect(canvasKeyCommand(key("ArrowRight"), ctx)).toEqual({ kind: "nudge", ids: ["a", "b"], delta: [1, 0] });
    expect(canvasKeyCommand(key("ArrowLeft"), ctx)).toEqual({ kind: "nudge", ids: ["a", "b"], delta: [-1, 0] });
    expect(canvasKeyCommand(key("ArrowUp"), ctx)).toEqual({ kind: "nudge", ids: ["a", "b"], delta: [0, -1] });
    expect(canvasKeyCommand(key("ArrowDown", { shiftKey: true }), ctx)).toEqual({ kind: "nudge", ids: ["a", "b"], delta: [0, 10] });
  });

  it("没有选中节点不微移", () => {
    expect(canvasKeyCommand(key("ArrowRight"), { selected: [], connectionInProgress: false })).toBeNull();
  });

  it("按住 Ctrl / Cmd / Alt 时方向键不微移", () => {
    expect(canvasKeyCommand(key("ArrowRight", { ctrlKey: true }), ctx)).toBeNull();
    expect(canvasKeyCommand(key("ArrowRight", { metaKey: true }), ctx)).toBeNull();
    expect(canvasKeyCommand(key("ArrowRight", { altKey: true }), ctx)).toBeNull();
  });

  it("defaultPrevented 也照旧微移（#97：页面级接管已经吞掉方向键）", () => {
    expect(canvasKeyCommand(key("ArrowUp", { defaultPrevented: true }), ctx)).toEqual({ kind: "nudge", ids: ["a", "b"], delta: [0, -1] });
    // 非方向键在 defaultPrevented 之后一律不处理。
    expect(canvasKeyCommand(key("Escape", { defaultPrevented: true }), ctx)).toBeNull();
  });
});

describe("Ctrl / Cmd 键位", () => {
  const ctx: KeyContext = { selected: ["a"], connectionInProgress: false };
  const both: Partial<KeyInput>[] = [{ ctrlKey: true }, { metaKey: true }];

  const cases: [string, CanvasKeyCommand][] = [
    ["0", { kind: "fitView" }],
    ["1", { kind: "actualSize" }],
    ["=", { kind: "zoomIn" }],
    ["+", { kind: "zoomIn" }],
    ["-", { kind: "zoomOut" }],
    ["J", { kind: "duplicate" }],
    ["j", { kind: "duplicate" }],
  ];

  it.each(cases)("Ctrl / Cmd + %s 对应一条命令", (k, expected) => {
    for (const mods of both) expect(canvasKeyCommand(key(k, mods), ctx)).toEqual(expected);
  });

  it("表外的键不处理", () => {
    expect(canvasKeyCommand(key("z", { ctrlKey: true }), ctx)).toBeNull();
    expect(canvasKeyCommand(key("a", { metaKey: true }), ctx)).toBeNull();
  });

  it("带 Alt 或 Shift 的 Ctrl 组合不处理", () => {
    expect(canvasKeyCommand(key("0", { ctrlKey: true, altKey: true }), ctx)).toBeNull();
    expect(canvasKeyCommand(key("0", { ctrlKey: true, shiftKey: true }), ctx)).toBeNull();
    expect(canvasKeyCommand(key("j", { ctrlKey: true, shiftKey: true }), ctx)).toBeNull();
  });

  it("不带 Ctrl / Cmd 的字母键不处理（复制粘贴的 Ctrl 键在 BoardCanvas）", () => {
    expect(canvasKeyCommand(key("j"), ctx)).toBeNull();
    expect(canvasKeyCommand(key("0"), ctx)).toBeNull();
  });

  it("defaultPrevented 时不处理", () => {
    expect(canvasKeyCommand(key("0", { ctrlKey: true, defaultPrevented: true }), ctx)).toBeNull();
  });
});

describe("Esc 清选区", () => {
  it("不在连线时清选区", () => {
    expect(canvasKeyCommand(key("Escape"), SELECTED)).toEqual({ kind: "clearSelection" });
  });

  it("连线拖动中不清（Esc 是取消这次连线）", () => {
    expect(canvasKeyCommand(key("Escape"), { selected: ["a"], connectionInProgress: true })).toBeNull();
  });

  it("Alt + Esc 与 Ctrl + Esc 都不处理", () => {
    expect(canvasKeyCommand(key("Escape", { altKey: true }), SELECTED)).toBeNull();
    expect(canvasKeyCommand(key("Escape", { ctrlKey: true }), SELECTED)).toBeNull();
  });
});

describe("滚轮当作触控板平移", () => {
  const wheel = (patch: Partial<{ deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; altKey: boolean }> = {}) => ({
    deltaX: 0,
    deltaY: 2.5,
    deltaMode: 0,
    ctrlKey: false,
    altKey: false,
    ...patch,
  });

  it("触控板双指平移，鼠标滚轮 / Ctrl / Alt 滚轮不算", () => {
    expect(wheelPansCanvas(wheel(), false)).toBe(true);
    expect(wheelPansCanvas(wheel({ deltaY: 100 }), false)).toBe(false);
    expect(wheelPansCanvas(wheel({ ctrlKey: true }), false)).toBe(false);
  });

  it(".nowheel 区域里让给控件自己处理", () => {
    expect(wheelPansCanvas(wheel(), true)).toBe(false);
  });
});

describe("Shift 框选加选", () => {
  it("只有 Shift + 画布空白按下才保留原选区", () => {
    expect(pointerKeepsSelection(true, true)).toBe(true);
    expect(pointerKeepsSelection(true, false)).toBe(false);
    expect(pointerKeepsSelection(false, true)).toBe(false);
    expect(pointerKeepsSelection(false, false)).toBe(false);
  });
});

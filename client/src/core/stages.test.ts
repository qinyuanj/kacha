import { describe, expect, it } from "vitest";
import { newBoard, type Board, type BoardNode } from "./board";
import { collapsedMembers, stageBoxes, STAGE_PADDING } from "./stages";

const ref = (id: string, pos: [number, number], size: [number, number] = [100, 50]): BoardNode => ({ id, type: "reference", pos, size, extra: {}, path: `${id}.png`, sha256: "0", display_name: id });

const staged = (): Board => ({
  ...newBoard(),
  nodes: [ref("a", [0, 0]), ref("b", [200, 100]), ref("c", [1000, 1000])],
  stages: [
    { id: "s1", name: "第一轮", nodes: ["a", "b", "gone"], collapsed: false, extra: {} },
    { id: "s2", name: "第二轮", nodes: ["c"], collapsed: true, extra: {} },
  ],
});

describe("阶段在画布上的呈现", () => {
  it("收起的阶段里的节点不显示；展开的照常", () => {
    expect([...collapsedMembers(staged())]).toEqual(["c"]);
  });

  it("阶段框包住全部成员并留边距；显示尺寸优先于存的尺寸，不在画板上的成员忽略", () => {
    const sizeOf = (id: string) => (id === "b" ? { width: 300, height: 200 } : undefined);
    const [s1, s2] = stageBoxes(staged(), sizeOf);
    const p = STAGE_PADDING;
    expect(s1).toMatchObject({ stage: { id: "s1" }, x: -p, y: -p, width: 500 + 2 * p, height: 300 + 2 * p, count: 2 });
    expect(s2).toMatchObject({ stage: { id: "s2" }, x: 1000 - p, y: 1000 - p, count: 1 });
  });

  it("成员都不在画板上的阶段不画", () => {
    const b = { ...staged(), stages: [{ id: "s", name: "空", nodes: ["gone"], collapsed: false, extra: {} }] };
    expect(stageBoxes(b, () => undefined)).toEqual([]);
  });
});

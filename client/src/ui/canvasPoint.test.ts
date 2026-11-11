// @vitest-environment jsdom
// 画布坐标与落点的纯计算：连线 id、尺寸、取整、根元素类名、指针窗口坐标、松手处命中的元素。
import { describe, expect, it } from "vitest";
import type { BoardEdge } from "../core/board";
import { canvasClassName, clientPointOf, dropTargetAt, edgeIdOf, nodeDims, posOf } from "./canvasPoint";

// 只用到端点：其余字段与渲染无关，按画板文件里必然存在的形状补齐。
const edge: BoardEdge = { from: ["ref1", "out"], to: ["task1", "image:0"], source_layer: null, region: null, system: false, extra: {} };

describe("连线 id", () => {
  it("用端点拼出稳定 id，源端口与目标端口都在内", () => {
    expect(edgeIdOf(edge)).toBe("ref1:out->task1:image:0");
  });
});

describe("节点尺寸", () => {
  it("只带测到的边，缺的一边留 undefined", () => {
    expect(nodeDims(120, 80)).toEqual({ width: 120, height: 80 });
    expect(nodeDims(undefined, 80)).toEqual({ width: undefined, height: 80 });
    expect(nodeDims(undefined, undefined)).toEqual({ width: undefined, height: undefined });
  });
});

describe("落点取整", () => {
  it("四舍五入到整数，负坐标向大取（-0.5 → -0）", () => {
    expect(posOf({ x: 10.4, y: 10.6 })).toEqual([10, 11]);
    expect(posOf({ x: -10.5, y: -10.6 })).toEqual([-10, -11]);
  });
});

describe("画布根元素类名", () => {
  it("拖线中 / 整理模式各加标记，都没有时只剩 canvas", () => {
    // 字符串逐字保留原写法：只开整理模式时中间留两个空格（classList 语义相同）。
    expect(canvasClassName(false, false)).toBe("canvas");
    expect(canvasClassName(true, false)).toBe("canvas connecting");
    expect(canvasClassName(false, true)).toBe("canvas  tidying");
    expect(canvasClassName(true, true)).toBe("canvas connecting tidying");
  });
});

describe("指针窗口坐标", () => {
  it("鼠标事件直接取 clientX / clientY", () => {
    expect(clientPointOf(new MouseEvent("mouseup", { clientX: 12, clientY: 34 }))).toEqual({ x: 12, y: 34 });
  });

  it("触控事件取第一根手指；没有触点时为 0", () => {
    const touch = { clientX: 5, clientY: 6 } as Touch;
    const withTouch = { changedTouches: [touch] } as unknown as TouchEvent;
    expect(clientPointOf(withTouch)).toEqual({ x: 5, y: 6 });
    const noTouch = { changedTouches: [] } as unknown as TouchEvent;
    expect(clientPointOf(noTouch)).toEqual({ x: 0, y: 0 });
  });
});

/** 造一个按选择器查表回答 closest 的元素；表里没有的选择器当作不命中。 */
function element(matching: Record<string, Element | null>): Element {
  return { closest: (selector: string) => matching[selector] ?? null } as unknown as Element;
}

const PANEL = ".react-flow__panel, .react-flow__node-toolbar";

describe("松手处落点", () => {
  it("命中节点卡片：按 data-id 报出节点", () => {
    const card = { getAttribute: (name: string) => (name === "data-id" ? "task1" : null) } as unknown as Element;
    const el = element({ ".react-flow__node": card });
    expect(dropTargetAt({ x: 1, y: 2 }, () => el)).toEqual({ kind: "node", nodeId: "task1" });
  });

  it("没有 data-id 的节点元素继续按画布空白判", () => {
    const card = { getAttribute: () => null } as unknown as Element;
    const el = element({ ".react-flow__node": card, ".react-flow": card, [PANEL]: null });
    expect(dropTargetAt({ x: 1, y: 2 }, () => el)).toEqual({ kind: "pane" });
  });

  it("画布空白与连线都算 pane", () => {
    const el = element({ ".react-flow__node": null, ".react-flow": {} as Element, [PANEL]: null });
    expect(dropTargetAt({ x: 1, y: 2 }, () => el)).toEqual({ kind: "pane" });
  });

  it("工具栏 / 小地图 / 控件 / 动作条上不算落点", () => {
    const el = element({ ".react-flow__node": null, ".react-flow": {} as Element, [PANEL]: {} as Element });
    expect(dropTargetAt({ x: 1, y: 2 }, () => el)).toBeNull();
  });

  it("缺省用 document.elementFromPoint 取元素", () => {
    // jsdom 没有布局，按需补一个桩：覆盖「不注入 elementAt」这条缺省路径。
    const had = "elementFromPoint" in document;
    const original = (document as { elementFromPoint?: unknown }).elementFromPoint;
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => null;
    try {
      expect(dropTargetAt({ x: 1, y: 2 })).toBeNull();
    } finally {
      if (had) (document as { elementFromPoint?: unknown }).elementFromPoint = original;
      else delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it("画布以外与取不到元素都为 null", () => {
    expect(dropTargetAt({ x: 1, y: 2 }, () => element({}))).toBeNull();
    expect(dropTargetAt({ x: 1, y: 2 }, () => null)).toBeNull();
  });
});

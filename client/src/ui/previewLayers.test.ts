// 放大预览弹窗的图层判定（#137）：位置样式按底图换算、底图尺寸没读到时先藏着、图层名字与单层底图。
import { describe, expect, it } from "vitest";
import type { LayerRecord } from "../core/taskDir";
import type { ImageInfo } from "../shell/port";
import { baseImageAlt, baseImagePath, layerIndexOf, layerName, layerStyleOf } from "./previewLayers";

const INFO: ImageInfo = { sha256: "a", bytes: 10, width: 100, height: 50, format: "png", has_alpha: false };

function layer(): LayerRecord {
  return { file: "l.png", name: "层", description: "", z_index: 2, bounding_box: { absolute: [10, 5, 50, 25] } } as unknown as LayerRecord;
}

describe("预览图层", () => {
  it("位置按底图尺寸换算成百分比", () => {
    const style = layerStyleOf(layer(), INFO);
    expect(style?.left).toBe("10%");
    expect(style?.top).toBe("10%");
    expect(style?.width).toBe("40%");
    expect(style?.height).toBe("40%");
    expect(style?.zIndex).toBe(2);
  });

  it("底图尺寸还没读到：先藏着，不给位置", () => {
    expect(layerStyleOf(layer(), null)).toEqual({ visibility: "hidden" });
    expect(layerStyleOf(layer(), undefined)).toEqual({ visibility: "hidden" });
  });

  it("历史结果（bounding_box 是数组）：照旧渲染，不给位置", () => {
    expect(layerStyleOf({ ...layer(), bounding_box: [1, 2, 3, 4] } as unknown as LayerRecord, INFO)).toBeUndefined();
  });

  it("图层名字：没有名字时按序号写「图层N」", () => {
    expect(layerName(layer(), 0)).toBe("层");
    expect(layerName({ ...layer(), name: undefined } as unknown as LayerRecord, 2)).toBe("图层3");
  });

  it("单层模式：底图换成那一层，alt 用它的文件名", () => {
    const req = { absPath: "/~/base.png", title: "预览" };
    const layers = [{ absPath: "/~/l0.png", record: layer() }];
    expect(baseImagePath(req, layers, null)).toBe("/~/base.png");
    expect(baseImagePath(req, layers, 0)).toBe("/~/l0.png");
    expect(baseImageAlt(req, layers, null)).toBe("预览");
    expect(baseImageAlt(req, layers, 0)).toBe("l.png");
  });

  it("选来源：底图是 0，图层从 1 起；越界当没有图层", () => {
    expect(layerIndexOf(0, 2)).toBeNull();
    expect(layerIndexOf(1, 2)).toBe(1);
    expect(layerIndexOf(2, 2)).toBe(2);
    expect(layerIndexOf(3, 2)).toBeNull();
  });
});

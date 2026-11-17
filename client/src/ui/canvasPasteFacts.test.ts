// 原生粘贴落点：指针位置与视口中心的坐标取整。
import { describe, expect, it } from "vitest";
import { pastePosition } from "./canvasPasteFacts";

describe("粘贴落点", () => {
  it("指针在画布内：用它换算的画布坐标，取整", () => {
    const at = pastePosition({ pointer: { x: 101, y: 51 }, center: () => ({ x: 0, y: 0 }), toFlow: (c) => ({ x: c.x / 2, y: c.y / 2 }) });
    expect(at).toEqual([51, 26]);
  });

  it("指针从没进过画布：用视口中央，取整", () => {
    const at = pastePosition({ pointer: null, center: () => ({ x: 500.4, y: 400.6 }), toFlow: (c) => c });
    expect(at).toEqual([500, 401]);
  });
});

import { describe, expect, it } from "vitest";
import { bySizeDescending, sizeTier } from "./boardSize";

// 期望值按票面规则手写：黄线 500、红线 1000（测试用小数），高于阈值才算该档。
const lines = { warn: 500, alert: 1000 };

describe("画板体量档位", () => {
  it("高于黄线标黄、高于红线标红，等于阈值不算该档", () => {
    expect(sizeTier(0, lines)).toBeNull();
    expect(sizeTier(500, lines)).toBeNull();
    expect(sizeTier(501, lines)).toBe("warn");
    expect(sizeTier(1000, lines)).toBe("warn");
    expect(sizeTier(1001, lines)).toBe("alert");
  });

  it("体量未知（画板读不懂）不标", () => {
    expect(sizeTier(null, lines)).toBeNull();
  });
});

describe("管理画板的排序", () => {
  it("按体量从大到小，体量未知的排在最后，同体量按名称", () => {
    const boards = [
      { name: "b", bytes: 300 },
      { name: "坏", bytes: null },
      { name: "a", bytes: 300 },
      { name: "大", bytes: 5000 },
      { name: "空", bytes: 0 },
    ];
    expect(bySizeDescending(boards).map((b) => b.name)).toEqual(["大", "a", "b", "空", "坏"]);
    // 不改动传入的列表。
    expect(boards[0].name).toBe("b");
  });
});

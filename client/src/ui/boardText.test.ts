import { describe, expect, it } from "vitest";
import { slotsRefusal } from "./boardText";

// 期望文案照抄票面（#89 已确认的简洁版），独立于源码，防止同义反复。
describe("画板位文案（#89）", () => {
  it("放得下时不拒绝，放不下时给出带实际数字的统一文案", () => {
    expect(slotsRefusal({ used: 7, total: 10 }, 1)).toBeNull();
    expect(slotsRefusal({ used: 7, total: 10 }, 3)).toBeNull();
    expect(slotsRefusal({ used: 9, total: 10 }, 2)).toBe("画板位满了（9/10），归档或删掉一块再新建。");
    expect(slotsRefusal({ used: 10, total: 10 }, 1)).toBe("画板位满了（10/10），归档或删掉一块再新建。");
    // 超出画板位的老用户：照实际数字写。
    expect(slotsRefusal({ used: 12, total: 10 }, 1)).toBe("画板位满了（12/10），归档或删掉一块再新建。");
  });

  it("不新增画板时不拒绝", () => {
    expect(slotsRefusal({ used: 12, total: 10 }, 0)).toBeNull();
  });
});

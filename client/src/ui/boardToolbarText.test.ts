// 精简后工具栏文案（#267）：置灰原因、运行守卫与撤销 / 重做提示。
// 新建任务按钮已移除，它的文案不再属于工具栏契约。
import { describe, expect, it } from "vitest";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import { redoHint, runHint, runSuffix, toolbarHint, undoHint } from "./boardToolbarText";

describe("工具栏文案", () => {
  it("没有画板：统一说明原因", () => {
    expect(toolbarHint(true, "某个入口的说明")).toBe("没有打开的画板");
  });

  it("有画板：用这个入口自己的说明", () => {
    expect(toolbarHint(false, "运行整个画板")).toBe("运行整个画板");
  });

  it("生成尚不可用：只标运行", () => {
    expect(runHint(true)).toBe("生成" + UNAVAILABLE_TEXT);
    expect(runHint(false)).toContain("运行整个画板");
  });

  it("运行按钮：有选中时写「选中」，不可用时补标记", () => {
    expect(runSuffix(0, false)).toBe("");
    expect(runSuffix(2, false)).toBe("选中");
    expect(runSuffix(2, true)).toBe("选中（" + UNAVAILABLE_TEXT + "）");
  });

  it("撤销 / 重做：没有历史项时说明没有", () => {
    expect(undoHint(null)).toBe("没有可撤销的操作");
    expect(redoHint(null)).toBe("没有可重做的操作");
    expect(undoHint("新建提示词")).toBe("撤销 新建提示词（Ctrl+Z）");
    expect(redoHint("新建提示词")).toBe("重做 新建提示词（Ctrl+Shift+Z）");
  });
});

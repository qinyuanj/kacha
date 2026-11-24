// 工具栏文案（#137）：置灰时的统一原因、「尚不可用」标记与撤销 / 重做。
import { describe, expect, it } from "vitest";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import {

  redoHint,
  runHint,
  runSuffix,
  toolbarHint,
  undoHint,
  newTaskHint,
  newTaskSuffix,
} from "./boardToolbarText";

describe("工具栏文案", () => {
  it("没有画板：所有入口都说同一个原因", () => {
    expect(toolbarHint(true, "在视口中央新建一个提示词节点")).toBe("没有打开的画板");
  });

  it("有画板：用这个入口自己的说明", () => {
    expect(toolbarHint(false, "在视口中央新建一个提示词节点")).toBe("在视口中央新建一个提示词节点");
  });

  it("生成尚不可用：新建任务与运行都标「尚不可用」", () => {
    expect(newTaskSuffix(true)).toBe("（" + UNAVAILABLE_TEXT + "）");
    expect(newTaskSuffix(false)).toBe("");
    expect(newTaskHint(true)).toBe("生成" + UNAVAILABLE_TEXT);
    expect(runHint(true)).toBe("生成" + UNAVAILABLE_TEXT);
  });

  it("生成可用：说明各自的用法", () => {
    expect(newTaskHint(false)).toContain("新建一个生成任务节点");
    expect(runHint(false)).toContain("运行整个画板");
  });

  it("运行按钮：有选中时写「选中」", () => {
    expect(runSuffix(0, false)).toBe("");
    expect(runSuffix(2, false)).toBe("选中");
    expect(runSuffix(2, true)).toBe("选中（" + UNAVAILABLE_TEXT + "）");
  });

  it("撤销 / 重做：没有可撤销 / 重做的操作时说明没有", () => {
    expect(undoHint(null)).toBe("没有可撤销的操作");
    expect(redoHint(null)).toBe("没有可重做的操作");
    expect(undoHint("新建提示词")).toBe("撤销 新建提示词（Ctrl+Z）");
    expect(redoHint("新建提示词")).toBe("重做 新建提示词（Ctrl+Shift+Z）");
  });
});

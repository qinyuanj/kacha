// 启动读数与版本提醒（#137）。
import { describe, expect, it } from "vitest";
import { boardMissingText, boardRenamedText, discardMissingText, restorePlan, shouldRecordVersion, stopTasksText } from "./appStartup";

describe("版本提醒", () => {
  it("没有见过这个版本：要提醒", () => {
    expect(shouldRecordVersion("1.0", undefined, false)).toBe(true);
  });

  it("已经见过：不再提醒", () => {
    expect(shouldRecordVersion("1.0", "1.0", false)).toBe(false);
  });

  it("读界面状态失败：不记版本", () => {
    expect(shouldRecordVersion("1.0", undefined, true)).toBe(false);
  });
});

describe("恢复标签页", () => {
  it("没有要恢复的：什么都不做", () => {
    const plan = restorePlan({ open_boards: [], active_board: null, last_seen_version: undefined, size_notices: {} }, []);
    expect(plan.opened).toEqual([]);
    expect(plan.activate).toBeNull();
    expect(plan.notices).toEqual([]);
  });

  it("找不到的画板：给出提示，不恢复", () => {
    const plan = restorePlan({ open_boards: ["/~/gone"], active_board: null, last_seen_version: undefined, size_notices: {} }, []);
    expect(plan.opened).toEqual([]);
    expect(plan.notices[0]).toContain("找不到画板文件");
  });

  it("还开着的画板：恢复并激活", () => {
    const plan = restorePlan({ open_boards: ["/~/a"], active_board: "/~/a", last_seen_version: undefined, size_notices: {} }, ["/~/a"]);
    expect(plan.opened).toEqual(["/~/a"]);
    expect(plan.activate).toBe("/~/a");
  });
});

describe("文案", () => {
  it("各有各的说法", () => {
    expect(stopTasksText(2)).toContain("2");
    expect(discardMissingText).toContain("导出画板包");
    expect(boardMissingText).toContain("刷新列表");
    expect(boardRenamedText).toContain("刷新列表");
  });
});

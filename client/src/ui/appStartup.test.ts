// 工作台的启动流程判定（#137）：读能力表与界面状态、恢复标签页、首次使用不提示更新。
import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE } from "../core/capabilities";
import { boardMissingText, discardMissingText, errorMessage, readStartup, restorePlan, shouldRecordVersion, stopTasksText } from "./appStartup";

describe("启动流程", () => {
  it("读不到能力表覆盖：降级到内置能力表并给出原因", async () => {
    const r = await readStartup({
      capabilityOverride: async () => {
        throw new Error("offline");
      },
      uiState: async () => null,
    });
    expect(r.table).toEqual(BUILTIN_TABLE);
    expect(r.tableError).toContain("读取能力表覆盖文件失败");
  });

  it("读得到界面状态：解析出来", async () => {
    const r = await readStartup({
      capabilityOverride: async () => null,
      uiState: async () => JSON.stringify({ open_boards: ["/~/a"], active_board: "/~/a" }),
    });
    expect(r.ui.open_boards).toEqual(["/~/a"]);
    expect(r.uiReadFailed).toBe(false);
  });

  it("读不到界面状态：标记为失败（不记更新提示）", async () => {
    const r = await readStartup({
      capabilityOverride: async () => null,
      uiState: async () => {
        throw new Error("offline");
      },
    });
    expect(r.uiReadFailed).toBe(true);
  });
});

describe("恢复标签页", () => {
  it("按顺序打开：找不到的记一条提示", () => {
    const plan = restorePlan({ open_boards: ["/~/a", "/~/b"], active_board: "/~/a" }, ["/~/a"]);
    expect(plan.opened).toEqual(["/~/a"]);
    expect(plan.notices).toEqual(["找不到画板文件：/~/b"]);
    expect(plan.activate).toBe("/~/a");
  });

  it("打开时抛错的画板：只报真实错误，不额外报找不到", () => {
    const plan = restorePlan({ open_boards: ["/~/a", "/~/b"], active_board: "/~/a" }, ["/~/a"], ["/~/b"]);
    expect(plan.opened).toEqual(["/~/a"]);
    expect(plan.notices).toEqual([]);
  });

  it("当前画板不在了就激活第一个打开的", () => {
    const plan = restorePlan({ open_boards: ["/~/a", "/~/b"], active_board: "/~/b" }, ["/~/a"]);
    expect(plan.activate).toBe("/~/a");
  });

  it("一个都没打开：交��新建", () => {
    const plan = restorePlan({ open_boards: [], active_board: null }, []);
    expect(plan.activate).toBeNull();
  });
});

describe("更新提示", () => {
  it("没有记录：记下当前版本", () => {
    expect(shouldRecordVersion("1.2.3", undefined, false)).toBe(true);
  });

  it("已经记过：不重复记", () => {
    expect(shouldRecordVersion("1.2.3", "1.2.3", false)).toBe(false);
  });

  it("读界面状态失败：不记（免得吞掉老用户这次的提示）", () => {
    expect(shouldRecordVersion("1.2.3", undefined, true)).toBe(false);
  });

  it("没有版本号：不记", () => {
    expect(shouldRecordVersion(undefined, undefined, false)).toBe(false);
  });
});

describe("提示文案", () => {
  it("关闭画板前的确认：说明不会在后台继续", () => {
    expect(stopTasksText(3)).toContain("还有 3 个任务在排队或执行");
    expect(stopTasksText(3)).toContain("不会在后台继续");
  });

  it("放弃已不存在的画板：提醒先导出画板包", () => {
    expect(discardMissingText).toContain("导出画板包");
  });

  it("画板找不到的提示", () => {
    expect(boardMissingText).toContain("请刷新列表");
  });

  it("错误的一句话说法", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
});

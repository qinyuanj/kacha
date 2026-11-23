// 工作台界面状态的判定（#137）：提示、菜单禁用与模态开关。
import { describe, expect, it } from "vitest";
import { activeSizeNotice, modalOpenOf, noticesAfterMove, packMenuDisabled, saveFailureNotice, uiStateOf, uiStateText, usageNoticeVisible } from "./appUiState";

const snapshot = (patch: Partial<Parameters<typeof uiStateOf>[0]> = {}) => ({
  sessions: [] as { key: string; path: string }[],
  activeKey: null as string | null,
  ...patch,
});

describe("界面状态", () => {
  it("没有画板：打开的画板为空", () => {
    const state = uiStateOf(snapshot(), undefined, {});
    expect(state.open_boards).toEqual([]);
    expect(state.active_board).toBeNull();
    expect(uiStateText(state)).toContain("open_boards");
  });

  it("有画板：记下路径与当前画板", () => {
    const state = uiStateOf(snapshot({ sessions: [{ key: "k1", path: "/~/a.ugcboard.json" }], activeKey: "k1" }), "1.0", {});
    expect(state.open_boards).toEqual(["/~/a.ugcboard.json"]);
    expect(state.active_board).toBe("/~/a.ugcboard.json");
    expect(state.last_seen_version).toBe("1.0");
  });

  it("画板位提醒：导不出来时禁用导出", () => {
    expect(packMenuDisabled(undefined, "exportPack")).toBe("没有打开的画板");
    expect(packMenuDisabled(undefined, "downloadResults")).toBe("没有打开的画板");
    expect(packMenuDisabled({ status: "ok" }, "exportPack")).toBeNull();
  });
});

describe("保存失败", () => {
  it("普通的失败：可以重试与导出画板包", () => {
    const notice = saveFailureNotice({ saveError: "写不进去", missing: false, conflicted: false });
    expect(notice.actions).toEqual(["retry", "export"]);
    expect(notice.note).toContain("重试");
  });

  it("冲突：给重新载入与导出画板包两个动作", () => {
    const notice = saveFailureNotice({ saveError: "冲突", missing: false, conflicted: true });
    expect(notice.actions).toEqual(["reload", "export"]);
    expect(notice.note).toContain("不会自动合并");
  });

  it("存储端口已没有：应保留当前画板并恢复原文件路径", () => {
    const notice = saveFailureNotice({ saveError: "读不到", missing: true, conflicted: false });
    expect(notice.actions).toEqual(["retry", "export", "close"]);
    expect(notice.note).toBe("");
  });
});

describe("其余判定", () => {
  it("移走之后的提示跟着同一块画板", () => {
    expect(noticesAfterMove({ "/~/a": "warn" }, "/~/a", "/~/归档/a")).toEqual({ "/~/归档/a": "warn" });
  });

  it("体量提醒：没超线就不显示", () => {
    expect(activeSizeNotice(null, undefined).show).toBeNull();
    expect(activeSizeNotice("warn", "warn").show).toBeNull();
  });

  it("用量提醒：没有用量就不显示", () => {
    expect(usageNoticeVisible(null, null)).toBe(false);
    expect(usageNoticeVisible("alert", null)).toBe(true);
    expect(usageNoticeVisible("alert", "alert")).toBe(false);
  });

  it("模态：任一模态打开就是 true，全关才 false", () => {
    expect(
      modalOpenOf({
        settingsOpen: false,
        changelogOpen: false,
        boardListOpen: false,
        confirmOpen: false,
        sendTextOpen: true,
        packDialogOpen: false,
      }),
    ).toBe(true);
    expect(
      modalOpenOf({
        settingsOpen: false,
        changelogOpen: false,
        boardListOpen: false,
        confirmOpen: false,
        sendTextOpen: false,
        packDialogOpen: false,
      }),
    ).toBe(false);
  });
});

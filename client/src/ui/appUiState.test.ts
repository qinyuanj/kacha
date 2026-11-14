// 工作台的界面状态判定（#137）：界面状态的内容、体量提示、用量提醒、模态判定、画板包菜单禁用。
import { describe, expect, it } from "vitest";
import { activeSizeNotice, modalOpenOf, noticesAfterMove, packMenuDisabled, saveFailureNotice, uiStateOf, usageNoticeVisible } from "./appUiState";

describe("界面状态", () => {
  it("写进去的是打开的画板与当前画板", () => {
    const state = uiStateOf({ sessions: [{ key: "a", path: "/~/a" }, { key: "b", path: "/~/b" }], activeKey: "b" }, "1.0", {});
    expect(state.open_boards).toEqual(["/~/a", "/~/b"]);
    expect(state.active_board).toBe("/~/b");
    expect(state.last_seen_version).toBe("1.0");
  });

  it("没有当前画板：active_board 为 null", () => {
    expect(uiStateOf({ sessions: [], activeKey: null }, undefined, {}).active_board).toBeNull();
  });

  it("画板改名或搬到归档目录：提示记录跟随", () => {
    const notices = noticesAfterMove({ "/~/a": "warn" }, "/~/a", "/~/b");
    expect(notices["/~/b"]).toBe("warn");
    expect(notices["/~/a"]).toBeUndefined();
  });
});

describe("体量与用量提示", () => {
  it("越过黄线：提醒 warn", () => {
    expect(activeSizeNotice("warn", undefined).show).toBe("warn");
  });

  it("已提醒过同一档：不再提醒", () => {
    expect(activeSizeNotice("warn", "warn").show).toBeNull();
  });

  it("用量提醒：关掉同一档后不再提醒，升到红再提醒", () => {
    expect(usageNoticeVisible("warn", null)).toBe(true);
    expect(usageNoticeVisible("warn", "warn")).toBe(false);
    expect(usageNoticeVisible("alert", "warn")).toBe(true);
    expect(usageNoticeVisible("alert", "alert")).toBe(false);
    expect(usageNoticeVisible(null, null)).toBe(false);
  });
});

describe("模态判定", () => {
  const none = { settingsOpen: false, changelogOpen: false, boardListOpen: false, confirmOpen: false, sendTextOpen: false, packDialogOpen: false, sessionExpired: false };

  it("都没有开着：不算模态", () => {
    expect(modalOpenOf(none)).toBe(false);
  });

  it("任一开着：算模态", () => {
    for (const key of Object.keys(none) as (keyof typeof none)[]) {
      expect(modalOpenOf({ ...none, [key]: true })).toBe(true);
    }
  });
});

describe("画板包菜单", () => {
  it("没有打开的画板：两个条目都置灰", () => {
    expect(packMenuDisabled(undefined, "exportPack")).toBe("没有打开的画板");
    expect(packMenuDisabled(undefined, "downloadResults")).toBe("没有打开的画板");
  });

  it("画板打不开：导出与下载各说各的", () => {
    expect(packMenuDisabled({ status: "corrupt" }, "exportPack")).toBe("画板无法打开，不能导出");
    expect(packMenuDisabled({ status: "corrupt" }, "downloadResults")).toBe("画板无法打开，不能下载");
  });

  it("画板正常：两个条目都可点", () => {
    expect(packMenuDisabled({ status: "ok" }, "exportPack")).toBeNull();
    expect(packMenuDisabled({ status: "ok" }, "downloadResults")).toBeNull();
  });
});

describe("保存失败的提示", () => {
  it("冲突：可以重新载入", () => {
    expect(saveFailureNotice({ saveError: "x", missing: false, conflicted: true }).actions).toContain("reload");
  });

  it("丢失：不能重新载入，只能导出或关闭，也不加说明", () => {
    const r = saveFailureNotice({ saveError: "x", missing: true, conflicted: true });
    expect(r.actions).not.toContain("reload");
    expect(r.actions).toContain("close");
    expect(r.note).toBe("");
  });

  it("其它失败：可以重试保存", () => {
    expect(saveFailureNotice({ saveError: "x", missing: false, conflicted: false }).actions).toContain("retry");
  });
});

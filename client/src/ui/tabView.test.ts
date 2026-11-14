// 标签页的判定（#137）：标题、样式类、能不能改名、右键菜单的画板状态。
import { describe, expect, it } from "vitest";
import type { Session } from "./useBoardSessions";
import { canRename, packBoardOf, renameDraftOf, renameKeyOf, tabClassOf, tabTitleOf } from "./tabView";

const ok = (patch: Partial<Session> = {}): Session =>
  ({ key: "/b/a.kacha", path: "/b/a.kacha", status: "ok", board: { title: "画板甲" }, saveError: null, ...patch }) as Session;
const bad = (patch: Partial<Session> = {}): Session =>
  ({ key: "/b/x.kacha", path: "/b/x.kacha", status: "corrupt", reason: "坏", ...patch }) as Session;

describe("标签页判定", () => {
  it("标题：读得出来写画板标题，读不出来写文件名", () => {
    expect(tabTitleOf(ok())).toBe("画板甲");
    expect(tabTitleOf(bad())).toBe("x.kacha");
  });

  it("样式类：当前标签高亮；读不出来或保存失败标红", () => {
    expect(tabClassOf(ok(), "/b/a.kacha")).toBe("tab tab-active ");
    // 与拆分前逐字一致（非当前标签时中间留空串，不改 DOM）。
    expect(tabClassOf(ok(), "/b/other.kacha")).toBe("tab  ");
    expect(tabClassOf(bad(), null)).toBe("tab  tab-bad");
    expect(tabClassOf(ok({ saveError: "写不进去" }), null)).toBe("tab  tab-bad");
  });

  it("改名：只有读得出来的画板能改", () => {
    expect(canRename(ok())).toBe(true);
    expect(canRename(bad())).toBe(false);
  });

  it("双击改名：读得出来给标题当草稿，读不出来给 null", () => {
    expect(renameDraftOf(ok())).toBe("画板甲");
    expect(renameDraftOf(bad())).toBeNull();
  });

  it("改名输入框按键：回车提交、Esc 取消，其它不处理", () => {
    expect(renameKeyOf("Enter")).toBe("commit");
    expect(renameKeyOf("Escape")).toBe("cancel");
    expect(renameKeyOf("a")).toBeNull();
  });

  it("右键菜单的画板状态：读得出来算 open，读不出来算 broken", () => {
    expect(packBoardOf(ok())).toEqual({ open: true, broken: false });
    expect(packBoardOf(bad())).toEqual({ open: false, broken: true });
  });
});
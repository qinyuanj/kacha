import { describe, expect, it } from "vitest";
import { isArchivedPath, readOnlyMenu } from "./archive";
import type { MenuItem } from "./contextMenu";

describe("归档画板的位置（#90）", () => {
  it("只有画板目录下归档子目录里的画板是归档画板", () => {
    // 期望路径独立手写：服务端 board_list::ARCHIVE_DIR 是「画板/归档」。
    expect(isArchivedPath("/~", "/~/画板/归档/甲.ugcboard.json")).toBe(true);
    expect(isArchivedPath("/~", "/~/画板/甲.ugcboard.json")).toBe(false);
    expect(isArchivedPath("/~", "/~/别处/归档/甲.ugcboard.json")).toBe(false);
    expect(isArchivedPath("C:\\data", "C:\\data\\画板\\归档\\甲.ugcboard.json")).toBe(true);
  });
});

describe("归档画板的只读菜单", () => {
  const item = (action: MenuItem["action"], separatorBefore = false): MenuItem => ({ action, label: action, disabledReason: null, ...(separatorBefore ? { separatorBefore } : {}) });

  it("只留查看与下载，其余编辑类条目全部去掉", () => {
    const items = [item("continueEditing"), item("addAsReference"), item("preview", true), item("saveAs"), item("newStage", true), item("delete", true)];
    expect(readOnlyMenu(items).map((i) => i.action)).toEqual(["preview", "saveAs"]);
    // 剩下的第一条不画分隔线。
    expect(readOnlyMenu(items)[0].separatorBefore).toBeFalsy();
  });

  it("空白处与连线上没有可用条目", () => {
    expect(readOnlyMenu([item("newPrompt"), item("undo", true)])).toEqual([]);
    expect(readOnlyMenu([item("editRegion"), item("disconnect", true)])).toEqual([]);
  });
});

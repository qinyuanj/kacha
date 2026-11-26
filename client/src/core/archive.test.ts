import { describe, expect, it } from "vitest";
import { isArchivedPath, readOnlyMenu } from "./archive";
import type { BoardAction, MenuItem } from "./contextMenu";

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
  const item = (action: BoardAction, separatorBefore = false): MenuItem => ({ action, label: action, disabledReason: null, ...(separatorBefore ? { separatorBefore } : {}) });

  /**
   * 除预览与另存为之外的每一个动作。用 Record 而不是数组：少写一个动作、或多写一个已经不在
   * BoardAction 里的动作，类型检查都会失败——这份枚举不能靠人记。
   */
  const EDITING_ACTIONS: Record<Exclude<BoardAction, "preview" | "saveAs">, true> = {
    newPrompt: true,
    newTask: true,
    addReferences: true,
    undo: true,
    redo: true,
    continueEditing: true,
    addAsReference: true,
    generateVariant: true,
    delete: true,
    run: true,
    cancel: true,
    regenerate: true,
    toggleSettings: true,
    viewSendText: true,
    disconnect: true,
    editRegion: true,
    exportPack: true,
    importPack: true,
  };
  const editingActions = Object.keys(EDITING_ACTIONS) as Exclude<BoardAction, "preview" | "saveAs">[];

  it("除预览与另存为之外的每一个动作都被过滤掉", () => {
    // 逐条单独过：混在一起分不清是被过滤掉还是顺序变了。
    for (const action of editingActions) expect(readOnlyMenu([item(action, true)])).toEqual([]);
    // 分隔线不改变结论。
    expect(readOnlyMenu(editingActions.map((action) => item(action, true)))).toEqual([]);
  });

  it("预览与另存为保留，剩下的第一条不画分隔线", () => {
    const items = [...editingActions.map((action) => item(action, true)), item("preview", true), item("saveAs")];
    const kept = readOnlyMenu(items);
    expect(kept.map((i) => i.action)).toEqual(["preview", "saveAs"]);
    expect(kept[0].separatorBefore).toBeFalsy();
  });
});

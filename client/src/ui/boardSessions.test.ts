// 多画板会话的判定逻辑（#137）：冲突类别、只读判定、保存失败提示、删除的阻断说明。
import { describe, expect, it } from "vitest";
import { PortError } from "../shell/port";
import { BOARD_MISSING_TEXT } from "./boardText";
import { deleteBlockedText, deleteFailureState, isConflict, isMissing, isReadOnly, isSlotsFull, samePath, saveErrorFlags, saveErrorText } from "./boardSessions";

const failure = (kind: "conflict" | "missing" | "slotsFull" | "network") => new PortError({ kind, code: kind, message: kind, status: 0 });

describe("端口失败的类别", () => {
  it("冲突类：过期保存 / 已改名 / 同名已存在 / 画板位满 / 已归档 / 已取消", () => {
    for (const kind of ["conflict", "missing", "alreadyExists", "slotsFull", "archived", "cancelled"] as const) {
      expect(isConflict(new PortError({ kind, code: kind, message: kind, status: 0 }))).toBe(true);
    }
    expect(isConflict(failure("network"))).toBe(false);
  });

  it("画板已不存在与画板位满分别判定", () => {
    expect(isMissing(failure("missing"))).toBe(true);
    expect(isMissing(failure("conflict"))).toBe(false);
    expect(isSlotsFull(failure("slotsFull"))).toBe(true);
    expect(isSlotsFull(failure("conflict"))).toBe(false);
  });
});

describe("只读画板", () => {
  it("归档目录下的画板只读", () => {
    expect(isReadOnly("/~", "/~/画板/归档/a.ugcboard.json")).toBe(true);
    expect(isReadOnly("/~", "/~/画板/a.ugcboard.json")).toBe(false);
  });

  it("没有数据根：判不了只读", () => {
    expect(isReadOnly(null, "/~/画板/归档/a.ugcboard.json")).toBe(false);
  });
});

describe("路径比较", () => {
  it("大小写与分隔符不敏感", () => {
    expect(samePath("C:\\画板\\a.json", "c:/画板/a.json")).toBe(true);
    expect(samePath("/~/a", "/~/b")).toBe(false);
  });
});

describe("保存失败的提示", () => {
  it("画板已不存在：单独说，并提示恢复原文件路径", () => {
    expect(saveErrorText("/~/a", "offline", true)).toContain(BOARD_MISSING_TEXT);
    expect(saveErrorText("/~/a", "offline", true)).toContain("恢复原文件路径");
  });

  it("其余失败：给路径与原因", () => {
    expect(saveErrorText("/~/a", "offline", false)).toBe("未能保存到 /~/a：offline");
  });

  it("状态标记：冲突与丢失分别打标", () => {
    expect(saveErrorFlags(failure("conflict"))).toEqual({ conflicted: true, missing: false });
    expect(saveErrorFlags(failure("missing"))).toEqual({ conflicted: true, missing: true });
    expect(saveErrorFlags(failure("network"))).toEqual({ conflicted: false, missing: false });
  });
});

describe("删除与归档的阻断说明", () => {
  it("画板已不存在 / 已被改过 / 没能保存：三种说法", () => {
    expect(deleteBlockedText({ missing: true, conflicted: false, saveError: "x" })).toContain(BOARD_MISSING_TEXT);
    expect(deleteBlockedText({ missing: false, conflicted: true, saveError: "x" })).toContain("请先重新载入");
    expect(deleteBlockedText({ missing: false, conflicted: false, saveError: "写不进去" })).toContain("写不进去");
  });

  it("删除失败：画板已不存在就标 missing，其余标 conflicted", () => {
    expect(deleteFailureState(failure("missing")).missing).toBe(true);
    expect(deleteFailureState(failure("conflict")).conflicted).toBe(true);
    expect(deleteFailureState(failure("network"))).toEqual({ saveError: null, conflicted: false, missing: false });
  });
});

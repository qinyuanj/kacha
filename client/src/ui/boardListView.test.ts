// 画板列表对话框的可见判定（#137）：标题去扩展名、分组、已打开标记、体量档位、画板位满。
import { describe, expect, it } from "vitest";
import type { BoardListEntry, BoardListing } from "../shell/types";
import { boardGroups, boardRow, listDescription, listTitle, overSlots, slotsFull, titleOf } from "./boardListView";

const entry = (name: string, patch: Partial<BoardListEntry> = {}): BoardListEntry => ({
  name,
  path: `/~/${name}`,
  archived: false,
  bytes: 10,
  ...patch,
});

function listing(boards: BoardListEntry[], slots = { used: 1, total: 10 }): BoardListing {
  return { boards, slots, size_lines: { warn: 100, alert: 200 } };
}

describe("画板列表", () => {
  it("标题去掉扩展名", () => {
    expect(titleOf("a.ugcboard.json")).toBe("a");
  });

  it("分组：可编辑的与归档的分开", () => {
    const g = boardGroups(listing([entry("a"), entry("b", { archived: true })]), false);
    expect(g.editable.map((b) => b.name)).toEqual(["a"]);
    expect(g.archived.map((b) => b.name)).toEqual(["b"]);
  });

  it("管理画板：按体量从大到小排", () => {
    const g = boardGroups(listing([entry("small", { bytes: 10 }), entry("big", { bytes: 900 })]), true);
    expect(g.editable.map((b) => b.name)).toEqual(["big", "small"]);
  });

  it("普通列表：照服务端给的顺序", () => {
    const g = boardGroups(listing([entry("small", { bytes: 10 }), entry("big", { bytes: 900 })]), false);
    expect(g.editable.map((b) => b.name)).toEqual(["small", "big"]);
  });

  it("一行：已打开的画板标注出来", () => {
    const e = entry("a");
    expect(boardRow(e, ["/~/a"], listing([e])).isOpen).toBe(true);
    expect(boardRow(e, [], listing([e])).isOpen).toBe(false);
  });

  it("一行：越过提醒线才有档位", () => {
    const e = entry("a", { bytes: 300 });
    expect(boardRow(e, [], listing([e])).tier).toBe("alert");
    expect(boardRow(entry("b", { bytes: 10 }), [], listing([entry("b", { bytes: 10 })])).tier).toBeNull();
  });

  it("画板位：满与超出分别判定", () => {
    expect(slotsFull(listing([], { used: 10, total: 10 }))).toBe(true);
    expect(slotsFull(listing([], { used: 11, total: 10 }))).toBe(true);
    expect(slotsFull(listing([], { used: 9, total: 10 }))).toBe(false);
    expect(overSlots(listing([], { used: 11, total: 10 }))).toBe(true);
    expect(overSlots(listing([], { used: 9, total: 10 }))).toBe(false);
  });

  it("标题与说明：两种入口各一套", () => {
    expect(listTitle(false, "管理画板")).toBe("画板列表");
    expect(listTitle(true, "管理画板")).toBe("管理画板");
    expect(listDescription(true)).toContain("按画板体量从大到小");
    expect(listDescription(false)).toContain("画板保存在服务端");
  });
});

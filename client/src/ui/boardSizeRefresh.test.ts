// 当前画板体量的分档（#137）：列表里没有、体量未知、越过提醒线。
import { describe, expect, it } from "vitest";
import type { BoardListing } from "../shell/types";
import { activeSizeOf, isSameBoardSize } from "./boardSizeRefresh";

function listing(boards: BoardListing["boards"], lines = { warn: 100, alert: 200 }): BoardListing {
  return { boards, slots: { used: 0, total: 10 }, size_lines: lines };
}

const entry = (path: string, bytes: number | null) => ({ name: path.slice(path.lastIndexOf("/") + 1), path, archived: false, bytes });

describe("当前画板体量", () => {
  it("列表里有这一块：给出体量与档位", () => {
    const size = activeSizeOf(listing([entry("/~/a.ugcboard.json", 50)]), "/~/a.ugcboard.json");
    expect(size).toEqual({ path: "/~/a.ugcboard.json", bytes: 50, tier: null });
  });

  it("越过黄线：warn；越过红线：alert", () => {
    expect(activeSizeOf(listing([entry("/~/a", 150)]), "/~/a")?.tier).toBe("warn");
    expect(activeSizeOf(listing([entry("/~/a", 300)]), "/~/a")?.tier).toBe("alert");
  });

  it("列表里没有这块画板：null", () => {
    expect(activeSizeOf(listing([entry("/~/b", 10)]), "/~/a")).toBeNull();
  });

  it("体量未知（画板读不懂）：null", () => {
    expect(activeSizeOf(listing([entry("/~/a", null)]), "/~/a")).toBeNull();
  });

  it("换了画板：旧的结果不当成新画板的体量", () => {
    const size = { path: "/~/a", bytes: 10, tier: null };
    expect(isSameBoardSize(size, "/~/a")).toBe(true);
    expect(isSameBoardSize(size, "/~/b")).toBe(false);
    expect(isSameBoardSize(null, "/~/a")).toBe(false);
  });
});

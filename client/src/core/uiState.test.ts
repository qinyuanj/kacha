import { describe, expect, it } from "vitest";
import { DEFAULT_UI_STATE, parseUiState, serializeUiState } from "./uiState";

describe("界面状态 ui-state.json", () => {
  it("往返：上次打开列表与当前页", () => {
    const state = { open_boards: ["/r/画板/a.ugcboard.json", "/r/画板/b.ugcboard.json"], active_board: "/r/画板/b.ugcboard.json" };
    expect(parseUiState(serializeUiState(state))).toEqual(state);
  });

  it("缺失或损坏静默重置为默认", () => {
    expect(parseUiState(null)).toEqual(DEFAULT_UI_STATE);
    expect(parseUiState("{oops")).toEqual(DEFAULT_UI_STATE);
    expect(parseUiState('{"open_boards": [1]}')).toEqual(DEFAULT_UI_STATE);
  });

  it("当前页不在打开列表里时取第一个", () => {
    const text = JSON.stringify({ open_boards: ["/a"], active_board: "/zzz" });
    expect(parseUiState(text).active_board).toBe("/a");
  });

  it("往返：上次看过的版本", () => {
    const state = { open_boards: [], active_board: null, last_seen_version: "1.2.0" };
    expect(parseUiState(serializeUiState(state))).toEqual(state);
  });

  it("旧文件没有上次看过的版本时不带该字段", () => {
    const parsed = parseUiState(JSON.stringify({ open_boards: ["/a"], active_board: "/a" }));
    expect(parsed).toStrictEqual({ open_boards: ["/a"], active_board: "/a" });
    expect("last_seen_version" in parsed).toBe(false);
  });

  it("往返：各画板已提醒到的体量档位", () => {
    const state = { open_boards: ["/a"], active_board: "/a", size_notices: { "/a": "warn" as const, "/b": "alert" as const } };
    expect(parseUiState(serializeUiState(state))).toEqual(state);
  });

  it("体量档位里认不得的值丢掉，其余照常", () => {
    const parsed = parseUiState(JSON.stringify({ open_boards: ["/a"], active_board: "/a", size_notices: { "/a": "red", "/b": "alert", "/c": 1 } }));
    expect(parsed.size_notices).toEqual({ "/b": "alert" });
    expect(parseUiState(JSON.stringify({ open_boards: ["/a"], active_board: "/a", size_notices: [] })).size_notices).toBeUndefined();
  });

  it("上次看过的版本不是字符串时忽略，标签页照常恢复", () => {
    const parsed = parseUiState(JSON.stringify({ open_boards: ["/a"], active_board: "/a", last_seen_version: 120 }));
    expect(parsed).toStrictEqual({ open_boards: ["/a"], active_board: "/a" });
  });
});

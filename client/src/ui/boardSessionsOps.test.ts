// 画板会话的各个操作（#137）：能不能编辑、改名的可用名。
import { describe, expect, it } from "vitest";
import { editable } from "./boardSessionsOps";

describe("会话的判定", () => {
  it("没有会话：不能编辑", () => {
    expect(editable(undefined, () => false, new Set())).toBe(false);
  });

  it("归档里的画板：只读，不能编辑", () => {
    expect(editable({ status: "ok", path: "/~/归档/a.ugcboard.json", key: "k1" } as never, (p) => p.includes("归档"), new Set())).toBe(false);
  });

  it("普通画板：能编辑", () => {
    expect(editable({ status: "ok", path: "/~/a.ugcboard.json", key: "k1" } as never, () => false, new Set())).toBe(true);
  });

  it("正在搬动的画板：不能编辑", () => {
    expect(editable({ status: "ok", path: "/~/a.ugcboard.json", key: "k1" } as never, () => false, new Set(["k1"]))).toBe(false);
  });

  it("不是 ok 的会话：不能编辑", () => {
    expect(editable({ status: "corrupt", path: "/~/a", key: "k1" } as never, () => false, new Set())).toBe(false);
  });
});

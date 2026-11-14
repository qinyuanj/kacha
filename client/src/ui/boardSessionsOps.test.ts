// 画板会话的各个操作（#137）：改名、删除、归档、另存与重载。
import { describe, expect, it, vi } from "vitest";
import type { Board } from "../core/board";
import { createFakePort } from "../shell/testing/fakePort";
import { archiveBoardSession, copyAsNewBoardSession, deleteBoardSession, editable, freePathIn, reloadBoardSession, renameBoardSession, unarchiveBoardSession, type SessionPorts, type SessionStore } from "./boardSessionsOps";

/** 一块画板。 */
const board = (title = "a"): Board => ({ format_version: 2, title, viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} });

/** 一个会话仓库（替身）：只用到 setSessions / sessionOf / patch / sessionsRef。 */
function storeOf(sessions: unknown[]): SessionStore & { sessions: unknown[] } {
  const ref = { current: sessions };
  return {
    sessions: sessions as never,
    sessionsRef: ref as never,
    setSessions: (next: unknown[]) => {
      ref.current = next;
    },
    sessionOf: (key: string) => ref.current.find((s) => (s as { key: string }).key === key) as never,
    patch: (key: string, fn: (s: never) => never) => {
      ref.current = ref.current.map((s) => ((s as { key: string }).key === key ? fn(s as never) : s));
    },
  } as never;
}

const okSession = (key = "k1", path = "/~/a.ugcboard.json", title = "a") => ({ key, path, status: "ok", board: board(title), history: { past: [], future: [] }, notice: null, saveError: null, version: "v1", conflicted: false, missing: false });

describe("能不能编辑", () => {
  it("没有会话：不能编辑", () => {
    expect(editable(undefined, () => false, new Set())).toBe(false);
  });

  it("归档里的画板：只读，不能编辑", () => {
    expect(editable({ status: "ok", path: "/~/画板/归档/a.ugcboard.json", key: "k1" } as never, (p) => p.includes("归档"), new Set())).toBe(false);
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

describe("删除画板", () => {
  it("先落盘再删：删除后关掉标签页", async () => {
    const port = createFakePort({ boards: [{ path: "/~/a.ugcboard.json", main: "{}", version: "v1" }] });
    const store = storeOf([okSession()]);
    const flush = vi.fn(async () => undefined);
    const dropSession = vi.fn();
    await deleteBoardSession(store, port as unknown as SessionPorts, flush, dropSession, "k1");
    expect(flush).toHaveBeenCalledWith("k1");
    expect(port.calls.remove).toHaveLength(1);
    expect(dropSession).toHaveBeenCalledWith("k1");
  });

  it("保存失败：不删，标签页留着", async () => {
    const port = createFakePort({ boards: [{ path: "/~/a.ugcboard.json", main: "{}", version: "v1" }] });
    const store = storeOf([{ ...okSession(), saveError: "写不进去" }]);
    const dropSession = vi.fn();
    await expect(deleteBoardSession(store, port as unknown as SessionPorts, async () => undefined, dropSession, "k1")).rejects.toThrow();
    expect(port.calls.remove).toHaveLength(0);
    expect(dropSession).not.toHaveBeenCalled();
  });

  it("画板已不在：报错但标签页留着", async () => {
    const port = createFakePort();
    const store = storeOf([okSession()]);
    const dropSession = vi.fn();
    await expect(deleteBoardSession(store, port as unknown as SessionPorts, async () => undefined, dropSession, "k1")).rejects.toThrow();
    expect(dropSession).not.toHaveBeenCalled();
  });
});

describe("归档画板", () => {
  it("搬进归档目录：标签页留着", async () => {
    const port = createFakePort({ boards: [{ path: "/~/a.ugcboard.json", main: "{}", version: "v1" }] });
    const store = storeOf([okSession()]);
    const movedTo = vi.fn();
    await archiveBoardSession(store, port as unknown as SessionPorts, "/~", async () => undefined, new Set(), movedTo, "/~/a.ugcboard.json");
    expect(port.calls.archive).toHaveLength(1);
    expect(movedTo).toHaveBeenCalled();
    expect(String(port.calls.archive[0].to)).toContain("归档");
  });

  it("没有用户数据根：什么都不做", async () => {
    const port = createFakePort();
    const movedTo = vi.fn();
    await archiveBoardSession(storeOf([okSession()]), port as unknown as SessionPorts, null, async () => undefined, new Set(), movedTo, "/~/a.ugcboard.json");
    expect(port.calls.archive).toHaveLength(0);
  });
});

describe("取消归档与另存", () => {
  it("取消归档：搬回画板目录", async () => {
    const port = createFakePort({ boards: [{ path: "/~/画板/归档/a.ugcboard.json", main: "{}", version: "v1", archived: true }] });
    const store = storeOf([]);
    const movedTo = vi.fn();
    const refusal = await unarchiveBoardSession(store, port as unknown as SessionPorts, "/~", movedTo, "/~/画板/归档/a.ugcboard.json");
    expect(refusal).toBeNull();
    expect(port.calls.unarchive).toHaveLength(1);
  });

  it("复制为新画板：另存到画板目录", async () => {
    const main = JSON.stringify({ format_version: 2, title: "a", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} });
    const port = createFakePort({ boards: [{ path: "/~/画板/归档/a.ugcboard.json", main, version: "v1", archived: true }] });
    const store = storeOf([]);
    const openPath = vi.fn(async () => true);
    const refusal = await copyAsNewBoardSession(store, port as unknown as SessionPorts, "/~", openPath, "/~/画板/归档/a.ugcboard.json");
    expect(refusal).toBeNull();
    expect(port.calls.write.length).toBeGreaterThan(0);
  });
});

describe("改名", () => {
  it("改标题：改文件名并改画板标题", async () => {
    const port = createFakePort({ boards: [{ path: "/~/a.ugcboard.json", main: "{}", version: "v1" }] });
    const store = storeOf([okSession()]);
    const movedTo = vi.fn();
    const apply = vi.fn();
    await renameBoardSession(store, port as unknown as SessionPorts, async () => undefined, apply, movedTo, () => false, new Set(), "k1", "新名字");
    expect(port.calls.rename).toHaveLength(1);
    expect(apply).toHaveBeenCalledWith("k1", { kind: "title", title: "新名字" });
  });

  it("标题没变：什么都不做", async () => {
    const port = createFakePort({ boards: [{ path: "/~/a.ugcboard.json", main: "{}", version: "v1" }] });
    const port2 = port as unknown as SessionPorts;
    const apply = vi.fn();
    await renameBoardSession(storeOf([okSession("k1", "/~/a.ugcboard.json", "a")]), port2, async () => undefined, apply, vi.fn(), () => false, new Set(), "k1", "a");
    expect(port.calls.rename).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it("只读画板：给出提示，不改", async () => {
    const port = createFakePort();
    const apply = vi.fn();
    await renameBoardSession(storeOf([okSession()]), port as unknown as SessionPorts, async () => undefined, apply, vi.fn(), () => true, new Set(), "k1", "新名字");
    expect(port.calls.rename).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("重载", () => {
  it("读回服务端的画板", async () => {
    const port = createFakePort({ boards: [{ path: "/~/a.ugcboard.json", main: '{"format_version":2,"title":"远端","viewport":{"zoom":1,"x":0,"y":0},"nodes":[],"edges":[],"extra":{}}', version: "v2" }] });
    const store = storeOf([okSession()]);
    await reloadBoardSession(store, port as unknown as SessionPorts, "/~", new Set(), "k1");
    const s = store.sessionOf("k1") as unknown as { status: string; board: Board; version: string };
    expect(s.status).toBe("ok");
    expect(s.board.title).toBe("远端");
    expect(s.version).toBe("v2");
  });
});

describe("可用文件名", () => {
  it("没重名：沿用原名", async () => {
    const port = createFakePort();
    const path = await freePathIn(storeOf([]), port as unknown as SessionPorts, "/~", "/~/a.ugcboard.json");
    expect(path).toBe("/~/a.ugcboard.json");
  });

  it("重名：加序号", async () => {
    const port = createFakePort({ boards: [{ path: "/~/a.ugcboard.json", main: "{}", version: "v1" }] });
    const path = await freePathIn(storeOf([]), port as unknown as SessionPorts, "/~", "/~/a.ugcboard.json");
    expect(path).not.toBe("/~/a.ugcboard.json");
    expect(path).toContain("(2)");
  });
});

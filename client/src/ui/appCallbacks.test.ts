// 工作台接线的判定（#137）：当前画板、保存失败的画板、归档判定、画板包菜单、体量提示。
import { describe, expect, it, vi } from "vitest";
import type { Session } from "./useBoardSessions";
import {
  activeSession,
  applyActive,
  applyWithFlush,
  archivedPath,
  boardFileOf,
  boardNoticeText,
  boardOpenState,
  boardTitleOf,
  cancelTaskOn,
  checkActive,
  closeBoardList,
  failingSessions,
  historyLabels,
  jumpToTask,
  openBoardList,
  openManageBoards,
  packMenuPick,
  redoOn,
  togglePackMenu,
  undoOn,
} from "./appCallbacks";
import { emptyHistory } from "../core/history";

const okSession = (patch: Partial<Extract<Session, { status: "ok" }>> = {}): Session => ({
  key: "k1",
  path: "/~/画板/a.ugcboard.json",
  status: "ok",
  board: { format_version: 2, title: "标题", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} },
  history: emptyHistory(),
  notice: null,
  saveError: null,
  version: "v1",
  conflicted: false,
  missing: false,
  ...patch,
});

describe("当前画板", () => {
  it("按 key 找出当前会话", () => {
    const sessions = [okSession(), { key: "k2", path: "/~/b", status: "newer" as const, version: 3 }];
    expect(activeSession(sessions, "k2")?.key).toBe("k2");
    expect(activeSession(sessions, "k9")).toBeUndefined();
  });

  it("能打开：ok 状态且有数据根", () => {
    expect(boardOpenState(okSession(), "/~")).toBe("ok");
    expect(boardOpenState(okSession(), null)).toBe("none");
  });

  it("版本太新 / 文件损坏：各有各的说法", () => {
    expect(boardOpenState({ key: "k", path: "/~/a", status: "newer", version: 3 }, "/~")).toBe("newer");
    expect(boardOpenState({ key: "k", path: "/~/a", status: "corrupt", reason: "坏了" }, "/~")).toBe("corrupt");
  });

  it("归档画板：路径给出来，非归档画板为 null", () => {
    expect(archivedPath(okSession(), "/~")).toBeNull();
    expect(archivedPath(okSession({ path: "/~/画板/归档/a.ugcboard.json" }), "/~")).toBe("/~/画板/归档/a.ugcboard.json");
  });

  it("画板名：已关闭的画板给个说明", () => {
    expect(boardTitleOf([okSession()], "k1")).toBe("标题");
    expect(boardTitleOf([okSession()], "k9")).toBe("（已关闭的画板）");
  });

  it("画板自己的提示", () => {
    expect(boardNoticeText(okSession({ notice: "重命名失败" }))).toBe("重命名失败");
    expect(boardNoticeText(okSession())).toBeNull();
  });

  it("画板文件名（只用于日志）", () => {
    expect(boardFileOf(okSession())).toBe("a.ugcboard.json");
    expect(boardFileOf(undefined)).toBe("");
  });
});

describe("保存失败的画板", () => {
  it("只报 ok 状态且有保存错误的", () => {
    const failing = failingSessions([okSession({ saveError: "写不进去" }), okSession(), { key: "k3", path: "/~/c", status: "newer", version: 1 }]);
    expect(failing).toHaveLength(1);
    expect(failing[0].saveError).toBe("写不进去");
  });

});

describe("画板包菜单", () => {
  it("点了菜单项：导入、导出、下载各走各的", () => {
    const importPack = vi.fn();
    const prepareExport = vi.fn();
    const download = vi.fn();
    packMenuPick("importPack", okSession(), importPack, prepareExport, download);
    expect(importPack).toHaveBeenCalled();
    expect(prepareExport).not.toHaveBeenCalled();
    packMenuPick("exportPack", okSession(), importPack, prepareExport, download);
    expect(prepareExport).toHaveBeenCalledWith("k1");
    packMenuPick("downloadResults", okSession(), importPack, prepareExport, download);
    expect(download).toHaveBeenCalledWith("/~/画板/a.ugcboard.json");
  });

  it("画板打不开：导出与下载都不做", () => {
    const importPack = vi.fn();
    const prepareExport = vi.fn();
    const download = vi.fn();
    const broken: Session = { key: "k", path: "/~/a", status: "corrupt", reason: "坏了" };
    packMenuPick("exportPack", broken, importPack, prepareExport, download);
    packMenuPick("downloadResults", broken, importPack, prepareExport, download);
    expect(prepareExport).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});

describe("画板变更与撤销", () => {
  it("变更：提交与结果立即落盘", () => {
    const flushNow = vi.fn(async () => undefined);
    const apply = vi.fn(() => ({ board: {} }));
    applyWithFlush(apply, flushNow, "k1", { kind: "submitted", taskId: "t1", lastSubmitted: null });
    applyWithFlush(apply, flushNow, "k1", { kind: "runResult", result: {} as never });
    expect(flushNow).toHaveBeenCalledTimes(2);
    expect(flushNow).toHaveBeenCalledWith("k1");
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("其它变更：不落盘", () => {
    const flushNow = vi.fn(async () => undefined);
    const apply = vi.fn(() => ({ board: {} }));
    applyWithFlush(apply, flushNow, "k1", { kind: "title", title: "新" });
    expect(flushNow).not.toHaveBeenCalled();
  });

  it("没有待写错误：不记保存失败", () => {
    expect(boardNoticeText(okSession())).toBeNull();
  });

  it("没有打开的画板：变更与试算都不做", () => {
    const apply = vi.fn();
    const check = vi.fn();
    expect(applyActive(apply, null, { kind: "title", title: "x" })).toBeNull();
    expect(checkActive(check, null, { kind: "title", title: "x" })).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("撤销 / 重做：没有打开的画板时不做", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    undoOn(undo, null);
    redoOn(redo, null);
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
  });

  it("任务节点的取消：没有打开的画板时不做", () => {
    const cancel = vi.fn();
    cancelTaskOn({ cancel } as never, null, "t1");
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("其它接线", () => {
  it("画板包菜单开关", () => {
    expect(togglePackMenu(null, { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(togglePackMenu({ x: 1, y: 2 }, { x: 3, y: 4 })).toBeNull();
  });

  it("画板列表关掉：管理入口一起复位", () => {
    const setBoardListOpen = vi.fn();
    const setManageBoards = vi.fn();
    closeBoardList(setBoardListOpen, setManageBoards);
    expect(setBoardListOpen).toHaveBeenCalledWith(false);
    expect(setManageBoards).toHaveBeenCalledWith(false);
  });

  it("工具栏「画板列表」入口：先落盘再开普通列表，不进入「管理画板」", async () => {
    const flushAll = vi.fn(async () => undefined);
    const setBoardListOpen = vi.fn();
    const setManageBoards = vi.fn();
    openBoardList(flushAll, setBoardListOpen);
    await flushAll.mock.results[0].value;
    expect(flushAll).toHaveBeenCalledTimes(1);
    expect(setBoardListOpen).toHaveBeenCalledWith(true);
    expect(setManageBoards).not.toHaveBeenCalled();
  });

  it("用量提醒「管理画板」入口：先落盘再按管理变体打开", async () => {
    const flushAll = vi.fn(async () => undefined);
    const setBoardListOpen = vi.fn();
    const setManageBoards = vi.fn();
    openManageBoards(flushAll, setManageBoards, setBoardListOpen);
    await flushAll.mock.results[0].value;
    expect(flushAll).toHaveBeenCalledTimes(1);
    expect(setManageBoards).toHaveBeenCalledWith(true);
    expect(setBoardListOpen).toHaveBeenCalledWith(true);
  });

  it("跳到任务：切画板并记下聚焦请求", () => {
    const setActiveKey = vi.fn();
    const setFocus = vi.fn();
    jumpToTask(setActiveKey, setFocus, { boardKey: "k1", nodeId: "n1", nonce: 3 }, { boardKey: "k2", taskNodeId: "t1" });
    expect(setActiveKey).toHaveBeenCalledWith("k2");
    expect(setFocus).toHaveBeenCalledWith({ boardKey: "k2", nodeId: "t1", nonce: 4 });
  });

  it("撤销 / 重做标签：没有画板时为 null", () => {
    expect(historyLabels(undefined)).toEqual({ undo: null, redo: null });
    const ok = okSession();
    if (ok.status !== "ok") throw new Error("fixture should be ok");
    const b = ok.board;
    expect(historyLabels(okSession({ history: { ...emptyHistory(), undo: [{ board: b, label: "改标题", seenResults: new Set() }], redo: [{ board: b, label: "删除节点", seenResults: new Set() }] } }))).toEqual({ undo: "改标题", redo: "删除节点" });
  });
});

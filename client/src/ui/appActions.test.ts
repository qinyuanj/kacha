// 工作台动作的接线（#137）：运行的分派、关闭与删除的阻断、导出与放弃的处理。
import { describe, expect, it, vi } from "vitest";
import type { Board } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { archiveBoardAt, closeBoard, copySendText, deleteBoardAt, discardMissing, exportBoardAt, openFromList } from "./appActions";

const board = (): Board => ({ format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} });

describe("关闭画板", () => {
  it("没有未完成的任务：直接关", async () => {
    const closeSessions = vi.fn(async () => undefined);
    await closeBoard({ pending: () => 0, ask: async () => true, closeRunner: vi.fn(), closeSessions }, "k1");
    expect(closeSessions).toHaveBeenCalledWith("k1");
  });

  it("有未完成的任务：先问用户；用户不肯就不关", async () => {
    const closeSessions = vi.fn(async () => undefined);
    const ask = vi.fn(async () => false);
    await closeBoard({ pending: () => 3, ask, closeRunner: vi.fn(), closeSessions }, "k1");
    expect(ask).toHaveBeenCalled();
    expect(closeSessions).not.toHaveBeenCalled();
  });

  it("用户同意：取消任务后关掉", async () => {
    const closeRunner = vi.fn();
    const closeSessions = vi.fn(async () => undefined);
    await closeBoard({ pending: () => 3, ask: async () => true, closeRunner, closeSessions }, "k1");
    expect(closeRunner).toHaveBeenCalledWith("k1");
    expect(closeSessions).toHaveBeenCalledWith("k1");
  });
});

describe("从列表删除画板", () => {
  it("本页没打开：直接删", async () => {
    const removeDirect = vi.fn(async () => undefined);
    const deleteSessions = vi.fn(async () => undefined);
    await deleteBoardAt({ keyOf: () => null, pending: () => 0, ask: async () => true, closeRunner: vi.fn(), deleteSessions, removeDirect }, "/~/a");
    expect(removeDirect).toHaveBeenCalledWith("/~/a");
    expect(deleteSessions).not.toHaveBeenCalled();
  });

  it("本页开着：先停任务再删", async () => {
    const closeRunner = vi.fn();
    const deleteSessions = vi.fn(async () => undefined);
    await deleteBoardAt({ keyOf: () => "k1", pending: () => 2, ask: async () => true, closeRunner, deleteSessions, removeDirect: async () => undefined }, "/~/a");
    expect(closeRunner).toHaveBeenCalledWith("k1");
    expect(deleteSessions).toHaveBeenCalledWith("k1");
  });

  it("用户不肯停任务：什么都不做", async () => {
    const deleteSessions = vi.fn(async () => undefined);
    await deleteBoardAt({ keyOf: () => "k1", pending: () => 2, ask: async () => false, closeRunner: vi.fn(), deleteSessions, removeDirect: async () => undefined }, "/~/a");
    expect(deleteSessions).not.toHaveBeenCalled();
  });
});

describe("归档画板", () => {
  it("本页开着且有未完成的任务：先确认再归档", async () => {
    const closeRunner = vi.fn();
    const archiveSessions = vi.fn(async () => undefined);
    await archiveBoardAt({ keyOf: () => "k1", pending: () => 1, ask: async () => true, closeRunner, archiveSessions }, "/~/a");
    expect(closeRunner).toHaveBeenCalledWith("k1");
    expect(archiveSessions).toHaveBeenCalledWith("/~/a");
  });

  it("本页没开着：直接归档", async () => {
    const closeRunner = vi.fn();
    const archiveSessions = vi.fn(async () => undefined);
    await archiveBoardAt({ keyOf: () => null, pending: () => 0, ask: async () => true, closeRunner, archiveSessions }, "/~/a");
    expect(closeRunner).not.toHaveBeenCalled();
    expect(archiveSessions).toHaveBeenCalledWith("/~/a");
  });
});

describe("导出画板包", () => {
  it("本页开着：直接导出", async () => {
    const prepareExport = vi.fn(async () => undefined);
    const open = vi.fn(async () => true);
    await exportBoardAt({ keyOf: () => "k1", open, prepareExport, toast: vi.fn() }, "/~/a");
    expect(prepareExport).toHaveBeenCalledWith("k1");
    expect(open).not.toHaveBeenCalled();
  });

  it("本页没开着：先打开再导出", async () => {
    const prepareExport = vi.fn(async () => undefined);
    const open = vi.fn(async () => true);
    await exportBoardAt({ keyOf: () => null, open, prepareExport, toast: vi.fn() }, "/~/a");
    expect(open).toHaveBeenCalledWith("/~/a", true);
    expect(prepareExport).not.toHaveBeenCalled();
  });

  it("打不开：提示画板不存在", async () => {
    const toast = vi.fn();
    await exportBoardAt({ keyOf: () => null, open: async () => false, prepareExport: async () => undefined, toast }, "/~/a");
    expect(toast).toHaveBeenCalled();
  });
});

describe("放弃已不存在的画板", () => {
  it("用户确认：丢掉会话", async () => {
    const dropSession = vi.fn();
    await discardMissing({ ask: async () => true, closeRunner: vi.fn(), dropSession }, "k1");
    expect(dropSession).toHaveBeenCalledWith("k1");
  });

  it("用户不确认：留着", async () => {
    const dropSession = vi.fn();
    await discardMissing({ ask: async () => false, closeRunner: vi.fn(), dropSession }, "k1");
    expect(dropSession).not.toHaveBeenCalled();
  });
});

describe("从列表打开画板", () => {
  it("打不开：提示可能被改名", async () => {
    const toast = vi.fn();
    await openFromList({ open: async () => false, toast }, "/~/a");
    expect(toast).toHaveBeenCalled();
  });

  it("打开了：不提示", async () => {
    const toast = vi.fn();
    await openFromList({ open: async () => true, toast }, "/~/a");
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("复制发送文本", () => {
  it("成功：提示已复制", async () => {
    const toast = vi.fn();
    await copySendText({ copyText: async () => undefined, toast }, "文本");
    expect(toast).toHaveBeenCalledWith("已复制发送文本");
  });

  it("失败：提示原因", async () => {
    const toast = vi.fn();
    await copySendText({ copyText: async () => { throw new Error("offline"); }, toast }, "文本");
    expect(toast).toHaveBeenCalledWith("复制失败：offline");
  });
});

describe("能力表", () => {
  it("内置能力表可用（供确认项上下文用）", () => {
    expect(BUILTIN_TABLE).toBeDefined();
    expect(board()).toBeDefined();
  });
});

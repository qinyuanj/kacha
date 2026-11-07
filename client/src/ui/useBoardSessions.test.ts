import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { newBoard, serializeBoard, type Board } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { ipc } from "../shell/ipc";
import { useBoardSessions } from "./useBoardSessions";

// Node 的 server renderer 执行真实 hook；测试使用其公开 snapshot/action，文件系统是唯一替身边界。
function sessions() {
  let result!: ReturnType<typeof useBoardSessions>;
  function Host() {
    result = useBoardSessions("/~", () => ({ table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set() }));
    return null;
  }
  renderToString(createElement(Host));
  return result;
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

function stagedBoard(): Board {
  const base = { pos: [0, 0] as [number, number], size: [200, 200] as [number, number], extra: {} };
  return { ...newBoard("original"),
    nodes: [
      { ...base, id: "r", type: "result", task_id: "20261107T000000Z-r", path: "2026-11-07/20261107T000000Z-r/result.png", file: "result.png", layer_count: 0, record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-11-07T00:00:00Z" } },
      { ...base, id: "t", type: "task", model: "m", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, image_ports: 1, layer_decomposition: false, transparent_background: false, last_submitted: null },
    ],
    edges: [{ from: ["r", "out"], to: ["t", "image:0"], source_layer: null, region: null, system: false, extra: {} }],
    stages: [{ id: "s", name: "stage", nodes: ["t"], collapsed: false, extra: {} }],
  };
}

it.each(["failed", "changed"])("移出SHA采集%s时不写新板，不删除原节点", async (mode) => {
  vi.useFakeTimers();
  const original = stagedBoard();
  vi.spyOn(ipc, "readBoard").mockResolvedValue({ main: serializeBoard(original), bak: null, version: "v" });
  const write = vi.spyOn(ipc, "writeBoard").mockResolvedValue();
  vi.spyOn(ipc, "listBoards").mockResolvedValue({ boards: [], slots: { used: 1, total: 10 }, size_lines: { warn: 100, alert: 200 } });
  const boards = sessions();
  await boards.openPath("/~/画板/original.ugcboard.json");
  const key = boards.snapshot().sessions[0].key;
  vi.spyOn(ipc, "fileSha256").mockImplementation(async () => {
    if (mode === "failed") throw new Error("offline");
    boards.apply(key, { kind: "title", title: "new title" });
    return "a".repeat(64);
  });
  expect(await boards.moveOutStage(key, "s")).toContain("移出失败");
  expect(boards.getBoard(key)?.nodes.map((n) => n.id)).toEqual(["r", "t"]);
  expect(write).not.toHaveBeenCalled();
});

it("归档从flush开始到移动完成期间拒绝编辑和撤销，失败后恢复编辑", async () => {
  vi.useFakeTimers();
  const original = newBoard("before");
  vi.spyOn(ipc, "readBoard").mockResolvedValue({ main: serializeBoard(original), bak: null, version: "v1" });
  vi.spyOn(ipc, "writeBoard").mockResolvedValue();
  let release!: () => void;
  vi.spyOn(ipc, "listBoardNames").mockImplementation(() => new Promise((resolve) => { release = () => resolve([]); }));
  vi.spyOn(ipc, "archiveBoard").mockRejectedValue(new Error("offline"));
  const boards = sessions();
  await boards.openPath("/~/画板/before.ugcboard.json");
  const key = boards.snapshot().sessions[0].key;
  boards.apply(key, { kind: "title", title: "saved" });
  const archive = boards.archiveBoard("/~/画板/before.ugcboard.json");
  expect(boards.apply(key, { kind: "title", title: "lost" })).toBeNull();
  boards.undoBoard(key);
  expect(boards.getBoard(key)?.title).toBe("saved");
  // flush 的内容版本哈希也完成后才会列目标目录。
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  expect(release).toBeDefined();
  release();
  await expect(archive).rejects.toThrow("offline");
  expect(boards.apply(key, { kind: "title", title: "editable" })?.board.title).toBe("editable");
  await boards.flushAll();
});

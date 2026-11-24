// 多画板会话（#126）：打开 / 保存 / 归档都只经壳端口；文件系统是唯一替身边界（内存端口，不发请求）。
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { newBoard, serializeBoard } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { useBoardSessions } from "./useBoardSessions";

/** 用给定端口渲染一次 hook（Node 的 server renderer 执行真实 hook）。 */
function sessions(port: FakePort) {
  let result!: ReturnType<typeof useBoardSessions>;
  function Host() {
    result = useBoardSessions(port.userRoot, () => ({ table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set() }));
    return null;
  }
  renderToString(createElement(ShellProvider, { port, children: createElement(Host) }));
  return result;
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

it("归档从flush开始到移动完成期间拒绝编辑和撤销，失败后恢复编辑", async () => {
  vi.useFakeTimers();
  const original = newBoard("before");
  const port = createFakePort({ boards: [{ path: "/~/画板/before.ugcboard.json", main: serializeBoard(original), version: "v1" }] });
  let release!: () => void;
  port.board.listNames = () => new Promise((resolve) => { release = () => resolve([]); });
  port.board.archive = async () => {
    throw new Error("offline");
  };
  const boards = sessions(port);
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

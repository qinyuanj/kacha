// 本地画板（#128）：打开、新建与保存都只经壳端口；保存失败要留住内存里的改动并给出原因，
// 保存成功后重新打开画板，改动仍在。文件系统是唯一替身边界（内存端口，不起 MyGo runtime）。
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { newBoard, serializeBoard } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { useBoardSessions } from "./useBoardSessions";

const BOARD_PATH = "/~/画板/本地.ugcboard.json";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** 用给定端口渲染一次 hook（Node 的 server renderer 执行真实 hook）。 */
function sessions(port: FakePort): ReturnType<typeof useBoardSessions> {
  let result!: ReturnType<typeof useBoardSessions>;
  function Host() {
    result = useBoardSessions(port.userRoot, () => ({ table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set() }));
    return null;
  }
  renderToString(createElement(ShellProvider, { port, children: createElement(Host) }));
  return result;
}

/** 打开一块画板并改标题（一次用户改动）。 */
async function openAndEdit(port: FakePort, title: string): Promise<{ key: string; boards: ReturnType<typeof useBoardSessions> }> {
  const boards = sessions(port);
  await act(async () => {
    await boards.openPath(BOARD_PATH);
  });
  const key = boards.snapshot().sessions[0].key;
  await act(async () => {
    boards.apply(key, { kind: "title", title });
  });
  return { key, boards };
}


it("打开本机画板：节点、连线与结果关系照常显示", async () => {
  const board = {
    ...newBoard("本地"),
    nodes: [
      { id: "p", type: "prompt", pos: [0, 0] as [number, number], size: [200, 200] as [number, number], text: "一个提示", extra: {} },
      { id: "r", type: "result", pos: [400, 0] as [number, number], size: [200, 200] as [number, number], task_id: "20261107T000000Z-r", path: "2026-11-07/20261107T000000Z-r/result.png", file: "result.png", layer_count: 0, record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-11-07T00:00:00Z" }, extra: {} },
    ],
    edges: [{ from: ["r", "out"] as [string, string], to: ["p", "in"] as [string, string], source_layer: null, region: null, system: false, extra: {} }],
  };
  const port = createFakePort({
    boards: [{ path: BOARD_PATH, main: serializeBoard(board), version: "v1" }],
  });

  const boards = sessions(port);
  await act(async () => {
    expect(await boards.openPath(BOARD_PATH)).toBe(true);
  });

  const session = boards.snapshot().sessions[0];
  if (session.status !== "ok") throw new Error("会话不是可编辑状态");
  expect(session.board.nodes.map((n) => n.id)).toEqual(["p", "r"]);
  expect(session.board.edges).toHaveLength(1);
  // 结果关系：结果节点的任务编号与路径原样带进来。
  const result = session.board.nodes.find((n) => n.type === "result");
  expect(result?.type === "result" && result.path).toBe("2026-11-07/20261107T000000Z-r/result.png");
});

it("保存失败：内存里的改动留着，失败原因看得见，不当作已保存", async () => {
  const port = createFakePort({
    boards: [{ path: BOARD_PATH, main: serializeBoard(newBoard("本地")), version: "v1" }],
    writeFailures: new Map([[BOARD_PATH, "failed"]]),
  });

  const { key, boards } = await openAndEdit(port, "改过的标题");
  await act(async () => {
    await boards.flushNow(key);
  });

  const session = boards.snapshot().sessions[0];
  expect(session.status).toBe("ok");
  if (session.status !== "ok") throw new Error("会话不是可编辑状态");
  // 改动还在页面里，没有被丢掉。
  expect(session.board.title).toBe("改过的标题");
  // 失败有明确原因：不是「已保存」。
  expect(session.saveError).toBeTruthy();
  expect(session.saveError).toContain("未能保存");
  expect(session.saveError).toContain("写入失败");
  // 非冲突类失败不把画板标成冲突，也不标成丢失。
  expect(session.conflicted).toBe(false);
  expect(session.missing).toBe(false);
});

it("保存失败后重试成功：原因消失，改动落盘", async () => {
  const port = createFakePort({
    boards: [{ path: BOARD_PATH, main: serializeBoard(newBoard("本地")), version: "v1" }],
    writeFailures: new Map([[BOARD_PATH, "failed"]]),
  });

  const { key, boards } = await openAndEdit(port, "重试后的标题");
  await act(async () => {
    await boards.flushNow(key);
  });
  const failed = boards.snapshot().sessions[0];
  if (failed.status !== "ok") throw new Error("会话不是可编辑状态");
  expect(failed.saveError).toBeTruthy();

  // 端口恢复正常后再保存一次。
  port.board.write = async (path: string, text: string) => {
    port.calls.write.push({ path, text });
  };
  await act(async () => {
    await boards.retrySave(key);
  });

  const session = boards.snapshot().sessions[0];
  if (session.status !== "ok") throw new Error("会话不是可编辑状态");
  expect(session.saveError).toBeNull();
  expect(port.calls.write.length).toBeGreaterThan(1);
});

it("保存成功后重新打开画板：改动还在", async () => {
  const port = createFakePort({
    boards: [{ path: BOARD_PATH, main: serializeBoard(newBoard("本地")), version: "v1" }],
  });

  const { key, boards } = await openAndEdit(port, "存下来的标题");
  await act(async () => {
    await boards.flushNow(key);
  });

  // 重新打开客户端：新的会话从端口读回保存后的内容。
  const reopened = sessions(port);
  await act(async () => {
    await reopened.openPath(BOARD_PATH);
  });
  const session = reopened.snapshot().sessions[0];
  expect(session.status === "ok" && session.board.title).toBe("存下来的标题");
});

it("新建画板：只新建不覆盖地写本地画板，文件名的重名由端口列出的名字决定", async () => {
  const port = createFakePort({
    boards: [{ path: BOARD_PATH, main: serializeBoard(newBoard("本地")), version: "v1" }],
  });

  const boards = sessions(port);
  await act(async () => {
    expect(await boards.createBoard()).toBeNull();
  });

  expect(port.calls.write).toHaveLength(1);
  expect(port.calls.write[0].options).toEqual({ createOnly: true });
  expect(port.calls.write[0].path).not.toBe(BOARD_PATH);
  // 新建的画板是一个标签页，内容在内存里。
  expect(boards.snapshot().sessions).toHaveLength(1);
});

it("新建画板写不进去：标签页留着，内容不丢，失败原因看得见", async () => {
  const port = createFakePort({
    boards: [{ path: BOARD_PATH, main: serializeBoard(newBoard("本地")), version: "v1" }],
    writeFailures: new Map([["/~/画板/未命名画板.ugcboard.json", "failed"]]),
  });

  const boards = sessions(port);
  await act(async () => {
    expect(await boards.createBoard()).toBeNull();
  });

  const session = boards.snapshot().sessions[0];
  expect(session.status).toBe("ok");
  expect(session.status === "ok" && session.saveError).toContain("写入失败");
});

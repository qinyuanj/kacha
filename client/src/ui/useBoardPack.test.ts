// 画板包导出（#127）：端口说「尚不可用」时要说出来，不能既不报错也不给消息。
// Web 版照旧：导出流程照常走。
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { newBoard, serializeBoard, type Board } from "../core/board";
import { PortError } from "../shell/port";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { useBoardPack } from "./useBoardPack";

afterEach(() => {
  vi.restoreAllMocks();
});

/** 用给定端口渲染一次 hook（server renderer 执行真实 hook）。 */
function packHook(port: FakePort, toast: (message: string) => void, board: Board | null = null) {
  let result!: ReturnType<typeof useBoardPack>;
  function Host() {
    result = useBoardPack(port.userRoot, {
      flushAll: async () => undefined,
      getBoard: () => board,
      boardFileName: () => (board ? "a.ugcboard.json" : null),
      openImportedBoard: async () => undefined,
    }, toast);
    return null;
  }
  renderToString(createElement(ShellProvider, { port, children: createElement(Host) }));
  return result;
}

it("Web 版：画板包导出照常走，不报「尚不可用」", async () => {
  const port = createFakePort();
  const toast = vi.fn();
  const pack = packHook(port, toast, newBoard("画板"));
  const facts = vi.spyOn(port.pack, "facts").mockResolvedValue([]);

  await expect(pack.prepareExport("k")).resolves.toBeUndefined();
  // 端口没拒绝：流程走到 hash 阶段，没有失败消息。
  expect(facts).toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it("桌面壳：画板包导出尚不可用时给出消息，不静默吞掉", async () => {
  const port = createFakePort({ boards: [{ path: "/~/画板/a.ugcboard.json", main: serializeBoard(newBoard("画板")), version: "v" }] });
  // 桌面壳的画板包端口每一项都拒绝：io.cancel(false) 就在 try 之外，没有守卫就静默。
  const unavailable = (): never => {
    throw new PortError({ kind: "unavailable", code: "unavailable", message: "桌面客户端：画板包导出尚不可用", status: 0, feature: "packExport" });
  };
  port.pack.io.cancel = async () => unavailable();
  port.pack.facts = async () => unavailable();
  port.pack.exportPack = async () => unavailable();
  const toast = vi.fn();
  const pack = packHook(port, toast, newBoard("画板"));

  await expect(pack.prepareExport("k")).resolves.toBeUndefined();
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast.mock.calls[0][0]).toContain("尚不可用");
});

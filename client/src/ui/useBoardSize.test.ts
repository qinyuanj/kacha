// @vitest-environment jsdom
// 当前画板体量的取数（#137）：保存后去抖取一次；列表里没有这一块就没有体量；换画板不当成旧画板的。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { useActiveBoardSize } from "./useBoardSize";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** 渲染一次 hook，返回它的最新返回值。 */
function sizeOf(port: FakePort, path: string | null, version: string | null): { current: ReturnType<typeof useActiveBoardSize> } {
  const box = { current: null as ReturnType<typeof useActiveBoardSize> };
  function Host() {
    box.current = useActiveBoardSize(path, version);
    return null;
  }
  act(() => root.render(createElement(ShellProvider, { port, children: createElement(Host) })));
  return box;
}

it("保存后取一次列表：给出体量与档位", async () => {
  const port = createFakePort({ boards: [{ path: "/~/a.ugcboard.json", main: "{}", version: "v" }] });
  let listed = 0;
  port.board.list = async () => {
    listed += 1;
    return {
    boards: [{ name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: 50 }],
      slots: { used: 0, total: 10 },
      size_lines: { warn: 100, alert: 200 },
    };
  };
  const box = sizeOf(port, "/~/a.ugcboard.json", "v1");
  expect(box.current).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(box.current).toEqual({ path: "/~/a.ugcboard.json", bytes: 50, tier: null });
  expect(listed).toBe(1);
});

it("列表里没有这一块：没有体量", async () => {
  const port = createFakePort();
  const box = sizeOf(port, "/~/missing.ugcboard.json", "v1");
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(box.current).toBeNull();
});

it("读列表失败：没有体量，也不影响任何操作", async () => {
  const port = createFakePort();
  port.board.list = async () => {
    throw new Error("offline");
  };
  const box = sizeOf(port, "/~/a.ugcboard.json", "v1");
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(box.current).toBeNull();
});

// @vitest-environment jsdom
// 当前画板体量的取数（#137）：版本变化后去抖取一次；读失败保持空；换画板不当成旧画板的。
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

  // 第二次保存（version 变化）再去抖取一次，连续变化只问一次。
  await act(async () => {
    root.render(createElement(ShellProvider, { port, children: createElement(function Host() { box.current = useActiveBoardSize("/~/a.ugcboard.json", "v2"); return null; }) }));
  });
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  await act(async () => {
    root.render(createElement(ShellProvider, { port, children: createElement(function Host() { box.current = useActiveBoardSize("/~/a.ugcboard.json", "v3"); return null; }) }));
  });
  await act(async () => {
    vi.advanceTimersByTime(1999);
  });
  expect(listed).toBe(1);
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(listed).toBe(2);
});

it("体量未知：没有体量", async () => {
  const port = createFakePort();
  port.board.list = async () => ({
    boards: [{ name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: null }],
    slots: { used: 0, total: 10 },
    size_lines: { warn: 100, alert: 200 },
  });
  const box = sizeOf(port, "/~/a.ugcboard.json", "v1");
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(box.current).toBeNull();
});

it("换了画板：旧的结果不当成新画板的体量", async () => {
  const port = createFakePort();
  port.board.list = async () => ({
    boards: [{ name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: 50 }],
    slots: { used: 0, total: 10 },
    size_lines: { warn: 100, alert: 200 },
  });
  const box = sizeOf(port, "/~/a.ugcboard.json", "v1");
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(box.current?.bytes).toBe(50);
  act(() => {
    // 同一 hook：换 key 后下一轮不能沿用旧 key 的体量。
    const next = sizeOf(port, "/~/b.ugcboard.json", "v2");
    expect(next.current).toBeNull();
  });
});

it("读列表失败：只取一次、不进体量", async () => {
  const port = createFakePort();
  const listed = vi.fn(async () => {
    throw new Error("offline");
  });
  port.board.list = listed;
  const box = sizeOf(port, "/~/a.ugcboard.json", "v1");
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(box.current).toBeNull();
  expect(listed).toHaveBeenCalledTimes(1);
});
// @vitest-environment jsdom
// 用量上限提醒的取数（#137）：读到提醒档位就提醒；没到线不提醒；读失败不提醒。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Usage } from "../shell/types";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { useUsageLimit } from "./useUsageLimit";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type UsageLimit = ReturnType<typeof useUsageLimit>;

function usageOf(port: FakePort, enabled: boolean): { current: UsageLimit | null } {
  const box: { current: UsageLimit | null } = { current: null };
  function Host() {
    box.current = useUsageLimit(enabled);
    return null;
  }
  act(() => root.render(createElement(ShellProvider, { port, children: createElement(Host) })));
  return box;
}

const usage = (patch: Partial<Usage> = {}): Usage => ({
  total_bytes: 100,
  boards_bytes: 50,
  meta_bytes: 50,
  last_access: 0,
  by_date: [],
  unreferenced: null,
  unreadable_board: null,
  limit_bytes: null,
  limit_level: null,
  ...patch,
});

it("达到阈值：给出提醒", async () => {
  const port = createFakePort();
  port.usage.usage = async () => usage({ limit_bytes: 100, limit_level: "warn" });
  const box = usageOf(port, true);
  await act(async () => {
    await Promise.resolve();
  });
  expect(box.current?.notice).toEqual({ level: "warn", total: 100, limit: 100 });
});

it("读失败：不提醒", async () => {
  const port = createFakePort();
  port.usage.usage = async () => {
    throw new Error("offline");
  };
  const box = usageOf(port, true);
  await act(async () => {
    await Promise.resolve();
  });
  expect(box.current?.notice).toBeNull();
});

it("没启用：不取用量", async () => {
  const port = createFakePort();
  let called = 0;
  port.usage.usage = async () => {
    called += 1;
    return usage();
  };
  const box = usageOf(port, false);
  await act(async () => {
    await Promise.resolve();
  });
  expect(called).toBe(0);
  expect(box.current?.notice).toBeNull();
});

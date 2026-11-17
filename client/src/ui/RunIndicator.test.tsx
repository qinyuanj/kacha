// @vitest-environment jsdom
// 顶栏运行指示（#155）：读图、执行、排队与退避都是未完成的份；取消排队不影响执行中的份。
import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTask, TaskActivity } from "../core/runner";
import { RunIndicator } from "./RunIndicator";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let dom: ReactRoot;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  dom = createRoot(container);
});

afterEach(async () => {
  await act(async () => dom.unmount());
  container.remove();
});

const idle: TaskActivity = { busy: false, pending: 0, reading: 0, waiting: 0, running: 0, backoff: 0, boards: [] };
const task = (taskId: string, state: ActiveTask["state"]): ActiveTask => ({ taskId, boardKey: "A", taskNodeId: "t1", state });

async function render(active: ActiveTask[], activity: TaskActivity, handlers: { onCancelWaiting?(): void; onCancelCopy?(taskId: string): void } = {}) {
  await act(async () =>
    dom.render(
      <RunIndicator
        active={active}
        activity={activity}
        titleOf={() => "画板 A"}
        onJump={() => undefined}
        onCancelCopy={handlers.onCancelCopy ?? (() => undefined)}
        onCancelWaiting={handlers.onCancelWaiting ?? (() => undefined)}
      />,
    ),
  );
}

const summary = () => container.querySelector("button")!.textContent;

describe("顶栏运行指示", () => {
  it("没有未完成的份时不显示", async () => {
    await render([], idle);
    expect(container.textContent).toBe("");
  });

  it("读参考图阶段就显示，并给出读图的份数", async () => {
    await render([], { ...idle, busy: true, pending: 1, reading: 1, boards: ["A"] });
    expect(summary()).toBe("执行 0 · 排队 0 · 读图 1");
  });

  it("执行、排队、退避各自计数", async () => {
    await render([task("a", "running"), task("b", "waiting")], { busy: true, pending: 3, reading: 0, waiting: 1, running: 1, backoff: 1, boards: ["A"] });
    expect(summary()).toBe("执行 1 · 排队 1 · 退避 1");
  });

  it("只有执行中的份时「取消全部排队」不可点；有排队或退避时可点", async () => {
    await render([task("a", "running")], { ...idle, busy: true, pending: 1, running: 1, boards: ["A"] });
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    const cancelAll = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "取消全部排队") as HTMLButtonElement;
    expect(cancelAll().disabled).toBe(true);
    await act(async () => dom.unmount());
    dom = createRoot(container);
    await render([task("a", "running"), task("b", "waiting")], { ...idle, busy: true, pending: 2, running: 1, waiting: 1, boards: ["A"] });
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    expect(cancelAll().disabled).toBe(false);
  });

  it("列表里取消一份：交出任务编号", async () => {
    const onCancelCopy = vi.fn();
    await render([task("20261117T000000Z-11112222", "waiting")], { ...idle, busy: true, pending: 1, waiting: 1, boards: ["A"] }, { onCancelCopy });
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    await act(async () => (container.querySelector('[aria-label^="取消任务"]') as HTMLButtonElement).click());
    expect(onCancelCopy).toHaveBeenCalledWith("20261117T000000Z-11112222");
  });
});

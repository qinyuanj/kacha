// @vitest-environment jsdom
// 空闲自动安装的接线（#180）：计时器推进、条件恢复、启动即就绪与「稍后」，都在假的时钟里推。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySnapshot, type UpdateSnapshot } from "../core/update";
import { AUTO_INSTALL_DELAY_MS, type AutoInstallView, type InstallOutcome } from "../core/updateAutoInstall";
import { BUSY_MESSAGE } from "../core/updatePreparation";
import { useUpdateAutoInstall, type AutoInstallDeps } from "./useUpdateAutoInstall";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let dom: ReactRoot;
/** 探针记下 hook 最新的样子：断言读它，不必去 DOM 里找。 */
let shown: { view: AutoInstallView; defer(): void } | null = null;
let installs = 0;

beforeEach(() => {
  vi.useFakeTimers();
  installs = 0;
  shown = null;
  container = document.createElement("div");
  document.body.append(container);
  dom = createRoot(container);
});
afterEach(async () => {
  await act(async () => dom.unmount());
  container.remove();
  vi.useRealTimers();
});

/** 已就绪且可装的快照。 */
const ready = (overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  ...emptySnapshot(),
  phase: "ready",
  version: "1.6.2",
  verified: true,
  installable: true,
  downloaded: 100,
  total: 100,
  ...overrides,
});

/** 把 hook 挂起来的最小探针。 */
function Probe({ deps }: { deps: AutoInstallDeps }): null {
  shown = useUpdateAutoInstall(deps);
  return null;
}

/** 默认依赖：已读到快照、空闲、安装成功。 */
const deps = (overrides: Partial<AutoInstallDeps> = {}): AutoInstallDeps => ({
  snapshot: ready(),
  loaded: true,
  idle: () => ({ boardsReady: true,
  settingsLoaded: true, pendingTasks: 0, unsavedChanges: false }),
  install: async (): Promise<InstallOutcome> => {
    installs++;
    return { ok: true };
  },
  ...overrides,
});

async function render(next: AutoInstallDeps): Promise<void> {
  await act(async () => dom.render(createElement(Probe, { deps: next })));
}

/** 推进假时钟：计时器与 Date.now 一起走。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("空闲自动安装的接线", () => {
  it("下载中：不装；下载完就绪后开始倒计时", async () => {
    await render(deps({ snapshot: ready({ phase: "downloading", downloaded: 10 }) }));
    expect(shown?.view.counting).toBe(false);
    await render(deps());
    expect(shown?.view.counting).toBe(true);
    expect(shown?.view.seconds).toBe(AUTO_INSTALL_DELAY_MS / 1000);
    expect(installs).toBe(0);
  });

  it("倒计时走完：交给安装器", async () => {
    await render(deps({ snapshot: ready({ phase: "downloading" }) }));
    await render(deps());
    await advance(AUTO_INSTALL_DELAY_MS - 1_000);
    expect(installs).toBe(0);
    expect(shown?.view.seconds).toBe(1);
    await advance(1_000);
    expect(installs).toBe(1);
  });

  it("任务在跑：不倒计时，任务结束后才开始", async () => {
    const busy = () => ({ boardsReady: true,
  settingsLoaded: true, pendingTasks: 2, unsavedChanges: false });
    await render(deps({ snapshot: ready({ phase: "downloading" }), idle: busy }));
    await render(deps({ idle: busy }));
    expect(shown?.view.waiting).toBe(BUSY_MESSAGE);
    expect(shown?.view.counting).toBe(false);
    await advance(AUTO_INSTALL_DELAY_MS * 2);
    expect(installs).toBe(0);
    // 任务结束：重新开始倒计时。
    await render(deps());
    expect(shown?.view.counting).toBe(true);
    await advance(AUTO_INSTALL_DELAY_MS);
    expect(installs).toBe(1);
  });

  it("点了稍后：本轮不再自动装", async () => {
    await render(deps({ snapshot: ready({ phase: "downloading" }) }));
    await render(deps());
    expect(shown?.view.counting).toBe(true);
    await act(async () => shown?.defer());
    expect(shown?.view.deferred).toBe(true);
    expect(shown?.view.counting).toBe(false);
    await advance(AUTO_INSTALL_DELAY_MS * 4);
    expect(installs).toBe(0);
  });
});

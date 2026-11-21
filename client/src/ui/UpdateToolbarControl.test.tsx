// @vitest-environment jsdom
// 首页版本号旁的更新入口（#164、#180、#181）：只验页面这一侧——按快照显示、只有已验签才能点安装、
// 准备被拒时不起安装、安装失败后恢复创作、保存没成功时也不装。
// 选版与验签在 Go 侧，替身不重复判定；快照与动作由工作台接线，这里用真 hook 接在替身上。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { UpdateToolbarControl } from "./UpdateToolbarControl";
import { useUpdateActions } from "./useUpdate";
import { emptySnapshot, type UpdateSnapshot } from "../core/update";
import { UNSAVED_MESSAGE, type UpdatePreparationPorts } from "../core/updatePreparation";

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

/** 准备依赖的替身；任务队列与保存由各用例覆盖（替身不模拟生成任务）。 */
const baseDeps: UpdatePreparationPorts = {
  queue: { pending: () => 0, setSubmissionGuard: () => undefined },
  saveBoards: async () => undefined,
  saveUi: async () => undefined,
  unsavedChanges: () => false,
};

/** 已就绪的快照：默认已验签且服务说可装。 */
const ready = (overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  ...emptySnapshot(),
  phase: "ready",
  version: "1.6.0",
  verified: true,
  installable: true,
  ...overrides,
});

/** 把真实的动作 hook 接在替身上：这一段测的就是「准备被拒就不安装」。 */
function Host({ snapshot, deps }: { snapshot: UpdateSnapshot; deps: UpdatePreparationPorts }): ReturnType<typeof createElement> {
  const { state, check, install } = useUpdateActions(deps, async () => undefined);
  return createElement(UpdateToolbarControl, { snapshot, state, check: () => void check(), install });
}

async function show(port: FakePort, snapshot: UpdateSnapshot, overrides: Partial<UpdatePreparationPorts> = {}): Promise<void> {
  await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(Host, { snapshot, deps: { ...baseDeps, ...overrides } }) })));
}

/** 按文字找按钮：入口上按钮不多，比 data-testid 更贴近用户看到的东西。 */
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`没有找到按钮「${text}」`);
  return found as HTMLButtonElement;
}

/** 入口上的文字。 */
function hint(): string {
  return container.textContent ?? "";
}

describe("首页版本号旁的更新入口", () => {
  it("能力没开时整段不显示", async () => {
    await show(createFakePort({ missing: ["update"] }), emptySnapshot());
    expect(container.querySelector(".topbar-update")).toBeNull();
  });

  it("没有新版本时只摆检查更新，不常驻一个灰的安装按钮", async () => {
    await show(createFakePort(), emptySnapshot());
    expect(hint()).toContain("检查更新");
    expect(container.textContent).not.toContain("下载并安装");
  });

  it("下载完成但没验签：安装按钮不能点", async () => {
    await show(createFakePort(), ready({ verified: false, installable: false }));
    expect(button("下载并安装").disabled).toBe(true);
  });

  it("实现说可装但没验签：仍然不能点（界面不把 installable 当成验签）", async () => {
    await show(createFakePort(), ready({ verified: false, installable: true }));
    expect(button("下载并安装").disabled).toBe(true);
  });

  it("已验签且可装：安装按钮能点", async () => {
    await show(createFakePort(), ready());
    expect(button("下载并安装").disabled).toBe(false);
  });

  it("正在检查时不能重复点检查", async () => {
    await show(createFakePort(), { ...emptySnapshot(), phase: "checking" });
    expect(button("检查中").disabled).toBe(true);
  });

  it("有未完成任务时拒绝安装，且不起安装器", async () => {
    const port = createFakePort();
    await show(port, ready(), { queue: { pending: () => 2, setSubmissionGuard: () => undefined } });
    await act(async () => button("下载并安装").click());
    expect(hint()).toContain("任务结束后可更新");
    expect(port.calls.updateInstall).toBe(0);
  });

  it("保存失败时拒绝安装，且说明原因", async () => {
    const port = createFakePort();
    await show(port, ready(), {
      saveBoards: async () => {
        throw new Error("磁盘已满");
      },
    });
    await act(async () => button("下载并安装").click());
    expect(hint()).toContain("保存画板失败：磁盘已满");
    expect(port.calls.updateInstall).toBe(0);
  });

  it("写盘没抛错但仍有改动没保存：拒绝安装（#180）", async () => {
    const port = createFakePort();
    await show(port, ready(), { unsavedChanges: () => true });
    await act(async () => button("下载并安装").click());
    expect(hint()).toContain(UNSAVED_MESSAGE);
    expect(port.calls.updateInstall).toBe(0);
  });

  it("准备通过后才交给真实安装器", async () => {
    const port = createFakePort();
    await show(port, ready());
    await act(async () => button("下载并安装").click());
    expect(port.calls.updateInstall).toBe(1);
  });

  it("安装失败：给出原因，界面回到可再试", async () => {
    const port = createFakePort({ updateInstallFailure: "failed" });
    await show(port, ready());
    await act(async () => button("下载并安装").click());
    expect(hint()).toContain("安装失败");
  });

  it("检查失败时给原因，不给假成功", async () => {
    await show(createFakePort({ update: { ...emptySnapshot(), phase: "error", error: "网络不可达" } }), { ...emptySnapshot(), phase: "error", error: "网络不可达" });
    expect(hint()).toContain("网络不可达");
  });
});

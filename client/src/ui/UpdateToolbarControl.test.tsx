// @vitest-environment jsdom
// 单一版本入口（#269）：每阶段只打开本地更新说明；安装准备、失败原因与手动检查按钮移除都要在这里守住。
// 选版与验签在 Go 侧，替身不重复判定；快照与动作由工作台接线，这里用真 hook 接在替身上。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { UpdateToolbarControl } from "./UpdateToolbarControl";
import { useUpdateActions } from "./useUpdate";
import { emptySnapshot, type UpdateSnapshot } from "../core/update";
import { UNSAVED_MESSAGE, type UpdatePreparationPorts } from "../core/updatePreparation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CURRENT_VERSION = "1.7.3";
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

const baseDeps: UpdatePreparationPorts = {
  queue: { pending: () => 0, setSubmissionGuard: () => undefined },
  saveBoards: async () => undefined,
  saveUi: async () => undefined,
  unsavedChanges: () => false,
};

const ready = (overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  ...emptySnapshot(),
  phase: "ready",
  version: "1.6.0",
  verified: true,
  installable: true,
  ...overrides,
});

function Host({
  snapshot,
  deps,
  onOpenChangelog,
}: {
  snapshot: UpdateSnapshot;
  deps: UpdatePreparationPorts;
  onOpenChangelog: () => void;
}): ReturnType<typeof createElement> {
  const { state, check, install } = useUpdateActions(deps, async () => undefined);
  return createElement(UpdateToolbarControl, {
    snapshot,
    state,
    check: () => void check(),
    install,
    version: CURRENT_VERSION,
    onOpenChangelog,
  });
}

async function show(
  port: FakePort,
  snapshot: UpdateSnapshot,
  overrides: Partial<UpdatePreparationPorts> = {},
): Promise<ReturnType<typeof vi.fn>> {
  const opens = vi.fn();
  await act(async () => dom.render(createElement(ShellProvider, {
    port,
    children: createElement(Host, { snapshot, deps: { ...baseDeps, ...overrides }, onOpenChangelog: opens }),
  })));
  return opens;
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")] as HTMLButtonElement[];
}

function versionButton(): HTMLButtonElement {
  const found = buttons().find((button) => button.textContent === CURRENT_VERSION);
  if (!found) throw new Error("没有找到只显示当前安装版本的按钮");
  return found;
}

function button(text: string): HTMLButtonElement {
  const found = buttons().find((button) => button.textContent?.includes(text));
  if (!found) throw new Error(`没有找到按钮「${text}」`);
  return found;
}

function hint(): string {
  return container.textContent ?? "";
}

const PHASES: Array<{
  phase: UpdateSnapshot["phase"];
  tone: string;
  status: string;
  snapshot?: Partial<UpdateSnapshot>;
  visible?: string;
}> = [
  { phase: "disabled", tone: "neutral", status: "自动更新尚不可用" },
  { phase: "idle", tone: "neutral", status: "尚未检查更新" },
  { phase: "checking", tone: "neutral", status: "正在检查更新…" },
  { phase: "up_to_date", tone: "latest", status: "已是最新版本" },
  { phase: "available", tone: "action", status: "发现新版本 9.9.9，准备下载", snapshot: { version: "9.9.9" } },
  { phase: "downloading", tone: "action", status: "正在下载 9.9.9（40%）", snapshot: { version: "9.9.9", downloaded: 40, total: 100 }, visible: "正在下载 9.9.9（40%）" },
  { phase: "ready", tone: "action", status: "新版本 9.9.9 已下载并验签，可安装", snapshot: { version: "9.9.9", verified: true, installable: true }, visible: "新版本 9.9.9 已下载并验签，可安装" },
  { phase: "installing", tone: "action", status: "正在安装，安装完成后请重新启动", visible: "正在安装，安装完成后请重新启动" },
  { phase: "error", tone: "neutral", status: "网络不可达", snapshot: { error: "网络不可达" }, visible: "网络不可达" },
];

describe("单一版本入口（#269）", () => {
  for (const item of PHASES) {
    it(item.phase + "：点版本号只打开本地更新说明", async () => {
      const port = createFakePort();
      const opens = await show(port, { ...emptySnapshot(), ...item.snapshot, phase: item.phase });
      const entry = versionButton();

      expect(entry.textContent).toBe(CURRENT_VERSION);
      expect(entry.dataset.updateTone).toBe(item.tone);
      expect(entry.title).toContain(item.status);
      expect(entry.getAttribute("aria-label")).toContain(item.status);
      expect(entry.getAttribute("aria-haspopup")).toBe("dialog");
      expect(buttons().some((b) => ["检查更新", "已是最新", "有新版本", "重试检查"].includes((b.textContent ?? "").trim()))).toBe(false);
      if (item.visible) expect(hint()).toContain(item.visible);

      await act(async () => entry.click());
      expect(opens).toHaveBeenCalledTimes(1);
      expect(port.calls.updateCheck).toBe(0);
      expect(port.calls.updateInstall).toBe(0);
    });
  }

  it("更新能力关闭也保留可点版本入口，状态为普通色", async () => {
    const port = createFakePort({ missing: ["update"] });
    const opens = await show(port, ready());
    const entry = versionButton();

    expect(entry.dataset.updateTone).toBe("neutral");
    expect(entry.title).toContain("自动更新尚不可用");
    await act(async () => entry.click());
    expect(opens).toHaveBeenCalledTimes(1);
  });

  it("已就绪但未验签：安装按钮仍不能点", async () => {
    await show(createFakePort(), ready({ verified: false, installable: true }));
    expect(button("下载并安装").disabled).toBe(true);
  });

  it("已验签且可装：安装按钮能点", async () => {
    await show(createFakePort(), ready());
    expect(button("下载并安装").disabled).toBe(false);
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

  it("检查失败不放外部下载旁路，失败原因保持可见", async () => {
    const port = createFakePort();
    await show(port, { ...emptySnapshot(), phase: "error", error: "网络不可达", page_url: "https://example.invalid/release" });
    expect(hint()).toContain("网络不可达");
    expect(container.querySelector("a.topbar-update-link, a[href='https://example.invalid/release']")).toBeNull();
  });
});

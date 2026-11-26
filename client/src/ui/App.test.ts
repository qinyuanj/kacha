// @vitest-environment jsdom
// 工作台的可见行为（#137）：没有画板时的空工作台、提示条、设置面板入口、画板包菜单的禁用。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardListing } from "../shell/types";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { emptySnapshot, type UpdateSnapshot } from "../core/update";
import { THEME_MIRROR_KEY } from "../core/theme";
import { ShellProvider } from "./shell";
import { App } from "../App";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 画布太重（React Flow），测试里替掉：断言工作台这一层的接线。
// 替身同时记下收到的 props —— 「App 把解析后的有效主题交给画布」这条链只能在这里观测。
const canvas = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("./BoardCanvas", async () => {
  const { createElement: h } = await import("react");
  return {
    BoardCanvas: (props: Record<string, unknown>) => {
      canvas.props = props;
      return h("div", { className: "canvas" });
    },
  };
});

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

function listing(boards: BoardListing["boards"] = []): BoardListing {
  return { boards, slots: { used: 0, total: 10 }, size_lines: { warn: 100, alert: 200 } };
}

/** 更新快照（#180）：默认是已下载并验签的 1.6.2。 */
const updateSnapshot = (patch: Partial<UpdateSnapshot>): UpdateSnapshot => ({
  ...emptySnapshot(),
  version: "1.6.2",
  verified: true,
  installable: true,
  downloaded: 100,
  total: 100,
  ...patch,
});

async function show(port: FakePort, props: { version?: string | null } = {}): Promise<void> {
  await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(App, { ...props }) })));
}

describe("工作台", () => {
  it("启动后新建一块画板：标签页上有它", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    await vi.waitFor(() => expect(container.textContent).toContain("未命名画板"));
  });

  it("顶栏：画板包与版本入口都在", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, { version: "1.2.3" });
    expect(container.textContent).toContain("画板包");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "1.2.3")).toBe(true);
  });

  it("画板包菜单只有导入与导出：整板结果下载不再出现（#262）", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    await vi.waitFor(() => expect(container.querySelector(".canvas")).not.toBeNull());
    const packButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("画板包"));
    await act(async () => packButton?.click());
    const items = [...container.querySelectorAll('[role="menuitem"]')];
    expect(items.map((item) => (item.textContent ?? "").trim())).toEqual(["导入画板包…", "导出画板包…"]);
    // 保留的相邻能力必须真能触发：点导入确实走到壳端口选包，而不是只剩空菜单。
    const importItem = items.find((item) => item.textContent?.includes("导入画板包"));
    await act(async () => (importItem as HTMLElement | undefined)?.click());
    expect(port.calls.pickPackFile).toHaveLength(1);
  });

  it("用量提醒：到了上限时给出提醒与管理画板入口", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.usage.usage = async () => ({
      total_bytes: 200,
      boards_bytes: 100,
      meta_bytes: 100,
      last_access: 0,
      by_date: [],
      unreferenced: null,
      unreadable_board: null,
      limit_bytes: 100,
      limit_level: "alert",
    });
    await show(port);
    await vi.waitFor(() => expect(container.textContent).toContain("用量已满"));
    expect(container.textContent).toContain("管理画板");
  });

  it("没有用量提醒：不显示那条提示", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.usage.usage = async () => ({
      total_bytes: 10,
      boards_bytes: 10,
      meta_bytes: 0,
      last_access: 0,
      by_date: [],
      unreferenced: null,
      unreadable_board: null,
      limit_bytes: null,
      limit_level: null,
    });
    await show(port);
    expect(container.textContent).not.toContain("用量已满");
  });

  it("高级设置：点开后面板出现，关掉后消失", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    const settingsButton = container.querySelector<HTMLButtonElement>("button[aria-label='高级设置']");
    await act(async () => settingsButton?.click());
    const settingsPanel = container.querySelector("[role='dialog'][aria-label='高级设置']");
    expect(settingsPanel).not.toBeNull();
    const close = [...(settingsPanel?.querySelectorAll("button") ?? [])].find((button) => button.getAttribute("aria-label") === "关闭");
    await act(async () => close?.click());
    expect(container.querySelector("[role='dialog'][aria-label='高级设置']")).toBeNull();
  });

  it("画板列表：点开列表后显示画板", async () => {
    const port = createFakePort();
    port.board.list = async () => listing([{ name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: 10 }]);
    await show(port);
    const listButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("画板"));
    await act(async () => listButton?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("a"));
  });

  it("更新已就绪：主界面提示条就看得见，不用进高级设置（#180）", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.update.status = async () => updateSnapshot({ phase: "ready" });
    await show(port);
    await vi.waitFor(() => expect(container.querySelector(".update-status")?.getAttribute("data-update-phase")).toBe("ready"));
  });

  it("点「稍后」：本轮不再自动装", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    let snapshot = updateSnapshot({ phase: "downloading", downloaded: 0 });
    port.update.status = async () => snapshot;
    await show(port);
    await vi.waitFor(() => expect(container.textContent).toContain("正在下载"));
    // 下载完成：倒计时开始，主界面出现「稍后」。
    snapshot = updateSnapshot({ phase: "ready" });
    await vi.waitFor(() => expect(container.textContent).toContain("稍后"));
    const later = [...container.querySelectorAll("button")].find((b) => b.textContent === "稍后");
    await act(async () => later?.click());
    expect(container.textContent).toContain("本次不再自动安装");
    expect(port.calls.updateInstall).toBe(0);
  });

  it("首屏反馈预览使用真实产品版本作为 build，不显示未知", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, { version: "1.9.9" });
    const feedback = [...container.querySelectorAll("button")].find((button) => button.textContent === "反馈");
    await act(async () => feedback?.click());
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "真实构建标识");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const preview = [...container.querySelectorAll("button")].find((button) => button.textContent === "预览");
    await act(async () => preview?.click());
    expect(container.textContent).toContain("build 1.9.9");
    expect(container.textContent).not.toContain("build 未知");
  });

  it("反馈能力关闭：入口标暂不可用，打开后发送给出不可用并可重试", async () => {
    const port = createFakePort({ missing: ["feedback"] });
    port.board.list = async () => listing();
    await show(port);
    const feedback = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("反馈"));
    expect(feedback?.textContent).toContain("暂不可用");
    await act(async () => feedback?.click());
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "能力关闭也要能重试");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const preview = [...container.querySelectorAll("button")].find((button) => button.textContent === "预览");
    await act(async () => preview?.click());
    const send = [...container.querySelectorAll("button")].find((button) => button.textContent === "确认发送");
    await act(async () => send?.click());
    expect(container.textContent).toContain("反馈暂不可用");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "重试");
    await act(async () => retry?.click());
    expect(port.calls.feedback).toHaveLength(2);
  });

  it("首屏反馈入口：打开表单后可以关闭", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    const feedback = [...container.querySelectorAll("button")].find((button) => button.textContent === "反馈");
    await act(async () => feedback?.click());
    expect(container.textContent).toContain("标题（可选）");
    const cancel = [...container.querySelectorAll("button")].find((button) => button.textContent === "取消");
    await act(async () => cancel?.click());
    expect(container.textContent).not.toContain("标题（可选）");
  });

  it("已有画板：从列表打开后进入画板工作台", async () => {
    const port = createFakePort();
    port.board.list = async () => listing([{ name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: 10 }]);
    await show(port);
    const listButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("画板"));
    await act(async () => listButton?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("a"));
    const boardButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("a"));
    await act(async () => boardButton?.click());
    await vi.waitFor(() => expect(container.querySelector(".canvas")).not.toBeNull());
  });

  it("顶栏与用量提醒里的入口都能打开对应弹层", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.usage.usage = async () => ({
      total_bytes: 200,
      boards_bytes: 100,
      meta_bytes: 100,
      last_access: 0,
      by_date: [],
      unreferenced: null,
      unreadable_board: null,
      limit_bytes: 100,
      limit_level: "alert",
    });
    await show(port);
    await vi.waitFor(() => expect(container.textContent).toContain("管理画板"));
    const clickByText = async (label: string): Promise<void> => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
      await act(async () => button?.click());
    };
    await clickByText("管理画板");
    await act(async () => container.querySelector<HTMLButtonElement>("button[aria-label='高级设置']")?.click());
    for (const label of ["反馈", "画板包", "检查更新"]) await clickByText(label);
    for (const button of [...container.querySelectorAll<HTMLButtonElement>("button[aria-label*='关闭']")]) {
      await act(async () => button.click());
    }
  });

  it("已归档画板：取消归档与复制入口都能点", async () => {
    const port = createFakePort();
    port.board.list = async () => listing([{ name: "old.ugcboard.json", path: "/~/old.ugcboard.json", archived: true, bytes: 10 }]);
    await show(port);
    const listButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("画板列表"));
    await act(async () => listButton?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("old"));
    for (const label of ["取消归档", "复制为新画板"]) {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
      await act(async () => button?.click());
    }
  });

  it("版本入口打开更新说明后可关闭", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, { version: "1.2.3" });
    const versionButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "1.2.3");
    await act(async () => versionButton?.click());
    const close = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "关闭");
    await act(async () => close?.click());
  });

  // 画板级动作（从列表删除 / 归档）是工作台最外一层的接线：
  // 每个动作都要真的落到壳端口上，不能只在 appActions 的单测里连过。
  /** 壳里已有的一块画板：列表与动作都按它走。 */
  const seededBoard = { path: "/~/a.ugcboard.json", main: null, version: null, bytes: 10 };

  /** 打开画板列表，等到第一行出来。 */
  async function openBoardList(): Promise<void> {
    await act(async () => container.querySelector<HTMLElement>(".tab-list")?.click());
    await vi.waitFor(() => expect(container.querySelector(".board-list-open")).not.toBeNull());
  }

  /** 确认框里的那个动作按钮（删除框里也有一个「删除」，只在这一层找）。 */
  async function confirmIn(label: string, action: string): Promise<void> {
    const dialog = document.querySelector(`[aria-label='${label}']`);
    const button = [...(dialog?.querySelectorAll("button") ?? [])].find((item) => item.textContent === action);
    await act(async () => button?.click());
  }

  it("从列表删除画板：壳端收到删除请求，列表里也不再列出它", async () => {
    const port = createFakePort({ boards: [seededBoard] });
    await show(port);
    await openBoardList();
    await act(async () => container.querySelector<HTMLElement>("[aria-label='删除「a」']")?.click());
    await confirmIn("删除画板", "删除");
    await vi.waitFor(() => expect(port.calls.remove.map((call) => call.path)).toEqual([seededBoard.path]));
    await vi.waitFor(() => expect(container.querySelector("[aria-label='删除「a」']")).toBeNull());
  });

  it("从列表归档画板：壳端收到归档请求，列表里转进已归档", async () => {
    const port = createFakePort({ boards: [seededBoard] });
    await show(port);
    await openBoardList();
    await act(async () => container.querySelector<HTMLElement>("[aria-label='归档「a」']")?.click());
    await confirmIn("归档画板", "归档");
    await vi.waitFor(() => expect(port.calls.archive.map((call) => call.from)).toEqual([seededBoard.path]));
    await vi.waitFor(() => expect(container.textContent).toContain("已归档"));
  });

// #265：顶栏主题切换入口——两态直接切换，旧 system 迁浅色，不监听系统配色。
});

describe("主题切换", () => {
  function clearThemeState(): void {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
  }

  beforeEach(clearThemeState);
  afterEach(() => {
    clearThemeState();
    vi.unstubAllGlobals();
  });

  async function settingsReady(): Promise<void> {
    await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>("button[aria-label='高级设置']");
      expect(button?.disabled).toBe(false);
    });
  }

  /** 主题入口是单按钮：从当前档位一击切到另一档。 */
  function switchButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(".theme-switch");
    if (!button) throw new Error("没有找到主题切换按钮");
    return button;
  }

  function recordSettingsWrites(port: FakePort): string[] {
    const writes: string[] = [];
    port.core.settingsPorts.writeSettings = async (text) => void writes.push(text);
    return writes;
  }

  it("顶栏只有一个两态按钮，不用打开高级设置，新用户默认浅色", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    await settingsReady();
    // 一个两态图标按钮取代三档文字分段控件，不用打开高级设置。
    expect(container.querySelectorAll(".theme-switch").length).toBe(1);
    expect(switchButton().getAttribute("aria-label")).toBe("切到暗色");
    await vi.waitFor(() => expect(port.calls.nativeTheme).toEqual(["light"]));
    // 没有打开设置面板。
    expect(container.querySelector("[role='dialog'][aria-label='高级设置']")).toBeNull();
  });

  it("点一下从浅色切到深色：文档根、镜像、宿主壳与设置文件都跟着变", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    const writes = recordSettingsWrites(port);
    await show(port);
    await settingsReady();
    await vi.waitFor(() => expect(port.calls.nativeTheme).toEqual(["light"]));
    const boardWrites = port.calls.write.length;

    await act(async () => switchButton().click());

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("dark");
    await vi.waitFor(() => expect(writes.map((text) => JSON.parse(text).theme)).toEqual(["dark"]));
    expect(port.calls.nativeTheme.at(-1)).toBe("dark");
    expect(JSON.parse(writes[0]).format_version).toBe(1);
    expect(port.calls.write.length).toBe(boardWrites);
  });

  it("显式深色重启后保持深色，再点一下回到浅色", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.core.settingsPorts.readSettings = async () => JSON.stringify({ format_version: 1, base_url: "http://gw.example:3001", theme: "dark" });
    await show(port);
    await settingsReady();
    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    await act(async () => switchButton().click());
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("light");
  });

  it("旧 system 偏好在设置读取边界迁为浅色", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.core.settingsPorts.readSettings = async () => JSON.stringify({ format_version: 1, base_url: "http://gw.example:3001", theme: "system" });
    await show(port);
    await settingsReady();
    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("light");
    await vi.waitFor(() => expect(port.calls.nativeTheme.at(-1)).toBe("light"));
    expect(canvas.props?.theme).toBe("light");
  });

  it("系统配色变化不再改变应用主题", async () => {
    const listeners: ((event: { matches: boolean }) => void)[] = [];
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => void listeners.push(listener),
      removeEventListener: () => undefined,
    }));
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    await settingsReady();
    expect(listeners).toEqual([]);
    await act(async () => {
      for (const listener of listeners) listener({ matches: true });
    });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("设置还没读到就切换：先不动磁盘，读到设置后补写一条", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const readSettings = port.core.settingsPorts.readSettings;
    port.core.settingsPorts.readSettings = async () => {
      await gate;
      return readSettings();
    };
    const writes = recordSettingsWrites(port);
    await show(port);

    await act(async () => switchButton().click());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("dark");
    expect(writes).toEqual([]);

    await act(async () => release());
    await vi.waitFor(() => expect(writes.map((text) => JSON.parse(text).theme)).toEqual(["dark"]));
    expect(JSON.parse(writes[0]).format_version).toBe(1);
  });

  it("宿主拒绝同步原生主题：界面照常切换，错误不冒出来", async () => {
    const port = createFakePort({ nativeThemeFailure: true });
    port.board.list = async () => listing();
    const writes = recordSettingsWrites(port);
    await show(port);
    await settingsReady();

    await act(async () => switchButton().click());

    expect(document.documentElement.dataset.theme).toBe("dark");
    await vi.waitFor(() => expect(writes.map((text) => JSON.parse(text).theme)).toEqual(["dark"]));
    expect(container.querySelector(".bar-error")).toBeNull();
  });

  it("设置文件版本过新：切换只在本会话生效，磁盘保持原样", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.core.settingsPorts.readSettings = async () => JSON.stringify({ format_version: 2, base_url: "http://gw.example:3001" });
    const writes = recordSettingsWrites(port);
    await show(port);
    await settingsReady();

    await act(async () => switchButton().click());

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("dark");
    await vi.waitFor(() => expect(port.calls.nativeTheme.at(-1)).toBe("dark"));
    expect(writes).toEqual([]);
  });

  it("设置文件读不出来：切换只在本会话生效，磁盘保持原样", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.core.settingsPorts.readSettings = async () => {
      throw new Error("拒绝访问");
    };
    const writes = recordSettingsWrites(port);
    await show(port);
    await settingsReady();

    await act(async () => switchButton().click());

    expect(document.documentElement.dataset.theme).toBe("dark");
    await vi.waitFor(() => expect(port.calls.nativeTheme.at(-1)).toBe("dark"));
    expect(writes).toEqual([]);
  });

  it("设置说浅色而首帧镜像为空：载入后补写镜像", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.core.settingsPorts.readSettings = async () => JSON.stringify({ format_version: 1, base_url: "http://gw.example:3001", theme: "light" });
    await show(port);
    await settingsReady();

    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("light");
  });

  it("两次点击回到原档：第二次补写回浅色，不留下中间态", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    const writes = recordSettingsWrites(port);
    await show(port);
    await settingsReady();
    await act(async () => switchButton().click());
    await vi.waitFor(() => expect(writes).toHaveLength(1));

    await act(async () => switchButton().click());

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("light");
    await vi.waitFor(() => expect(writes.map((text) => JSON.parse(text).theme)).toEqual(["dark", "light"]));
  });
});

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

  it("顶栏：画板包、设置与版本入口都在", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, { version: "1.2.3" });
    expect(container.textContent).toContain("画板包");
    expect(container.textContent).toContain("高级设置");
    expect(container.textContent).toContain("Kacha 1.2.3");
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
    const settingsButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("高级设置"));
    await act(async () => settingsButton?.click());
    const settingsPanel = container.querySelector("[aria-label='高级设置']");
    expect(settingsPanel).not.toBeNull();
    const close = [...(settingsPanel?.querySelectorAll("button") ?? [])].find((button) => button.getAttribute("aria-label") === "关闭");
    await act(async () => close?.click());
    expect(container.querySelector("[aria-label='高级设置']")).toBeNull();
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
    const tokenInput = container.querySelector("input[placeholder*='Gitea token']") as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(tokenInput, "test-token");
      tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
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
    const tokenInput = container.querySelector("input[placeholder*='Gitea token']") as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(tokenInput, "test-token");
      tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
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

// #221：顶栏主题切换入口——即时生效、首帧镜像、通知宿主壳、写回设置，且不覆盖受保护的设置文件。
});

describe("主题切换", () => {
  /** 文档根与本地存储都没有全局 reset：本组用例自己清，别串到别的用例。 */
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

  /** 等设置载入完成：高级设置按钮解禁就是信号（主题的宿主同步也在这一刻之后）。 */
  async function settingsReady(): Promise<void> {
    await vi.waitFor(() => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("高级设置"));
      expect(button?.disabled).toBe(false);
    });
  }

  function option(label: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[aria-label='${label}']`);
    if (!button) throw new Error("没有找到主题档位：" + label);
    return button;
  }

  /** 记下写进 settings.json 的原文（替身默认也写内存，这里换成可断言的记录）。 */
  function recordSettingsWrites(port: FakePort): string[] {
    const writes: string[] = [];
    port.core.settingsPorts.writeSettings = async (text) => void writes.push(text);
    return writes;
  }

  it("三档常驻在顶栏，不用打开高级设置", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    await settingsReady();
    expect(container.querySelector("[aria-label='主题']")).not.toBeNull();
    for (const label of ["暗色", "浅色", "跟随系统"]) expect(option(label)).not.toBeNull();
    // 没有打开设置面板。
    expect(container.querySelector("[aria-label='高级设置']")).toBeNull();
  });

  it("点浅色：文档根、首帧镜像、宿主壳与设置文件都跟着变", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    const writes = recordSettingsWrites(port);
    await show(port);
    await settingsReady();
    // 拿到设置后先同步一次真源档位（默认暗色）。
    await vi.waitFor(() => expect(port.calls.nativeTheme).toEqual(["dark"]));
    const boardWrites = port.calls.write.length;

    await act(async () => option("浅色").click());

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("light");
    await vi.waitFor(() => expect(writes.map((text) => JSON.parse(text).theme)).toEqual(["light"]));
    expect(port.calls.nativeTheme.at(-1)).toBe("light");
    // 主题字段写进 v1 设置文件，不升格式版本。
    expect(JSON.parse(writes[0]).format_version).toBe(1);
    // 切主题不碰画板：壳端口没有多出任何画板写入（也就不进撤销栈）。
    expect(port.calls.write.length).toBe(boardWrites);
  });

  it("跟随系统：系统配色变化时界面跟着变，宿主拿到的是 system 而不是被钉死的暗色", async () => {
    const listeners: ((event: { matches: boolean }) => void)[] = [];
    // jsdom 没有 matchMedia：注入一个可控的媒体查询，系统配色变化由本用例触发。
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

    await act(async () => option("跟随系统").click());
    expect(document.documentElement.dataset.theme).toBe("light");

    await act(async () => {
      for (const listener of listeners) listener({ matches: true });
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(port.calls.nativeTheme.at(-1)).toBe("system");
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("system");
  });

  it("跟随系统 + 系统深色：画布拿到的是解析后的有效主题，不是档位", async () => {
    // jsdom 没有 matchMedia：系统配色钉成深色。
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const port = createFakePort();
    port.core.settingsPorts.readSettings = async () => JSON.stringify({ format_version: 1, base_url: "http://gw.example:3001", theme: "system" });
    await show(port);
    await settingsReady();

    await vi.waitFor(() => expect(canvas.props?.theme).toBe("dark"));
    // 交给画布的是有效主题（暗色），不是三档里的 system。
    expect(canvas.props?.theme).not.toBe("system");
  });

  it("设置还没读到就切换：先不动磁盘，读到设置后补写一条", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    // 把读设置停在半路：切换发生在「磁盘内容还未知」的那一段。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const readSettings = port.core.settingsPorts.readSettings;
    port.core.settingsPorts.readSettings = async () => {
      await gate;
      return readSettings();
    };
    const writes = recordSettingsWrites(port);
    await show(port);

    // 不等设置载入：这时界面照常可切，但不能拿默认值去覆盖用户真实的设置文件。
    await act(async () => option("浅色").click());
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("light");
    expect(writes).toEqual([]);

    await act(async () => release());

    // 载入完成后补写一次：写的是读到的设置加上本次选的档位。
    await vi.waitFor(() => expect(writes.map((text) => JSON.parse(text).theme)).toEqual(["light"]));
    expect(JSON.parse(writes[0]).format_version).toBe(1);
  });

  it("宿主拒绝同步原生主题：界面照常切换，错误不冒出来", async () => {
    const port = createFakePort({ nativeThemeFailure: true });
    port.board.list = async () => listing();
    const writes = recordSettingsWrites(port);
    await show(port);
    await settingsReady();

    await act(async () => option("浅色").click());

    expect(document.documentElement.dataset.theme).toBe("light");
    await vi.waitFor(() => expect(writes.map((text) => JSON.parse(text).theme)).toEqual(["light"]));
    expect(port.calls.nativeTheme.at(-1)).toBe("light");
    expect(container.querySelector(".bar-error")).toBeNull();
  });

  it("设置文件版本过新：切换只在本会话生效，磁盘保持原样", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.core.settingsPorts.readSettings = async () => JSON.stringify({ format_version: 2, base_url: "http://gw.example:3001" });
    const writes = recordSettingsWrites(port);
    await show(port);
    await settingsReady();

    await act(async () => option("浅色").click());

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("light");
    await vi.waitFor(() => expect(port.calls.nativeTheme.at(-1)).toBe("light"));
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

    await act(async () => option("暗色").click());

    expect(document.documentElement.dataset.theme).toBe("dark");
    await vi.waitFor(() => expect(port.calls.nativeTheme.at(-1)).toBe("dark"));
    expect(writes).toEqual([]);
  });

  it("设置说浅色而首帧镜像为空：载入后补写镜像，下次首帧不再从暗色翻过来", async () => {
    // 迁移配置目录 / 清过本地存储：settings.json 说浅色，镜像却是空的。
    const port = createFakePort();
    port.board.list = async () => listing();
    port.core.settingsPorts.readSettings = async () => JSON.stringify({ format_version: 1, base_url: "http://gw.example:3001", theme: "light" });
    await show(port);
    await settingsReady();

    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("light");
  });

  it("设置还没读到、用户也没选过：不往镜像里写默认值", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const readSettings = port.core.settingsPorts.readSettings;
    port.core.settingsPorts.readSettings = async () => {
      await gate;
      return readSettings();
    };
    await show(port);

    // 此刻界面按默认暗色显示，但磁盘上是什么还不知道：写下去就成了与设置冲突的猜测值。
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBeNull();

    await act(async () => release());
    await settingsReady();
    // 载入后才写：写的是设置里的档位（默认设置的暗色）。
    await vi.waitFor(() => expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("dark"));
  });

  it("点当前已选的档位：值没变就不重复写盘", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    const writes = recordSettingsWrites(port);
    await show(port);
    await settingsReady();

    // 设置里本来就是暗色（默认），再点一次暗色没有要改的东西。
    await act(async () => option("暗色").click());

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe("dark");
    expect(writes).toEqual([]);
  });
});

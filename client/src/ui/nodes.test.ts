// @vitest-environment jsdom
// 节点组件的渲染与交互行为：状态徽标、模型说明、图片节点、宽高比组合框。
// vitest 的 include 只收 *.test.ts，所以用 createElement 而不是 JSX；@xyflow/react 的 Handle / NodeResizer 用替身。
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_TABLE, type CapabilityTable, type ModelCapability, type SizeRule } from "../core/capabilities";
import type { TaskStatus } from "../core/run";
import type { SizeSpec } from "../core/size";
import { thumbUrl } from "../shell/ipc";
import { BoardContext, type BoardActions } from "./context";
import { ImageNode, ModelInfo, RatioCombo, StatusBadge } from "./nodes";
import { AUTO_RATIO } from "./ratioCombo";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@xyflow/react", async () => {
  const { createElement: h } = await import("react");
  return {
    NodeResizer: (props: { isVisible?: boolean }) => h("div", { "data-testid": "resizer", "data-visible": String(props.isVisible) }),
    Handle: (props: { id?: string; className?: string }) => h("span", { className: props.className, "data-handle": props.id }),
    Position: { Left: "left", Right: "right" },
    useUpdateNodeInternals: () => () => undefined,
    useNodeId: () => null,
  };
});

// ---- 渲染脚手架 ----

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

/** 渲染（或重渲染）一棵节点组件树，等副作用走完。 */
async function show(ui: ReactElement): Promise<void> {
  await act(async () => root.render(ui));
}

function board(overrides: Partial<BoardActions> = {}): BoardActions {
  return {
    table: BUILTIN_TABLE,
    userRoot: "/~",
    availableModels: [],
    concurrency: 2,
    apply: vi.fn(),
    continueEditing: vi.fn(),
    addAsReference: vi.fn(),
    generateVariant: vi.fn(),
    relocate: vi.fn(),
    previewNode: vi.fn(),
    editRegion: vi.fn(),
    perform: vi.fn(),
    setPromptDraft: vi.fn(),
    takePromptFocus: () => false,
    nodeUnmounted: vi.fn(),
    ...overrides,
  };
}

function inBoard(ui: ReactElement, actions: BoardActions = board()): ReactElement {
  return createElement(BoardContext.Provider, { value: actions }, ui);
}

/** 像用户键入一样改受控输入框的值（React 只在原生 setter 之后收到 input 事件）。 */
function typeInto(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressKey(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

// ---- 状态徽标 ----

describe("StatusBadge", () => {
  it("排队 / 失败 / 已取消 / 已中断 各给文字与色调", async () => {
    const cases: [TaskStatus, string, string][] = [
      [{ kind: "queued" }, "排队中", "status-queued"],
      [{ kind: "failed", label: "网关报错" }, "失败 · 网关报错", "status-failed"],
      [{ kind: "cancelled", gatewayMayContinue: true }, "已取消", "status-queued"],
      [{ kind: "interrupted" }, "已中断", "status-queued"],
    ];
    for (const [status, text, tone] of cases) {
      await show(createElement(StatusBadge, { status }));
      const badge = container.querySelector(".status")!;
      expect(badge.textContent).toBe(text);
      expect(badge.className).toBe(`status ${tone}`);
    }
  });

  it("执行中每秒刷新已用时间，分钟按整分补零", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T08:00:00Z"));
    try {
      await show(createElement(StatusBadge, { status: { kind: "running", startedAt: Date.now() - 65_000 } }));
      expect(container.textContent).toContain("执行中 1:05");
      expect(container.querySelector(".spinner")).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(1000));
      expect(container.textContent).toContain("执行中 1:06");
    } finally {
      vi.useRealTimers();
    }
  });

  it("限流退避显示剩余秒数，到点后不再为负", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T08:00:00Z"));
    try {
      await show(createElement(StatusBadge, { status: { kind: "backoff", retryAt: Date.now() + 5000 } }));
      expect(container.textContent).toBe("网关限流，5 秒后重试");
      await act(async () => vi.advanceTimersByTime(3000));
      expect(container.textContent).toBe("网关限流，2 秒后重试");
      await act(async () => vi.advanceTimersByTime(5000));
      expect(container.textContent).toBe("网关限流，0 秒后重试");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- 模型说明浮层 ----

describe("ModelInfo", () => {
  const flash = BUILTIN_TABLE.models.find((m) => m.model_id === "doubao-seedream-5-0-flash-260915")!;
  const tableOf = (...models: ModelCapability[]): CapabilityTable => ({ format_version: BUILTIN_TABLE.format_version, models });

  it("列出档位、参考图上限与待测能力", async () => {
    const model: ModelCapability = { ...flash, native_mask: "untested" };
    await show(inBoard(createElement(ModelInfo, { modelId: model.model_id, onClose: vi.fn() }), board({ table: tableOf(model) })));
    const text = container.textContent!;
    expect(text).toContain(model.display_name);
    expect(text).toContain(model.model_id);
    expect(text).toContain("模型档位：经济");
    expect(text).toContain("参考图上限：10");
    expect(text).toContain("待测（当前按不支持处理）：");
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(container.querySelector("li")!.textContent).toBe("原生蒙版");
  });

  it("未上架的模型标「未上架」，没有待测与文档链接时不出这两块", async () => {
    const model: ModelCapability = { ...flash, tier: null, help_url: null, reference_phrasing: { en_verified: "supported" } };
    await show(inBoard(createElement(ModelInfo, { modelId: model.model_id, onClose: vi.fn() }), board({ table: tableOf(model) })));
    expect(container.textContent).toContain("模型档位：未上架");
    expect(container.textContent).not.toContain("待测");
    expect(container.textContent).not.toContain("查看官方文档");
  });

  it("模型不在能力表内时什么都不渲染", async () => {
    await show(inBoard(createElement(ModelInfo, { modelId: "unknown-model", onClose: vi.fn() }), board({ table: tableOf() })));
    expect(container.innerHTML).toBe("");
  });

  it("「关闭」与「查看官方文档」都接上了回调", async () => {
    const onClose = vi.fn();
    const open = vi.fn();
    const original = window.open;
    window.open = open as unknown as typeof window.open;
    try {
      await show(inBoard(createElement(ModelInfo, { modelId: flash.model_id, onClose }), board({ table: tableOf(flash) })));
      const close = [...container.querySelectorAll("button")].find((b) => b.textContent === "关闭")!;
      await act(async () => close.click());
      expect(onClose).toHaveBeenCalledTimes(1);
      const docs = [...container.querySelectorAll("button")].find((b) => b.textContent === "查看官方文档")!;
      await act(async () => docs.click());
      expect(open).toHaveBeenCalledWith(flash.help_url, "_blank", "noopener,noreferrer");
    } finally {
      window.open = original;
    }
  });
});

// ---- 图片节点 ----

describe("ImageNode", () => {
  const image = (overrides: Partial<Parameters<typeof ImageNode>[0]> = {}): ReactElement =>
    createElement(ImageNode, {
      id: "n1",
      absPath: "/~/.data/a.png",
      name: "a.png",
      missing: false,
      selected: false,
      width: 200,
      height: 100,
      badges: [],
      hover: {},
      children: null,
      ...overrides,
    });

  it("缺图时显示占位、文件名与两种重新定位", async () => {
    const actions = board();
    await show(inBoard(image({ missing: true }), actions));
    expect(container.textContent).toContain("图片缺失");
    expect(container.textContent).toContain("a.png");
    expect(container.querySelector('[data-testid="resizer"]')).toBeNull();
    const [search, pick] = [...container.querySelectorAll("button")];
    await act(async () => search.click());
    expect(actions.relocate).toHaveBeenCalledWith("n1", "search");
    await act(async () => pick.click());
    expect(actions.relocate).toHaveBeenCalledWith("n1", "pick");
  });

  it("有图时显示缩略图、缩放柄与角标，双击放大预览", async () => {
    const actions = board();
    await show(inBoard(image({ selected: true, badges: ["透明", "2 图层"] }), actions));
    const thumb = container.querySelector("img")!;
    expect(thumb.getAttribute("src")).toBe(thumbUrl("/~/.data/a.png"));
    expect(thumb.getAttribute("alt")).toBe("a.png");
    expect(container.querySelector('[data-testid="resizer"]')?.getAttribute("data-visible")).toBe("true");
    expect([...container.querySelectorAll(".badge")].map((b) => b.textContent)).toEqual(["透明", "2 图层"]);
    await act(async () => thumb.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(actions.previewNode).toHaveBeenCalledWith("n1");
  });

  it("尺寸未知（画布还没量）时不给缩放柄，没有角标时不出角标栏", async () => {
    await show(inBoard(image({ width: undefined, height: undefined })));
    expect(container.querySelector('[data-testid="resizer"]')).toBeNull();
    expect(container.querySelector(".image-badges")).toBeNull();
  });

  it("缩略图读不出来时退回缺图占位", async () => {
    await show(inBoard(image()));
    const thumb = container.querySelector("img")!;
    await act(async () => thumb.dispatchEvent(new Event("error")));
    expect(container.textContent).toContain("图片缺失");
    expect(container.querySelector("img")).toBeNull();
  });

  it("卸载时通知画布收起悬浮动作条", async () => {
    const actions = board();
    await show(inBoard(image(), actions));
    await act(async () => root.unmount());
    expect(actions.nodeUnmounted).toHaveBeenCalledWith("n1");
  });
});

// ---- 宽高比组合框 ----

describe("RatioCombo", () => {
  /** 允许任意宽高比（范围 1:2–2:1），1K 档有两个预设。 */
  const rule: SizeRule = {
    tiers: { "1K": { "1:1": [1024, 1024], "16:9": [1424, 800] } },
    custom: { min_total_pixels: null, max_total_pixels: null, min_aspect_ratio: 0.5, max_aspect_ratio: 2 },
  };
  const ratios = ["1:1", "16:9"];
  const manual: SizeSpec = { tier: "1K", ratio: "16:9", width: null, height: null };
  const auto: SizeSpec = { tier: "1K", ratio: "16:9", width: null, height: null, auto_ratio: { ratio: "16:9", image: null, source: null } };

  const combo = (spec: SizeSpec, onPick = vi.fn(), extra: { unsupported?: boolean; disabled?: boolean } = {}): ReactElement =>
    createElement(RatioCombo, { rule, spec, ratios, unsupported: extra.unsupported ?? false, disabled: extra.disabled ?? false, onPick });
  const input = (): HTMLInputElement => container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const toggle = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('button[aria-label="宽高比预设"]')!;
  const openList = async (): Promise<void> => {
    await act(async () => toggle().click());
  };
  const options = (): HTMLLIElement[] => [...container.querySelectorAll<HTMLLIElement>('[role="option"]')];

  it("手动原样显示、自动显示推测标签、发不出去时标「（不支持）」", async () => {
    await show(combo(manual));
    expect(input().value).toBe("16:9");
    expect(container.querySelector(".ratio-combo")!.className).not.toContain("ratio-unsupported");
    await show(combo(auto));
    expect(input().value).toBe("自动（16:9）");
    await show(combo({ ...manual, ratio: "3:2" }, vi.fn(), { unsupported: true }));
    expect(input().value).toBe("3:2（不支持）");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector(".ratio-combo")!.className).toContain("ratio-unsupported");
  });

  it("聚焦填入当前值；没改过失焦不提交，自动状态从空开始", async () => {
    const onPick = vi.fn();
    await show(combo(manual, onPick));
    await act(async () => input().focus());
    expect(input().value).toBe("16:9");
    await act(async () => input().blur());
    expect(onPick).not.toHaveBeenCalled();
    expect(input().value).toBe("16:9");
    await show(combo(auto, onPick));
    await act(async () => input().focus());
    expect(input().value).toBe("");
  });

  it("手填后失焦提交，文本约分", async () => {
    const onPick = vi.fn();
    await show(combo({ ...manual, ratio: "1:1" }, onPick));
    await act(async () => input().focus());
    await act(async () => typeInto(input(), "32:18"));
    await act(async () => input().blur());
    expect(onPick).toHaveBeenCalledWith("16:9");
    // 画板值没变（父组件没重渲染）：输入框回到改前的 1:1，等画板文本追上。
    expect(input().value).toBe("1:1");
  });

  it("手填的文本约分后与当前值相同就不提交（不占撤销步）", async () => {
    const onPick = vi.fn();
    await show(combo(manual, onPick));
    await act(async () => input().focus());
    await act(async () => typeInto(input(), "32:18"));
    await act(async () => input().blur());
    expect(onPick).not.toHaveBeenCalled();
    expect(input().value).toBe("16:9");
  });

  it("Enter 提交，Esc 放弃手填内容", async () => {
    const onPick = vi.fn();
    await show(combo(manual, onPick));
    await act(async () => input().focus());
    await act(async () => typeInto(input(), "1:1"));
    await act(async () => pressKey(input(), "Enter"));
    expect(onPick).toHaveBeenCalledWith("1:1");
    await act(async () => input().focus());
    await act(async () => typeInto(input(), "8:1"));
    await act(async () => pressKey(input(), "Escape"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("16:9");
  });

  it("越界的手填钳制到模型边界并提示范围，提示到时收起", async () => {
    vi.useFakeTimers();
    try {
      const onPick = vi.fn();
      await show(combo(manual, onPick));
      await act(async () => input().focus());
      await act(async () => typeInto(input(), "8:1"));
      await act(async () => input().blur());
      expect(onPick).toHaveBeenCalledWith("2:1");
      expect(container.querySelector('[role="status"]')!.textContent).toBe("该模型宽高比范围 1:2–2:1");
      await act(async () => vi.advanceTimersByTime(4000));
      expect(container.querySelector('[role="status"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("↓ 与按钮都能展开预设，当前项标为选中", async () => {
    await show(combo(manual));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => pressKey(input(), "ArrowDown"));
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(options().map((o) => o.textContent)).toEqual(["自动", ...ratios]);
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    expect(options()[2].className).toBe("selected");
    await openList();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("自动状态下「自动」项显示推测标签", async () => {
    await show(combo(auto));
    await openList();
    expect(options().map((o) => o.textContent)).toEqual(["自动（16:9）", ...ratios]);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("点预设换宽高比；点当前项不提交", async () => {
    const onPick = vi.fn();
    await show(combo(manual, onPick));
    await openList();
    await act(async () => options()[1].click());
    expect(onPick).toHaveBeenCalledWith("1:1");
    await openList();
    await act(async () => options()[2].click());
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("手动时点「自动」转为自动；已经是自动就不提交", async () => {
    const onPick = vi.fn();
    await show(combo(manual, onPick));
    await openList();
    await act(async () => options()[0].click());
    expect(onPick).toHaveBeenCalledWith(AUTO_RATIO);
    const autoPick = vi.fn();
    await show(combo(auto, autoPick));
    await openList();
    await act(async () => options()[0].click());
    expect(autoPick).not.toHaveBeenCalled();
  });

  it("禁用时不能手填与展开；手填途中被锁定则丢掉草稿", async () => {
    await show(combo(manual, vi.fn(), { disabled: true }));
    expect(input().disabled).toBe(true);
    expect(toggle().disabled).toBe(true);
    await act(async () => toggle().click());
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    const onPick = vi.fn();
    await show(combo(manual, onPick));
    await act(async () => input().focus());
    await act(async () => typeInto(input(), "8:1"));
    expect(input().value).toBe("8:1");
    await show(combo(manual, onPick, { disabled: true }));
    expect(input().value).toBe("16:9");
    expect(onPick).not.toHaveBeenCalled();
  });
});

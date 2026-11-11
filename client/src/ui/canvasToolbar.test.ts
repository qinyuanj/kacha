// @vitest-environment jsdom
// 画布工具栏：portal 进页面给定的槽位、归档画板整块置灰、新建任务模型下拉（默认模型、不可用占位、改选落盘）
// 与各按钮接上的回调。@xyflow/react 用替身（工具栏经 ModelOptions 间接引到节点模块）。
// vitest 的 include 只收 *.test.ts，所以用 createElement 而不是 JSX。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_FORMAT_VERSION, type Board } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { PREFERRED_TASK_MODEL } from "../core/settings";
import { FLASH_UNAVAILABLE_TEXT, TIDY_TEXT } from "./boardText";
import { CanvasToolbar, type CanvasToolbarProps } from "./canvasToolbar";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@xyflow/react", async () => {
  const { createElement: h } = await import("react");
  return {
    NodeResizer: () => null,
    Handle: () => null,
    ViewportPortal: (props: { children?: unknown }) => h("div", null, props.children as never),
    Position: { Left: "left", Right: "right", Top: "top" },
    useUpdateNodeInternals: () => () => undefined,
    useNodeId: () => null,
  };
});

// ---- 夹具 ----

/** 除了默认模型 Flash 以外的一个上架模型：用来区分「board.last_model 生效」与「退回 Flash」。 */
const OTHER = BUILTIN_TABLE.models.find((m) => m.model_id !== PREFERRED_TASK_MODEL && m.tier !== null)!;
const SHELVED = BUILTIN_TABLE.models.filter((m) => m.tier !== null);

function makeBoard(lastModel: string | null): Board {
  return { format_version: BOARD_FORMAT_VERSION, title: "画板", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], last_model: lastModel, extra: {} };
}

let container: HTMLDivElement;
/** portal 的目标槽位：页面顶部第二行左侧的容器。 */
let slot: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  slot = document.createElement("div");
  document.body.append(container, slot);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  slot.remove();
});

function blank(): CanvasToolbarProps {
  return {
    toolbarSlot: slot,
    readOnly: false,
    board: makeBoard(null),
    table: BUILTIN_TABLE,
    discovery: { source: "none" },
    availableModels: SHELVED,
    apply: vi.fn(),
    onNewPrompt: vi.fn(),
    onAddReferences: vi.fn(),
    onNewTask: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    undoLabel: null,
    redoLabel: null,
    selectedCount: 0,
    onRun: vi.fn(),
    tidying: false,
    onTidyChange: vi.fn(),
  };
}

async function show(props: CanvasToolbarProps): Promise<void> {
  await act(async () => root.render(createElement(CanvasToolbar, props)));
}

const toolbar = (): HTMLElement => slot.querySelector<HTMLElement>(".board-toolbar-left")!;
const modelSelect = (): HTMLSelectElement => slot.querySelector<HTMLSelectElement>("select.toolbar-model")!;
const button = (text: string): HTMLButtonElement => [...slot.querySelectorAll("button")].find((b) => b.textContent === text)!;
const options = (): HTMLOptionElement[] => [...modelSelect().options];

/** 像用户改选一样改受控下拉的值（React 只在原生 setter 之后收到 change 事件）。 */
function pickModel(select: HTMLSelectElement, modelId: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, modelId);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("CanvasToolbar", () => {
  it("没有槽位时什么都不渲染（portal 语义）", async () => {
    await show(blankWith({ toolbarSlot: null }));
    expect(container.innerHTML).toBe("");
    expect(slot.innerHTML).toBe("");
  });

  it("归档画板：一整块置灰的工具栏，模型下拉是禁用占位", async () => {
    await show(blankWith({ readOnly: true, onNewPrompt: vi.fn() }));
    expect(container.innerHTML).toBe("");
    expect(toolbar().getAttribute("aria-label")).toBe("画板工具栏");
    expect(button("＋ 提示词").getAttribute("aria-disabled")).toBe("true");
    expect(button("▶ 运行").getAttribute("aria-disabled")).toBe("true");
    expect(modelSelect().disabled).toBe(true);
    expect(options()).toHaveLength(0);
  });

  it("正常画板：模型下拉退回 Flash、列出可用模型、运行按钮写「运行选中」", async () => {
    await show(blankWith({ selectedCount: 2, undoLabel: "移动节点", redoLabel: "删除节点" }));
    // 没选过模型（board.last_model 为 null）→ 默认 Flash。
    expect(modelSelect().value).toBe(PREFERRED_TASK_MODEL);
    expect(modelSelect().getAttribute("aria-label")).toBe("新建任务模型");
    expect(options().map((o) => o.value)).toEqual(expect.arrayContaining([PREFERRED_TASK_MODEL, OTHER.model_id]));
    // 默认模型可用时不补占位项。
    expect(options().some((o) => o.textContent === FLASH_UNAVAILABLE_TEXT)).toBe(false);
    expect(button("▶ 运行选中")).toBeTruthy();
    expect(button("↶").getAttribute("aria-disabled")).toBeNull();
    expect(button("↷").getAttribute("aria-disabled")).toBeNull();
    expect(button(TIDY_TEXT.enter).getAttribute("aria-pressed")).toBe("false");
    expect(button(TIDY_TEXT.enter)).toBeTruthy();
  });

  it("可用列表只有当前模型：不补不可用占位项", async () => {
    const current = SHELVED.find((m) => m.model_id === PREFERRED_TASK_MODEL)!;
    await show(blankWith({ availableModels: [current] }));
    expect(modelSelect().value).toBe(PREFERRED_TASK_MODEL);
    expect(options()).toHaveLength(1);
    expect(options()[0].value).toBe(PREFERRED_TASK_MODEL);
    expect(options()[0].disabled).toBe(false);
    expect(options()[0].textContent).not.toBe(FLASH_UNAVAILABLE_TEXT);
  });

  it("默认模型不在可用列表：补一个置灰占位项，值仍是 Flash", async () => {
    await show(blankWith({ availableModels: [] }));
    expect(modelSelect().value).toBe(PREFERRED_TASK_MODEL);
    expect(options()).toHaveLength(1);
    expect(options()[0].disabled).toBe(true);
    expect(options()[0].value).toBe(PREFERRED_TASK_MODEL);
    expect(options()[0].textContent).toBe(FLASH_UNAVAILABLE_TEXT);
  });

  it("画板上次选过的模型可用时用它；改选写 lastModel（偏好，不进撤销）", async () => {
    const props = blankWith({ board: makeBoard(OTHER.model_id) });
    await show(props);
    expect(modelSelect().value).toBe(OTHER.model_id);
    await act(async () => pickModel(modelSelect(), PREFERRED_TASK_MODEL));
    expect(props.apply).toHaveBeenCalledWith({ kind: "lastModel", model: PREFERRED_TASK_MODEL });
  });

  it("新建类动作与撤销 / 重做、运行、整理都接上了回调", async () => {
    const props = blankWith({ undoLabel: "移动节点", redoLabel: "删除节点", selectedCount: 1 });
    await show(props);
    for (const [text, called] of [
      ["＋ 提示词", props.onNewPrompt],
      ["＋ 参考图…", props.onAddReferences],
      ["＋ 生成任务", props.onNewTask],
      ["↶", props.onUndo],
      ["↷", props.onRedo],
      ["▶ 运行选中", props.onRun],
    ] as const) {
      await act(async () => button(text).click());
      expect(called).toHaveBeenCalledTimes(1);
    }
  });

  it("整理按钮反映整理模式，点它切换", async () => {
    const props = blankWith({ tidying: true });
    await show(props);
    expect(button(TIDY_TEXT.enter).getAttribute("aria-pressed")).toBe("true");
    await act(async () => button(TIDY_TEXT.enter).click());
    expect(props.onTidyChange).toHaveBeenCalledWith(false);
    const idle = blankWith({ tidying: false });
    await show(idle);
    await act(async () => button(TIDY_TEXT.enter).click());
    expect(idle.onTidyChange).toHaveBeenCalledWith(true);
  });
});

/** 带覆盖项的 props（各测试只写关心的字段）。 */
function blankWith(overrides: Partial<CanvasToolbarProps>): CanvasToolbarProps {
  return { ...blank(), ...overrides };
}

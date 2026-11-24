// @vitest-environment jsdom
// BoardCanvas 顶层接线的行为测试（#101 拆分的回归网）：工具栏 portal、空白右键菜单、快捷键、Esc 清选区、方向键微移、
// 悬浮动作条与放大预览、HTML5 拖放、只读画板、以及画布交给 React Flow 的契约 props；
// 粘贴（#96）走页面级 paste 事件：粘图片落成参考图、粘节点标记还原节点、模态 / 输入框里放行。
// vitest 的 include 只收 *.test.ts，所以用 createElement 而不是 JSX。@xyflow/react 用替身：ReactFlow 只渲染一层 div，
// 收到的 props 存进 xyflow.captured —— 测试用它模拟 React Flow 报来的事件（等价于用户在画布上操作），并断言画布交出去的契约；
// 断言只针对用户可见行为与这些契约，不看内部函数名与 DOM 层级。
import { act, createElement, type ComponentProps, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Edge as FlowEdge, Node as FlowNode, ReactFlowProps } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readOnlyMenu } from "../core/archive";
import { newBoard, parseBoard, serializeBoard, type Board, type BoardEdge, type BoardNode, type PortRef, type TaskNode } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { actionBarItems, menuItems, type BoardAction, type MenuFacts, type MenuItem } from "../core/contextMenu";
import type { BoardChange, EditResult } from "../core/edit";
import { countLabel } from "../core/history";
import { edgeHoverInfo } from "../core/hoverInfo";
import { LOCKED_HINT, TASK_BUSY } from "../core/iterate";
import { MAX_PASTE_BYTES, isNodeMarker, nodeMarker, PASTE_NAME_PREFIX } from "../core/pageInput";
import type { ClipboardContent } from "../core/clipboardDispatch";
import type { BoardMeasure } from "../core/tidy";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { BoardCanvas } from "./BoardCanvas";
import { ARCHIVE_TEXT, DELETE_TASK_TEXT, IMPORT_TEXT, SAVE_TEXT, TIDY_TEXT } from "./boardText";
import { writeClipboard } from "./canvasKeyboard";
import { HOVER_DELAY_MS } from "./hoverInfo";
import { ShellProvider } from "./shell";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- 替身 ----

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
/** 替身 inspectImage 回的图片信息：宽高用于图片节点的显示尺寸。 */
const IMAGE_INFO = { sha256: SHA_A, bytes: 12, width: 240, height: 160, format: "png", has_alpha: false };

/** @xyflow/react 替身里供测试读 / 改的部分：captured = ReactFlow 这一帧收到的 props。 */
const xyflow = vi.hoisted(() => {
  /** props = ReactFlow 这一帧收到的 props；plugin = 画布插件（Background / Controls / MiniMap 等）各自收到的 props。 */
  const captured: { props: Record<string, unknown>; plugin: Record<string, Record<string, unknown>> } = { props: {}, plugin: {} };
  /** 拖线态（useConnection 收到的 ConnectionState）：换成一个进行中的连线即可模拟「正拖着一条线」。 */
  const connection: { current: Record<string, unknown> } = { current: { inProgress: false, fromHandle: null } };
  const flow = {
    // 坐标原样返回：断言里的画布坐标就等于派发事件的窗口坐标，读起来直白。
    screenToFlowPosition: vi.fn((point: { x: number; y: number }) => ({ x: point.x, y: point.y })),
    getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    setViewport: vi.fn(async () => undefined),
    fitView: vi.fn(async () => undefined),
    zoomTo: vi.fn(async () => undefined),
    zoomIn: vi.fn(async () => undefined),
    zoomOut: vi.fn(async () => undefined),
    deleteElements: vi.fn(async (_args: { nodes?: { id: string }[]; edges?: { id: string }[] }) => undefined),
    getZoom: vi.fn(() => 1),
    setCenter: vi.fn(async (_x: number, _y: number, _options?: { zoom?: number; duration?: number }) => undefined),
  };
  return { captured, flow, connection };
});

vi.mock("@xyflow/react", async () => {
  const { createElement: h } = await import("react");
  /** 只是占位的画布插件：渲染成带名字的 div，方便断言「在不在」。 */
  const box = (name: string) => (props: { children?: ReactNode } & Record<string, unknown>) => {
    xyflow.captured.plugin[name] = props;
    return h("div", { "data-xyflow": name }, props.children);
  };
  return {
    ReactFlow: (props: { children?: ReactNode }) => {
      // 把这一帧的 props 交给测试；节点 / 连线的 selected、画布配置都从这里断言。
      xyflow.captured.props = props;
      return h("div", { className: "react-flow", "data-testid": "react-flow" }, h("div", { className: "react-flow__pane" }), props.children);
    },
    Background: box("background"),
    Controls: box("controls"),
    MiniMap: box("minimap"),
    ViewportPortal: box("viewport-portal"),
    NodeToolbar: (props: { nodeId?: string | string[]; isVisible?: boolean; children?: ReactNode }) =>
      h("div", { "data-testid": "node-toolbar", "data-node-id": JSON.stringify(props.nodeId ?? null), "data-visible": String(props.isVisible) }, props.children),
    Handle: (props: { id?: string; className?: string }) => h("span", { className: props.className, "data-handle": props.id }),
    NodeResizer: (props: { isVisible?: boolean }) => h("div", { "data-testid": "resizer", "data-visible": String(props.isVisible) }),
    BaseEdge: (props: { id?: string }) => h("path", { "data-edge": props.id }),
    EdgeLabelRenderer: box("edge-label"),
    getBezierPath: () => ["", 0, 0, 0, 0],
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    SelectionMode: { Partial: "partial", Full: "full" },
    useReactFlow: () => xyflow.flow,
    useStoreApi: () => ({ getState: () => ({ connection: { inProgress: false } }) }),
    // 照真 hook 的用法：画布传选择器（dragFromOf），替身把选择器作用在可切换的拖线态上。
    useConnection: (selector?: (state: Record<string, unknown>) => unknown) => (selector ? selector(xyflow.connection.current) : xyflow.connection.current),
    useUpdateNodeInternals: () => () => undefined,
    useNodeId: () => null,
  };
});

// 会碰宿主 / 网络的接线一律替身；core 逻辑保持真实（本测试锁的是它与界面的接线）。
// 壳端口是内存替身：上传、读图、度量、确认框与剪贴板都记在 port.calls 上，不发请求。


// ---- 画板夹具 ----

const SPEC_2K = { tier: "2K", ratio: "16:9", width: null, height: null };

function promptNode(id: string, pos: [number, number]): BoardNode {
  return { id, type: "prompt", pos, size: [240, 140], extra: {}, text: "一只猫" };
}

function referenceNode(id: string, pos: [number, number]): BoardNode {
  return { id, type: "reference", pos, size: [200, 220], extra: {}, path: `reference/${id}.png`, sha256: SHA_A, display_name: `${id}.png` };
}

function taskNode(id: string, pos: [number, number]): TaskNode {
  return { id, type: "task", pos, size: [280, 260], extra: {}, model: "qwen-image-3.0", size_spec: SPEC_2K, image_ports: 1, layer_decomposition: false, transparent_background: false, last_submitted: null };
}

function userEdge(from: PortRef, to: PortRef): BoardEdge {
  return { from, to, source_layer: null, region: null, system: false, extra: {} };
}

/** 一块小画板：提示词 p1、参考图 r1、生成任务 t1，提示词接正向端口、参考图接图 1。 */
function sampleBoard(): Board {
  const board = newBoard("测试画板");
  board.nodes = [promptNode("p1", [40, 60]), referenceNode("r1", [320, 60]), taskNode("t1", [600, 60])];
  board.edges = [userEdge(["p1", "positive"], ["t1", "positive"]), userEdge(["r1", "out"], ["t1", "image:0"])];
  return board;
}

/** 旧画板：把 stages 这类历史字段塞回序列化后的 JSON 再解析，等价于打开一份带阶段数据的画板文件。 */
function legacyBoard(board: Board, extra: Record<string, unknown>): Board {
  const raw = { ...(JSON.parse(serializeBoard(board)) as Record<string, unknown>), ...extra };
  const parsed = parseBoard(JSON.stringify(raw));
  if (parsed.kind !== "ok") throw new Error(`夹具画板应能打开：${parsed.kind === "corrupt" ? parsed.reason : parsed.kind}`);
  return parsed.board;
}

// ---- 渲染脚手架 ----

type Props = ComponentProps<typeof BoardCanvas>;

let container: HTMLDivElement;
let slot: HTMLDivElement;
let root: Root;
/** 落点判定（dropTargetAt）用 document.elementFromPoint：jsdom 没有实现，由测试喂。 */
let elementAt: Mock<() => Element | null>;
/** 壳端口的另存为替身（每次 beforeEach 重新装）。 */
let port: FakePort;
let nativeClipboard: ClipboardContent;
/** 「另存为」的替身（每次 beforeEach 重新装）。 */
let saveCopyAs: (absPath: string) => Promise<{ kind: "saved" | "cancelled" }>;

beforeEach(() => {
  vi.clearAllMocks();
  port = createFakePort();
  nativeClipboard = { kind: "empty", text: null, images: [], reason: null, readFailureCount: 0 };
  port.media.readClipboard = vi.fn(async () => nativeClipboard);
  port.files.inspectImage = vi.fn(async () => IMAGE_INFO);
  port.board.measure = vi.fn(async () => ({ nodes: {}, dirs: {} } satisfies BoardMeasure));
  port.ui.ask = vi.fn(async () => true);
  port.media.pickImages = vi.fn(async () => [] as File[]);
  port.media.uploadReference = vi.fn(async (file: File) => ({ path: `reference/${file.name}`, sha256: SHA_B }));
  port.media.copyText = vi.fn(async () => undefined);
  // 「另存为」经壳端口的 media.saveCopyAs；这里只记调用。
  saveCopyAs = vi.fn(async () => ({ kind: "saved" as const }));
  port.media.saveCopyAs = saveCopyAs;
  // 画板状态的读取在本次运行的测试里没有任务目录：一律读失败，画布按「没有结局记录」处理。
  port.core.taskFs = { readFile: vi.fn(async () => Promise.reject(new Error("测试里没有任务目录"))), writeNewFile: vi.fn() };
  // 应用内剪贴板是模块级状态（可跨画板粘贴），每条用例从「没复制过」开始。
  writeClipboard(null);
  xyflow.connection.current = { inProgress: false, fromHandle: null };
  elementAt = vi.fn((): Element | null => null);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, writable: true, value: () => elementAt() });
  container = document.createElement("div");
  document.body.append(container);
  slot = document.createElement("div");
  slot.id = "toolbar-slot";
  document.body.append(slot);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  slot.remove();
});

/** 造一份真实的 props（回调都是新的 vi.fn，方便逐条断言）。 */
function makeProps(patch: Partial<Props> = {}) {
  // 回调先建好，测试里直接断言这些替身；props 里放的就是同一批函数。
  const spies = {
    apply: vi.fn((_change: BoardChange): EditResult | null => null),
    check: vi.fn((_change: BoardChange): EditResult | null => null),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    toast: vi.fn(),
    onRun: vi.fn(),
    onCancelTask: vi.fn(),
    onRegenerate: vi.fn(),
    onViewSendText: vi.fn(),
    onTidyChange: vi.fn(),
  };
  const props: Props = {
    board: sampleBoard(),
    boardFile: "测试画板.ugcboard.json",
    table: BUILTIN_TABLE,
    userRoot: "/~",
    locked: new Set<string>(),
    undoLabel: null,
    redoLabel: null,
    discovery: { source: "none" },
    concurrency: 2,
    runNodes: new Map(),
    handled: new Set<string>(),
    toolbarSlot: null,
    focus: null,
    tidying: false,
    theme: "dark",
    ...spies,
    ...patch,
  };
  return { props, ...spies };
}

type Harness = ReturnType<typeof makeProps>;

/** 多刷几轮微任务：图片信息、上传等 promise 链要把状态提交进 React 之后才能断言。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderCanvas(patch: Partial<Props> = {}): Promise<Harness> {
  const harness = makeProps(patch);
  await act(async () => root.render(createElement(ShellProvider, { port, children: createElement(BoardCanvas, harness.props) })));
  await flush();
  return harness;
}

// ---- 断言用的读取器 ----

/** 替身 ReactFlow 这一帧收到的 props：测试据此模拟画布回调、断言交给 React Flow 的契约。 */
function flowProps(): Partial<ReactFlowProps> {
  return xyflow.captured.props as Partial<ReactFlowProps>;
}

function canvasFlowNodes(): FlowNode[] {
  return flowProps().nodes ?? [];
}

function canvasFlowEdges(): FlowEdge[] {
  return flowProps().edges ?? [];
}

function flowNodeOf(id: string): FlowNode {
  const node = canvasFlowNodes().find((n) => n.id === id);
  if (!node) throw new Error(`React Flow 没有收到节点 ${id}`);
  return node;
}

function selectedOf(id: string): boolean {
  return flowNodeOf(id).selected === true;
}

/** 画布根（承载右键、拖放监听的那一层）。 */
function canvasRoot(): HTMLElement {
  const el = container.querySelector<HTMLElement>(".canvas");
  if (!el) throw new Error("找不到画布根 .canvas");
  return el;
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found;
}

function buttonByLabel(scope: ParentNode, label: string): HTMLButtonElement {
  const found = scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`找不到按钮：${label}`);
  return found;
}

function menuEl(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="menu"]');
}

function menuItemLabels(): string[] {
  return [...(menuEl()?.querySelectorAll('[role="menuitem"]') ?? [])].map((b) => (b.textContent ?? "").trim());
}

/** 按动作找菜单条目：文案取 core/contextMenu 算出的同一张表，测试不手抄中文。 */
function menuItemButton(expected: MenuItem[], action: BoardAction): HTMLButtonElement {
  const item = expected.find((i) => i.action === action);
  if (!item) throw new Error(`菜单里没有 ${action}`);
  return buttonByText(menuEl()!, item.label);
}

/** 菜单条目的置灰态（aria-disabled）：与 menuItemLabels 一一对应。 */
function menuItemDisabledStates(): boolean[] {
  return [...(menuEl()?.querySelectorAll('[role="menuitem"]') ?? [])].map((b) => b.getAttribute("aria-disabled") === "true");
}

/** 悬浮到某个元素上（禁用按钮也收得到指针事件），等悬浮浮层弹出来；返回浮层文本。 */
async function hoverInfoText(el: Element, point = { x: 30, y: 40 }): Promise<string | null> {
  const event = new Event("pointermove", { bubbles: true });
  Object.defineProperty(event, "clientX", { value: point.x });
  Object.defineProperty(event, "clientY", { value: point.y });
  // 按着键移动不弹悬浮（见 hoverInfo 的 useHover）。
  Object.defineProperty(event, "buttons", { value: 0 });
  await act(async () => {
    el.dispatchEvent(event);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, HOVER_DELAY_MS + 50));
  });
  return container.querySelector('[role="tooltip"]')?.textContent ?? null;
}

function appliedChanges(apply: Harness["apply"]): BoardChange[] {
  return apply.mock.calls.map(([change]) => change);
}

/** 画板编辑类变更：排除每次渲染都会发的系统变更 syncAutoRatios。 */
function editChanges(apply: Harness["apply"]): BoardChange[] {
  return appliedChanges(apply).filter((c) => c.kind !== "syncAutoRatios");
}

/** 菜单条目文案的唯一来源是 core/contextMenu：测试用同一函数算期望，不手抄文案。 */
function menuFactsOf(board: Board, patch: Partial<MenuFacts> = {}): MenuFacts {
  return { board, table: BUILTIN_TABLE, selected: new Set<string>(), locked: new Set<string>(), expanded: new Set<string>(), undoLabel: null, redoLabel: null, ...patch };
}

// ---- 交互帮手 ----

/** 像用户按键一样派发 keydown（冒泡到 window 上的画布监听）；返回事件本体，便于断言是否被拦。 */
async function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

/** 模拟用户在画布上移动光标：粘贴图片的落点跟着最后一次 pointermove。 */
async function pointerMove(x: number, y: number): Promise<void> {
  const event = new Event("pointermove", { bubbles: true });
  Object.defineProperty(event, "clientX", { value: x });
  Object.defineProperty(event, "clientY", { value: y });
  await act(async () => {
    canvasRoot().dispatchEvent(event);
  });
}

/** 原生剪贴板替身的输入；paste 事件只负责触发，文本同时供输入框默认粘贴判断。 */
interface ClipboardStub {
  /** 纯文本（`getData("text/plain")` 的返回值），缺省空串。 */
  text?: string;
  /** 剪贴板里的文件。 */
  files?: File[];
}

/** jsdom 没有 ClipboardEvent / DataTransfer：用普通 Event 挂上 paste 处理器读的字段。返回事件本体。 */
async function paste(clipboard: ClipboardStub = {}, target: EventTarget = document.body): Promise<Event> {
  const files = clipboard.files ?? [];
  const text = clipboard.text ?? null;
  const images = files.filter(file => file.type.startsWith("image/") && file.size > 0);
  const tooLarge = images.some(file => file.size > MAX_PASTE_BYTES);
  nativeClipboard = {
    kind: isNodeMarker(text) ? "mark" : tooLarge ? "unsupported" : images.length ? "images" : files.length ? "unsupported" : text ? "text" : "empty",
    text,
    images: tooLarge ? [] : images,
    reason: tooLarge ? "tooLarge" : files.length && !images.length ? "files" : null,
    readFailureCount: files.length - images.length,
  };
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? (clipboard.text ?? "") : ""),
      // 图片只从原生端口快照读取，事件不提供图片回退。
      files: [],
    },
  });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  await flush();
  return event;
}

/** 模拟 React Flow 报来一次选中（等价于用户在画布上点选 / 框选）。 */
async function selectNodes(ids: string[]): Promise<void> {
  await act(async () => {
    flowProps().onNodesChange!(ids.map((id) => ({ type: "select" as const, id, selected: true })));
  });
}

/** 模拟 React Flow 报来节点悬浮。 */
async function hoverNode(id: string): Promise<void> {
  await act(async () => {
    flowProps().onNodeMouseEnter!({} as ReactMouseEvent, flowNodeOf(id));
  });
}

/** 右键事件替身：openMenu 只读 clientX / clientY 与 preventDefault。 */
function contextMenuEvent(x: number, y: number): ReactMouseEvent {
  return { clientX: x, clientY: y, preventDefault: () => undefined } as unknown as ReactMouseEvent;
}

async function openPaneMenu(x: number, y: number): Promise<void> {
  await act(async () => {
    flowProps().onPaneContextMenu!(contextMenuEvent(x, y));
  });
}

async function openNodeMenu(id: string, x: number, y: number): Promise<void> {
  await act(async () => {
    flowProps().onNodeContextMenu!(contextMenuEvent(x, y), flowNodeOf(id));
  });
}

async function openEdgeMenu(index: number, x: number, y: number): Promise<void> {
  await act(async () => {
    flowProps().onEdgeContextMenu!(contextMenuEvent(x, y), canvasFlowEdges()[index]);
  });
}

/** 真实 DOM drop：jsdom 没有 DataTransfer，补上 useCanvasDrop 读取的字段。 */
function dropFiles(target: HTMLElement, files: File[], point = { x: 30, y: 40 }): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: point.x },
    clientY: { value: point.y },
    dataTransfer: { value: { types: ["Files"], files } },
  });
  target.dispatchEvent(event);
  return event;
}

// ---- 用例 ----

describe("工具栏（portal 进 toolbarSlot）", () => {
  it("工具栏渲染在 toolbarSlot 里，点「＋ 提示词」在视口中央新建", async () => {
    const { apply } = await renderCanvas({ toolbarSlot: slot });
    expect(slot.querySelector('[role="toolbar"][aria-label="画板工具栏"]')).not.toBeNull();
    // portal：渲染在槽里，不在画布根的子树里。
    expect(container.querySelector('[aria-label="画板工具栏"]')).toBeNull();
    expect(slot.querySelector('select[aria-label="新建任务模型"]')).not.toBeNull();
    // 文案在生产侧 BoardToolbar / PreviewDialog（本票未改动的既有组件），这里手抄同源字面量。
    await act(async () => buttonByText(slot, "＋ 提示词").click());
    // jsdom 里画布 rect 全 0，视口中央 = (-120, -80)（节点半尺寸），坐标取整。
    expect(apply).toHaveBeenCalledWith({ kind: "newPrompt", at: [-120, -80] });
    // 文案在生产侧 BoardToolbar / PreviewDialog（本票未改动的既有组件），这里手抄同源字面量。
    await act(async () => buttonByText(slot, "＋ 生成任务").click());
    expect(apply).toHaveBeenCalledWith({ kind: "newTask", at: [-120, -80], promptId: null });
  });

  it("没有槽位时不出工具栏", async () => {
    await renderCanvas();
    expect(container.querySelector('[aria-label="画板工具栏"]')).toBeNull();
    expect(slot.childElementCount).toBe(0);
  });

  it("撤销 / 重做 / 运行 / 整理按钮接上回调", async () => {
    const harness = await renderCanvas({ toolbarSlot: slot, undoLabel: "移动 2 个节点", redoLabel: "新建提示词" });
    await act(async () => buttonByLabel(slot, "撤销").click());
    expect(harness.onUndo).toHaveBeenCalledTimes(1);
    await act(async () => buttonByLabel(slot, "重做").click());
    expect(harness.onRedo).toHaveBeenCalledTimes(1);
    await selectNodes(["p1", "r1"]);
    // 文案在生产侧 BoardToolbar / PreviewDialog（本票未改动的既有组件），这里手抄同源字面量。
    await act(async () => buttonByText(slot, "▶ 运行选中").click());
    expect(harness.onRun).toHaveBeenCalledWith(["p1", "r1"]);
    await act(async () => buttonByText(slot, TIDY_TEXT.enter).click());
    expect(harness.onTidyChange).toHaveBeenCalledWith(true);
  });

  it("「＋ 参考图…」选好文件后上传并落成参考图", async () => {
    const { apply } = await renderCanvas({ toolbarSlot: slot });
    const file = new File(["x"], "ref.png", { type: "image/png" });
    vi.mocked(port.media.pickImages).mockResolvedValueOnce([file]);
    // 文案在生产侧 BoardToolbar / PreviewDialog（本票未改动的既有组件），这里手抄同源字面量。
    await act(async () => buttonByText(slot, "＋ 参考图…").click());
    await flush();
    expect(port.media.pickImages).toHaveBeenCalledWith(true);
    expect(port.media.uploadReference).toHaveBeenCalledWith(file);
    expect(apply).toHaveBeenCalledWith({
      kind: "addReferences",
      images: [{ path: "reference/ref.png", sha256: SHA_A, display_name: "ref.png", width: 240, height: 160, bytes: IMAGE_INFO.bytes }],
      at: [-120, -80],
      attach: null,
    });
  });
});

describe("上下文菜单", () => {
  it("空白处右键出菜单，点「新建生成任务」按点击处建任务并关掉菜单", async () => {
    const { apply } = await renderCanvas();
    await openPaneMenu(30, 40);
    const expected = menuItems({ kind: "pane" }, menuFactsOf(sampleBoard()));
    expect(menuItemLabels()).toEqual(expected.map((i) => i.label));
    // 菜单开着时 Delete 键不交给 React Flow（否则删的是背后画板的节点）。
    expect(flowProps().deleteKeyCode).toBeNull();
    await act(async () => menuItemButton(expected, "newTask").click());
    expect(apply).toHaveBeenCalledWith({ kind: "newTask", at: [30, 40], promptId: null });
    expect(menuEl()).toBeNull();
  });

  it("Esc 与点菜单外面都关掉菜单", async () => {
    await renderCanvas();
    await openPaneMenu(10, 10);
    expect(menuEl()).not.toBeNull();
    await press("Escape");
    expect(menuEl()).toBeNull();
    await openPaneMenu(10, 10);
    expect(menuEl()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(menuEl()).toBeNull();
    // 开始拖动画布（视口移动）也关菜单。
    await openPaneMenu(10, 10);
    expect(menuEl()).not.toBeNull();
    await act(async () => {
      flowProps().onMoveStart!(null, { x: 0, y: 0, zoom: 1 });
    });
    expect(menuEl()).toBeNull();
  });

  it("节点右键菜单：另存为与删除接到对应动作，展开切任务参数", async () => {
    const harness = await renderCanvas();
    await openNodeMenu("r1", 20, 20);
    expect(selectedOf("r1")).toBe(true);
    const referenceMenu = menuItems({ kind: "node", nodeId: "r1" }, menuFactsOf(harness.props.board, { selected: new Set(["r1"]) }));
    expect(menuItemLabels()).toEqual(referenceMenu.map((i) => i.label));
    await act(async () => menuItemButton(referenceMenu, "saveAs").click());
    await flush();
    expect(saveCopyAs).toHaveBeenCalledWith("/~/reference/r1.png");
    expect(harness.toast).toHaveBeenCalledWith(SAVE_TEXT.started);

    await openNodeMenu("r1", 20, 20);
    await act(async () => buttonByText(menuEl()!, "删除").click());
    expect(xyflow.flow.deleteElements).toHaveBeenCalledWith({ nodes: [{ id: "r1" }] });

    // 任务节点的参数默认跟随选中展开：右键（= 选中）之后菜单给的是「收起」。
    await openNodeMenu("t1", 20, 20);
    expect((flowNodeOf("t1").data as { expanded?: boolean }).expanded).toBe(true);
    // 任务节点的「收起 / 展开」条目由 core/contextMenu 按展开态给。
    const taskMenu = menuItems({ kind: "node", nodeId: "t1" }, menuFactsOf(harness.props.board, { selected: new Set(["t1"]), expanded: new Set(["t1"]) }));
    await act(async () => menuItemButton(taskMenu, "toggleSettings").click());
    expect((flowNodeOf("t1").data as { expanded?: boolean }).expanded).toBe(false);
  });

  it("锁定任务节点：菜单按 core/contextMenu 的置灰表置灰，原因经悬浮浮层显示", async () => {
    const harness = await renderCanvas({ locked: new Set(["t1"]) });
    await openNodeMenu("t1", 20, 20);
    // 期望表由 core/contextMenu 同一个函数算：锁定没接进菜单事实里的话，条目会全亮，这里立刻现形。
    const expected = menuItems({ kind: "node", nodeId: "t1" }, menuFactsOf(harness.props.board, { selected: new Set(["t1"]), locked: new Set(["t1"]), expanded: new Set(["t1"]) }));
    expect(menuItemLabels()).toEqual(expected.map((i) => i.label));
    expect(menuItemDisabledStates()).toEqual(expected.map((i) => i.disabledReason !== null));
    // 排队 / 执行中的任务：运行、重新生成、查看发送文本置灰，原因都是 TASK_BUSY。
    const busy = expected.filter((i) => i.disabledReason === TASK_BUSY).map((i) => i.action);
    expect(busy).toContain("run");
    expect(busy).toContain("viewSendText");
    // 删除不置灰：删运行中的任务走「先取消再删除」的确认，不是禁用。
    expect(expected.find((i) => i.action === "delete")?.disabledReason).toBeNull();
    // 置灰原因对用户可见：悬浮到「运行」上，浮层写的就是那个原因。
    const runItem = [...menuEl()!.querySelectorAll('[role="menuitem"]')].find((b) => (b.textContent ?? "").trim() === expected.find((i) => i.action === "run")!.label)!;
    expect(await hoverInfoText(runItem)).toBe(TASK_BUSY);
  });

  it("锁定任务的连线：断开置灰，原因来自 core/iterate 的锁定提示", async () => {
    const harness = await renderCanvas({ locked: new Set(["t1"]) });
    await selectNodes(["t1"]);
    await openEdgeMenu(1, 20, 20);
    const expected = menuItems({ kind: "edge", edge: harness.props.board.edges[1] }, menuFactsOf(harness.props.board, { locked: new Set(["t1"]) }));
    expect(menuItemLabels()).toEqual(expected.map((i) => i.label));
    expect(menuItemDisabledStates()).toEqual(expected.map((i) => i.disabledReason !== null));
    const disconnect = [...menuEl()!.querySelectorAll('[role="menuitem"]')].find((b) => (b.textContent ?? "").trim() === expected.find((i) => i.action === "disconnect")!.label)!;
    expect(await hoverInfoText(disconnect)).toBe(LOCKED_HINT);
  });

  it("空白处右键：无可撤销 / 可重做时两项置灰，原因对用户可见", async () => {
    await renderCanvas();
    await openPaneMenu(10, 10);
    const expected = menuItems({ kind: "pane" }, menuFactsOf(sampleBoard()));
    expect(menuItemLabels()).toEqual(expected.map((i) => i.label));
    expect(menuItemDisabledStates()).toEqual(expected.map((i) => i.disabledReason !== null));
    const undo = expected.find((i) => i.action === "undo")!;
    expect(undo.disabledReason).not.toBeNull();
    const undoButton = [...menuEl()!.querySelectorAll('[role="menuitem"]')].find((b) => (b.textContent ?? "").trim() === undo.label)!;
    expect(await hoverInfoText(undoButton)).toBe(undo.disabledReason);
  });

  it("多选右键：菜单按整组选区给条目", async () => {
    await renderCanvas();
    await selectNodes(["p1", "r1"]);
    await act(async () => {
      flowProps().onSelectionContextMenu!(contextMenuEvent(20, 20), [flowNodeOf("p1"), flowNodeOf("r1")]);
    });
    expect(menuItemLabels()).toEqual(menuItems({ kind: "node", nodeId: "p1" }, menuFactsOf(sampleBoard(), { selected: new Set(["p1", "r1"]) })).map((i) => i.label));
    expect(menuItemLabels()).toContain(countLabel("删除", 2));
  });

});

describe("键盘快捷键（接线）", () => {
  // 键盘判定与执行归 useBoardKeyboard（撤销 / 重做 / 复制的矩阵、⌘ 等效、输入区放行都在那里），
  // 这里只留「挂上了、且落到真实回调」的接线冒烟。
  it("Ctrl+Z 接到 onUndo、Ctrl+Y 接到 onRedo", async () => {
    const { onUndo, onRedo } = await renderCanvas();
    await press("z", { ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    await press("y", { ctrlKey: true });
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+C 把选区复制成节点标记（系统剪贴板里是标记文本）", async () => {
    const { apply } = await renderCanvas();
    await selectNodes(["p1", "r1"]);
    await press("c", { ctrlKey: true });
    await flush();
    expect(port.media.copyText).toHaveBeenCalledWith(nodeMarker(2));
    // 复制本身不写画板。
    expect(editChanges(apply)).toEqual([]);
  });

});

describe("页面级粘贴（#96：从系统剪贴板粘图片 / 节点）", () => {
  it("剪贴板里是图片：上传成参考图，落点是最后一次 pointermove 处的画布坐标", async () => {
    const { apply } = await renderCanvas();
    await pointerMove(50, 60);
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const event = await paste({ files: [file] });
    expect(event.defaultPrevented).toBe(true);
    expect(port.media.uploadReference).toHaveBeenCalledWith(file);
    expect(port.files.inspectImage).toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith({
      kind: "addReferences",
      images: [{ path: "reference/shot.png", sha256: SHA_A, display_name: expect.stringMatching(new RegExp(`^${PASTE_NAME_PREFIX}-`)), width: 240, height: 160, bytes: IMAGE_INFO.bytes }],
      at: [50, 60],
      attach: null,
    });
    // 显示名是「粘贴-年月日-时分[.扩展名]」（时间戳不抄进断言）。
    const added = appliedChanges(apply).flatMap((c) => (c.kind === "addReferences" ? c.images : []));
    expect(added[0]?.display_name.startsWith(`${PASTE_NAME_PREFIX}-`)).toBe(true);
  });

  it("从没在画布上移动过光标时，图片落在视口中央", async () => {
    const { apply } = await renderCanvas();
    const event = await paste({ files: [new File(["x"], "shot.png", { type: "image/png" })] });
    expect(event.defaultPrevented).toBe(true);
    // jsdom 里画布 rect 全 0，视口中央 = (-120, -80)。
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ kind: "addReferences", at: [-120, -80] }));
  });

  it("只读归档画板粘图片：只提示只读，不上传不写画板", async () => {
    const harness = await renderCanvas({ readOnly: true });
    const event = await paste({ files: [new File(["x"], "shot.png", { type: "image/png" })] });
    expect(event.defaultPrevented).toBe(true);
    expect(harness.toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(port.media.uploadReference).not.toHaveBeenCalled();
    expect(editChanges(harness.apply)).toEqual([]);
  });

  it("模态开着时粘贴放行给弹窗", async () => {
    const harness = await renderCanvas({ modalOpen: true });
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const event = await paste({ files: [file] });
    expect(event.defaultPrevented).toBe(false);
    expect(port.media.uploadReference).not.toHaveBeenCalled();
    expect(editChanges(harness.apply)).toEqual([]);
  });

  it("真实画布拖放：只读与非图片只提示，落在任务卡片上按 attach 接到该任务", async () => {
    const readOnly = await renderCanvas({ readOnly: true });
    readOnly.toast.mockClear();
    const blocked = dropFiles(canvasRoot(), [new File(["x"], "a.png", { type: "image/png" })]);
    expect(blocked.defaultPrevented).toBe(true);
    expect(readOnly.toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(port.media.uploadReference).not.toHaveBeenCalled();
    expect(editChanges(readOnly.apply)).toEqual([]);

    const writable = await renderCanvas();
    writable.toast.mockClear();
    dropFiles(canvasRoot(), [new File(["x"], "note.txt", { type: "text/plain" })]);
    expect(writable.toast).toHaveBeenCalledWith(IMPORT_TEXT.imageOnly);
    expect(port.media.uploadReference).not.toHaveBeenCalled();
    writable.toast.mockClear();
    // 真实 DOM 落点：jsdom 里节点由替身渲染成普通容器，给任务节点容器打上生产用的落点属性。
    const taskCard = document.createElement("div");
    taskCard.className = "react-flow__node";
    taskCard.setAttribute("data-id", "t1");
    canvasRoot().append(taskCard);
    elementAt.mockReturnValue(taskCard);
    dropFiles(canvasRoot(), [new File(["x"], "a.png", { type: "image/png" })]);
    await flush();
    expect(editChanges(writable.apply)).toEqual([
      expect.objectContaining({ kind: "addReferences", attach: { taskId: "t1", place: "left" } }),
    ]);
  });

});

describe("悬浮动作条与放大预览", () => {
  it("悬浮参考图出动作条，点「放大预览」打开弹窗", async () => {
    await renderCanvas();
    await hoverNode("r1");
    const bar = container.querySelector<HTMLElement>('[data-testid="node-toolbar"]');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("data-node-id")).toBe(JSON.stringify(["r1"]));
    const expected = actionBarItems("r1", menuFactsOf(sampleBoard())).map((i) => i.label);
    expect([...bar!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(expected);
    await act(async () => buttonByLabel(bar!, expected[0]).click());
    await flush();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // 参考图的弹窗标题是它的显示名。
    expect(dialog!.getAttribute("aria-label")).toBe("r1.png");
    // 弹窗开着：Delete 键不交给画布。
    expect(flowProps().deleteKeyCode).toBeNull();
    // 文案在生产侧 BoardToolbar / PreviewDialog（本票未改动的既有组件），这里手抄同源字面量。
    await act(async () => buttonByText(dialog!, "关闭").click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("指针停在动作条上时动作条不收起", async () => {
    // 宽限期本身（150ms 定时器）由 useCanvasHover 拥有；这里只证明组件把 onPointerEnter 接到了
    // 「按住不收起」的那条路上：离开节点之后指针停在动作条上，动作条仍在。
    await renderCanvas();
    await hoverNode("r1");
    const toolbar = container.querySelector('[data-testid="node-toolbar"] [role="toolbar"]')!;
    expect(toolbar).not.toBeNull();
    await act(async () => {
      flowProps().onNodeMouseLeave!({} as ReactMouseEvent, flowNodeOf("r1"));
    });
    // React 的 onPointerEnter / onPointerLeave 由 pointerover / pointerout 推导。
    await act(async () => {
      toolbar.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="node-toolbar"]')).not.toBeNull();
  });

  it("连线悬浮出信息浮层，移出即收起", async () => {
    await renderCanvas();
    await selectNodes(["t1"]);
    const edge = canvasFlowEdges()[1];
    const hoverLines = edgeHoverInfo(sampleBoard().edges[1]);
    expect(hoverLines.length).toBeGreaterThan(0);
    await act(async () => {
      flowProps().onEdgeMouseMove!({ buttons: 0, clientX: 10, clientY: 20 } as unknown as ReactMouseEvent, edge);
    });
    // 停留约 400ms 才弹，扫过时不闪。
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, HOVER_DELAY_MS + 50));
    });
    const tip = container.querySelector('[role="tooltip"]');
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain(hoverLines[0].text);
    await act(async () => {
      flowProps().onEdgeMouseLeave!({} as ReactMouseEvent, edge);
    });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe("只读画板（归档）", () => {
  it("工具栏置灰、编辑类动作不写画板、粘贴只提示只读", async () => {
    const harness = await renderCanvas({ readOnly: true, toolbarSlot: slot });
    expect(buttonByText(slot, "＋ 提示词").getAttribute("aria-disabled")).toBe("true");
    expect(slot.querySelector<HTMLSelectElement>('select[aria-label="新建任务模型"]')!.disabled).toBe(true);
    expect(flowProps().nodesDraggable).toBe(false);
    expect(flowProps().nodesConnectable).toBe(false);
    // 画板不能改，Delete 键也不交给 React Flow。
    expect(flowProps().deleteKeyCode).toBeNull();
    // 只读经画板传给粘贴层（拖放的只读拒绝由上面的真实 DOM drop 用例拥有）。
    harness.toast.mockClear();
    const pasted = await paste({ files: [new File(["y"], "b.png", { type: "image/png" })] });
    expect(pasted.defaultPrevented).toBe(true);
    expect(harness.toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(port.media.uploadReference).not.toHaveBeenCalled();
    expect(editChanges(harness.apply)).toEqual([]);
    // 只读同样进到悬浮动作条：条目与右键菜单同源（core/archive 的 readOnlyMenu）。
    const expected = readOnlyMenu(menuItems({ kind: "node", nodeId: "r1" }, menuFactsOf(harness.props.board, { selected: new Set(["r1"]) })));
    await hoverNode("r1");
    const barButtons = container.querySelectorAll('[data-testid="node-toolbar"] button');
    expect([...barButtons].map((b) => b.getAttribute("aria-label"))).toEqual(expected.map((i) => i.label));
    // 右键节点：菜单只剩查看与下载（条目同样由 core/archive 的 readOnlyMenu 给）。
    await openNodeMenu("r1", 20, 20);
    expect(menuItemLabels()).toEqual(expected.map((i) => i.label));
    // 仍可放大预览。
    await act(async () => menuItemButton(expected, "preview").click());
    await flush();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("画布结构", () => {
  it("根类名与交给 React Flow 的关键 props", async () => {
    const { props } = await renderCanvas();
    expect(canvasRoot().className).toBe("canvas");
    const p = flowProps();
    expect(p.nodesDraggable).toBe(true);
    expect(p.nodesConnectable).toBe(true);
    expect(p.onlyRenderVisibleElements).toBe(true);
    expect(p.minZoom).toBe(0.1);
    expect(p.deleteKeyCode).toEqual(["Delete", "Backspace"]);
    // 画布导航、框选与缩放的关键取值（canvasFlowProps 的真实消费点就是这里）：
    // 右键/中键拖平移、空格临时平移、左键拖空白框选 + Shift 加选、滚轮/双指缩放、双击不缩放、
    // 方向键微移交给自己处理（关掉 React Flow 自带的键盘移动）。
    expect(p.panOnDrag).toEqual([1, 2]);
    expect(p.panActivationKeyCode).toBe("Space");
    expect(p.selectionOnDrag).toBe(true);
    expect(p.selectionMode).toBe("partial");
    expect(p.selectionKeyCode).toBeNull();
    expect(p.multiSelectionKeyCode).toBe("Shift");
    expect(p.zoomOnScroll).toBe(true);
    expect(p.zoomOnPinch).toBe(true);
    expect(p.zoomOnDoubleClick).toBe(false);
    expect(p.disableKeyboardA11y).toBe(true);
    expect(p.defaultViewport).toEqual(props.board.viewport);
    expect(canvasFlowNodes().map((n) => n.id)).toEqual(["p1", "r1", "t1"]);
    expect(canvasFlowNodes().map((n) => [n.type, n.position.x, n.position.y])).toEqual([
      ["prompt", 40, 60],
      ["reference", 320, 60],
      ["task", 600, 60],
    ]);
    await selectNodes(["t1"]);
    expect(canvasFlowEdges().map((e) => e.id)).toEqual(["p1:positive->t1:positive", "r1:out->t1:image:0"]);
    for (const name of ["background", "controls", "minimap"]) {
      expect(container.querySelector(`[data-xyflow="${name}"]`)).not.toBeNull();
    }
  });

  it("有效主题交给 React Flow 色彩模式，点阵背景与迷你地图带 token 配置", async () => {
    await renderCanvas({ theme: "light" });
    expect(flowProps().colorMode).toBe("light");
    expect(xyflow.captured.plugin.background).toMatchObject({
      gap: 20,
      color: "var(--rf-dot)",
      bgColor: "var(--rf-background)",
    });
    expect(xyflow.captured.plugin.minimap).toMatchObject({
      pannable: true,
      zoomable: true,
      bgColor: "var(--rf-minimap-bg)",
      maskColor: "var(--rf-minimap-mask)",
      maskStrokeColor: "var(--rf-controls-border)",
      maskStrokeWidth: 1,
      nodeColor: "var(--rf-minimap-node)",
    });
    // 同一个画布换主题再渲染：色彩模式跟着有效主题走，背景 token 引用不变。
    await renderCanvas({ theme: "dark" });
    expect(flowProps().colorMode).toBe("dark");
    expect(xyflow.captured.plugin.background).toMatchObject({ bgColor: "var(--rf-background)" });
  });

  it("整理模式：根类名带 tidying、出整理条、可退出", async () => {
    const harness = await renderCanvas({ tidying: true, toolbarSlot: slot });
    // 两个标记用空格拼接的写法照原样保留（中间会多一个空格），按 classList 断言不含糊。
    expect([...canvasRoot().classList]).toEqual(["canvas", "tidying"]);
    const bar = container.querySelector<HTMLElement>('[role="status"][aria-label="整理模式"]');
    expect(bar).not.toBeNull();
    await act(async () => buttonByText(bar!, TIDY_TEXT.done).click());
    expect(harness.onTidyChange).toHaveBeenCalledWith(false);
  });

  it("带阶段数据的旧画板照常打开：没有阶段框，收起的阶段也不再隐藏成员", async () => {
    // 阶段特性已移除（#250）：文件里的 stages 不再画成框，collapsed 也不再让成员消失。
    const board = legacyBoard(sampleBoard(), { stages: [{ id: "s1", name: "第一批", nodes: ["p1", "r1"], collapsed: true }] });
    await renderCanvas({ board });
    expect(container.querySelector('[data-stage-id="s1"]')).toBeNull();
    expect(container.querySelector(".stage-frame")).toBeNull();
    expect(canvasFlowNodes().map((n) => n.id)).toEqual(["p1", "r1", "t1"]);
    expect(canvasFlowNodes().filter((n) => n.hidden)).toEqual([]);
  });

  it("跳转请求把视口居中到该节点并选中它", async () => {
    await renderCanvas({ focus: { nodeId: "r1", nonce: 1 } });
    expect(xyflow.flow.setCenter).toHaveBeenCalled();
    const [cx, cy] = vi.mocked(xyflow.flow.setCenter).mock.calls[0];
    // 参考图左上角 (320, 60) + 半尺寸 (100, 110)。
    expect([cx, cy]).toEqual([420, 170]);
    expect(selectedOf("r1")).toBe(true);
  });
});

describe("React Flow 回调接线", () => {
  it("提示词端口拖到空白处：新建任务并带上来源 promptId", async () => {
    const { apply } = await renderCanvas();
    elementAt.mockReturnValue(container.querySelector(".react-flow__pane"));
    await act(async () => {
      flowProps().onConnectEnd!(
        new MouseEvent("mouseup", { clientX: 70, clientY: 90 }),
        { isValid: false, fromHandle: { nodeId: "p1", id: "out", type: "source" } } as never,
      );
    });
    // 工具栏新建走 promptId 缺省为 null；拖线建任务则必须保留来源提示词。
    expect(apply).toHaveBeenCalledWith({ kind: "newTask", at: [70, 90], promptId: "p1" });
  });

  it("React Flow 的回调都接上了（逐类载荷由 canvasFlowHandlers 拥有）", async () => {
    const { apply } = await renderCanvas();
    // 只看编辑类变更：每次渲染都会发的 syncAutoRatios 不算。
    const edits = (): number => editChanges(apply).length;
    // 每种事件至少落地一次：证明 BoardCanvas 把 flowHandlers 的每个入口都接到了 <ReactFlow> 上。
    await act(async () => flowProps().onNodesChange!([{ type: "position", id: "p1", position: { x: 5, y: 6 } }]));
    expect(edits()).toBe(1);
    await act(async () => flowProps().onConnect!({ source: "p1", sourceHandle: "positive", target: "t1", targetHandle: "negative" }));
    await act(async () => flowProps().onMoveEnd!(null, { x: 10, y: 20, zoom: 0.5 }));
    await selectNodes(["t1"]);
    await act(async () => flowProps().onEdgesChange!([{ type: "select", id: "p1:positive->t1:positive", selected: true }]));
    expect(edits()).toBe(3);
    expect(canvasFlowEdges().find((e) => e.id === "p1:positive->t1:positive")?.selected).toBe(true);
    for (const name of ["onNodesChange", "onEdgesChange", "onConnect", "onConnectEnd", "onMoveEnd", "onBeforeDelete", "onDelete"] as const) {
      expect(typeof flowProps()[name]).toBe("function");
    }
  });

  it("删除：试算被拒时提示不删；锁定任务先确认取消再删", async () => {
    const rejected = await renderCanvas();
    rejected.check.mockReturnValueOnce({ board: rejected.props.board, step: null, hint: "任务正在排队 / 执行中，不能断开它的输入" });
    let allowed: unknown;
    await act(async () => {
      allowed = await flowProps().onBeforeDelete!({ nodes: [flowNodeOf("p1")], edges: [] });
    });
    expect(allowed).toBe(false);
    expect(rejected.toast).toHaveBeenCalledWith("任务正在排队 / 执行中，不能断开它的输入");

    const locked = await renderCanvas({ locked: new Set(["t1"]) });
    await act(async () => {
      allowed = await flowProps().onBeforeDelete!({ nodes: [flowNodeOf("t1")], edges: [] });
    });
    // 确认框的文案与按钮由 boardText 的 DELETE_TASK_TEXT 给（「先取消再删除」）。
    expect(port.ui.ask).toHaveBeenCalledWith(DELETE_TASK_TEXT.confirm(1), {
      title: DELETE_TASK_TEXT.title,
      kind: "warning",
      okLabel: DELETE_TASK_TEXT.ok,
      cancelLabel: DELETE_TASK_TEXT.cancel,
    });
    expect(locked.onCancelTask.mock.calls.map(([id]) => id)).toEqual(["t1"]);
    expect(allowed).toBeTruthy();
    await act(async () => flowProps().onDelete!({ nodes: [flowNodeOf("t1")], edges: [] }));
    expect(locked.apply).toHaveBeenCalledWith({ kind: "delete", nodes: ["t1"], edges: [], cancelled: ["t1"] });

    // 点「不删除」：不取消、不删。
    const declined = await renderCanvas({ locked: new Set(["t1"]) });
    vi.mocked(port.ui.ask).mockResolvedValueOnce(false);
    await act(async () => {
      allowed = await flowProps().onBeforeDelete!({ nodes: [flowNodeOf("t1")], edges: [] });
    });
    expect(allowed).toBe(false);
    expect(declined.onCancelTask).not.toHaveBeenCalled();
    expect(declined.apply).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "delete" }));
  });
});

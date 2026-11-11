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
import { newBoard, type Board, type BoardEdge, type BoardNode, type PortRef, type TaskNode } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { actionBarItems, menuItems, type BoardAction, type MenuFacts, type MenuItem } from "../core/contextMenu";
import type { BoardChange, EditResult } from "../core/edit";
import { countLabel } from "../core/history";
import { edgeHoverInfo } from "../core/hoverInfo";
import { LOCKED_HINT, PASTE_OFFSET, TASK_BUSY } from "../core/iterate";
import { MAX_PASTE_BYTES, nodeMarker, PASTE_NAME_PREFIX } from "../core/pageInput";
import type { BoardMeasure } from "../core/tidy";
import { browser, ipc, transfer } from "../shell/ipc";
import { copyTextToClipboard } from "../shell/clipboard";
import { saveCopyAs } from "../shell/saveFile";
import { BoardCanvas } from "./BoardCanvas";
import { ARCHIVE_TEXT, DELETE_TASK_TEXT, IMPORT_TEXT, PASTE_TEXT, SAVE_TEXT, STAGE_TEXT, TIDY_TEXT } from "./boardText";
import { writeClipboard } from "./canvasKeyboard";
import { HOVER_DELAY_MS } from "./hoverInfo";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- 替身 ----

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
/** 替身 inspectImage 回的图片信息：宽高用于图片节点的显示尺寸。 */
const IMAGE_INFO = { sha256: SHA_A, bytes: 12, width: 240, height: 160, format: "png", has_alpha: false };

/** @xyflow/react 替身里供测试读 / 改的部分：captured = ReactFlow 这一帧收到的 props。 */
const xyflow = vi.hoisted(() => {
  const captured: { props: Record<string, unknown> } = { props: {} };
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
  const box = (name: string) => (props: { children?: ReactNode }) => h("div", { "data-xyflow": name }, props.children);
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
vi.mock("../shell/ipc", () => ({
  ipc: {
    inspectImage: vi.fn(),
    measureBoard: vi.fn(),
    readFileBytes: vi.fn(),
    writeNewFile: vi.fn(),
    listDir: vi.fn(),
    isFile: vi.fn(),
    fileSha256: vi.fn(),
  },
  browser: { ask: vi.fn(), message: vi.fn(), onPackProgress: vi.fn(), openExternal: vi.fn(), version: vi.fn() },
  transfer: { pickLocalImages: vi.fn(), uploadReference: vi.fn(), downloadImage: vi.fn(), downloadBoardResults: vi.fn() },
  fileUrl: (path: string) => `/api/fs/file?path=${encodeURIComponent(path)}`,
  thumbUrl: (path: string) => `/api/fs/thumb?path=${encodeURIComponent(path)}`,
  userRoot: "/~",
}));

vi.mock("../shell/adapters", () => ({
  relocateFs: { listDir: vi.fn(), isFile: vi.fn(), sha256: vi.fn() },
  // 画板状态的读取在本次运行的测试里没有任务目录：一律读失败，画布按「没有结局记录」处理。
  taskFs: { readFile: vi.fn(async () => Promise.reject(new Error("测试里没有任务目录"))), writeNewFile: vi.fn() },
  openExternal: vi.fn(),
}));

vi.mock("../shell/log", () => ({ logEvent: vi.fn() }));
// 系统剪贴板写入是宿主能力（安全上下文 / 内网 HTTP 两套实现）：替身只记调用，回成功。
vi.mock("../shell/clipboard", () => ({ copyTextToClipboard: vi.fn(async () => undefined) }));
vi.mock("../shell/imageClipboard", () => ({ copyImageToClipboard: vi.fn(async () => null) }));
vi.mock("../shell/saveFile", () => ({ saveCopyAs: vi.fn(async () => undefined) }));

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

function resultNode(id: string, pos: [number, number]): BoardNode {
  return {
    id,
    type: "result",
    pos,
    size: [220, 300],
    extra: {},
    task_id: "t1",
    file: "result.png",
    path: "tasks/t1/result.png",
    layer_count: 0,
    record: { model: "qwen-image-3.0", prompt: "一只猫", negative_prompt: "", size_spec: SPEC_2K, submitted_at: "2026-01-01T00:00:00Z" },
  };
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

// ---- 渲染脚手架 ----

type Props = ComponentProps<typeof BoardCanvas>;

let container: HTMLDivElement;
let slot: HTMLDivElement;
let root: Root;
/** 落点判定（dropTargetAt）用 document.elementFromPoint：jsdom 没有实现，由测试喂。 */
let elementAt: Mock<() => Element | null>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.inspectImage).mockResolvedValue(IMAGE_INFO);
  vi.mocked(ipc.measureBoard).mockResolvedValue({ nodes: {}, dirs: {} } satisfies BoardMeasure);
  vi.mocked(browser.ask).mockResolvedValue(true);
  vi.mocked(transfer.pickLocalImages).mockResolvedValue([]);
  vi.mocked(transfer.uploadReference).mockImplementation(async (file: File) => ({ path: `reference/${file.name}`, sha256: SHA_B }));
  vi.mocked(copyTextToClipboard).mockResolvedValue(undefined);
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
    onMoveOutStage: vi.fn(async (_stageId: string) => ""),
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
  await act(async () => root.render(createElement(BoardCanvas, harness.props)));
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

/** 剪贴板替身：paste 事件的 clipboardData 由测试给（文本 + 文件）。 */
interface ClipboardStub {
  /** 纯文本（`getData("text/plain")` 的返回值），缺省空串。 */
  text?: string;
  /** 剪贴板里的文件。 */
  files?: File[];
}

/** jsdom 没有 ClipboardEvent / DataTransfer：用普通 Event 挂上 paste 处理器读的字段。返回事件本体。 */
async function paste(clipboard: ClipboardStub = {}, target: EventTarget = document.body): Promise<Event> {
  const files = clipboard.files ?? [];
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? (clipboard.text ?? "") : ""),
      files,
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    },
  });
  await act(async () => {
    target.dispatchEvent(event);
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

/** 文件拖放：jsdom 没有 DragEvent / DataTransfer，用普通 Event 挂上 drop 处理器读的字段。 */
async function dropFiles(target: HTMLElement, files: File[], point: { x: number; y: number }): Promise<void> {
  await act(async () => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files } });
    Object.defineProperty(event, "clientX", { value: point.x });
    Object.defineProperty(event, "clientY", { value: point.y });
    target.dispatchEvent(event);
  });
  await flush();
}

/** 落在某个任务卡片上的一点（elementFromPoint 的回值）：断言「拖到卡片上接到它的图片端口」。 */
function pointInsideTaskCard(nodeId: string): Element {
  const card = document.createElement("div");
  card.className = "react-flow__node";
  card.setAttribute("data-id", nodeId);
  const inner = document.createElement("span");
  card.append(inner);
  return inner;
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
    vi.mocked(transfer.pickLocalImages).mockResolvedValueOnce([file]);
    // 文案在生产侧 BoardToolbar / PreviewDialog（本票未改动的既有组件），这里手抄同源字面量。
    await act(async () => buttonByText(slot, "＋ 参考图…").click());
    await flush();
    expect(transfer.pickLocalImages).toHaveBeenCalledWith(true);
    expect(transfer.uploadReference).toHaveBeenCalledWith(file);
    expect(apply).toHaveBeenCalledWith({
      kind: "addReferences",
      images: [{ path: "reference/ref.png", sha256: SHA_A, display_name: "ref.png", width: 240, height: 160 }],
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

  it("「另存为…」触发下载并提示；下载失败也告诉用户", async () => {
    const board = sampleBoard();
    board.nodes = [...board.nodes, resultNode("x1", [900, 60])];
    const harness = await renderCanvas({ board });
    const resultMenu = menuItems({ kind: "node", nodeId: "x1" }, menuFactsOf(board, { selected: new Set(["x1"]) }));
    await openNodeMenu("x1", 20, 20);
    await act(async () => menuItemButton(resultMenu, "saveAs").click());
    await flush();
    // 结果节点的绝对路径来自用户数据根 + 节点路径；带图层时服务端打 zip，提示同一句。
    expect(saveCopyAs).toHaveBeenCalledWith("/~/tasks/t1/result.png");
    expect(harness.toast).toHaveBeenCalledWith(SAVE_TEXT.started);

    vi.mocked(saveCopyAs).mockRejectedValueOnce(new Error("磁盘满了"));
    harness.toast.mockClear();
    await openNodeMenu("x1", 20, 20);
    await act(async () => menuItemButton(resultMenu, "saveAs").click());
    await flush();
    expect(harness.toast).toHaveBeenCalledWith(SAVE_TEXT.failed("磁盘满了"));
  });

  it("连线右键菜单：断开走 React Flow 删除流程", async () => {
    const board = sampleBoard();
    await renderCanvas();
    await openEdgeMenu(0, 20, 20);
    await act(async () => menuItemButton(menuItems({ kind: "edge", edge: board.edges[0] }, menuFactsOf(board)), "disconnect").click());
    expect(xyflow.flow.deleteElements).toHaveBeenCalledWith({ edges: [{ id: "p1:positive->t1:positive" }] });
  });
});

describe("键盘快捷键", () => {
  it("Ctrl+Z 撤销，Ctrl+Y 与 Ctrl+Shift+Z 重做", async () => {
    const { onUndo, onRedo } = await renderCanvas();
    await press("z", { ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    await press("y", { ctrlKey: true });
    expect(onRedo).toHaveBeenCalledTimes(1);
    await press("z", { ctrlKey: true, shiftKey: true });
    expect(onRedo).toHaveBeenCalledTimes(2);
    // ⌘ 同效（Mac）。
    await press("z", { metaKey: true });
    expect(onUndo).toHaveBeenCalledTimes(2);
  });

  it("Ctrl+C 复制选中节点：写应用内剪贴板与系统剪贴板标记，并吞掉默认行为", async () => {
    const { apply } = await renderCanvas();
    await selectNodes(["p1", "r1"]);
    const event = await press("c", { ctrlKey: true });
    await flush();
    // 只有真复制到节点才拦默认行为（系统剪贴板里那段文本就是复制的产物）。
    expect(event.defaultPrevented).toBe(true);
    expect(copyTextToClipboard).toHaveBeenCalledWith(nodeMarker(2));
    // 复制本身不写画板。
    expect(editChanges(apply)).toEqual([]);
  });

  it("Ctrl+C 空选区：不写剪贴板、不拦默认行为", async () => {
    await renderCanvas();
    const event = await press("c", { ctrlKey: true });
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(copyTextToClipboard).not.toHaveBeenCalled();
  });

  it("系统剪贴板写不进去时提示可以用 Ctrl+J 原地复制", async () => {
    const { toast } = await renderCanvas();
    await selectNodes(["p1"]);
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error("浏览器拒绝了复制操作"));
    await press("c", { ctrlKey: true });
    await flush();
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.markerUnwritable);
  });

  it("Ctrl+V 不再由 keydown 管（粘贴走页面级 paste 事件）", async () => {
    const harness = await renderCanvas();
    await selectNodes(["p1"]);
    await press("c", { ctrlKey: true });
    const event = await press("v", { ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(appliedChanges(harness.apply).flatMap((c) => (c.kind === "paste" ? [c] : []))).toEqual([]);
  });

  it("焦点在输入框里时快捷键不作用于画板", async () => {
    const harness = await renderCanvas();
    await selectNodes(["p1"]);
    const input = document.createElement("input");
    document.body.append(input);
    try {
      input.focus();
      await press("z", { ctrlKey: true }, input);
      await press("y", { ctrlKey: true }, input);
      await press("c", { ctrlKey: true }, input);
      await press("v", { ctrlKey: true }, input);
      await press("ArrowRight", {}, input);
      const kinds = appliedChanges(harness.apply).map((c) => c.kind);
      expect(harness.onUndo).not.toHaveBeenCalled();
      expect(harness.onRedo).not.toHaveBeenCalled();
      expect(kinds).not.toContain("paste");
      expect(kinds).not.toContain("nudge");
      // Ctrl+C 也不能抢输入框里的复制。
      expect(copyTextToClipboard).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });
});

describe("页面级粘贴（#96：从系统剪贴板粘图片 / 节点）", () => {
  it("剪贴板里是图片：上传成参考图，落点是最后一次 pointermove 处的画布坐标", async () => {
    const { apply } = await renderCanvas();
    await pointerMove(50, 60);
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const event = await paste({ files: [file] });
    expect(event.defaultPrevented).toBe(true);
    expect(transfer.uploadReference).toHaveBeenCalledWith(file);
    expect(ipc.inspectImage).toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith({
      kind: "addReferences",
      images: [{ path: "reference/shot.png", sha256: SHA_A, display_name: expect.stringMatching(new RegExp(`^${PASTE_NAME_PREFIX}-`)), width: 240, height: 160 }],
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

  it("剪贴板里是节点标记：粘节点，连续粘两次第二次按 PASTE_OFFSET 错开", async () => {
    const { apply } = await renderCanvas();
    await selectNodes(["p1"]);
    // 先真复制一次：应用内剪贴板有内容，系统剪贴板里则是那段标记。
    await press("c", { ctrlKey: true });
    await flush();
    const first = await paste({ text: nodeMarker(1) });
    const second = await paste({ text: nodeMarker(1) });
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    const pastes = appliedChanges(apply).flatMap((c) => (c.kind === "paste" ? [c] : []));
    expect(pastes).toHaveLength(2);
    expect(pastes[0].clip.nodes.map((n) => n.id)).toEqual(["p1"]);
    const [x, y] = pastes[0].clip.nodes[0].pos;
    expect(pastes[1].clip.nodes[0].pos).toEqual([x + PASTE_OFFSET, y + PASTE_OFFSET]);
  });

  it("标记还在但应用内剪贴板已空：提示重新复制，不粘", async () => {
    const { apply, toast } = await renderCanvas();
    // 每条用例开始时应用内剪贴板都是空的（等价于刷新过页面、或标记来自另一个标签页）。
    const event = await paste({ text: nodeMarker(1) });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.staleNodeClip);
    expect(appliedChanges(apply).flatMap((c) => (c.kind === "paste" ? [c] : []))).toEqual([]);
  });

  it("剪贴板里是文件本身（读不到内容）：提示拖进画板", async () => {
    const { toast } = await renderCanvas();
    const event = await paste({ files: [new File([], "report.bin", { type: "" })] });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(transfer.uploadReference).not.toHaveBeenCalled();
  });

  it("只读归档画板粘图片：只提示只读，不上传不写画板", async () => {
    const harness = await renderCanvas({ readOnly: true });
    const event = await paste({ files: [new File(["x"], "shot.png", { type: "image/png" })] });
    expect(event.defaultPrevented).toBe(true);
    expect(harness.toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(transfer.uploadReference).not.toHaveBeenCalled();
    expect(editChanges(harness.apply)).toEqual([]);
  });

  it("超过单张上限的图片：提示先压缩，不上传", async () => {
    const { toast } = await renderCanvas();
    const big = new File(["x"], "big.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: MAX_PASTE_BYTES + 1 });
    const event = await paste({ files: [big] });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.tooLarge);
    expect(transfer.uploadReference).not.toHaveBeenCalled();
  });

  it("模态开着时粘贴放行给弹窗", async () => {
    const harness = await renderCanvas({ modalOpen: true });
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const event = await paste({ files: [file] });
    expect(event.defaultPrevented).toBe(false);
    expect(transfer.uploadReference).not.toHaveBeenCalled();
    expect(editChanges(harness.apply)).toEqual([]);
  });

  it("焦点在输入框里粘纯文本：放行给输入框", async () => {
    const harness = await renderCanvas();
    const input = document.createElement("input");
    document.body.append(input);
    try {
      input.focus();
      const event = await paste({ text: "一段文字" }, input);
      expect(event.defaultPrevented).toBe(false);
      expect(transfer.uploadReference).not.toHaveBeenCalled();
      expect(editChanges(harness.apply)).toEqual([]);
    } finally {
      input.remove();
    }
  });
});

describe("选区与微移", () => {
  it("Esc 清空选区", async () => {
    await renderCanvas();
    await selectNodes(["p1"]);
    expect(selectedOf("p1")).toBe(true);
    await press("Escape");
    expect(selectedOf("p1")).toBe(false);
  });

  it("选中节点后方向键微移（1px，Shift 10px）", async () => {
    const { apply } = await renderCanvas();
    await selectNodes(["p1"]);
    await press("ArrowRight");
    expect(apply).toHaveBeenCalledWith({ kind: "nudge", ids: ["p1"], delta: [1, 0] });
    await press("ArrowDown", { shiftKey: true });
    expect(apply).toHaveBeenCalledWith({ kind: "nudge", ids: ["p1"], delta: [0, 10] });
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

  it("从节点移到动作条上时动作条不收起，移出后过宽限期才收起", async () => {
    await renderCanvas();
    await hoverNode("r1");
    const bar = container.querySelector('[data-testid="node-toolbar"]');
    expect(bar).not.toBeNull();
    const toolbar = bar!.querySelector('[role="toolbar"]')!;
    await act(async () => {
      flowProps().onNodeMouseLeave!({} as ReactMouseEvent, flowNodeOf("r1"));
    });
    // React 的 onPointerEnter / onPointerLeave 由 pointerover / pointerout 推导。
    await act(async () => {
      toolbar.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(container.querySelector('[data-testid="node-toolbar"]')).not.toBeNull();
    await act(async () => {
      toolbar.dispatchEvent(new Event("pointerout", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(container.querySelector('[data-testid="node-toolbar"]')).toBeNull();
  });

  it("连线悬浮出信息浮层，移出即收起", async () => {
    await renderCanvas();
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

  it("任务节点上悬浮不出动作条（只有图片节点有）", async () => {
    await renderCanvas();
    await hoverNode("t1");
    expect(container.querySelector('[data-testid="node-toolbar"]')).toBeNull();
    await hoverNode("r1");
    expect(container.querySelector('[data-testid="node-toolbar"]')).not.toBeNull();
  });
});

describe("HTML5 拖放", () => {
  it("拖入图片：上传后落成参考图；落在任务卡片上时接到该任务", async () => {
    const { apply } = await renderCanvas();
    const file = new File(["x"], "cat.png", { type: "image/png" });
    await dropFiles(canvasRoot(), [file], { x: 10, y: 20 });
    expect(transfer.uploadReference).toHaveBeenCalledWith(file);
    expect(apply).toHaveBeenCalledWith({
      kind: "addReferences",
      images: [{ path: "reference/cat.png", sha256: SHA_A, display_name: "cat.png", width: 240, height: 160 }],
      at: [10, 20],
      attach: null,
    });
    // 拖到任务卡片上：接到该任务的空图片端口（放在左侧）。
    apply.mockClear();
    elementAt.mockReturnValue(pointInsideTaskCard("t1"));
    const second = new File(["y"], "dog.jpeg", { type: "image/jpeg" });
    await dropFiles(canvasRoot(), [second], { x: 30, y: 40 });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ kind: "addReferences", attach: { taskId: "t1", place: "left" } }));
  });

  it("拖入非图片文件只提示，不上传", async () => {
    const { apply, toast } = await renderCanvas();
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    await dropFiles(canvasRoot(), [file], { x: 10, y: 20 });
    expect(toast).toHaveBeenCalledWith(IMPORT_TEXT.imageOnly);
    expect(transfer.uploadReference).not.toHaveBeenCalled();
    expect(editChanges(apply)).toEqual([]);
  });
});

describe("只读画板（归档）", () => {
  it("工具栏置灰、编辑类动作不写画板、拖入图片与粘贴只提示只读", async () => {
    const harness = await renderCanvas({ readOnly: true, toolbarSlot: slot });
    expect(buttonByText(slot, "＋ 提示词").getAttribute("aria-disabled")).toBe("true");
    expect(slot.querySelector<HTMLSelectElement>('select[aria-label="新建任务模型"]')!.disabled).toBe(true);
    expect(flowProps().nodesDraggable).toBe(false);
    expect(flowProps().nodesConnectable).toBe(false);
    // 画板不能改，Delete 键也不交给 React Flow。
    expect(flowProps().deleteKeyCode).toBeNull();
    // 右键节点：菜单只剩查看与下载（条目由 core/archive 的 readOnlyMenu 给）。
    await openNodeMenu("r1", 20, 20);
    const expected = readOnlyMenu(menuItems({ kind: "node", nodeId: "r1" }, menuFactsOf(harness.props.board, { selected: new Set(["r1"]) })));
    expect(menuItemLabels()).toEqual(expected.map((i) => i.label));
    // 仍可放大预览。
    await act(async () => menuItemButton(expected, "preview").click());
    await flush();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    // 拖入图片：不上传、不写画板，只提示只读。
    harness.toast.mockClear();
    await dropFiles(canvasRoot(), [new File(["x"], "a.png", { type: "image/png" })], { x: 1, y: 2 });
    expect(harness.toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(transfer.uploadReference).not.toHaveBeenCalled();
    // 粘贴同样被挡下（应用内剪贴板里的内容不落盘）。
    await selectNodes(["r1"]);
    await press("c", { ctrlKey: true });
    await press("v", { ctrlKey: true });
    expect(harness.toast.mock.calls.map(([m]) => m)).toContain(ARCHIVE_TEXT.readOnly);
    expect(editChanges(harness.apply)).toEqual([]);
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
    expect(p.defaultViewport).toEqual(props.board.viewport);
    expect(canvasFlowNodes().map((n) => n.id)).toEqual(["p1", "r1", "t1"]);
    expect(canvasFlowNodes().map((n) => [n.type, n.position.x, n.position.y])).toEqual([
      ["prompt", 40, 60],
      ["reference", 320, 60],
      ["task", 600, 60],
    ]);
    expect(canvasFlowEdges().map((e) => e.id)).toEqual(["p1:positive->t1:positive", "r1:out->t1:image:0"]);
    for (const name of ["background", "controls", "minimap"]) {
      expect(container.querySelector(`[data-xyflow="${name}"]`)).not.toBeNull();
    }
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

  it("拖线中根类名带 connecting，连线按起点端口着色", async () => {
    xyflow.connection.current = { inProgress: true, fromHandle: { nodeId: "r1", id: "out", type: "source" } };
    await renderCanvas();
    expect(canvasRoot().className).toBe("canvas connecting");
    expect(flowProps().connectionLineStyle).toEqual({ stroke: "var(--port-image)" });
  });

  it("画布内屏蔽原生右键菜单，输入控件上保留", async () => {
    await renderCanvas();
    const onCanvas = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => canvasRoot().dispatchEvent(onCanvas));
    expect(onCanvas.defaultPrevented).toBe(true);
    // 输入框里的右键留给原生菜单（复制粘贴）。
    const input = document.createElement("input");
    canvasRoot().append(input);
    const onInput = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(onInput));
    expect(onInput.defaultPrevented).toBe(false);
  });

  it("阶段框上的动作走画板写入", async () => {
    const board = sampleBoard();
    board.stages = [{ id: "s1", name: "第一批", nodes: ["p1", "r1"], collapsed: false, extra: {} }];
    const { apply } = await renderCanvas({ board });
    const frame = container.querySelector<HTMLElement>('[data-stage-id="s1"]');
    expect(frame).not.toBeNull();
    await act(async () => buttonByText(frame!, STAGE_TEXT.collapse).click());
    expect(apply).toHaveBeenCalledWith({ kind: "setStageCollapsed", stageId: "s1", collapsed: true });
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
  it("选中 / 移动 / 测量 / 连线 / 视口都走画板写入", async () => {
    const { apply } = await renderCanvas();
    await act(async () => flowProps().onNodesChange!([{ type: "position", id: "p1", position: { x: 5, y: 6 } }]));
    expect(apply).toHaveBeenCalledWith({ kind: "move", moves: [["p1", [5, 6]]], drag: null });
    await act(async () => flowProps().onNodesChange!([{ type: "dimensions", id: "p1", dimensions: { width: 240, height: 140 } }]));
    await flush();
    expect(flowNodeOf("p1").measured).toEqual({ width: 240, height: 140 });
    await act(async () => flowProps().onConnect!({ source: "p1", sourceHandle: "positive", target: "t1", targetHandle: "negative" }));
    expect(apply).toHaveBeenCalledWith({ kind: "connect", connection: { source: "p1", sourceHandle: "positive", target: "t1", targetHandle: "negative" } });
    await act(async () => flowProps().onMoveEnd!(null, { x: 10, y: 20, zoom: 0.5 }));
    expect(apply).toHaveBeenCalledWith({ kind: "viewport", viewport: { x: 10, y: 20, zoom: 0.5 } });
    await act(async () => flowProps().onEdgesChange!([{ type: "select", id: "p1:positive->t1:positive", selected: true }]));
    expect(canvasFlowEdges().find((e) => e.id === "p1:positive->t1:positive")?.selected).toBe(true);
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
    expect(browser.ask).toHaveBeenCalledWith(DELETE_TASK_TEXT.confirm(1), {
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
    vi.mocked(browser.ask).mockResolvedValueOnce(false);
    await act(async () => {
      allowed = await flowProps().onBeforeDelete!({ nodes: [flowNodeOf("t1")], edges: [] });
    });
    expect(allowed).toBe(false);
    expect(declined.onCancelTask).not.toHaveBeenCalled();
    expect(declined.apply).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "delete" }));
  });
});

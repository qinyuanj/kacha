// @vitest-environment jsdom
// useCanvasData 的接线：画板上的图片引用（含结果图层）、读到的图片信息与透明通道、读不到的图片、
// 运行 / 任务状态，以及自动宽高比补算的触发时机。壳层（ipc / adapters）用替身：真实现要发 HTTP。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newBoard, type Board, type BoardNode, type ReferenceNode, type ResultNode, type TaskNode } from "../core/board";
import type { CapabilityTable } from "../core/capabilities";
import type { BoardChange, EditResult } from "../core/edit";
import type { NodeRunState } from "../core/runner";
import { OUTCOME_FILE, taskFilePath } from "../core/taskDir";
import type { ImageInfo } from "../shell/ipc";
import { useCanvasData, type CanvasData } from "./useCanvasData";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 壳层替身：图片探测、任务目录读取与日志（vi.mock 先于 import 执行，替身用 vi.hoisted 提前造好）。
const shell = vi.hoisted(() => ({
  inspectImage: vi.fn(),
  readFile: vi.fn(),
  logEvent: vi.fn(async () => undefined),
}));

vi.mock("../shell/ipc", () => ({
  ipc: { inspectImage: shell.inspectImage, logEvent: shell.logEvent },
  // 导入面里画布用得上的地址拼装函数一并替身，免得测试碰到真实现。
  fileUrl: (path: string) => `file:${path}`,
  thumbUrl: (path: string) => `thumb:${path}`,
}));

vi.mock("../shell/adapters", () => ({
  taskFs: { readFile: shell.readFile, writeNewFile: vi.fn(async () => undefined) },
}));

// ---- 画板与渲染脚手架 ----

const USER_ROOT = "/~";
const TABLE: CapabilityTable = { format_version: 1, models: [] };
const EMPTY: ReadonlySet<string> = new Set();
const BOARD_FILE = "/~/画板/测试.ugcboard.json";

/** 每次取新路径 / 新任务编号：context 里的图片信息与文件读取在模块级按路径缓存，跨用例不能撞。 */
let seq = 0;
const freshName = (label: string): string => `${label}-${++seq}`;
const freshTaskId = (): string => `20260101T000000Z-${(0xa0000000 + ++seq).toString(16)}`;

const promptNode = (id: string): BoardNode => ({ type: "prompt", id, pos: [0, 0], size: [100, 100], text: id, extra: {} });

const refNode = (id: string, path: string): ReferenceNode => ({ type: "reference", id, pos: [0, 0], size: [100, 100], path, sha256: "sha", display_name: `${id}.png`, extra: {} });

/** 结果节点：底图 + 记录里的各图层，图层路径相对任务目录（= 结果文件所在目录）。 */
const resultNode = (id: string, dir: string, layers: string[]): ResultNode => ({
  type: "result",
  id,
  pos: [0, 0],
  size: [100, 100],
  task_id: `task-${id}`,
  file: "out.png",
  path: `${dir}/out.png`,
  layer_count: layers.length,
  record: {
    model: "m",
    prompt: "",
    negative_prompt: "",
    size_spec: { tier: null, ratio: null, width: null, height: null },
    submitted_at: "",
    layers: layers.map((file, i) => ({ file, z_index: i, bounding_box: [0, 0, 1, 1] })),
  },
  extra: {},
});

/** 提交过的任务节点：last_submitted 里的任务编号是「已中断」候选的来源。 */
const taskNode = (id: string, taskId: string, lastSubmitted: TaskNode["last_submitted"] = { task_id: taskId }): TaskNode => ({
  type: "task",
  id,
  pos: [0, 0],
  size: [200, 120],
  model: "m",
  size_spec: { tier: null, ratio: null, width: null, height: null },
  image_ports: 0,
  layer_decomposition: false,
  transparent_background: false,
  last_submitted: lastSubmitted,
  extra: {},
});

const boardOf = (...nodes: BoardNode[]): Board => ({ ...newBoard("测试"), nodes });

interface ProbeProps {
  board: Board;
  boardFile: string;
  userRoot: string;
  table: CapabilityTable;
  locked: ReadonlySet<string>;
  handled: ReadonlySet<string>;
  runNodes: ReadonlyMap<string, NodeRunState>;
  applyChange: (change: BoardChange) => EditResult | null;
}

let container: HTMLDivElement;
let root: Root;
let data: CanvasData;
/** 交出去的画板变更（applyChange 的替身只记录，不落盘）。 */
let applied: BoardChange[];

const applyChange = (change: BoardChange): EditResult | null => {
  applied.push(change);
  return null;
};

function Probe(props: ProbeProps) {
  data = useCanvasData(props);
  return null;
}

/** 渲染一次并让异步读取（图片信息、结局记录）落地。 */
async function show(props: ProbeProps): Promise<void> {
  await act(async () => root.render(createElement(Probe, props)));
  await act(async () => {});
  await act(async () => {});
}

function propsOf(overrides: Partial<ProbeProps> = {}): ProbeProps {
  return { board: boardOf(), boardFile: BOARD_FILE, userRoot: USER_ROOT, table: TABLE, locked: EMPTY, handled: EMPTY, runNodes: new Map(), applyChange, ...overrides };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  applied = [];
  // 默认：图片读不到、结局记录不存在（404 与 ipc.readFileBytes 的错误形状一致：没有结局记录 ≠ 读故障）。
  shell.inspectImage.mockRejectedValue(new Error("读不到图片"));
  shell.readFile.mockImplementation(async () => {
    throw Object.assign(new Error("没有这个文件"), { status: 404 });
  });
  shell.logEvent.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("图片引用与图片信息", () => {
  it("按画板顺序列出参考图、结果底图与各图层的绝对路径", async () => {
    const refPath = `img/${freshName("a")}.png`;
    const dir = `2026-01-01/${freshName("res")}`;
    const infos = new Map<string, ImageInfo>([
      [`${USER_ROOT}/${refPath}`, { sha256: "s1", bytes: 1, width: 10, height: 10, format: "png", has_alpha: true }],
      [`${USER_ROOT}/${dir}/out.png`, { sha256: "s2", bytes: 2, width: 20, height: 20, format: "png", has_alpha: false }],
    ]);
    shell.inspectImage.mockImplementation(async (path: string) => {
      const info = infos.get(path);
      if (!info) throw new Error("读不到图层");
      return info;
    });

    await show(propsOf({ board: boardOf(promptNode("p1"), refNode("ref1", refPath), resultNode("res1", dir, ["layers/01.png"])) }));

    const abs = (rel: string) => `${USER_ROOT}/${rel}`;
    // 图片源集合本身不外露（只经 useImageInfos 的批量读取与下游派生体现），这里按读图顺序锁。
    const readOrder = [...new Set(shell.inspectImage.mock.calls.map(([path]) => path as string))];
    expect(readOrder).toEqual([abs(refPath), abs(`${dir}/out.png`), abs(`${dir}/layers/01.png`)]);
    expect(data.imageInfos.get(abs(refPath))).toEqual(infos.get(abs(refPath)));
    // 读取失败记 null，不记「没有图片」。
    expect(data.imageInfos.get(abs(`${dir}/layers/01.png`))).toBeNull();
  });

  it("透明通道只收读到的图片：无透明通道也有值，读不到的节点不进 Map", async () => {
    const refPath = `img/${freshName("b")}.png`;
    const dir = `2026-01-01/${freshName("res")}`;
    shell.inspectImage.mockImplementation(async (path: string) => {
      if (path === `${USER_ROOT}/${refPath}`) return { sha256: "s1", bytes: 1, width: 10, height: 10, format: "png", has_alpha: true };
      if (path === `${USER_ROOT}/${dir}/out.png`) return { sha256: "s2", bytes: 2, width: 20, height: 20, format: "png", has_alpha: false };
      throw new Error("读不到图层");
    });

    await show(propsOf({ board: boardOf(refNode("ref1", refPath), resultNode("res1", dir, ["layers/01.png"])) }));

    expect([...data.alphaByNode]).toEqual([
      ["ref1", true],
      ["res1", false],
    ]);
    // 读不到的图片按节点 / 图层分键进 missing，底图与图层互不株连。
    expect(data.missing).toEqual(new Set(["res1:layer:1"]));
  });

  it("没有图片的提示词节点不读图片信息，也不进 missing", async () => {
    await show(propsOf({ board: boardOf(promptNode("p1")) }));
    expect(shell.inspectImage).not.toHaveBeenCalled();
    expect(data.missing).toEqual(new Set());
    expect(data.alphaByNode.size).toBe(0);
    expect(data.missing.size).toBe(0);
  });
});

describe("运行 / 任务状态", () => {
  it("本次运行没经手过的按任务目录的结局记录推导，没有记录即已中断", async () => {
    const failedId = freshTaskId();
    const lostId = freshTaskId();
    const failedPath = taskFilePath(USER_ROOT, failedId, OUTCOME_FILE)!;
    shell.readFile.mockImplementation(async (path: string) => {
      if (path === failedPath) return new TextEncoder().encode(JSON.stringify({ outcome: "failed", label: "网关错误" }));
      throw Object.assign(new Error("没有这个文件"), { status: 404 });
    });

    await show(propsOf({ board: boardOf(taskNode("t1", failedId), taskNode("t2", lostId)) }));

    expect(data.statusOf("t1")).toEqual({ kind: "failed", label: "网关错误" });
    expect(data.statusOf("t2")).toEqual({ kind: "interrupted" });
    expect(data.runStateOf("t2")?.counts).toEqual({ interrupted: 1 });
    // 没有任何状态的节点不虚构。
    expect(data.runStateOf("不在画板上的节点")).toBeUndefined();
    expect(data.statusOf("不在画板上的节点")).toBeNull();
  });

  it("本次运行经手过的以运行器为准", async () => {
    const taskId = freshTaskId();
    const runner: NodeRunState = { copies: [{ taskId, status: { kind: "queued" } }], counts: { queued: 1 }, total: 1 };

    await show(propsOf({ board: boardOf(taskNode("t1", taskId)), runNodes: new Map([["t1", runner]]) }));

    expect(data.runStateOf("t1")).toBe(runner);
    // 任务目录里没有结局记录（推导为已中断），但本次运行正在排队：显示运行器的状态。
    expect(data.statusOf("t1")).toEqual({ kind: "queued" });
  });
});

describe("自动宽高比的补算时机", () => {
  it("装配时补算，图片信息读到之后再补算一次", async () => {
    const refPath = `img/${freshName("sync")}.png`;
    shell.inspectImage.mockResolvedValue({ sha256: "s", bytes: 1, width: 4, height: 4, format: "png", has_alpha: true });

    await show(propsOf({ board: boardOf(refNode("ref1", refPath)) }));

    expect(applied.every((change) => change.kind === "syncAutoRatios")).toBe(true);
    expect(applied).toHaveLength(2);
  });

  it("画板 / 锁定集 / 能力表 / 用户数据根变化时补算，画板文件变化不补算", async () => {
    let props = propsOf();
    await show(props);
    const mounted = applied.length;
    expect(mounted).toBeGreaterThan(0);

    // 同一份依赖重渲染：不重复补算。
    await show(props);
    expect(applied).toHaveLength(mounted);

    // 画板文件（改名 / 换标签页）不是依赖。
    props = { ...props, boardFile: "/~/画板/另一块.ugcboard.json" };
    await show(props);
    expect(applied).toHaveLength(mounted);

    props = { ...props, board: boardOf() };
    await show(props);
    expect(applied).toHaveLength(mounted + 1);
    expect(applied.at(-1)).toEqual({ kind: "syncAutoRatios" });

    props = { ...props, locked: new Set(["t1"]) };
    await show(props);
    expect(applied).toHaveLength(mounted + 2);

    props = { ...props, table: { ...TABLE, models: [] } };
    await show(props);
    expect(applied).toHaveLength(mounted + 3);

    props = { ...props, userRoot: "/~other" };
    await show(props);
    expect(applied).toHaveLength(mounted + 4);
  });
});

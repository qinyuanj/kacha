// 画布动作（BoardActions）的构造：迭代 / 草稿 / 聚焦 / 预览 / 区域编辑 / 变体 / 重新定位。
// 依赖全部用替身注入；transfer、ipc、日志与文件系统找文件用 vi.mock，日志断言调用参数逐字一致。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardEdge, BoardNode, ReferenceNode, ResultNode, TaskNode } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import type { BoardChange, EditResult } from "../core/edit";
import { LOCKED_HINT } from "../core/iterate";
import { findReferenceFile, findResultFile } from "../core/relocate";
import { ipc, transfer, type ImageInfo } from "../shell/ipc";
import { logEvent } from "../shell/log";
import { REGION_TEXT, RELOCATE_TEXT, VARIANT_TEXT } from "./boardText";
import { canvasBoardActions, type CanvasBoardActionsDeps } from "./canvasBoardActions";
import { nodePreviewRequest } from "./canvasPreview";

vi.mock("../core/relocate", () => ({ findResultFile: vi.fn(), findReferenceFile: vi.fn() }));
vi.mock("../shell/adapters", () => ({ relocateFs: { listDir: vi.fn(), isFile: vi.fn(), sha256: vi.fn() } }));
vi.mock("../shell/ipc", () => ({
  ipc: { inspectImage: vi.fn() },
  transfer: { pickLocalImages: vi.fn(), uploadReference: vi.fn() },
}));
vi.mock("../shell/log", () => ({ logEvent: vi.fn() }));

const SPEC = { tier: "1K", ratio: "1:1", width: null, height: null } as const;
const ROOT = "/~";
const BOARD_FILE = "画板/a.ugcboard.json";
const INFO: ImageInfo = { sha256: "b".repeat(64), bytes: 128, width: 10, height: 20, format: "png", has_alpha: false };

function board(nodes: BoardNode[], edges: BoardEdge[] = []): Board {
  return { format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

function reference(id: string, patch: Partial<ReferenceNode> = {}): ReferenceNode {
  return { id, type: "reference", pos: [0, 0], size: [200, 220], extra: {}, path: `refs/${id}.png`, sha256: "a".repeat(64), display_name: `${id}.png`, ...patch };
}

function result(id: string, patch: Partial<ResultNode> = {}): ResultNode {
  return {
    id,
    type: "result",
    pos: [0, 0],
    size: [220, 300],
    extra: {},
    task_id: `task-${id}`,
    file: `${id}.png`,
    path: `results/${id}/${id}.png`,
    layer_count: 0,
    record: { model: "qwen-image-3.0", prompt: "", negative_prompt: "", size_spec: { ...SPEC }, submitted_at: "" },
    ...patch,
  };
}

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return { id, type: "task", pos: [0, 0], size: [280, 260], extra: {}, model: "qwen-image-3.0", size_spec: { ...SPEC }, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null, ...patch };
}

function edge(from: [string, string], to: [string, string], patch: Partial<BoardEdge> = {}): BoardEdge {
  return { from, to, source_layer: null, region: null, system: false, extra: {}, ...patch };
}

/** 参考图扇出到一个图片任务（支持区域指示），结果节点带产出任务。 */
function canvasBoard(): Board {
  return board([reference("ref1"), task("t1"), result("res1"), reference("ref2")], [edge(["ref1", "out"], ["t1", "image:0"]), edge(["t1", "result"], ["res1", "in"], { system: true })]);
}

/** 已算好的一步变更结果（只用到 step / selection / board 三处）。 */
function editResult(b: Board, patch: Partial<EditResult> = {}): EditResult {
  return { board: b, step: { label: "新建提示词" } as unknown as EditResult["step"], ...patch };
}

/** 等异步的重新定位走完（全在微任务里，等一个宏任务即可）。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  deps: CanvasBoardActionsDeps;
  apply: ReturnType<typeof vi.fn>;
  showPreview: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  onRegenerate: ReturnType<typeof vi.fn>;
  primeImageInfo: ReturnType<typeof vi.fn>;
  requestPromptFocus: ReturnType<typeof vi.fn>;
  unhoverNode: ReturnType<typeof vi.fn>;
  setPromptDrafts: ReturnType<typeof vi.fn>;
  setExpandOverrides: ReturnType<typeof vi.fn>;
  performRef: { current: CanvasBoardActionsDeps["performRef"]["current"] };
  boardRef: { current: Board };
  selectedRef: { current: ReadonlySet<string> };
  lockedRef: { current: ReadonlySet<string> };
  focusPromptRef: { current: string | null };
}

function harness(patch: Partial<CanvasBoardActionsDeps> = {}): Harness {
  const refs = {
    boardRef: { current: canvasBoard() },
    selectedRef: { current: new Set(["ref1"]) as ReadonlySet<string> },
    lockedRef: { current: new Set<string>() as ReadonlySet<string> },
    focusPromptRef: { current: null as string | null },
    performRef: { current: vi.fn() },
  };
  const fns = {
    apply: vi.fn<(change: BoardChange) => EditResult | null>(() => null),
    showPreview: vi.fn(),
    toast: vi.fn(),
    onRegenerate: vi.fn(),
    primeImageInfo: vi.fn(),
    requestPromptFocus: vi.fn(),
    unhoverNode: vi.fn(),
    setPromptDrafts: vi.fn(),
    setExpandOverrides: vi.fn(),
  };
  const deps: CanvasBoardActionsDeps = {
    table: BUILTIN_TABLE,
    boardFile: BOARD_FILE,
    userRoot: ROOT,
    discovery: { source: "none" },
    concurrency: 2,
    apply: fns.apply,
    boardRef: refs.boardRef,
    selectedRef: refs.selectedRef,
    lockedRef: refs.lockedRef,
    focusPromptRef: refs.focusPromptRef,
    requestPromptFocus: fns.requestPromptFocus,
    setPromptDrafts: fns.setPromptDrafts,
    setExpandOverrides: fns.setExpandOverrides,
    unhoverNode: fns.unhoverNode,
    showPreview: fns.showPreview,
    primeImageInfo: fns.primeImageInfo,
    onRegenerate: fns.onRegenerate,
    toast: fns.toast,
    performRef: refs.performRef,
    ...patch,
  };
  return { deps, ...fns, ...refs };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("动作对象的字段", () => {
  it("画板事实直接透传：能力表、用户数据根、可用模型、并发上限", () => {
    const h = harness();
    const actions = canvasBoardActions(h.deps);
    expect(actions.table).toBe(BUILTIN_TABLE);
    expect(actions.userRoot).toBe(ROOT);
    expect(actions.concurrency).toBe(2);
    // discovery = none 且没失败：上架清单就是可用模型。
    expect(actions.availableModels.length).toBe(BUILTIN_TABLE.models.length);
  });

  it("perform 经 ref 转发最新一版（画布每次渲染重建新建类函数）", () => {
    const h = harness();
    const actions = canvasBoardActions(h.deps);
    actions.perform("newPrompt", { kind: "pane" }, { x: 1, y: 2 });
    expect(h.performRef.current).toHaveBeenCalledWith("newPrompt", { kind: "pane" }, { x: 1, y: 2 });
  });

  it("apply 只转发变更，不把试算结果交给调用方", () => {
    const h = harness();
    const actions = canvasBoardActions(h.deps);
    const change: BoardChange = { kind: "lastModel", model: "qwen-image-3.0" };
    expect(actions.apply(change)).toBeUndefined();
    expect(h.apply).toHaveBeenCalledWith(change);
  });
});

describe("以此继续编辑", () => {
  const created = board([reference("ref1"), task("t1"), { id: "p2", type: "prompt", pos: [0, 0], size: [240, 160], extra: {}, text: "" }, task("t2")], [edge(["p2", "out"], ["t2", "positive"]), edge(["ref1", "out"], ["t2", "image:0"])]);

  it("按当前选区与落点试算一步；选中的新提示词取一次性聚焦，接它的新任务节点默认展开", () => {
    const h = harness();
    h.apply.mockReturnValue(editResult(created, { selection: ["p2"] }));
    canvasBoardActions(h.deps).continueEditing("ref1", 2, { x: 10.4, y: 20.6 });
    expect(h.apply).toHaveBeenCalledWith({ kind: "continueEditing", sources: ["ref1"], trigger: "ref1", sourceLayer: 2, at: [10, 21] });
    const override = h.setExpandOverrides.mock.calls[0][0] as (o: ReadonlyMap<string, boolean>) => ReadonlyMap<string, boolean>;
    expect(override(new Map())).toEqual(new Map([["t2", true]]));
    expect(h.requestPromptFocus).toHaveBeenCalledWith("p2");
  });

  it("没有落点时触发节点在选区内则带上整个选区（多选一起续作）", () => {
    const h = harness();
    h.selectedRef.current = new Set(["ref1", "res1"]);
    h.apply.mockReturnValue(editResult(created, { selection: ["p2"] }));
    canvasBoardActions(h.deps).continueEditing("ref1");
    expect(h.apply).toHaveBeenCalledWith({ kind: "continueEditing", sources: ["ref1", "res1"], trigger: "ref1", sourceLayer: null, at: null });
  });

  it("被拒（没有撤销步 / 没有建议选中）时既不聚焦也不展开", () => {
    const h = harness();
    canvasBoardActions(h.deps).continueEditing("ref1");
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.setExpandOverrides).not.toHaveBeenCalled();
    expect(h.requestPromptFocus).not.toHaveBeenCalled();
  });

  it("有建议选中但没有撤销步时也不聚焦、不展开", () => {
    const h = harness();
    h.apply.mockReturnValue(editResult(created, { step: null, selection: ["p2"] }));
    canvasBoardActions(h.deps).continueEditing("ref1");
    expect(h.setExpandOverrides).not.toHaveBeenCalled();
    expect(h.requestPromptFocus).not.toHaveBeenCalled();
  });

  it("选中的是别的节点（没有新建任务节点）时只聚焦", () => {
    const h = harness();
    h.apply.mockReturnValue(editResult(board([reference("ref1")]), { selection: ["p2"] }));
    canvasBoardActions(h.deps).continueEditing("ref1");
    expect(h.setExpandOverrides).not.toHaveBeenCalled();
    expect(h.requestPromptFocus).toHaveBeenCalledWith("p2");
  });
});

describe("提示词未提交文本", () => {
  /** 取出 setter 收到的更新函数。 */
  const updaterOf = (h: Harness) => h.setPromptDrafts.mock.calls[0][0] as (d: ReadonlyMap<string, string>) => ReadonlyMap<string, string>;

  it("写入新文本", () => {
    const h = harness();
    canvasBoardActions(h.deps).setPromptDraft("p1", "半句");
    const before = new Map<string, string>();
    expect(updaterOf(h)(before)).toEqual(new Map([["p1", "半句"]]));
    expect(updaterOf(h)(before)).not.toBe(before);
  });

  it("文本没变时保留原 Map（不触发重渲染）", () => {
    const h = harness();
    canvasBoardActions(h.deps).setPromptDraft("p1", "半句");
    const before = new Map([["p1", "半句"]]);
    expect(updaterOf(h)(before)).toBe(before);
  });

  it("null 清掉已有文本", () => {
    const h = harness();
    canvasBoardActions(h.deps).setPromptDraft("p1", null);
    expect(updaterOf(h)(new Map([["p1", "半句"]]))).toEqual(new Map());
  });

  it("null 而本来就没有时保留原 Map", () => {
    const h = harness();
    canvasBoardActions(h.deps).setPromptDraft("p1", null);
    const before = new Map<string, string>();
    expect(updaterOf(h)(before)).toBe(before);
  });
});

describe("一次性聚焦请求", () => {
  it("仍指向该提示词：清掉并返回 true", () => {
    const h = harness();
    h.focusPromptRef.current = "p1";
    expect(canvasBoardActions(h.deps).takePromptFocus("p1")).toBe(true);
    expect(h.requestPromptFocus).toHaveBeenCalledWith(null);
  });

  it("已经清掉或指向别的提示词：返回 false，不动请求", () => {
    const h = harness();
    h.focusPromptRef.current = "p2";
    expect(canvasBoardActions(h.deps).takePromptFocus("p1")).toBe(false);
    expect(h.requestPromptFocus).not.toHaveBeenCalled();
  });
});

describe("节点卸载", () => {
  it("交给画布收起该节点的悬浮动作条", () => {
    const h = harness();
    canvasBoardActions(h.deps).nodeUnmounted("ref1");
    expect(h.unhoverNode).toHaveBeenCalledWith("ref1");
  });
});

describe("加为参考图", () => {
  it("按当前选区与图层写一步变更", () => {
    const h = harness();
    canvasBoardActions(h.deps).addAsReference("res1", 2);
    expect(h.apply).toHaveBeenCalledWith({ kind: "addAsReference", resultId: "res1", selected: ["ref1"], sourceLayer: 2 });
  });

  it("缺省不带图层", () => {
    const h = harness();
    canvasBoardActions(h.deps).addAsReference("res1");
    expect(h.apply).toHaveBeenCalledWith({ kind: "addAsReference", resultId: "res1", selected: ["ref1"], sourceLayer: null });
  });
});

describe("放大预览", () => {
  it("参考图 / 结果节点打开预览弹窗，请求由画板现算", () => {
    const h = harness();
    canvasBoardActions(h.deps).previewNode("res1");
    expect(h.showPreview).toHaveBeenCalledWith(nodePreviewRequest(canvasBoard(), BUILTIN_TABLE, ROOT, "res1"));
  });

  it("任务节点没有可预览的图片：不弹窗", () => {
    const h = harness();
    canvasBoardActions(h.deps).previewNode("t1");
    expect(h.showPreview).not.toHaveBeenCalled();
  });
});

describe("框选修改区域", () => {
  it("锁定任务只提示锁定（排队 / 执行中不能改输入线的区域）", () => {
    const h = harness();
    h.lockedRef.current = new Set(["t1"]);
    canvasBoardActions(h.deps).editRegion("t1", { from: ["ref1", "out"], to: ["t1", "image:0"] });
    expect(h.toast).toHaveBeenCalledWith(LOCKED_HINT);
    expect(h.showPreview).not.toHaveBeenCalled();
  });

  it("模型不支持框选区域（这条线上找不到目标）时给拒绝原因", () => {
    const h = harness();
    h.boardRef.current = board([reference("ref1"), task("t1", { model: "不存在的模型" })], [edge(["ref1", "out"], ["t1", "image:0"])]);
    canvasBoardActions(h.deps).editRegion("t1", { from: ["ref1", "out"], to: ["t1", "image:0"] });
    expect(h.toast).toHaveBeenCalledWith(REGION_TEXT.unsupported);
    expect(h.showPreview).not.toHaveBeenCalled();
  });

  it("目标在、但源节点不是图片节点（提示词接到图片端口）时静默：不提示也不弹窗", () => {
    const h = harness();
    h.boardRef.current = board([{ id: "p1", type: "prompt", pos: [0, 0], size: [240, 160], extra: {}, text: "" }, task("t1")], [edge(["p1", "out"], ["t1", "image:0"])]);
    canvasBoardActions(h.deps).editRegion("t1", { from: ["p1", "out"], to: ["t1", "image:0"] });
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.showPreview).not.toHaveBeenCalled();
  });

  it("支持时打开预览弹窗并直接进入该线的区域编辑", () => {
    const h = harness();
    canvasBoardActions(h.deps).editRegion("t1", { from: ["ref1", "out"], to: ["t1", "image:0"] });
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.showPreview).toHaveBeenCalledWith(expect.objectContaining({ title: REGION_TEXT.previewTitle("ref1.png"), absPath: "/~/refs/ref1.png" }));
  });
});

describe("生成变体", () => {
  it("按结果节点的父任务目录重跑", () => {
    const h = harness();
    canvasBoardActions(h.deps).generateVariant("res1");
    expect(h.onRegenerate).toHaveBeenCalledWith("t1", "task-res1");
  });

  it("父任务已删除（或节点不是结果）时提示", () => {
    const h = harness();
    canvasBoardActions(h.deps).generateVariant("ref1");
    expect(h.toast).toHaveBeenCalledWith(VARIANT_TEXT.parentGone);
    expect(h.onRegenerate).not.toHaveBeenCalled();
  });

  it("非结果节点即使带来源任务连线也不重跑", () => {
    const h = harness();
    h.boardRef.current = board([reference("ref1"), task("t1")], [edge(["t1", "result"], ["ref1", "in"], { system: true })]);
    canvasBoardActions(h.deps).generateVariant("ref1");
    expect(h.toast).toHaveBeenCalledWith(VARIANT_TEXT.parentGone);
    expect(h.onRegenerate).not.toHaveBeenCalled();
  });
});

describe("重新定位：选文件", () => {
  const pick = (h: Harness) => canvasBoardActions(h.deps).relocate("ref1", "pick");

  it("上传到用户数据根后按服务端路径改写节点，并记一条成功日志", async () => {
    const h = harness();
    vi.mocked(transfer.pickLocalImages).mockResolvedValue([{ name: "新文件.png" } as File]);
    vi.mocked(transfer.uploadReference).mockResolvedValue({ path: "refs/新文件.png", sha256: "c".repeat(64) });
    vi.mocked(ipc.inspectImage).mockResolvedValue(INFO);
    pick(h);
    await flush();
    expect(transfer.pickLocalImages).toHaveBeenCalledWith(false);
    expect(h.primeImageInfo).toHaveBeenCalledWith("/~/refs/新文件.png", INFO);
    expect(h.apply).toHaveBeenCalledWith({ kind: "relocate", nodeId: "ref1", path: "refs/新文件.png", sha256: "b".repeat(64), fileName: "新文件.png", picked: true });
    expect(logEvent).toHaveBeenCalledWith("relocate", { board_file: BOARD_FILE, node_id: "ref1", node_type: "reference", mode: "pick", ok: true });
  });

  it("用户取消选文件：什么也不做", async () => {
    const h = harness();
    vi.mocked(transfer.pickLocalImages).mockResolvedValue([]);
    pick(h);
    await flush();
    expect(h.apply).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("上传 / 读图失败：提示读了哪个文件，记 unreadable", async () => {
    const h = harness();
    vi.mocked(transfer.pickLocalImages).mockResolvedValue([{ name: "坏.png" } as File]);
    vi.mocked(transfer.uploadReference).mockRejectedValue(new Error("网关拒绝"));
    pick(h);
    await flush();
    expect(h.apply).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("relocate", { board_file: BOARD_FILE, node_id: "ref1", node_type: "reference", mode: "pick", ok: false, reason: "unreadable" });
    expect(h.toast).toHaveBeenCalledWith(RELOCATE_TEXT.unreadable("坏.png", "网关拒绝"));
  });

  it("不是参考图 / 结果节点时不做任何事", async () => {
    const h = harness();
    canvasBoardActions(h.deps).relocate("t1", "pick");
    await flush();
    expect(transfer.pickLocalImages).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("重新定位：在用户数据根内找", () => {
  it("结果按 task_id 与文件名找，找到后写相对路径与文件名", async () => {
    const h = harness();
    vi.mocked(findResultFile).mockResolvedValue("/~/任务/task-res1/res1.png");
    vi.mocked(ipc.inspectImage).mockResolvedValue(INFO);
    canvasBoardActions(h.deps).relocate("res1", "search");
    await flush();
    expect(findResultFile).toHaveBeenCalledWith(expect.anything(), ROOT, { task_id: "task-res1", file: "res1.png" });
    expect(findReferenceFile).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledWith({ kind: "relocate", nodeId: "res1", path: "任务/task-res1/res1.png", sha256: "b".repeat(64), fileName: "res1.png", picked: false });
    expect(logEvent).toHaveBeenCalledWith("relocate", { board_file: BOARD_FILE, node_id: "res1", node_type: "result", mode: "search", ok: true });
  });

  it("参考图按 sha256 与显示名找", async () => {
    const h = harness();
    vi.mocked(findReferenceFile).mockResolvedValue("/~/参考/ref1.png");
    vi.mocked(ipc.inspectImage).mockResolvedValue(INFO);
    canvasBoardActions(h.deps).relocate("ref1", "search");
    await flush();
    expect(findReferenceFile).toHaveBeenCalledWith(expect.anything(), ROOT, { sha256: "a".repeat(64), display_name: "ref1.png" });
    expect(findResultFile).not.toHaveBeenCalled();
  });

  it("没找到：按节点种类给名字，记 not_found", async () => {
    const h = harness();
    vi.mocked(findResultFile).mockResolvedValue(null);
    canvasBoardActions(h.deps).relocate("res1", "search");
    await flush();
    expect(logEvent).toHaveBeenCalledWith("relocate", { board_file: BOARD_FILE, node_id: "res1", node_type: "result", mode: "search", ok: false, reason: "not_found" });
    expect(h.toast).toHaveBeenCalledWith(RELOCATE_TEXT.missing("res1.png"));
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("参考图没找到时用显示名", async () => {
    const h = harness();
    vi.mocked(findReferenceFile).mockResolvedValue(null);
    canvasBoardActions(h.deps).relocate("ref1", "search");
    await flush();
    expect(h.toast).toHaveBeenCalledWith(RELOCATE_TEXT.missing("ref1.png"));
  });

  it("读图失败：按文件名提示，记 unreadable", async () => {
    const h = harness();
    vi.mocked(findResultFile).mockResolvedValue("/~/任务/task-res1/res1.png");
    vi.mocked(ipc.inspectImage).mockRejectedValue(new Error("文件不可读"));
    canvasBoardActions(h.deps).relocate("res1", "search");
    await flush();
    expect(logEvent).toHaveBeenCalledWith("relocate", { board_file: BOARD_FILE, node_id: "res1", node_type: "result", mode: "search", ok: false, reason: "unreadable" });
    expect(h.toast).toHaveBeenCalledWith(RELOCATE_TEXT.unreadable("res1.png", "文件不可读"));
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("找不到节点（已经不在画板上）时什么也不做", async () => {
    const h = harness();
    canvasBoardActions(h.deps).relocate("没有这个节点", "search");
    await flush();
    expect(findResultFile).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { newBoard, parseBoard, serializeBoard, taskCount, type Board, type ReferenceNode, type ResultNode, type TaskNode } from "./board";
import {
  PACK_CANCELLED,
  PACK_MANIFEST,
  buildExportSpec,
  planExport,
  planPackContents,
  runCancellable,
  type PackEntryFact,
  type PackFs,
} from "./boardPack";

const ROOT = "/~";

const base = { pos: [0, 0] as [number, number], size: [200, 200] as [number, number], extra: {} };

const result = (id: string, taskId: string, date = "2026-09-16"): ResultNode => ({
  ...base,
  id,
  type: "result",
  task_id: taskId,
  file: "result.png",
  path: `${date}/${taskId}/result.png`,
  layer_count: 0,
  record: { model: "qwen-image", prompt: "猫", negative_prompt: "", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-09-16T00:00:00Z" },
});

const reference = (id: string, path: string, sha = "old"): ReferenceNode => ({ ...base, id, type: "reference", path, sha256: sha, display_name: path.split(/[\\/]/).pop()! });

const boardWith = (...nodes: Board["nodes"]): Board => ({ ...newBoard("千问测试"), nodes });

/** 内存文件系统：绝对路径 → sha256。 */
function memoryFs(files: Record<string, string>): PackFs {
  return {
    isFile: async (p) => p in files,
    sha256: async (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
  };
}

const abs = (rel: string) => `${ROOT}/${rel}`;

describe("导出计划", () => {
  it("带上结果节点直接引用的任务目录（去重、排序），不改结果路径", async () => {
    const board = boardWith(result("r1", "20260916T010000Z-00000002"), result("r2", "20260916T010000Z-00000001"), result("r3", "20260916T010000Z-00000001"));
    const plan = await planExport(board, ROOT, memoryFs({ [abs("2026-09-16/20260916T010000Z-00000001/result.png")]: "", [abs("2026-09-16/20260916T010000Z-00000002/result.png")]: "" }));
    expect(plan.taskDirs).toEqual(["2026-09-16/20260916T010000Z-00000001", "2026-09-16/20260916T010000Z-00000002"]);
    expect(plan.files).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.board).toEqual(board);
  });

  it("根目录内指向任务目录的参考图带上该任务目录", async () => {
    const board = boardWith(reference("a", "2026-09-17/20260917T010000Z-0000000a/result.png"));
    const plan = await planExport(board, ROOT, memoryFs({ [abs("2026-09-17/20260917T010000Z-0000000a/result.png")]: "x" }));
    expect(plan.taskDirs).toEqual(["2026-09-17/20260917T010000Z-0000000a"]);
    expect(plan.board.nodes[0]).toEqual(board.nodes[0]);
  });

  it("根目录外参考图按 sha256 去重放进导入参考图，画板路径改写为相对路径", async () => {
    const board = boardWith(reference("a", "D:\\素材\\猫.PNG"), reference("b", "E:\\别处\\同一只猫.png"), reference("c", "D:\\素材\\狗.jpg"));
    const plan = await planExport(board, ROOT, memoryFs({ "D:\\素材\\猫.PNG": "aa", "E:\\别处\\同一只猫.png": "aa", "D:\\素材\\狗.jpg": "bb" }));
    expect(plan.files).toEqual([
      { source: "D:\\素材\\猫.PNG", entry: "导入参考图/aa.png" },
      { source: "D:\\素材\\狗.jpg", entry: "导入参考图/bb.jpg" },
    ]);
    const refs = plan.board.nodes as ReferenceNode[];
    expect(refs.map((n) => [n.path, n.sha256, n.display_name])).toEqual([
      ["导入参考图/aa.png", "aa", "猫.PNG"],
      ["导入参考图/aa.png", "aa", "同一只猫.png"],
      ["导入参考图/bb.jpg", "bb", "狗.jpg"],
    ]);
    // 原画板不被改动。
    expect((board.nodes[0] as ReferenceNode).path).toBe("D:\\素材\\猫.PNG");
  });

  it("根目录内但不在任务目录里的参考图（含写成绝对路径的）也放进导入参考图", async () => {
    const board = boardWith(reference("a", "素材/猫.png"), reference("b", abs("素材/狗.png")));
    const plan = await planExport(board, ROOT, memoryFs({ [abs("素材/猫.png")]: "aa", [abs("素材/狗.png")]: "bb" }));
    expect(plan.files).toEqual([
      { source: abs("素材/猫.png"), entry: "导入参考图/aa.png" },
      { source: abs("素材/狗.png"), entry: "导入参考图/bb.png" },
    ]);
    expect((plan.board.nodes as ReferenceNode[]).map((n) => n.path)).toEqual(["导入参考图/aa.png", "导入参考图/bb.png"]);
  });

  it("缺图节点列出，照常导出且路径不改写", async () => {
    const board = boardWith(result("r", "20260916T010000Z-00000001"), reference("a", "D:\\素材\\没了.png"), reference("b", "素材/也没了.png"));
    const plan = await planExport(board, ROOT, memoryFs({}));
    expect(plan.missing).toEqual([
      { nodeId: "r", path: "2026-09-16/20260916T010000Z-00000001/result.png" },
      { nodeId: "a", path: "D:\\素材\\没了.png" },
      { nodeId: "b", path: "素材/也没了.png" },
    ]);
    expect(plan.taskDirs).toEqual(["2026-09-16/20260916T010000Z-00000001"]);
    expect(plan.files).toEqual([]);
    expect(plan.board).toEqual(board);
  });

  it("导出规格：清单与画板作为文本条目，任务目录与参考图原样传给壳", async () => {
    const plan = await planExport(boardWith(reference("a", "D:\\猫.png")), ROOT, memoryFs({ "D:\\猫.png": "aa" }));
    const spec = buildExportSpec("0.2.0", "千问测试.ugcboard.json", plan, planPackContents([]));
    expect(spec.texts.map((t) => t.entry)).toEqual([PACK_MANIFEST, "画板/千问测试.ugcboard.json"]);
    expect(JSON.parse(spec.texts[0].text)).toEqual({ pack_format_version: 2, app_version: "0.2.0", boards: ["画板/千问测试.ugcboard.json"], duplicates: {} });
    expect(spec.texts[1].text).toBe(serializeBoard(plan.board));
    expect(spec.task_dirs).toEqual([]);
    expect(spec.files).toEqual(plan.files);
    expect(spec.omitted).toEqual([]);
  });

  /** Flash 结果：两层，其中 02 的图层文件不在磁盘上。 */
  const flashResult = (id: string, taskId: string, date = "2026-09-16"): ResultNode => {
    const node = result(id, taskId, date);
    node.record.model = "doubao-seedream-5-0-flash-260915";
    node.layer_count = 2;
    node.record.layers = [
      { file: "layers/01.png", z_index: 1, bounding_box: { absolute: [0, 0, 100, 50], normalized: [0, 0, 500, 500] }, name: "主体" },
      { file: "layers/02.png", z_index: 2, bounding_box: { absolute: [10, 10, 60, 40], normalized: [50, 100, 300, 400] }, description: "阴影" },
    ];
    return node;
  };

  it("Flash 结果的图层文件缺失：逐个列入缺图清单，任务目录照常带上", async () => {
    const taskId = "20260916T010000Z-00000001";
    const board = boardWith(flashResult("r", taskId));
    const files = {
      [abs(`2026-09-16/${taskId}/result.png`)]: "",
      [abs(`2026-09-16/${taskId}/layers/01.png`)]: "",
    };
    const plan = await planExport(board, ROOT, memoryFs(files));
    expect(plan.taskDirs).toEqual([`2026-09-16/${taskId}`]);
    expect(plan.missing).toEqual([{ nodeId: "r", path: `2026-09-16/${taskId}/layers/02.png` }]);
  });

  it("包往返：图层记录与来源图层连线经序列化 / 解析原样保留", async () => {
    const taskId = "20260916T010000Z-00000001";
    const res = flashResult("r", taskId);
    const board: Board = {
      ...boardWith(res),
      edges: [{ from: ["r", "out"], to: ["t", "image:0"], source_layer: 2, region: null, system: false, extra: {} }],
    };
    const files = Object.fromEntries(["result.png", "layers/01.png", "layers/02.png"].map((f) => [abs(`2026-09-16/${taskId}/${f}`), ""]));
    const plan = await planExport(board, ROOT, memoryFs(files));
    expect(plan.missing).toEqual([]);
    const parsed = parseBoard(serializeBoard(plan.board));
    if (parsed.kind !== "ok") throw new Error(parsed.kind);
    const node = parsed.board.nodes[0] as ResultNode;
    expect(node.record.layers).toEqual(res.record.layers);
    expect(node.layer_count).toBe(2);
    expect(parsed.board.edges[0]).toMatchObject({ source_layer: 2 });
  });
});

describe("导出 v2：按内容去重", () => {
  const A = "2026-09-16/20260916T010000Z-0000000a";
  const B = "2026-09-16/20260916T020000Z-0000000b";
  const C = "2026-09-17/20260917T010000Z-0000000c";
  const fact = (entry: string, sha256: string, size: number): PackEntryFact => ({ entry, sha256, size });
  /** B 的参考图快照是 A 的结果，C 的结果与 B 的快照同内容；导入参考图与 C 的参考图快照同内容。 */
  const facts = [
    fact(`${B}/references/01.png`, "s1", 100),
    fact(`${A}/task.json`, "ta", 10),
    fact(`${C}/result.png`, "s1", 100),
    fact(`${A}/result.png`, "s1", 100),
    fact(`${B}/task.json`, "tb", 12),
    fact(`${B}/result.png`, "s2", 200),
    fact(`${C}/task.json`, "tc", 11),
    fact(`${C}/references/01.png`, "s3", 50),
    fact("导入参考图/s3.png", "s3", 50),
  ];

  it("内容相同的条目只保留路径排序第一的，其余写进 duplicates 指向它", () => {
    const contents = planPackContents(facts);
    expect(contents.duplicates).toEqual({
      [`${B}/references/01.png`]: `${A}/result.png`,
      [`${C}/result.png`]: `${A}/result.png`,
      "导入参考图/s3.png": `${C}/references/01.png`,
    });
  });

  it("同一输入导出规划稳定：与条目顺序无关", () => {
    const expected = planPackContents(facts);
    for (const shuffled of [[...facts].reverse(), [...facts.slice(4), ...facts.slice(0, 4)]]) {
      const again = planPackContents(shuffled);
      expect(again).toEqual(expected);
      expect(JSON.stringify(again.duplicates)).toBe(JSON.stringify(expected.duplicates));
    }
  });

  it("预估大小等于实存条目的字节和；也给出未去重的字节和", () => {
    const contents = planPackContents(facts);
    // 实存：A/task.json 10、A/result.png 100、B/task.json 12、B/result.png 200、C/task.json 11、C/references/01.png 50。
    expect(contents.bytes).toBe(10 + 100 + 12 + 200 + 11 + 50);
    expect(contents.totalBytes).toBe(facts.reduce((n, f) => n + f.size, 0));
  });

  it("没有重复时 duplicates 为空，预估大小等于全部字节", () => {
    const contents = planPackContents([fact(`${A}/task.json`, "ta", 10), fact(`${A}/result.png`, "s1", 100)]);
    expect(contents).toEqual({ duplicates: {}, bytes: 110, totalBytes: 110 });
  });

  it("任务目录与导入参考图以外的条目不会被省略", () => {
    const contents = planPackContents([fact(`${A}/result.png`, "s1", 100), fact("别处/猫.png", "s1", 100)]);
    expect(contents.duplicates).toEqual({});
    expect(contents.bytes).toBe(200);
  });

  it("导出规格只省略 duplicates 的键，清单写 v2 与 duplicates", async () => {
    const board = boardWith(result("ra", "20260916T010000Z-0000000a"), result("rc", "20260917T010000Z-0000000c", "2026-09-17"));
    const plan = await planExport(board, ROOT, memoryFs({ [abs(`${A}/result.png`)]: "", [abs(`${C}/result.png`)]: "" }));
    const contents = planPackContents(facts);
    const spec = buildExportSpec("0.4.0", "千问测试.ugcboard.json", plan, contents);
    expect(spec.omitted).toEqual(Object.keys(contents.duplicates).sort());
    const manifest = JSON.parse(spec.texts[0].text);
    expect(manifest).toMatchObject({ pack_format_version: 2, duplicates: contents.duplicates });

  });
});

describe("份数随画板包导出与导入", () => {
  const task = (id: string, count?: number): TaskNode => ({
    ...base,
    id,
    type: "task",
    model: "qwen-image-3.0-pro",
    size_spec: { tier: "2K", ratio: "1:1", width: null, height: null },
    image_ports: 0,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
    ...(count === undefined ? {} : { count }),
  });

  it("导出的画板带份数，导入后原样保留（超过并发上限也不改写）；旧包没有份数按 1", async () => {
    const plan = await planExport(boardWith(task("t", 3), task("big", 50), task("old")), ROOT, memoryFs({}));
    const spec = buildExportSpec("0.3.0", "千问测试.ugcboard.json", plan, planPackContents([]));
    const parsed = parseBoard(spec.texts[1].text);
    if (parsed.kind !== "ok") throw new Error(parsed.kind);
    const tasks = parsed.board.nodes as TaskNode[];
    expect(tasks.map((t) => taskCount(t))).toEqual([3, 50, 1]);
    expect(tasks[2]).not.toHaveProperty("count");
  });

  it("同一次提交各份的任务目录随包导出（失败 / 已中断的份没有结果节点）；只有 task_id 的旧画板行为不变", async () => {
    const copies = ["20261106T080000Z-0000000a", "20261106T080000Z-0000000b"];
    const multi: TaskNode = { ...task("t", 2), last_submitted: { task_id: copies[1], copy_task_ids: copies, images: [] } };
    const old: TaskNode = { ...task("old"), last_submitted: { task_id: "20260916T010000Z-0000000f", images: [] } };
    const plan = await planExport(boardWith(multi, old, result("r", copies[0], "2026-11-06")), ROOT, memoryFs({ [abs(`2026-11-06/${copies[0]}/result.png`)]: "" }));
    expect(plan.taskDirs).toEqual(copies.map((id) => `2026-11-06/${id}`));
    expect(plan.missing).toEqual([]);
    expect(plan.board.nodes[0]).toEqual(multi);
  });
});

describe("可取消的画板包命令", () => {
  it("先复位取消标记，复位之后才进入进度阶段，再跑命令", async () => {
    const steps: string[] = [];
    const io = { cancel: async (cancelled: boolean) => void steps.push(`cancel(${cancelled})`) };
    const outcome = await runCancellable(io, (stage) => steps.push(stage), async () => {
      steps.push("run");
      return 7;
    });
    expect(outcome).toEqual({ ok: true, value: 7 });
    expect(steps).toEqual(["cancel(false)", "progress", "run"]);
  });

  it("命令以取消标记 reject 归为 cancelled，其他错误归为 failed", async () => {
    const io = { cancel: async () => undefined };
    expect(await runCancellable(io, () => undefined, () => Promise.reject(PACK_CANCELLED))).toEqual({ ok: false, result: "cancelled", error: PACK_CANCELLED });
    expect(await runCancellable(io, () => undefined, () => Promise.reject(new Error("磁盘已满")))).toEqual({ ok: false, result: "failed", error: "磁盘已满" });
  });
});

describe("导出节点归属", () => {
  it("纯提示词节点原样保留：不带任务目录 / 参考图 / 缺图", async () => {
    const prompt = { ...base, id: "p", type: "prompt" as const, text: "一段提示" };
    const board = boardWith(prompt);
    const plan = await planExport(board, ROOT, memoryFs({}));
    expect(plan.taskDirs).toEqual([]);
    expect(plan.files).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.board.nodes[0]).toBe(prompt);
  });

  it("任务节点没有上次提交时不带任何任务目录", async () => {
    const task: TaskNode = { ...base, id: "t", type: "task", model: "qwen-image-3.0-pro", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null };
    const plan = await planExport(boardWith(task), ROOT, memoryFs({}));
    expect(plan.taskDirs).toEqual([]);
    expect(plan.board.nodes[0]).toBe(task);
  });

});

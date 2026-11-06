import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { newBoard, parseBoard, serializeBoard, taskCount, uniqueBoardFileName, type Board, type ReferenceNode, type ResultNode, type TaskNode } from "./board";
import {
  PACK_CANCELLED,
  PACK_FORMAT_VERSION,
  PACK_MANIFEST,
  buildExportSpec,
  buildManifest,
  checkPack,
  importPack,
  importSummary,
  inspectPack,
  inspectPackLocally,
  planExport,
  planPackContents,
  runCancellable,
  type PackEntryFact,
  type MergeUnit,
  type PackFs,
  type PackIo,
} from "./boardPack";
import { resolveFromRoot } from "./paths";
import { buildZip } from "./testing/zipFixture";
import { blobSource } from "./zipIndex";

const ROOT = "C:\\Users\\Lzx_8\\Pictures\\UGC AI 生图工具";

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

const abs = (rel: string) => `${ROOT}\\${rel.replace(/\//g, "\\")}`;

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

  it("Windows 根目录外的参考图改写后，在 macOS 根目录下解析到导入参考图", async () => {
    const plan = await planExport(boardWith(reference("a", "D:\\素材\\猫.png")), ROOT, memoryFs({ "D:\\素材\\猫.png": "aa" }));
    const imported = parseBoard(serializeBoard(plan.board));
    if (imported.kind !== "ok") throw new Error(imported.kind);
    const path = (imported.board.nodes[0] as ReferenceNode).path;
    expect(resolveFromRoot("/Users/art/Pictures/UGC AI 生图工具", path)).toBe("/Users/art/Pictures/UGC AI 生图工具/导入参考图/aa.png");
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

  it("导出规格只省略 duplicates 的键，清单写 v2 与 duplicates；按规格写出的包通过 v2 导入校验并还原全部路径", async () => {
    const board = boardWith(result("ra", "20260916T010000Z-0000000a"), result("rc", "20260917T010000Z-0000000c", "2026-09-17"));
    const plan = await planExport(board, ROOT, memoryFs({ [abs(`${A}/result.png`)]: "", [abs(`${C}/result.png`)]: "" }));
    const contents = planPackContents(facts);
    const spec = buildExportSpec("0.4.0", "千问测试.ugcboard.json", plan, contents);
    expect(spec.omitted).toEqual(Object.keys(contents.duplicates).sort());
    const manifest = JSON.parse(spec.texts[0].text);
    expect(manifest).toMatchObject({ pack_format_version: 2, duplicates: contents.duplicates });

    // 服务端只写实存条目：文本条目 + 未被省略的文件。
    const written = [...spec.texts.map((t) => t.entry), ...facts.map((f) => f.entry).filter((e) => !spec.omitted.includes(e))];
    const textMap = Object.fromEntries(spec.texts.map((t) => [t.entry, t.text]));
    const check = await inspectPack(written, async (names) => Object.fromEntries(names.filter((n) => n in textMap).map((n) => [n, textMap[n]])));
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    expect(check.units.map((u) => u.path)).toEqual([A, B, C, "导入参考图/s3.png"]);
    expect(Object.fromEntries(check.duplicates.map((d) => [d.path, d.source]))).toEqual(contents.duplicates);
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
    const [manifest, boardText] = spec.texts;
    const check = checkPack(manifest.text, { [boardText.entry]: boardText.text });
    if (check.kind !== "ok") throw new Error(check.kind);
    const tasks = check.boards[0].board.nodes as TaskNode[];
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

describe("包清单与版本判定", () => {
  const boardText = serializeBoard(newBoard("豆包测试"));

  it("版本不高于本机时通过，返回解析后的画板", () => {
    const manifest = buildManifest("0.2.0", ["画板/豆包测试.ugcboard.json"]);
    const check = checkPack(manifest, { "画板/豆包测试.ugcboard.json": boardText });
    expect(check.kind).toBe("ok");
    if (check.kind === "ok") expect(check.boards.map((b) => b.board.title)).toEqual(["豆包测试"]);
  });

  it("包格式版本更高时拒绝并提示升级", () => {
    const manifest = JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION + 1, app_version: "9.0.0", boards: [] });
    const check = checkPack(manifest, {});
    expect(check).toEqual({ kind: "newer", message: expect.stringContaining("升级") });
  });

  it("包内画板 format_version 更高时拒绝", () => {
    const manifest = buildManifest("0.2.0", ["画板/a.ugcboard.json"]);
    const newer = JSON.stringify({ ...JSON.parse(boardText), format_version: 99 });
    expect(checkPack(manifest, { "画板/a.ugcboard.json": newer }).kind).toBe("newer");
  });

  it("本机支持包格式 v2，导出一律写 v2", () => {
    expect(PACK_FORMAT_VERSION).toBe(2);
    expect(JSON.parse(buildManifest("0.2.0", [])).pack_format_version).toBe(2);
    const v2 = JSON.stringify({ pack_format_version: 2, app_version: "0.4.0", boards: ["画板/豆包测试.ugcboard.json"], duplicates: {} });
    expect(checkPack(v2, { "画板/豆包测试.ugcboard.json": boardText }).kind).toBe("ok");
  });

  it("清单缺失 / 损坏、画板缺失或损坏时判为损坏", () => {
    expect(checkPack(null, {}).kind).toBe("corrupt");
    expect(checkPack("{", {}).kind).toBe("corrupt");
    expect(checkPack(JSON.stringify({ pack_format_version: 1, boards: [] }), {}).kind).toBe("corrupt");
    expect(checkPack(buildManifest("0.2.0", ["画板/a.ugcboard.json"]), {}).kind).toBe("corrupt");
    expect(checkPack(buildManifest("0.2.0", ["画板/a.ugcboard.json"]), { "画板/a.ugcboard.json": "{" }).kind).toBe("corrupt");
  });
});

describe("导入前检查包内容", () => {
  const TASK = "2026-09-16/20260916T010000Z-0000000a";
  const boardEntry = "画板/千问测试.ugcboard.json";
  const texts: Record<string, string> = { [PACK_MANIFEST]: buildManifest("0.2.0", [boardEntry]), [boardEntry]: serializeBoard(newBoard("千问测试")) };

  /** 只读被请求的文本，记录读了哪些。 */
  function reader(source: Record<string, string>) {
    const read: string[][] = [];
    return {
      read,
      readTexts: async (names: string[]) => {
        read.push(names);
        return Object.fromEntries(names.filter((n) => n in source).map((n) => [n, source[n]]));
      },
    };
  }

  it("只读清单与画板；任务目录按 task.json 比对、参考图按整文件比对", async () => {
    const entries = [PACK_MANIFEST, boardEntry, `${TASK}/task.json`, `${TASK}/result.png`, `${TASK}/layers/01.png`, "导入参考图/aa.png"];
    const r = reader(texts);
    const check = await inspectPack(entries, r.readTexts);
    expect(r.read).toEqual([[PACK_MANIFEST, boardEntry]]);
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    expect(check.boards.map((b) => b.entry)).toEqual([boardEntry]);
    expect(check.units).toEqual<MergeUnit[]>([
      { path: TASK, identity: "task.json" },
      { path: "导入参考图/aa.png", identity: null },
    ]);
  });

  it("版本更高时先于布局判定拒绝（新格式可能有新布局）", async () => {
    const newer = { ...texts, [PACK_MANIFEST]: JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION + 1, app_version: "9", boards: [] }) };
    expect((await inspectPack([PACK_MANIFEST, "新目录/x.bin"], reader(newer).readTexts)).kind).toBe("newer");
  });

  it("任务目录与导入参考图以外的路径、缺 task.json 的任务目录、不安全路径判为损坏", async () => {
    const ok = [PACK_MANIFEST, boardEntry];
    for (const extra of [["素材/猫.png"], [`${TASK}/result.png`], ["导入参考图/子目录/aa.png"], [`${TASK}/../../evil.png`, `${TASK}/task.json`], ["manifest.json/x"]]) {
      const check = await inspectPack([...ok, ...extra], reader(texts).readTexts);
      expect(check.kind, extra.join()).toBe("corrupt");
    }
  });

  describe("包格式 v2：duplicates", () => {
    const OTHER = "2026-09-16/20260916T020000Z-0000000b";
    const v2 = (duplicates: unknown) => ({
      ...texts,
      [PACK_MANIFEST]: JSON.stringify({ pack_format_version: 2, app_version: "0.4.0", boards: [boardEntry], duplicates }),
    });
    const present = [PACK_MANIFEST, boardEntry, `${TASK}/task.json`, `${TASK}/result.png`, `${OTHER}/task.json`, "导入参考图/aa.png"];

    it("合法的 v2 包：被省略的路径计入布局，合并单元与 v1 相同，返回按路径排序的还原清单", async () => {
      const duplicates = {
        [`${OTHER}/references/01.png`]: `${TASK}/result.png`,
        [`${OTHER}/result.png`]: `${TASK}/result.png`,
        "导入参考图/bb.png": "导入参考图/aa.png",
      };
      const check = await inspectPack(present, reader(v2(duplicates)).readTexts);
      expect(check).toMatchObject({ kind: "ok" });
      if (check.kind !== "ok") return;
      expect(check.units).toEqual<MergeUnit[]>([
        { path: TASK, identity: "task.json" },
        { path: OTHER, identity: "task.json" },
        { path: "导入参考图/aa.png", identity: null },
        { path: "导入参考图/bb.png", identity: null },
      ]);
      expect(check.duplicates).toEqual([
        { path: `${OTHER}/references/01.png`, source: `${TASK}/result.png` },
        { path: `${OTHER}/result.png`, source: `${TASK}/result.png` },
        { path: "导入参考图/bb.png", source: "导入参考图/aa.png" },
      ]);
    });

    it("被省略的 task.json 仍算任务目录含 task.json", async () => {
      const entries = [PACK_MANIFEST, boardEntry, `${TASK}/task.json`, `${OTHER}/result.png`];
      const check = await inspectPack(entries, reader(v2({ [`${OTHER}/task.json`]: `${TASK}/task.json` })).readTexts);
      expect(check.kind).toBe("ok");
      if (check.kind === "ok") expect(check.units.map((u) => u.path)).toEqual([TASK, OTHER]);
    });

    it("没有 duplicates 的 v2 包与 v1 一样；v1 包的还原清单为空", async () => {
      const v2Check = await inspectPack(present, reader(v2(undefined)).readTexts);
      expect(v2Check).toMatchObject({ kind: "ok", duplicates: [] });
      const v1Check = await inspectPack(present, reader(texts).readTexts);
      expect(v1Check).toMatchObject({ kind: "ok", duplicates: [] });
    });

    const violations: [string, unknown][] = [
      ["duplicates 不是对象", ["导入参考图/bb.png"]],
      ["值不是字符串", { "导入参考图/bb.png": 1 }],
      ["键不在白名单（任意位置）", { "素材/猫.png": "导入参考图/aa.png" }],
      ["键是清单", { [PACK_MANIFEST]: "导入参考图/aa.png" }],
      ["键是画板", { "画板/乙.ugcboard.json": boardEntry }],
      ["键是不安全路径", { [`${TASK}/../../evil.png`]: "导入参考图/aa.png" }],
      ["键同时是实存条目", { [`${TASK}/result.png`]: "导入参考图/aa.png" }],
      ["值不是实存条目", { "导入参考图/bb.png": "导入参考图/没有.png" }],
      ["链式映射", { "导入参考图/bb.png": "导入参考图/cc.png", "导入参考图/cc.png": "导入参考图/aa.png" }],
    ];
    for (const [rule, duplicates] of violations) {
      it(`违规判为损坏：${rule}`, async () => {
        const check = await inspectPack(present, reader(v2(duplicates)).readTexts);
        expect(check.kind, rule).toBe("corrupt");
      });
    }

    it("被省略路径计入布局后仍须合法：省略路径所在任务目录缺 task.json 判为损坏", async () => {
      const check = await inspectPack(present, reader(v2({ "2026-09-16/20260916T030000Z-0000000c/result.png": `${TASK}/result.png` })).readTexts);
      expect(check).toMatchObject({ kind: "corrupt", reason: expect.stringContaining("task.json") });
    });
  });
});

describe("导入结果", () => {
  it("同名画板沿用 (2) 自动改名", () => {
    expect(uniqueBoardFileName("千问测试", ["千问测试.ugcboard.json"])).toBe("千问测试 (2).ugcboard.json");
  });

  const units: MergeUnit[] = [
    { path: "2026-09-16/a", identity: "task.json" },
    { path: "2026-09-16/b", identity: "task.json" },
    { path: "2026-09-16/c", identity: "task.json" },
    { path: "导入参考图/aa.png", identity: null },
    { path: "导入参考图/bb.png", identity: null },
  ];

  it("只按任务目录计导入与跳过数；参考图冲突也列出", () => {
    const summary = importSummary(units, [
      { path: "2026-09-16/a", outcome: "moved" },
      { path: "2026-09-16/b", outcome: "identical" },
      { path: "2026-09-16/c", outcome: "conflict" },
      { path: "导入参考图/aa.png", outcome: "identical" },
      { path: "导入参考图/bb.png", outcome: "conflict" },
    ]);
    expect(summary).toEqual({ imported: 1, skipped: 1, conflicts: ["2026-09-16/c", "导入参考图/bb.png"], message: "导入 1 个任务，跳过 1 个，2 项冲突未覆盖" });
  });

  it("无冲突时不附冲突数", () => {
    expect(importSummary(units.slice(0, 1), [{ path: "2026-09-16/a", outcome: "moved" }]).message).toBe("导入 1 个任务，跳过 0 个");
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

describe("导入画板包", () => {
  /** zip 读取器认不了的包（不是 zip）：跳过本地检查，整包上传后由服务端读条目判定。 */
  const PACK = new File(["zip"], "千问测试.ugcpack");
  /** 真 zip：本地检查读得了。.json 条目 deflate，其余 stored，都带 data descriptor（与 Web 导出一致）。 */
  const zipFile = (pack: Record<string, string>) =>
    new File([buildZip(Object.entries(pack).map(([name, data]) => ({ name, data, method: name.endsWith(".json") ? 8 : 0, descriptor: true })))], "千问测试.ugcpack");
  const UPLOAD_ID = "up-1";
  const TASK = "2026-09-16/20260916T010000Z-0000000a";
  const SECRET = "机密提示词：橘猫";
  const boardA = "画板/甲.ugcboard.json";
  const boardB = "画板/乙.ugcboard.json";
  const withPrompt = (name: string): Board => ({
    ...newBoard(name),
    nodes: [{ ...base, id: "p", type: "prompt", text: SECRET }],
  });
  const goodPack: Record<string, string> = {
    [PACK_MANIFEST]: buildManifest("0.2.0", [boardA, boardB]),
    [boardA]: serializeBoard(withPrompt("甲")),
    [boardB]: serializeBoard(withPrompt("乙")),
    [`${TASK}/task.json`]: "{}",
    [`${TASK}/result.png`]: "",
  };

  /** 内存包命令：记录各步调用与移入的合并单元；failUpload 让上传以该错误 reject，failAfterMove 让导入移完第一个单元后以该错误 reject。 */
  function memoryPackIo(pack: Record<string, string>, opts: { failAfterMove?: unknown; failUpload?: unknown } = {}) {
    const moved: string[] = [];
    const steps: string[] = [];
    const restored: { path: string; source: string }[] = [];
    const io: PackIo = {
      cancel: async (cancelled) => void steps.push(`cancel(${cancelled})`),
      upload: async (file) => {
        steps.push(`upload(${file.name})`);
        if (opts.failUpload !== undefined) throw opts.failUpload;
        return UPLOAD_ID;
      },
      entries: async (id) => {
        steps.push(`entries(${id})`);
        return Object.keys(pack);
      },
      readTexts: async (_pack, names) => {
        steps.push("readTexts");
        return Object.fromEntries(names.filter((n) => n in pack).map((n) => [n, pack[n]]));
      },
      discard: async (id) => void steps.push(`discard(${id})`),
      importUnits: async (id, units, duplicates) => {
        steps.push(`import(${id})`);
        restored.push(...duplicates);
        for (const unit of units) {
          moved.push(unit.path);
          if (opts.failAfterMove !== undefined) throw opts.failAfterMove;
        }
        return { outcomes: units.map((u) => ({ path: u.path, outcome: "moved" as const })), bytes: 1234 };
      },
    };
    return { io, moved, steps, restored };
  }

  function run(io: PackIo, addBoard: (board: Board) => Promise<string> = async (b) => `${ROOT}\\画板\\${b.title}.ugcboard.json`, file: File = PACK) {
    const logs: Record<string, unknown>[] = [];
    const added: string[] = [];
    const stages: string[] = [];
    const outcome = importPack(io, {
      file,
      addBoard: async (board) => {
        added.push(board.title);
        return addBoard(board);
      },
      onStage: (stage) => stages.push(stage),
      log: (kind, fields) => void logs.push({ kind, ...fields }),
    });
    return { outcome, logs, added, stages };
  }

  it("读取器认不了的包、版本更高：整包上传后由服务端条目判定，不合并、不写画板，放弃上传，日志记 newer", async () => {
    const newer = { ...goodPack, [PACK_MANIFEST]: JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION + 1, app_version: "9", boards: [] }) };
    const { io, moved, steps } = memoryPackIo(newer);
    const r = run(io);
    expect(await r.outcome).toMatchObject({ kind: "newer" });
    expect(moved).toEqual([]);
    expect(steps).toEqual(["cancel(false)", "upload(千问测试.ugcpack)", `entries(${UPLOAD_ID})`, "readTexts", `discard(${UPLOAD_ID})`]);
    expect(r.added).toEqual([]);
    expect(r.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", result: "newer" }]);
  });

  it("读取器认不了的包、损坏（布局不合法或服务端读不了条目）：不写任何文件，日志记 corrupt", async () => {
    const { io, moved } = memoryPackIo({ ...goodPack, "素材/猫.png": "" });
    const r = run(io);
    expect(await r.outcome).toMatchObject({ kind: "corrupt", reason: expect.stringContaining("素材/猫.png") });
    expect(moved).toEqual([]);
    expect(r.added).toEqual([]);

    const broken = memoryPackIo(goodPack);
    broken.io.entries = async () => {
      throw new Error("不是 zip");
    };
    const r2 = run(broken.io);
    expect(await r2.outcome).toEqual({ kind: "corrupt", reason: "不是 zip" });
    expect(r2.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", result: "corrupt" }]);
  });

  it("上传被取消：返回 cancelled，不读条目、不读文本、不合并、不写画板", async () => {
    const { io, moved, steps } = memoryPackIo(goodPack, { failUpload: PACK_CANCELLED });
    const r = run(io);
    expect(await r.outcome).toEqual({ kind: "cancelled" });
    expect(steps).toEqual(["cancel(false)", "upload(千问测试.ugcpack)"]);
    expect(moved).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.stages).toEqual(["progress"]);
    expect(r.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", result: "cancelled" }]);
  });

  it("上传失败：返回 failed 与报错原文，不读条目、不读文本、不合并、不写画板", async () => {
    const { io, moved, steps } = memoryPackIo(goodPack, { failUpload: new Error("服务器空间不足，请联系管理员") });
    const r = run(io);
    expect(await r.outcome).toEqual({ kind: "failed", error: "服务器空间不足，请联系管理员" });
    expect(steps).toEqual(["cancel(false)", "upload(千问测试.ugcpack)"]);
    expect(moved).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", result: "failed" }]);
  });

  it("上传后读条目时被取消：返回 cancelled，不合并，放弃上传", async () => {
    const { io, moved, steps } = memoryPackIo(goodPack);
    io.entries = async () => {
      steps.push("entries");
      throw new Error(PACK_CANCELLED);
    };
    const r = run(io);
    expect(await r.outcome).toEqual({ kind: "cancelled" });
    expect(moved).toEqual([]);
    expect(steps).toEqual(["cancel(false)", "upload(千问测试.ugcpack)", "entries", `discard(${UPLOAD_ID})`]);
  });

  it("导入中取消：返回 cancelled，已移入的任务目录保留，不写画板", async () => {
    const { io, moved } = memoryPackIo(goodPack, { failAfterMove: PACK_CANCELLED });
    const r = run(io);
    expect(await r.outcome).toEqual({ kind: "cancelled" });
    expect(moved).toEqual([TASK]);
    expect(r.added).toEqual([]);
    expect(r.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", board_file: "甲.ugcboard.json, 乙.ugcboard.json", result: "cancelled" }]);
  });

  it("导入命令失败：返回 failed 与报错原文，日志只记类别", async () => {
    const { io } = memoryPackIo(goodPack, { failAfterMove: new Error(`磁盘已满 ${SECRET}`) });
    const r = run(io);
    expect(await r.outcome).toEqual({ kind: "failed", error: `磁盘已满 ${SECRET}` });
    expect(r.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", board_file: "甲.ugcboard.json, 乙.ugcboard.json", result: "failed" }]);
  });

  it("读取器认不了的包、成功：先复位取消再进入进度，上传后按上传句柄判定与导入，逐个写画板，日志记计数与实际写入的文件名", async () => {
    const { io, steps } = memoryPackIo(goodPack);
    const r = run(io, async (b) => `${ROOT}\\画板\\${b.title} (2).ugcboard.json`);
    const outcome = await r.outcome;
    expect(steps).toEqual(["cancel(false)", "upload(千问测试.ugcpack)", `entries(${UPLOAD_ID})`, "readTexts", `import(${UPLOAD_ID})`]);
    expect(r.stages).toEqual(["progress"]);
    expect(r.added).toEqual(["甲", "乙"]);
    expect(outcome).toEqual({
      kind: "done",
      summary: { imported: 1, skipped: 0, conflicts: [], message: "导入 1 个任务，跳过 0 个" },
      written: ["甲 (2).ugcboard.json", "乙 (2).ugcboard.json"],
      writeError: null,
    });
    expect(r.logs).toEqual([
      { kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", task_dirs: 1, skipped: 0, conflicts: 0, bytes: 1234, board_file: "甲 (2).ugcboard.json, 乙 (2).ugcboard.json", result: "ok" },
    ]);
  });

  it("v2 包：被省略路径的还原清单随合并单元一起交给壳；v1 包为空", async () => {
    const v2Pack = { ...goodPack, [PACK_MANIFEST]: JSON.stringify({ pack_format_version: 2, app_version: "0.4.0", boards: [boardA, boardB], duplicates: { [`${TASK}/references/01.png`]: `${TASK}/result.png` } }) };
    const v2 = memoryPackIo(v2Pack);
    expect(await run(v2.io).outcome).toMatchObject({ kind: "done" });
    expect(v2.moved).toEqual([TASK]);
    expect(v2.restored).toEqual([{ path: `${TASK}/references/01.png`, source: `${TASK}/result.png` }]);
    const v1 = memoryPackIo(goodPack);
    await run(v1.io).outcome;
    expect(v1.restored).toEqual([]);
  });

  it("第 2 个画板写失败：第 1 个保留、第一个失败即停、writeError 有值、日志记 board_write_failed", async () => {
    const { io } = memoryPackIo(goodPack);
    const r = run(io, async (b) => {
      if (b.title === "乙") throw new Error(`画板目录只读 ${SECRET}`);
      return `${ROOT}\\画板\\${b.title}.ugcboard.json`;
    });
    expect(await r.outcome).toMatchObject({ kind: "done", written: ["甲.ugcboard.json"], writeError: `画板目录只读 ${SECRET}` });
    expect(r.logs).toEqual([
      { kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", task_dirs: 1, skipped: 0, conflicts: 0, bytes: 1234, board_file: "甲.ugcboard.json, 乙.ugcboard.json", result: "board_write_failed" },
    ]);
  });

  describe("浏览器本地检查（#61）", () => {
    const newerPack = { ...goodPack, [PACK_MANIFEST]: JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION + 1, app_version: "9", boards: [] }) };

    it("清单版本更高：不上传、不读服务端条目，返回 newer，日志记 newer", async () => {
      const { io, steps } = memoryPackIo(newerPack);
      const r = run(io, undefined, zipFile(newerPack));
      expect(await r.outcome).toMatchObject({ kind: "newer", message: expect.stringContaining(`格式版本 ${PACK_FORMAT_VERSION + 1}`) });
      expect(steps).toEqual(["cancel(false)"]);
      expect(r.added).toEqual([]);
      expect(r.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", result: "newer" }]);
    });

    it("包内画板版本更高：不上传，返回 newer", async () => {
      const pack = { ...goodPack, [boardB]: JSON.stringify({ format_version: 99, title: "乙", nodes: [], edges: [] }) };
      const { io, steps } = memoryPackIo(pack);
      expect(await run(io, undefined, zipFile(pack)).outcome).toMatchObject({ kind: "newer" });
      expect(steps).toEqual(["cancel(false)"]);
    });

    it("布局不合法：不上传，返回 corrupt 与原因，日志记 corrupt", async () => {
      const pack = { ...goodPack, "素材/猫.png": "" };
      const { io, steps } = memoryPackIo(pack);
      const r = run(io, undefined, zipFile(pack));
      expect(await r.outcome).toEqual({ kind: "corrupt", reason: "包内含无法识别的路径：素材/猫.png" });
      expect(steps).toEqual(["cancel(false)"]);
      expect(r.logs).toEqual([{ kind: "board_pack", action: "import", pack_file: "千问测试.ugcpack", result: "corrupt" }]);
    });

    it("v2 的 duplicates 不合法：不上传，返回 corrupt", async () => {
      const pack = { ...goodPack, [PACK_MANIFEST]: JSON.stringify({ pack_format_version: 2, app_version: "0.4.0", boards: [boardA, boardB], duplicates: { [`${TASK}/a.png`]: `${TASK}/没有.png` } }) };
      const { io, steps } = memoryPackIo(pack);
      expect(await run(io, undefined, zipFile(pack)).outcome).toMatchObject({ kind: "corrupt", reason: expect.stringContaining("不存在的条目") });
      expect(steps).toEqual(["cancel(false)"]);
    });

    it("检查通过：整包上传后直接按本地判定合并，不再在服务端读条目与文本", async () => {
      const { io, steps, moved } = memoryPackIo(goodPack);
      const r = run(io, undefined, zipFile(goodPack));
      expect(await r.outcome).toMatchObject({ kind: "done", summary: { imported: 1 }, written: ["甲.ugcboard.json", "乙.ugcboard.json"] });
      expect(steps).toEqual(["cancel(false)", "upload(千问测试.ugcpack)", `import(${UPLOAD_ID})`]);
      expect(moved).toEqual([TASK]);
      expect(r.stages).toEqual(["progress"]);
    });

    it("检查通过的 v2 包：本地读出的还原清单交给壳", async () => {
      const pack = { ...goodPack, [PACK_MANIFEST]: JSON.stringify({ pack_format_version: 2, app_version: "0.4.0", boards: [boardA, boardB], duplicates: { [`${TASK}/references/01.png`]: `${TASK}/result.png` } }) };
      const v2 = memoryPackIo(pack);
      expect(await run(v2.io, undefined, zipFile(pack)).outcome).toMatchObject({ kind: "done" });
      expect(v2.restored).toEqual([{ path: `${TASK}/references/01.png`, source: `${TASK}/result.png` }]);
    });

    it("目录条目不计入布局（与服务端列条目一致）", async () => {
      const { io, steps } = memoryPackIo(goodPack);
      const file = new File([buildZip([...Object.entries(goodPack).map(([name, data]) => ({ name, data })), { name: "2026-09-16/", data: "" }])], "千问测试.ugcpack");
      expect(await run(io, undefined, file).outcome).toMatchObject({ kind: "done" });
      expect(steps).toEqual(["cancel(false)", "upload(千问测试.ugcpack)", `import(${UPLOAD_ID})`]);
    });

    it("读取器不支持的压缩方法：跳过本地检查，整包上传，由服务端判定", async () => {
      const { io, steps } = memoryPackIo(goodPack);
      const file = new File([buildZip(Object.entries(goodPack).map(([name, data]) => ({ name, data, method: name.endsWith(".png") ? 12 : 0 })))], "千问测试.ugcpack");
      expect(await run(io, undefined, file).outcome).toMatchObject({ kind: "done" });
      expect(steps).toEqual(["cancel(false)", "upload(千问测试.ugcpack)", `entries(${UPLOAD_ID})`, "readTexts", `import(${UPLOAD_ID})`]);
    });

    it("仓库里的 0.2.0 / 0.3.2 桌面包与 v2 包：本地检查通过，合并单元与还原清单齐全", async () => {
      const local = async (path: string) => inspectPackLocally(blobSource(new File([readFileSync(path)], "x.ugcpack")));
      expect(await local("../contracts/smoke/board-pack/千问测试.ugcpack")).toMatchObject({ kind: "ok", boards: [{ entry: "画板/千问测试.ugcboard.json" }] });
      expect(await local("fixtures/packs/v0.3.2-flash-layers.ugcpack")).toMatchObject({ kind: "ok", units: expect.arrayContaining([{ path: TASK, identity: "task.json" }]) });
      expect(await local("fixtures/packs/v2-duplicates.ugcpack")).toMatchObject({
        kind: "ok",
        duplicates: [{ path: "2026-09-16/20260916T020000Z-0000000b/references/01.png", source: `${TASK}/result.png` }],
      });
    });

    it("本地读到损坏的 deflate 数据：不当作损坏，整包上传由服务端判定", async () => {
      const bytes = buildZip(Object.entries(goodPack).map(([name, data]) => ({ name, data, method: name === PACK_MANIFEST ? 8 : 0 })));
      // 清单是第一个条目：把它的压缩数据改成无效的 deflate 块（BTYPE = 11）。
      bytes[30 + PACK_MANIFEST.length] = 0xff;
      const { io, steps } = memoryPackIo(goodPack);
      expect(await run(io, undefined, new File([bytes], "千问测试.ugcpack")).outcome).toMatchObject({ kind: "done" });
      expect(steps).toEqual(["cancel(false)", "upload(千问测试.ugcpack)", `entries(${UPLOAD_ID})`, "readTexts", `import(${UPLOAD_ID})`]);
    });
  });

  it("日志不含提示词与报错原文：只有类别、文件名与计数", async () => {
    const cases = [memoryPackIo(goodPack).io, memoryPackIo(goodPack, { failAfterMove: new Error(SECRET) }).io];
    const logs: Record<string, unknown>[] = [];
    for (const io of cases) {
      const r = run(io, async () => {
        throw new Error(SECRET);
      });
      await r.outcome;
      logs.push(...r.logs);
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const entry of logs) {
      expect(JSON.stringify(entry)).not.toContain("橘猫");
      for (const [key, value] of Object.entries(entry)) {
        expect(["kind", "action", "pack_file", "board_file", "result", "task_dirs", "skipped", "conflicts", "bytes"]).toContain(key);
        expect(typeof value === "number" || typeof value === "string").toBe(true);
      }
    }
  });
});

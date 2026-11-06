import { describe, expect, it } from "vitest";
import type { Board, BoardNode } from "./board";
import { parseOutcome } from "./taskDir";
import { board, harness, settle } from "./testing/runnerHarness";
import { createRunner, nodeCopyDetail, nodeStatus, nodeSummary, summaryTone } from "./runner";
import { BUILTIN_TABLE } from "./capabilities";
import { memoryTaskFs } from "./testing/memoryTaskFs";
import { sendPlanOf } from "./taskView";
import type { RunDeps } from "./run";

// Official flat-response example encoded with synthetic bytes. No real gateway evidence.
describe("Flash 图层运行器：官方契约合成回放", () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const box = { absolute: [100, 200, 300, 400], normalized: [100, 200, 300, 400] };
  const fixture = (opts: { width?: number; height?: number; input?: Uint8Array; layerDownloadFails?: boolean; layerJpeg?: boolean; decodeFails?: boolean } = {}) => {
    const fs = memoryTaskFs();
    const changes: any[] = [], payloads: any[] = [];
    let alpha = true;
    const deps: RunDeps = { ...fs, readFile: async (p) => p === "/root/refs/cat.png" ? opts.input ?? png : fs.readFile(p), now: () => new Date("2026-10-10T00:00:00Z"), schedule: () => () => {}, imageCodec: { decode: async () => { if (opts.decodeFails) throw new Error("decode"); return { width: opts.width ?? 1000, height: opts.height ?? 1000, hasAlpha: () => alpha, close: () => {}, encode: async () => png }; } }, fetch: async (_url, init) => { if (init.method === "GET") return { status: 403, headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) }; payloads.push(JSON.parse(init.body!)); return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{ z_index: 1, ...(opts.layerDownloadFails ? { url: "https://synthetic.test/layer" } : { b64_json: btoa(String.fromCharCode(...(opts.layerJpeg ? new Uint8Array([255, 216, 255, 1]) : png))) }), bounding_box: box }, { z_index: 0, b64_json: btoa(String.fromCharCode(...png)) }] }), arrayBuffer: async () => png.slice().buffer }; } };
    const runner = createRunner({ deps, apply: (_key, c) => changes.push(c), log: () => {}, concurrency: 1 });
    const b = board(["t1"], true);
    b.edges = b.edges.filter((e) => e.to[1] !== "positive");
    for (const n of b.nodes) if (n.type === "task") { n.model = "doubao-seedream-5-0-flash-260915"; n.layer_decomposition = true; }
    const target = { boardKey: "A", boardFile: null, table: BUILTIN_TABLE, userRoot: "/root", baseUrl: "https://synthetic.test", apiKey: "test" };
    return { fs, changes, payloads, runner, b, target, setAlpha: (v: boolean) => { alpha = v; } };
  };
  it.each([{ width: 511, height: 512 }, { width: 6001, height: 6000 }, { width: 16001, height: 1000 }, { input: new Uint8Array(30000001) }, { input: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]) }, { decodeFails: true }])("专用输入非法时不发送网关 %#", async (opts) => {
    const h = fixture(opts);
    expect(await h.runner.submit(h.target, h.b, ["t1"])).not.toEqual([]);
    await settle();
    expect(h.payloads).toHaveLength(0);
    expect(h.fs.files.size).toBe(0);
  });
  it.each([{ layerDownloadFails: true }, { layerJpeg: true }])("任一图层下载或格式失败，整体没有成功结果 %#", async (opts) => {
    const h = fixture(opts);
    await h.runner.submit(h.target, h.b, ["t1"]); await settle();
    expect(nodeStatus(h.runner.getSnapshot().board("A").nodes.get("t1"))?.kind).toBe("failed");
    expect(h.changes.filter((c) => c.kind === "runResult")).toHaveLength(0);
    expect([...h.fs.files.keys()].filter((p) => /\/result\.|\/layers\//.test(p))).toEqual([]);
  });
  it("无需提示词提交单图，只产出一个完整结果并保存定位元数据", async () => {
    const h = fixture();
    expect(await h.runner.submit(h.target, h.b, ["t1"])).toEqual([]);
    await settle();
    expect(h.payloads[0]).toMatchObject({ layer_decomposition: true, size: "auto" });
    expect(h.payloads[0]).not.toHaveProperty("prompt");
    const results = h.changes.filter((c) => c.kind === "runResult");
    expect(results).toHaveLength(1);
    expect(results[0].result.layers).toEqual([{ file: "layers/01.png", z_index: 1, bounding_box: box }]);
    expect([...h.fs.files.keys()].some((p) => p.endsWith("/layers.json"))).toBe(true);
  });
  it("任一图层没有 alpha 则整体失败，没有结果或成功图片落盘", async () => {
    const h = fixture(); h.setAlpha(false);
    await h.runner.submit(h.target, h.b, ["t1"]); await settle();
    expect(nodeStatus(h.runner.getSnapshot().board("A").nodes.get("t1"))).toEqual({ kind: "failed", label: "响应无效" });
    expect(h.changes.filter((c) => c.kind === "runResult")).toHaveLength(0);
    expect([...h.fs.files.keys()].filter((p) => /\/result\.|\/layers\//.test(p))).toEqual([]);
  });
});
it("Flash 区域发送文本、原图/叠加图顺序及任务记录经runner保持一致，重新生成还原坐标", async () => {
  const fs = memoryTaskFs();
  const b = board(["t1"], true);
  const t = b.nodes.find((n) => n.type === "task")!;
  if (t.type !== "task") throw new Error("task");
  t.model = "doubao-seedream-5-0-flash-260915";
  const image = b.edges.find((e) => e.to[1] === "image:0")!;
  image.region = { rects: [[0, 0, 1, 1]], render: "bbox_tag", coordinate_kind: "point" };
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
  fs.files.set("/root/refs/cat.png", png);
  const bodies: any[] = [];
  const r = createRunner({ concurrency: 1, log: () => {}, apply: (_, c) => { if (c.kind === "submitted") t.last_submitted = c.lastSubmitted; }, deps: {
    ...fs, now: () => new Date("2026-10-10T10:00:00Z"), schedule: () => () => {},
    imageCodec: { decode: async () => ({ width: 1024, height: 1024, hasAlpha: () => true, encode: async () => png, close() {} }) },
    fetch: async (_, init) => { bodies.push(JSON.parse(String(init?.body))); return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{ b64_json: btoa(String.fromCharCode(...png)) }] }), arrayBuffer: async () => png.buffer as ArrayBuffer }; },
  }});
  const target = { boardKey: "A", boardFile: "A", table: BUILTIN_TABLE, userRoot: "/root", baseUrl: "http://gw", apiKey: "k" };
  const shown = sendPlanOf(b, BUILTIN_TABLE, "t1")!;
  expect(await r.submit(target, b, ["t1"])).toEqual([]);
  await settle();
  const records = [...fs.files].filter(([p]) => p.endsWith("/task.json")).map(([, bytes]) => JSON.parse(new TextDecoder().decode(bytes)));
  expect(records[0].send_text).toBe(shown.text);
  expect(bodies[0].prompt).toBe(shown.text);
  expect(bodies[0].image).toHaveLength(1);
  expect(records[0].references[0].region).toEqual({ rects: [[0, 0, 1, 1]], render: "bbox_tag", coordinate_kind: "point", source_port: 1 });
  expect(await r.regenerate(target, b, "t1")).toBeNull();
  await settle();
  expect(bodies[1].prompt).toBe(shown.text);
  image.region!.rects = [[-1, 0, 1, 1]];
  expect(await r.submit(target, b, ["t1"])).toHaveLength(1);
  expect(bodies).toHaveLength(2);
});

describe("Lite 停用", () => {
  it("普通运行明确阻止，不调用网关或写入任务目录", async () => {
    const h = harness();
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-lite-260128";
    expect(await h.runner.submit(h.target(), b, ["t1"])).toEqual(["Lite 已停用，请切换到 Flash"]);
    await settle();
    expect(h.requests).toEqual([]);
    expect(h.files.size).toBe(0);
    expect(h.changes).toEqual([]);
  });
  it.each([undefined, "20260916T091500Z-deadbeef"])("历史 Lite 重新生成/变体在当前节点已改 Flash 后仍阻止且不改历史 (%s)", async (fromTaskId) => {
    const h = harness();
    const b = board();
    const t = b.nodes.find((n) => n.type === "task")!;
    if (t.type !== "task") throw new Error("task");
    const taskId = "20260916T091500Z-deadbeef";
    const path = `/root/2026-09-16/${taskId}/task.json`;
    const old = new TextEncoder().encode(JSON.stringify({ task_id: taskId, submitted_at: "2026-09-16T09:15:00Z", workflow: "text_to_image", model: "doubao-seedream-5-0-lite-260128", capability_format_version: 1, capability_table_sha256: "a".repeat(64), prompt: "旧猫", negative_prompt: "", send_text: "旧猫", size_spec: { tier: "3K", ratio: "1:1", width: null, height: null }, size: { width: 3072, height: 3072 }, layer_decomposition: false, transparent_background: false, references: [] }));
    h.files.set(path, old);
    t.model = "doubao-seedream-5-0-flash-260915";
    t.last_submitted = { task_id: taskId, model: "doubao-seedream-5-0-lite-260128", prompt: "旧猫", negative_prompt: "", size_spec: { tier: "3K", ratio: "1:1", width: null, height: null }, layer_decomposition: false, transparent_background: false, images: [] };
    expect(await h.runner.regenerate(h.target(), b, "t1", fromTaskId)).toBe("Lite 已停用，请切换到 Flash");
    expect(h.requests).toEqual([]);
    expect(h.files.size).toBe(1);
    expect(h.files.get(path)).toEqual(old);
  });
  it("旧 Lite 结果作为 Flash 任务的参考图仍可提交，快照与谱系指向旧任务目录", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
    const h = harness({ imageCodec: { decode: async () => ({ width: 1024, height: 1024, hasAlpha: () => false, encode: async () => png, close: () => {} }) } });
    h.replies.push({ status: 200, body: JSON.stringify({ data: [{ b64_json: btoa(String.fromCharCode(...png)) }] }) });
    const b = board();
    const t = b.nodes.find((n) => n.type === "task")!;
    if (t.type !== "task") throw new Error("task");
    t.model = "doubao-seedream-5-0-flash-260915";
    t.image_ports = 1;
    h.files.set("/root/2026-09-16/task-old/result.png", png);
    b.nodes.push({ id: "old", type: "result", pos: [0, 200], size: [100, 100], extra: {}, task_id: "task-old", file: "result.png", path: "2026-09-16/task-old/result.png", layer_count: 0, record: { model: "doubao-seedream-5-0-lite-260128", prompt: "旧猫", negative_prompt: "", size_spec: { tier: "3K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-09-16T09:15:00Z" } });
    b.edges.push({ from: ["old", "out"], to: ["t1", "image:0"], source_layer: null, region: null, system: false, extra: {} });
    expect(await h.runner.submit(h.target(), b, ["t1"])).toEqual([]);
    await settle();
    expect(h.requests).toEqual(["http://gw/v1/images/generations"]);
    const record = [...h.files].filter(([p]) => p.endsWith("/task.json")).map(([, bytes]) => JSON.parse(new TextDecoder().decode(bytes)))[0];
    expect(record.model).toBe("doubao-seedream-5-0-flash-260915");
    expect(record.references[0].source).toEqual({ kind: "result", task_id: "task-old", file: "result.png" });
    expect([...h.files].find(([p]) => p.endsWith("/reference-1.png"))![1]).toEqual(png);
  });
});

describe("Flash 失败政策", () => {
  it.each(["base64", "URL"])("%s 的 PNG 签名残片解码失败，不存结果或产出节点", async (transport) => {
    const damaged = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    const decoded: Uint8Array[] = [];
    const h = harness({ imageCodec: { decode: async (bytes) => {
      decoded.push(bytes);
      throw new Error("truncated PNG");
    } } });
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-flash-260915";
    h.replies.push({ status: 200, body: JSON.stringify({ data: [transport === "URL" ? { url: "https://result.test/broken.png" } : { b64_json: btoa(String.fromCharCode(...damaged)) }] }) });
    if (transport === "URL") h.replies.push({ status: 200, body: "", bytes: damaged });
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "failed", label: "响应无效" });
    expect(decoded).toEqual([damaged]);
    expect(h.changes.filter((c) => c.change.kind === "runResult")).toEqual([]);
    expect([...h.files.keys()].some((path) => /\/result\./.test(path))).toBe(false);
  });
  it.each([401, 400, 500])("HTTP %i 不重发，保留失败", async (status) => {
    const h = harness();
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-flash-260915";
    h.replies.push({ status, body: "{}" });
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    expect(h.statuses().t1?.kind).toBe("failed");
    h.advance(300000);
    await settle();
    expect(h.requests).toHaveLength(1);
  });
  it.each([
    { data: [] },
    { data: [{ url: "https://result.test/a" }, { url: "https://result.test/b" }] },
    { data: [{ b64_json: "not-valid!" }] },
  ])("坏响应失败，不产出结果节点", async (body) => {
    const h = harness();
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-flash-260915";
    h.replies.push({ status: 200, body: JSON.stringify(body) });
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "failed", label: "响应无效" });
    expect(h.changes.filter((c) => c.change.kind === "runResult")).toEqual([]);
    expect(h.requests).toHaveLength(1);
  });
  it("URL 下载拒绝明确失败且不重发生成", async () => {
    const h = harness();
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-flash-260915";
    h.replies.push({ status: 200, body: JSON.stringify({ data: [{ url: "https://result.test/a" }] }) }, { status: 403, body: "denied" });
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "failed", label: "网关拒绝" });
    expect(h.requests).toEqual(["http://gw/v1/images/generations", "https://result.test/a"]);
    expect(h.changes.filter((c) => c.change.kind === "runResult")).toEqual([]);
  });
  it("429 明确失败，不自动退避重发或换模型", async () => {
    const h = harness();
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-flash-260915";
    h.replies.push({ status: 429, body: "{}" });
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "failed", label: "网关限流" });
    expect(h.requests).toHaveLength(1);
    expect(h.transitions()).not.toContain("t1:running→backoff");
  });
});

describe("任务运行器：成功", () => {
  it("先后产出「提交记录」「运行结果」两条系统变更，状态清空", async () => {
    const h = harness();
    const problems = await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(problems).toEqual([]);
    expect(h.changes.map((c) => [c.boardKey, c.change.kind])).toEqual([
      ["A", "submitted"],
      ["A", "runResult"],
    ]);
    const [submitted, result] = h.changes.map((c) => c.change);
    expect(submitted).toMatchObject({ taskId: "t1", lastSubmitted: { prompt: "一只橘猫" } });
    const taskId = submitted.kind === "submitted" ? submitted.lastSubmitted?.task_id : null;
    expect(result).toMatchObject({ result: { taskId: "t1", submittedTaskId: taskId } });
    expect(h.statuses()).toEqual({});
    expect(h.locked()).toEqual([]);
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.transitions()).toEqual(["t1:null→queued", "t1:queued→running", "t1:running→succeeded"]);
  });
});

describe("任务运行器：取消", () => {
  it("等待中取消且从未派发：不写任务目录、不写 last_submitted、状态清空", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"]);
    await settle();
    expect(h.statuses()).toMatchObject({ t1: { kind: "running" }, t2: { kind: "queued" } });
    const dirsBefore = h.taskDirs();
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t2" });
    expect(h.statuses().t2).toBeUndefined();
    expect(h.locked()).toEqual(["t1"]);
    h.gateway.open();
    await settle();
    expect(h.taskDirs()).toEqual(dirsBefore);
    expect(h.changes.filter((c) => c.change.kind === "submitted").map((c) => c.change.kind === "submitted" && c.change.taskId)).toEqual(["t1"]);
    expect(h.transitions()).toContain("t2:queued→cancelled");
    expect(h.logs.find((l) => l.fields.task_node_id === "t2" && l.fields.to_status === "cancelled")?.fields.gateway_may_continue).toBe(false);
  });

  it("限流退避中取消：已取消、gatewayMayContinue = false、记 outcome.json", async () => {
    const h = harness();
    h.replies.push({ status: 429, body: "{}" });
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.statuses().t1).toMatchObject({ kind: "backoff" });
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "cancelled", gatewayMayContinue: false });
    expect(h.locked()).toEqual([]);
    expect(outcomes(h)).toEqual([{ kind: "cancelled", gatewayMayContinue: false }]);
    expect(h.transitions().at(-1)).toBe("t1:backoff→cancelled");
  });

  it("执行中取消：gatewayMayContinue = true、记 outcome.json、结果不落画板", async () => {
    const h = harness();
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.gateway.held).toBe(1);
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    expect(h.statuses().t1).toEqual({ kind: "cancelled", gatewayMayContinue: true });
    h.gateway.open();
    await settle();
    expect(outcomes(h)).toEqual([{ kind: "cancelled", gatewayMayContinue: true }]);
    expect(h.changes.map((c) => c.change.kind)).toEqual(["submitted"]);
    expect([...h.files.keys()].some((k) => k.includes("result"))).toBe(false);
    expect(h.statuses().t1).toEqual({ kind: "cancelled", gatewayMayContinue: true });
  });

  it("写任务目录期间取消：目录写完后补记结局，不调网关", async () => {
    const h = harness();
    h.write.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.write.held).toBe(1);
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    expect(h.statuses().t1).toEqual({ kind: "cancelled", gatewayMayContinue: false });
    h.write.open();
    await settle();
    expect(outcomes(h)).toEqual([{ kind: "cancelled", gatewayMayContinue: false }]);
    expect(h.requests).toEqual([]);
  });

  it("读参考图期间取消：不入队、不留状态；同批后续任务不再读图", async () => {
    const h = harness();
    h.read.closed = true;
    const submitting = h.runner.submit(h.target(), board(["t1", "t2"], true), ["t1", "t2"]);
    await settle();
    expect(h.statuses()).toEqual({ t1: { kind: "queued" } });
    expect(h.runner.getSnapshot().pending("A")).toBe(1);
    h.runner.cancel({ kind: "board", boardKey: "A" });
    expect(h.statuses()).toEqual({});
    expect(h.read.held).toBe(1);
    h.read.open();
    expect(await submitting).toEqual([]);
    await settle();
    expect(h.statuses()).toEqual({});
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.files.size).toBe(0);
    expect(h.logs).toEqual([]);
    // t2 没有参考图：若提交了，会读图后入队留下日志；这里只断言读图闸没再被经过。
    expect(h.read.held).toBe(0);
  });

  it("取消不存在的任务：无事发生", async () => {
    const h = harness();
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    const before = h.runner.getSnapshot();
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "zzz" });
    expect(h.runner.getSnapshot().board("A").nodes).toEqual(before.board("A").nodes);
    expect(h.logs.filter((l) => l.fields.to_status === "cancelled")).toEqual([]);
  });

  it("取消全部排队：执行中的不受影响", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2", "t3"]), ["t1", "t2", "t3"]);
    await settle();
    expect(h.runner.getSnapshot().active.map((a) => [a.taskNodeId, a.state])).toEqual([["t1", "running"], ["t2", "waiting"], ["t3", "waiting"]]);
    h.runner.cancel({ kind: "waiting" });
    expect(h.statuses()).toEqual({ t1: expect.objectContaining({ kind: "running" }) });
    h.gateway.open();
    await settle();
    expect(h.changes.map((c) => c.change.kind)).toEqual(["submitted", "runResult"]);
  });
});

describe("任务运行器：按份数展开", () => {
  const node = (h: ReturnType<typeof harness>, id: string) => h.runner.getSnapshot().board("A").nodes.get(id);
  const results = (h: ReturnType<typeof harness>) => h.changes.filter((c) => c.change.kind === "runResult");
  const submittedIds = (h: ReturnType<typeof harness>) => h.changes.flatMap((c) => (c.change.kind === "submitted" ? [c.change.lastSubmitted?.task_id] : []));
  /** 最后一次写到任务节点上的 last_submitted。 */
  const lastSubmitted = (h: ReturnType<typeof harness>) => h.changes.flatMap((c) => (c.change.kind === "submitted" ? [c.change.lastSubmitted as Record<string, unknown>] : [])).at(-1)!;
  const boardWithLast = (b: Board, last: Record<string, unknown>): Board => ({ ...b, nodes: b.nodes.map((n) => (n.type === "task" ? { ...n, last_submitted: last } : n)) });
  /** 各任务目录 task.json 去掉任务编号后的内容。 */
  const records = (h: ReturnType<typeof harness>) =>
    [...h.files].filter(([k]) => k.endsWith("/task.json")).map(([, v]) => {
      const { task_id, ...rest } = JSON.parse(new TextDecoder().decode(v));
      return { task_id, rest };
    });

  it("份数 N 展开为 N 个生成任务、N 个任务目录、N 条运行结果；任务记录除任务编号外相同", async () => {
    const h = harness({ concurrency: 3 });
    h.read.closed = true;
    const submitting = h.runner.submit(h.target(), board(["t1"], true), ["t1"], { t1: 3 });
    await settle();
    // 各份读参考图期间时钟走动，任务记录仍相同。
    h.advance(1500);
    h.read.open();
    expect(await submitting).toEqual([]);
    await settle();
    expect(results(h)).toHaveLength(3);
    expect(h.taskDirs().size).toBe(3);
    const recs = records(h);
    expect(new Set(recs.map((r) => r.task_id)).size).toBe(3);
    expect(recs[1].rest).toEqual(recs[0].rest);
    expect(recs[2].rest).toEqual(recs[0].rest);
    const resultTaskIds = results(h).map((c) => c.change.kind === "runResult" && c.change.result.submittedTaskId);
    expect(new Set(resultTaskIds)).toEqual(new Set(recs.map((r) => r.task_id)));
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.locked()).toEqual([]);
  });

  it("不传份数时为一份；每份各发一次 n: 1 请求", async () => {
    const h = harness();
    await h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"], { t1: 2 });
    await settle();
    expect(results(h)).toHaveLength(3);
    expect(h.bodies).toHaveLength(3);
    for (const body of h.bodies) expect(body).toMatchObject({ n: 1 });
  });

  it("各份写入 last_submitted，最后派发的一份成为节点最近一次提交", async () => {
    const h = harness({ concurrency: 1 });
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 2 });
    await settle();
    const dispatched = h.logs.filter((l) => l.kind === "queue_dispatch").map((l) => l.fields.task_id);
    expect(dispatched).toHaveLength(2);
    expect(submittedIds(h)).toEqual(dispatched);
  });

  it("last_submitted 记下同一次提交已派发的各份任务编号", async () => {
    const h = harness({ concurrency: 1 });
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 3 });
    await settle();
    const dispatched = h.logs.filter((l) => l.kind === "queue_dispatch").map((l) => l.fields.task_id);
    const last = lastSubmitted(h);
    expect(last.task_id).toBe(dispatched[2]);
    expect(last.copy_task_ids).toEqual(dispatched);
  });

  it("排队中取消、从未派发的份不进 last_submitted", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 3 });
    await settle();
    h.runner.cancel({ kind: "waiting" });
    h.gateway.open();
    await settle();
    const [first] = h.logs.filter((l) => l.kind === "queue_dispatch").map((l) => l.fields.task_id);
    expect(lastSubmitted(h)).toMatchObject({ task_id: first, copy_task_ids: [first] });
    expect(h.taskDirs().size).toBe(1);
  });

  it("一份时 last_submitted 不带各份任务编号；之后的单份重新生成不沿用上次各份", async () => {
    const h = harness();
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(lastSubmitted(h)).not.toHaveProperty("copy_task_ids");
    const h2 = harness();
    await h2.runner.submit(h2.target(), board(), ["t1"], { t1: 2 });
    await settle();
    const withCopies = boardWithLast(board(), lastSubmitted(h2));
    await h2.runner.regenerate(h2.target(), withCopies, "t1");
    await settle();
    expect(lastSubmitted(h2)).not.toHaveProperty("copy_task_ids");
  });

  it("提交后调低并发上限，不影响已排队任务的数量", async () => {
    const h = harness({ concurrency: 3 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 3 });
    await settle();
    h.runner.setConcurrency(1);
    h.gateway.open();
    await settle();
    expect(results(h)).toHaveLength(3);
  });

  it("运行全部：各节点各自展开，不限总数，超出并发的排队；运行指示每份一行", async () => {
    const h = harness({ concurrency: 2 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"], { t1: 2, t2: 2 });
    await settle();
    const active = h.runner.getSnapshot().active;
    expect(active.map((a) => [a.taskNodeId, a.state])).toEqual([["t1", "running"], ["t1", "running"], ["t2", "waiting"], ["t2", "waiting"]]);
    expect(new Set(active.map((a) => a.taskId)).size).toBe(4);
    expect(node(h, "t1")?.counts).toEqual({ running: 2 });
    expect(node(h, "t2")?.counts).toEqual({ queued: 2 });
    h.gateway.open();
    await settle();
    expect(results(h)).toHaveLength(4);
  });

  it("节点锁定到最后一份结束；期间再次运行被跳过；每份成功后立即产出结果", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 2 });
    await settle();
    // 放行第一份，第二份派发后挂在网关。
    h.gateway.open();
    h.gateway.closed = true;
    await settle();
    expect(results(h)).toHaveLength(1);
    expect(h.locked()).toEqual(["t1"]);
    expect(node(h, "t1")?.counts).toEqual({ running: 1 });
    // 只剩一份未结束：节点仍按本次提交的 2 份显示计数摘要，不变回单份徽标。
    expect(nodeSummary(node(h, "t1"))).toBe("执行中 1");
    expect(await h.runner.submit(h.target(), board(), ["t1"], { t1: 2 })).toEqual([]);
    expect(await h.runner.regenerate(h.target(), board(), "t1")).toBeNull();
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(1);
    h.gateway.open();
    await settle();
    expect(results(h)).toHaveLength(2);
    expect(h.locked()).toEqual([]);
    expect(h.requests).toHaveLength(2);
  });

  it("部分失败：成功的产出结果，失败的计入摘要，不自动补跑", async () => {
    const h = harness({ concurrency: 1 });
    h.replies.push({ status: 500, body: "{}" });
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 3 });
    await settle();
    expect(results(h)).toHaveLength(2);
    expect(h.requests).toHaveLength(3);
    const failedTaskId = h.logs.find((l) => l.kind === "task" && l.fields.to_status === "failed")?.fields.task_id;
    expect(node(h, "t1")).toEqual({ copies: [{ taskId: failedTaskId, status: { kind: "failed", label: expect.any(String) } }], counts: { failed: 1 }, total: 3 });
    // 摘要按本次提交的份数：3 份里只剩 1 份失败，仍显示计数摘要与悬停明细。
    expect(nodeSummary(node(h, "t1"))).toBe("失败 1");
    expect(nodeCopyDetail(node(h, "t1"))).toMatch(/^第 1 份：失败 · /);
  });

  it("重新运行前只清除该节点上次的终态一次，展开中的后续份不再清除", async () => {
    const h = harness();
    h.replies.push({ status: 500, body: "{}" });
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(node(h, "t1")?.counts).toEqual({ failed: 1 });
    // 参考图缺失：两份都在读图时失败。
    const b = board(["t1"], true);
    const gone = { ...b, nodes: b.nodes.map((n) => (n.id === "r" ? { ...n, path: "refs/gone.png" } : n)) as BoardNode[] };
    const problems = await h.runner.submit(h.target(), gone, ["t1"], { t1: 2 });
    expect(problems).toHaveLength(2);
    expect(node(h, "t1")?.counts).toEqual({ failed: 2 });
  });

  /** 先运行一次，把 last_submitted 写回画板，供重新生成 / 生成变体使用。 */
  async function submitted(h: ReturnType<typeof harness>) {
    const b = board();
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    const t = b.nodes.find((n) => n.id === "t1")!;
    if (t.type !== "task") throw new Error("task");
    const last = h.changes.filter((c) => c.change.kind === "submitted").at(-1)!.change;
    if (last.kind === "submitted") t.last_submitted = last.lastSubmitted ?? null;
    h.changes.length = 0;
    return { b, resultTaskId: String(t.last_submitted!.task_id) };
  }

  it("重新生成按传入的份数展开：N 个任务目录、N 条运行结果，各份写入 last_submitted", async () => {
    const h = harness({ concurrency: 3 });
    const { b } = await submitted(h);
    expect(await h.runner.regenerate(h.target(), b, "t1", undefined, 3)).toBeNull();
    await settle();
    expect(results(h)).toHaveLength(3);
    expect(h.taskDirs().size).toBe(4);
    expect(submittedIds(h)).toHaveLength(3);
    expect(new Set(submittedIds(h)).size).toBe(3);
  });

  it("重新生成不传份数时仍为一份", async () => {
    const h = harness();
    const { b } = await submitted(h);
    expect(await h.runner.regenerate(h.target(), b, "t1")).toBeNull();
    await settle();
    expect(results(h)).toHaveLength(1);
  });

  it("生成变体总是只生成一份，不改 last_submitted", async () => {
    const h = harness({ concurrency: 3 });
    const { b, resultTaskId } = await submitted(h);
    expect(await h.runner.regenerate(h.target(), b, "t1", resultTaskId, 3)).toBeNull();
    await settle();
    expect(results(h)).toHaveLength(1);
    expect(h.taskDirs().size).toBe(2);
    expect(submittedIds(h)).toEqual([]);
  });

  it("任务迁移与 queue_dispatch 按每份任务各自记录", async () => {
    const h = harness({ concurrency: 2 });
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 2 });
    await settle();
    const dispatched = h.logs.filter((l) => l.kind === "queue_dispatch").map((l) => l.fields.task_id);
    expect(new Set(dispatched).size).toBe(2);
    for (const id of dispatched) {
      const steps = h.logs.filter((l) => l.kind === "task" && l.fields.task_id === id).map((l) => `${l.fields.from_status}→${l.fields.to_status}`);
      expect(steps).toEqual(["null→queued", "queued→running", "running→succeeded"]);
    }
  });
});

describe("任务运行器：取消各份", () => {
  const nodeOf = (h: ReturnType<typeof harness>, id: string) => h.runner.getSnapshot().board("A").nodes.get(id);
  const resultCount = (h: ReturnType<typeof harness>) => h.changes.filter((c) => c.change.kind === "runResult").length;
  const activeIds = (h: ReturnType<typeof harness>) => h.runner.getSnapshot().active.map((a) => a.taskId);
  const catReads = (h: ReturnType<typeof harness>) => h.reads.filter((path) => path.endsWith("cat.png"));

  it("节点取消：一次取消执行中与排队的全部份，并解除锁定", async () => {
    const h = harness({ concurrency: 2 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 3 });
    await settle();
    expect(nodeOf(h, "t1")?.counts).toEqual({ running: 2, queued: 1 });
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    expect(nodeOf(h, "t1")?.counts).toEqual({ cancelled: 2 });
    expect(h.locked()).toEqual([]);
    expect(h.runner.getSnapshot().pending()).toBe(0);
    h.gateway.open();
    await settle();
    expect(resultCount(h)).toBe(0);
    expect(h.requests).toHaveLength(2);
    expect(outcomes(h)).toEqual([
      { kind: "cancelled", gatewayMayContinue: true },
      { kind: "cancelled", gatewayMayContinue: true },
    ]);
  });

  it("节点取消只影响该节点：其他节点的份继续", async () => {
    const h = harness({ concurrency: 4 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"], { t1: 2, t2: 2 });
    await settle();
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    expect(h.locked()).toEqual(["t2"]);
    h.gateway.open();
    await settle();
    expect(h.changes.filter((c) => c.change.kind === "runResult")).toHaveLength(2);
  });

  it("展开中途节点取消：还没读图的份不再读图、不入队，同一次提交的其他节点照常", async () => {
    const h = harness();
    h.read.closed = true;
    const submitting = h.runner.submit(h.target(), board(["t1", "t2"], true), ["t1", "t2"], { t1: 3 });
    await settle();
    expect(h.read.held).toBe(1);
    expect(nodeOf(h, "t1")?.counts).toEqual({ queued: 3 });
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    expect(nodeOf(h, "t1")).toBeUndefined();
    expect(h.locked()).toEqual([]);
    h.read.open();
    expect(await submitting).toEqual([]);
    await settle();
    expect(h.logs.filter((l) => l.fields.task_node_id === "t1")).toEqual([]);
    expect(catReads(h)).toHaveLength(1);
    expect([...h.taskDirs()]).toHaveLength(1);
    expect(h.changes.filter((c) => c.change.kind === "runResult")).toHaveLength(1);
  });

  it("展开中途节点取消：已入队的份一并取消，后续的份不再入队", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    h.read.closeAfter(1);
    const submitting = h.runner.submit(h.target(), board(["t1"], true), ["t1"], { t1: 3 });
    await settle();
    expect(h.read.held).toBe(1);
    expect(nodeOf(h, "t1")?.counts).toEqual({ running: 1, queued: 2 });
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    h.read.open();
    h.gateway.open();
    expect(await submitting).toEqual([]);
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.requests.length).toBeLessThanOrEqual(1);
    expect(h.logs.filter((l) => l.kind === "queue_dispatch")).toHaveLength(1);
    expect(h.logs.filter((l) => l.kind === "task" && l.fields.from_status === null)).toHaveLength(1);
    expect(catReads(h)).toHaveLength(2);
    expect(resultCount(h)).toBe(0);
  });

  it("单份取消执行中的一份：只取消该份，排队的份补上派发，其余份产出结果", async () => {
    const h = harness({ concurrency: 2 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 3 });
    await settle();
    const [first, second, third] = activeIds(h);
    h.runner.cancel({ kind: "copy", taskId: first });
    await settle();
    expect(nodeOf(h, "t1")?.counts).toEqual({ cancelled: 1, running: 2 });
    expect(nodeOf(h, "t1")?.copies[0]).toEqual({ taskId: first, status: { kind: "cancelled", gatewayMayContinue: true } });
    expect(activeIds(h)).toEqual([second, third]);
    expect(h.locked()).toEqual(["t1"]);
    h.gateway.open();
    await settle();
    expect(resultCount(h)).toBe(2);
    expect(h.locked()).toEqual([]);
    expect(outcomes(h)).toEqual([{ kind: "cancelled", gatewayMayContinue: true }]);
  });

  it("单份取消排队的一份：从未派发，不写任务目录、不留痕迹，其余份继续", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 3 });
    await settle();
    const [first, second, third] = activeIds(h);
    h.runner.cancel({ kind: "copy", taskId: second });
    expect(activeIds(h)).toEqual([first, third]);
    expect(nodeOf(h, "t1")?.counts).toEqual({ running: 1, queued: 1 });
    expect(h.logs.filter((l) => l.fields.to_status === "cancelled").map((l) => l.fields.task_id)).toEqual([second]);
    h.gateway.open();
    await settle();
    expect(resultCount(h)).toBe(2);
    expect(h.taskDirs().size).toBe(2);
    expect([...h.files.keys()].some((k) => k.includes(second))).toBe(false);
  });

  it("单份取消退避中的一份：已取消、网关没在算，其余份继续", async () => {
    const h = harness({ concurrency: 2 });
    h.replies.push({ status: 429, body: "{}" });
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 2 });
    await settle();
    expect(nodeOf(h, "t1")?.counts).toEqual({ backoff: 1 });
    const [backoff] = activeIds(h);
    h.runner.cancel({ kind: "copy", taskId: backoff });
    await settle();
    expect(nodeOf(h, "t1")?.copies).toEqual([{ taskId: backoff, status: { kind: "cancelled", gatewayMayContinue: false } }]);
    expect(resultCount(h)).toBe(1);
    expect(h.locked()).toEqual([]);
  });

  it("展开中途单份取消：不影响同一次提交里还没读图的份和后面的节点", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    h.read.closeAfter(1);
    const submitting = h.runner.submit(h.target(), board(["t1", "t2"], true), ["t1", "t2"], { t1: 3 });
    await settle();
    expect(h.read.held).toBe(1);
    const [first] = activeIds(h);
    h.runner.cancel({ kind: "copy", taskId: first });
    h.read.open();
    h.gateway.open();
    expect(await submitting).toEqual([]);
    await settle();
    expect(h.changes.filter((c) => c.change.kind === "runResult")).toHaveLength(3);
    expect(h.locked()).toEqual([]);
  });

  it("单份取消不存在或已结束的任务编号：无事发生", async () => {
    const h = harness();
    await h.runner.submit(h.target(), board(), ["t1"], { t1: 2 });
    await settle();
    const taskId = h.logs.find((l) => l.kind === "queue_dispatch")?.fields.task_id as string;
    for (const id of [taskId, "zzz"]) h.runner.cancel({ kind: "copy", taskId: id });
    await settle();
    expect(resultCount(h)).toBe(2);
    expect(h.logs.filter((l) => l.fields.to_status === "cancelled")).toEqual([]);
  });

  it("取消全部排队：覆盖各份里排队的，执行中的份不受影响", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"], { t1: 2, t2: 2 });
    await settle();
    h.runner.cancel({ kind: "waiting" });
    expect(nodeOf(h, "t1")?.counts).toEqual({ running: 1 });
    expect(nodeOf(h, "t2")).toBeUndefined();
    h.gateway.open();
    await settle();
    expect(resultCount(h)).toBe(1);
  });

  it("展开中途取消全部排队：还没读图的份和后面的节点不再提交", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    h.read.closeAfter(1);
    const submitting = h.runner.submit(h.target(), board(["t1", "t2"], true), ["t1", "t2"], { t1: 3 });
    await settle();
    expect(h.read.held).toBe(1);
    h.runner.cancel({ kind: "waiting" });
    expect(nodeOf(h, "t1")?.counts).toEqual({ running: 1 });
    h.read.open();
    h.gateway.open();
    await submitting;
    await settle();
    expect(resultCount(h)).toBe(1);
    expect(nodeOf(h, "t2")).toBeUndefined();
  });

  it("按画板取消：覆盖该画板全部份，其他画板不受影响", async () => {
    const h = harness({ concurrency: 2 });
    h.gateway.closed = true;
    await h.runner.submit(h.target("A"), board(), ["t1"], { t1: 3 });
    await h.runner.submit(h.target("B"), board(), ["t1"], { t1: 2 });
    await settle();
    h.runner.cancel({ kind: "board", boardKey: "A" });
    expect(h.runner.getSnapshot().pending("A")).toBe(0);
    expect(h.runner.getSnapshot().pending("B")).toBe(2);
    h.gateway.open();
    await settle();
    expect(h.changes.filter((c) => c.change.kind === "runResult").map((c) => c.boardKey)).toEqual(["B", "B"]);
  });

  it("关闭画板：取消全部份并遗忘各份终态，展开中途的份不再入队", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    h.read.closeAfter(1);
    const submitting = h.runner.submit(h.target(), board(["t1"], true), ["t1"], { t1: 3 });
    await settle();
    expect(h.read.held).toBe(1);
    h.runner.closeBoard("A");
    h.read.open();
    h.gateway.open();
    await submitting;
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.runner.getSnapshot().board("A").nodes.size).toBe(0);
    expect(h.runner.getSnapshot().board("A").locked.size).toBe(0);
    expect(resultCount(h)).toBe(0);
  });
});

describe("任务节点状态显示", () => {
  const copy = (kind: "running" | "queued" | "failed" | "cancelled" | "backoff") =>
    ({ taskId: null, status: kind === "running" ? { kind, startedAt: 0 } : kind === "failed" ? { kind, label: "x" } : kind === "cancelled" ? { kind, gatewayMayContinue: false } : kind === "backoff" ? { kind, retryAt: 0 } : { kind } }) as const;

  it("只有一份时没有计数摘要，状态即该份", () => {
    const n = { copies: [copy("running")], counts: { running: 1 }, total: 1 };
    expect(nodeSummary(n)).toBeNull();
    expect(nodeStatus(n)).toEqual({ kind: "running", startedAt: 0 });
    expect(nodeSummary(undefined)).toBeNull();
  });

  it("多份时给出计数摘要，执行中、排队（含限流退避）、失败、已取消依次排列", () => {
    expect(nodeSummary({ copies: [copy("failed"), copy("running"), copy("running"), copy("queued")], counts: { failed: 1, running: 2, queued: 1 }, total: 4 })).toBe("执行中 2 · 排队 1 · 失败 1");
    expect(nodeSummary({ copies: [copy("cancelled"), copy("backoff"), copy("queued")], counts: { cancelled: 1, backoff: 1, queued: 1 }, total: 3 })).toBe("排队 2 · 已取消 1");
  });

  it("按本次提交的份数判断：多份提交只剩一份未成功时仍给摘要与明细", () => {
    const n = { copies: [copy("failed")], counts: { failed: 1 }, total: 3 };
    expect(nodeSummary(n)).toBe("失败 1");
    expect(nodeCopyDetail(n)).toBe("第 1 份：失败 · x");
  });

  it("摘要徽标的色调由计数决定：有失败即失败色，有执行中的带转圈", () => {
    expect(summaryTone({ running: 1, failed: 1 })).toEqual({ tone: "failed", spinning: true });
    expect(summaryTone({ running: 2, queued: 1 })).toEqual({ tone: "running", spinning: true });
    expect(summaryTone({ queued: 1, cancelled: 1 })).toEqual({ tone: "queued", spinning: false });
    expect(summaryTone({ backoff: 1, failed: 2 })).toEqual({ tone: "failed", spinning: false });
  });

  it("悬停明细：多份时逐份列出状态与失败原因；一份时没有", () => {
    const failed = (label: string) => ({ taskId: null, status: { kind: "failed" as const, label } });
    expect(nodeCopyDetail({ copies: [failed("网关超时"), failed("内容审核未通过"), copy("cancelled"), copy("running")], counts: { failed: 2, cancelled: 1, running: 1 }, total: 4 })).toBe(
      "第 1 份：失败 · 网关超时\n第 2 份：失败 · 内容审核未通过\n第 3 份：已取消\n第 4 份：执行中",
    );
    expect(nodeCopyDetail({ copies: [{ taskId: null, status: { kind: "interrupted" } }, copy("backoff"), copy("queued")], counts: {}, total: 3 })).toBe("第 1 份：已中断\n第 2 份：网关限流，等待重试\n第 3 份：排队中");
    expect(nodeCopyDetail({ copies: [failed("x")], counts: { failed: 1 }, total: 1 })).toBeNull();
    expect(nodeCopyDetail(undefined)).toBeNull();
  });
});

/** 已写下的 outcome.json 内容。 */
function outcomes(h: ReturnType<typeof harness>) {
  return [...h.files].filter(([k]) => k.endsWith("/outcome.json")).map(([, v]) => parseOutcome(v));
}

describe("任务运行器：读参考图失败", () => {
  it("状态失败，不写 outcome.json，提交返回本地失败说明", async () => {
    const h = harness();
    const b = board(["t1"], true);
    const gone = { ...b, nodes: b.nodes.map((n) => (n.id === "r" ? { ...n, path: "refs/gone.png" } : n)) as BoardNode[] };
    const problems = await h.runner.submit(h.target(), gone, ["t1"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("读取图1");
    expect(h.statuses()).toEqual({ t1: { kind: "failed", label: "本地文件错误" } });
    expect(h.locked()).toEqual([]);
    expect(h.files.size).toBe(0);
    expect(h.changes).toEqual([]);
  });
});

describe("任务运行器：快照按（画板, 任务节点）聚合", () => {
  const node = (h: ReturnType<typeof harness>, id: string, boardKey = "A") => h.runner.getSnapshot().board(boardKey).nodes.get(id);
  const activeTaskId = (h: ReturnType<typeof harness>, id: string) => h.runner.getSnapshot().active.find((a) => a.taskNodeId === id)?.taskId;

  it("执行中、排队的各份带任务编号，计数按状态汇总", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"]);
    await settle();
    expect(activeTaskId(h, "t1")).toMatch(/^\d{8}T\d{6}Z-/);
    expect(node(h, "t1")).toEqual({ copies: [{ taskId: activeTaskId(h, "t1"), status: expect.objectContaining({ kind: "running" }) }], counts: { running: 1 }, total: 1 });
    expect(node(h, "t2")).toEqual({ copies: [{ taskId: activeTaskId(h, "t2"), status: { kind: "queued" } }], counts: { queued: 1 }, total: 1 });
  });

  it("读参考图中的份还没有任务编号；读图失败的份明细带失败原因", async () => {
    const h = harness();
    h.read.closed = true;
    const b = board(["t1"], true);
    const gone = { ...b, nodes: b.nodes.map((n) => (n.id === "r" ? { ...n, path: "refs/gone.png" } : n)) as BoardNode[] };
    const submitting = h.runner.submit(h.target(), gone, ["t1"]);
    await settle();
    expect(node(h, "t1")).toEqual({ copies: [{ taskId: null, status: { kind: "queued" } }], counts: { queued: 1 }, total: 1 });
    h.read.open();
    await submitting;
    expect(node(h, "t1")).toEqual({ copies: [{ taskId: null, status: { kind: "failed", label: "本地文件错误" } }], counts: { failed: 1 }, total: 1 });
  });

  it("失败的份明细带任务编号与失败原因；再运行成功后不再显示上次的终态", async () => {
    const h = harness();
    h.replies.push({ status: 500, body: "{}" });
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    const failedTaskId = h.logs.find((l) => l.kind === "queue_dispatch")?.fields.task_id;
    expect(node(h, "t1")).toEqual({ copies: [{ taskId: failedTaskId, status: { kind: "failed", label: expect.any(String) } }], counts: { failed: 1 }, total: 1 });
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.runner.getSnapshot().board("A").nodes.size).toBe(0);
  });

  it("已取消的份按任务编号保留；关闭画板后遗忘", async () => {
    const h = harness();
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    const taskId = activeTaskId(h, "t1");
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    expect(node(h, "t1")).toEqual({ copies: [{ taskId, status: { kind: "cancelled", gatewayMayContinue: true } }], counts: { cancelled: 1 }, total: 1 });
    h.runner.closeBoard("A");
    expect(h.runner.getSnapshot().board("A").nodes.size).toBe(0);
  });
});

describe("任务运行器：429 退避", () => {
  it("按 30s / 60s / 120s 退避、整队暂停；重试不重写任务目录与 last_submitted；第 4 次 429 按失败并记结局", async () => {
    const h = harness({ concurrency: 1 });
    for (let i = 0; i < 4; i++) h.replies.push({ status: 429, body: "{}" });
    await h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"]);
    await settle();
    const t0 = Date.parse("2026-09-16T09:15:00Z");
    expect(h.statuses()).toEqual({ t1: { kind: "backoff", retryAt: t0 + 30_000 }, t2: { kind: "queued" } });
    // 退避期间整队暂停：t2 也不派发。
    expect(h.requests).toHaveLength(1);
    expect(h.runner.getSnapshot().active.map((a) => [a.taskNodeId, a.state])).toEqual([["t1", "waiting"], ["t2", "waiting"]]);

    h.advance(29_999);
    await settle();
    expect(h.requests).toHaveLength(1);
    h.advance(1);
    await settle();
    expect(h.requests).toHaveLength(2);
    expect(h.statuses().t1).toEqual({ kind: "backoff", retryAt: t0 + 30_000 + 60_000 });
    h.advance(60_000);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "backoff", retryAt: t0 + 90_000 + 120_000 });
    h.advance(120_000);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "failed", label: "网关限流" });
    expect(outcomes(h)).toEqual([{ kind: "failed", label: "网关限流" }]);
    // 第 4 次按失败后 t2 立即派发并成功。
    expect(h.statuses().t2).toBeUndefined();
    expect(h.changes.filter((c) => c.change.kind === "submitted")).toHaveLength(2);
    const dirs = [...h.files.keys()].filter((k) => k.endsWith("/task.json"));
    expect(dirs).toHaveLength(2);

    const rateLimits = h.logs.filter((l) => l.kind === "rate_limit").map((l) => [l.fields.attempt, l.fields.outcome]);
    expect(rateLimits).toEqual([[1, "retry"], [2, "retry"], [3, "retry"], [4, "failed"]]);
    expect(h.logs.find((l) => l.kind === "rate_limit")?.fields).toMatchObject({ retry_at: new Date(t0 + 30_000).toISOString(), queue_paused_until: new Date(t0 + 30_000).toISOString() });
    expect(h.transitions().filter((t) => t.startsWith("t1"))).toEqual([
      "t1:null→queued",
      "t1:queued→running",
      "t1:running→backoff",
      "t1:backoff→running",
      "t1:running→backoff",
      "t1:backoff→running",
      "t1:running→backoff",
      "t1:backoff→running",
      "t1:running→failed",
    ]);
  });

  it("多个执行中任务先后 429：按先后回到队首（排在已退避任务之后），暂停到最晚的恢复时刻", async () => {
    const h = harness({ concurrency: 2 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2", "t3"]), ["t1", "t2", "t3"]);
    await settle();
    h.replies.push({ status: 429, body: "{}" }, { status: 429, body: "{}" });
    h.gateway.open();
    h.gateway.closed = true;
    await settle();
    expect(h.runner.getSnapshot().active.map((a) => a.taskNodeId)).toEqual(["t1", "t2", "t3"]);
    expect(h.statuses()).toMatchObject({ t1: { kind: "backoff" }, t2: { kind: "backoff" }, t3: { kind: "queued" } });
    h.advance(30_000);
    await settle();
    expect(h.runner.getSnapshot().active.map((a) => [a.taskNodeId, a.state])).toEqual([["t1", "running"], ["t2", "running"], ["t3", "waiting"]]);
    h.gateway.open();
    await settle();
  });
});

describe("任务运行器：并发上限", () => {
  it("达到上限不再派发；调大后立即补派发", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2", "t3"]), ["t1", "t2", "t3"]);
    await settle();
    expect(h.requests).toHaveLength(1);
    h.runner.setConcurrency(3);
    await settle();
    expect(h.requests).toHaveLength(3);
    const dispatches = h.logs.filter((l) => l.kind === "queue_dispatch").map((l) => [l.fields.task_node_id, l.fields.running, l.fields.waiting, l.fields.limit]);
    expect(dispatches).toEqual([["t1", 1, 0, 1], ["t2", 3, 0, 3], ["t3", 3, 0, 3]]);
    h.gateway.open();
    await settle();
  });
});

describe("任务运行器：跨画板", () => {
  it("跨画板 FIFO；同一（画板, 任务节点）在占用期间重复提交被跳过", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target("A"), board(["t1"]), ["t1"]);
    await h.runner.submit(h.target("B"), board(["t9"]), ["t9"]);
    await h.runner.submit(h.target("A"), board(["t1", "t2"]), ["t1", "t2"]);
    expect(await h.runner.regenerate(h.target("A"), board(["t1"]), "t1")).toBeNull();
    await settle();
    expect(h.runner.getSnapshot().active.map((a) => `${a.boardKey}/${a.taskNodeId}`)).toEqual(["A/t1", "B/t9", "A/t2"]);
    expect(h.logs.filter((l) => l.fields.to_status === "queued").map((l) => `${l.fields.board_file}/${l.fields.task_node_id}`)).toEqual(["A.ugcboard/t1", "B.ugcboard/t9", "A.ugcboard/t2"]);
    h.gateway.open();
    await settle();
    expect(h.changes.filter((c) => c.change.kind === "runResult").map((c) => c.boardKey)).toEqual(["A", "B", "A"]);
  });

  it("两块画板含相同任务节点 id：状态表、锁定集、取消互不影响", async () => {
    const h = harness();
    h.gateway.closed = true;
    await h.runner.submit(h.target("A"), board(["t1"]), ["t1"]);
    await h.runner.submit(h.target("B"), board(["t1"]), ["t1"]);
    await settle();
    expect(h.locked("A")).toEqual(["t1"]);
    expect(h.locked("B")).toEqual(["t1"]);
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    expect(h.statuses("A").t1).toMatchObject({ kind: "cancelled" });
    expect(h.statuses("B").t1).toMatchObject({ kind: "running" });
    expect(h.locked("A")).toEqual([]);
    expect(h.locked("B")).toEqual(["t1"]);
    expect(h.runner.getSnapshot().pending("A")).toBe(0);
    expect(h.runner.getSnapshot().pending("B")).toBe(1);
    h.gateway.open();
    await settle();
    expect(h.changes.filter((c) => c.change.kind === "runResult").map((c) => c.boardKey)).toEqual(["B"]);
  });
});

describe("任务运行器：关闭画板", () => {
  it("取消该画板并遗忘：状态清空，其任务编号不再算「经手过」；别的画板不动", async () => {
    const h = harness();
    h.replies.push({ status: 401, body: "{}" });
    await h.runner.submit(h.target("A"), board(["t1"]), ["t1"]);
    await settle();
    h.gateway.closed = true;
    await h.runner.submit(h.target("A"), board(["t2"]), ["t2"]);
    await h.runner.submit(h.target("B"), board(["t1"]), ["t1"]);
    await settle();
    expect(h.statuses("A")).toMatchObject({ t1: { kind: "failed" }, t2: { kind: "running" } });
    expect(h.runner.getSnapshot().board("A").handled.size).toBe(2);

    h.runner.closeBoard("A");
    expect(h.statuses("A")).toEqual({});
    expect(h.runner.getSnapshot().board("A").handled.size).toBe(0);
    expect(h.runner.getSnapshot().pending()).toBe(1);
    expect(h.statuses("B").t1).toMatchObject({ kind: "running" });
    h.gateway.open();
    await settle();
    expect(h.statuses("A")).toEqual({});
    // 执行中被关掉的任务照样记下已取消，重开时由 outcome.json 给出。
    expect(outcomes(h)).toEqual(expect.arrayContaining([{ kind: "failed", label: "鉴权失败" }, { kind: "cancelled", gatewayMayContinue: true }]));
    expect(h.changes.filter((c) => c.change.kind === "runResult").map((c) => c.boardKey)).toEqual(["B"]);
  });
});

describe("任务运行器：关闭画板时正在算摘要的提交", () => {
  it("submit / regenerate 在关闭前已开始：不入队、不留状态", async () => {
    const h = harness();
    const submitting = h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"]);
    const regenerating = h.runner.regenerate(h.target(), board(), "t1");
    h.runner.closeBoard("A");
    expect(await submitting).toEqual([]);
    expect(await regenerating).toBeNull();
    await settle();
    expect(h.statuses()).toEqual({});
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.files.size).toBe(0);
    expect(h.logs).toEqual([]);
  });
});

describe("任务运行器：日志", () => {
  it("关键迁移带画板文件名、任务节点、任务编号；取消带 gateway_may_continue", async () => {
    const h = harness();
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    h.runner.cancel({ kind: "all" });
    const task = h.logs.filter((l) => l.kind === "task");
    expect(task.map((l) => [l.fields.from_status, l.fields.to_status, l.fields.gateway_may_continue])).toEqual([
      [null, "queued", undefined],
      ["queued", "running", undefined],
      ["running", "cancelled", true],
    ]);
    expect(task[0].fields).toMatchObject({ board_file: "A.ugcboard", task_node_id: "t1", model: "qwen-image-3.0-pro", workflow: "text_to_image" });
    expect(typeof task[0].fields.task_id).toBe("string");
    h.gateway.open();
    await settle();
    expect(h.logs.filter((l) => l.kind === "download")).toEqual([]);
  });

  it("失败迁移带错误类别；下载事件带任务编号与张数", async () => {
    const h = harness();
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.logs.find((l) => l.kind === "download")?.fields).toMatchObject({ ok: true, images: 1, model: "qwen-image-3.0-pro" });
    h.replies.push({ status: 401, body: "{}" });
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.logs.filter((l) => l.kind === "task").at(-1)?.fields).toMatchObject({ from_status: "running", to_status: "failed", category: "auth", message: "鉴权失败" });
  });
});


describe("任务运行器：提交守护（更新准备）", () => {
  it("准备失败已解除守护后，之前卡在摘要阶段的提交也不能复活", async () => {
    const h = harness();
    const submitting = h.runner.submit(h.target(), board(), ["t1"]);
    const regenerating = h.runner.regenerate(h.target(), board(), "t1");
    h.runner.setSubmissionGuard(() => undefined);
    h.runner.setSubmissionGuard(null);
    expect(await submitting).toEqual([]);
    expect(await regenerating).toBeNull();
    await settle();
    expect(h.files.size).toBe(0);
    expect(h.runner.getSnapshot().pending()).toBe(0);
  });
  it("守护在位时 submit / regenerate 拒绝入队，解除后恢复", async () => {
    const h = harness();
    const blocked: string[] = [];
    h.runner.setSubmissionGuard(() => blocked.push("blocked"));
    expect(await h.runner.submit(h.target(), board(), ["t1"])).toEqual([]);
    expect(await h.runner.regenerate(h.target(), board(), "t1")).toBeNull();
    await settle();
    expect(blocked).toEqual(["blocked", "blocked"]);
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.statuses()).toEqual({});
    expect(h.files.size).toBe(0);
    expect(h.logs).toEqual([]);

    h.runner.setSubmissionGuard(null);
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.files.size).toBeGreaterThan(0);
  });

  it("守护在 tableDigest 期间挂上：异步间隙里的提交也不入队", async () => {
    // 摘要是真异步（纯 JS SHA-256，见 core/sha256.ts）：守护在摘要算完后才挂上时，这次提交必须被拦在入队前。
    const h = harness();
    const submitting = h.runner.submit(h.target(), board(), ["t1"]);
    h.runner.setSubmissionGuard(() => undefined);
    expect(await submitting).toEqual([]);
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.files.size).toBe(0);
  });

  it("守护在 regenerate 的摘要间隙挂上：同样拦在入队前", async () => {
    const h = harness();
    const regenerating = h.runner.regenerate(h.target(), board(), "t1");
    h.runner.setSubmissionGuard(() => undefined);
    expect(await regenerating).toBeNull();
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.files.size).toBe(0);
  });
});

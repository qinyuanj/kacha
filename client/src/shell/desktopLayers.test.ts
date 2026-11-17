// 透明背景与图层拆分闭环（#156）：按模型能力从桌面端口提交 Flash 任务，经受控网关替身拿到
// 真实 PNG 字节，落在临时数据根的任务目录；保存重开后按 layers.json 还原底图与图层，
// 并可从某一层继续编辑且保留谱系。这里不起 MyGo 窗口：桥下面的 Go 服务（文件读写、探测、
// 任务目录）由 desktop/internal/localservice、localstore 与 gateway 的临时目录 / httptest 测试单独证明。
// 画布像素处理只在 WebView 里有，所以 imageCodec 用同形替身；它按真实 PNG 字节解出尺寸与 alpha，
// 不读取产品自己的实现。
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";
import { inflateSync } from "node:zlib";

import type { Board, ReferenceNode, ResultNode, TaskNode } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { base64Of } from "../core/base64";
import type { DecodedImage, ImageCodec } from "../core/fitImage";
import { continueEditing } from "../core/iterate";
import { addResultNode } from "../core/layout";
import type { RunDeps } from "../core/run";
import { createRunner, type RunTarget, type Runner, type RunnerChange } from "../core/runner";
import { collectRunFacts } from "../core/submission";
import { restoreResultLayers, taskFilePath, type TaskFs } from "../core/taskDir";
import { png as makePng } from "../core/testing/png";
import { createDesktopPort, type DesktopBridge, type DesktopGatewayBridge, type DesktopLocalBridge } from "./desktop";
import { PortError } from "./port";
import { taskPorts } from "../core/graph";
import { taskView } from "../core/taskView";

const KEY = "sk-synthetic-153";
const FLASH = "doubao-seedream-5-0-flash-260915";
const PRO = "doubao-seedream-5-0-pro-260628";
const QWEN = "qwen-image-3.0-pro";
const servers: Server[] = [];
const roots: string[] = [];

/** 测试自己的 PNG 解码：按真实字节算尺寸与透明通道，不依赖产品实现。 */
function decodePng(bytes: Uint8Array): { width: number; height: number; hasAlpha: boolean } {
  const buf = Buffer.from(bytes);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((b, i) => buf[i] !== b)) throw new Error("不是 PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error("测试 PNG 只支持 RGB / RGBA");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  let hasAlpha = false;
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    if (raw[rowStart] !== 0) throw new Error("测试 PNG 只支持无滤波行");
    for (let x = 0; x < width; x++) if (channels === 4 && raw[rowStart + 1 + x * 4 + 3] < 255) hasAlpha = true;
  }
  return { width, height, hasAlpha };
}

const bytesOfPng = (width: number, height: number, alpha = true): Uint8Array => Uint8Array.from(Buffer.from(makePng(width, height, { alpha }), "base64"));
const REFERENCE = bytesOfPng(1024, 1024, true);
const BASE = bytesOfPng(1024, 1024, true);
const LAYER1 = bytesOfPng(800, 800, true);
const LAYER2 = bytesOfPng(1024, 1024, true);
const OPAQUE = bytesOfPng(1024, 1024, false);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function referenceNode(path: string): ReferenceNode {
  return { id: "r", type: "reference", pos: [0, 0], size: [200, 150], extra: {}, path, sha256: "x".repeat(64), display_name: "参考.png" };
}

function taskNode(patch: Partial<TaskNode> = {}): TaskNode {
  return { id: "t", type: "task", pos: [300, 0], size: [280, 260], extra: {}, model: FLASH, size_spec: { tier: "2K", ratio: "4:3", width: null, height: null }, image_ports: 1, layer_decomposition: false, transparent_background: false, last_submitted: null, ...patch };
}

function layerBoard(refPath: string, patch: Partial<TaskNode> = {}): Board {
  return {
    format_version: 2,
    title: "图层拆分",
    viewport: { zoom: 1, x: 0, y: 0 },
    nodes: [referenceNode(refPath), taskNode({ layer_decomposition: true, layer_size: "1K", ...patch })],
    edges: [{ from: ["r", "out"], to: ["t", "image:0"], source_layer: null, region: null, system: false, extra: {} }],
    extra: {},
  };
}

function bodyOf(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function until<T>(check: () => T | undefined | null | false, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待桌面透明 / 图层闭环超时");
}

type Mode = "layers" | "transparent" | "transparentOpaque" | "partialDownload" | "corruptLayer";

/** 网关替身返回的图片路径到字节。 */
const SERVED: Record<string, Uint8Array> = { "/base.png": BASE, "/layer-1.png": LAYER1, "/layer-2.png": LAYER2, "/opaque.png": OPAQUE };

interface Setup {
  root: string;
  port: Awaited<ReturnType<typeof createDesktopPort>>["port"];
  board: Board;
  runner: Runner;
  changes: RunnerChange[];
  writes: string[];
  generated: Record<string, any>[];
  target: RunTarget;
  failWriteSuffix(value: string | null): void;
  setBoard(next: Board): void;
}

function responseForLayers(baseUrl: string): unknown {
  return {
    data: [
      { url: baseUrl + "/base.png", z_index: 0, description: "合成底图" },
      { url: baseUrl + "/layer-1.png", z_index: 1, bounding_box: { absolute: [100, 120, 700, 820], normalized: [100, 120, 700, 820] }, name: "主体" },
      { url: baseUrl + "/layer-2.png", z_index: 2, bounding_box: { absolute: [0, 0, 1024, 1024], normalized: [0, 0, 1000, 1000] }, description: "阴影" },
    ],
  };
}

async function setup(mode: Mode, patch: Partial<TaskNode> = {}, model = FLASH): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "kacha-156-"));
  roots.push(root);
  await mkdir(join(root, "画板"), { recursive: true });
  await mkdir(join(root, "导入参考图"), { recursive: true });
  await writeFile(join(root, "导入参考图", "ref.png"), REFERENCE);
  let baseUrl = "";
  const generated: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    const raw = await bodyOf(req);
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      const payload = JSON.parse(raw || "{}") as Record<string, unknown>;
      generated.push(payload);
      res.writeHead(200, { "content-type": "application/json" });
      if (payload.layer_decomposition === true && ["layers", "partialDownload", "corruptLayer"].includes(mode)) return void res.end(JSON.stringify(responseForLayers(baseUrl)));
      if (mode === "transparentOpaque") return void res.end(JSON.stringify({ data: [{ url: baseUrl + "/opaque.png" }] }));
      return void res.end(JSON.stringify({ data: [{ url: baseUrl + "/base.png" }] }));
    }
    if (req.method === "GET") {
      if (mode === "partialDownload" && req.url === "/layer-2.png") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "gone" } }));
        return;
      }
      const served = mode === "corruptLayer" && req.url === "/layer-2.png" ? OPAQUE : SERVED[req.url ?? ""];
      if (served) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(served);
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  baseUrl = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  const writes: string[] = [];
  let failSuffix: string | null = null;
  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_t, prop: string) => {
      if (prop === "writeNewFileBase64") return async (abs: string, data: string) => {
        const target = resolve(abs);
        if (!target.startsWith(resolve(root) + sep)) throw new Error("写入越出数据根");
        if (failSuffix && target.endsWith(failSuffix)) return { ok: false, kind: "failed", message: "磁盘写入失败", version: "" };
        writes.push(target);
        await mkdir(dirname(target), { recursive: true });
        try {
          await writeFile(target, Buffer.from(data, "base64"), { flag: "wx" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, kind: "alreadyExists", message: "只新建不覆盖", version: "" };
          throw e;
        }
        return { ok: true, kind: "", message: "", version: "" };
      };
      if (prop === "readFile") return async (abs: string) => {
        try { return base64Of(await readFile(resolve(abs))); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new PortError({ kind: "missing", code: "missing", message: "文件不存在", status: 404 });
          throw e;
        }
      };
      if (prop === "isFile") return async (abs: string) => {
        try { await readFile(resolve(abs)); return true; } catch { return false; }
      };
      // 与 Go 的 InspectImage 同形：按真实文件字节给尺寸与透明通道，文件不在报 missing。
      if (prop === "inspectImage") return async (abs: string) => {
        let bytes: Buffer;
        try { bytes = await readFile(resolve(abs)); }
        catch { throw new PortError({ kind: "missing", code: "missing", message: "文件不存在", status: 404 }); }
        const info = decodePng(bytes);
        return { sha256: "x".repeat(64), bytes: bytes.length, width: info.width, height: info.height, format: "png", has_alpha: info.hasAlpha };
      };
      return () => Promise.reject(new Error("Unexpected local." + prop));
    },
  });
  const gateway: DesktopGatewayBridge = {
    request: async (url, method, headers, payload = "") => {
      const response = await fetch(url, { method, headers, body: payload || undefined });
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "";
      const textual = contentType === "" || /json|text|xml|urlencoded/i.test(contentType);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: textual ? bytes.toString("utf8") : "",
        ...(textual ? {} : { body_base64: bytes.toString("base64") }),
      };
    },
    readApiKey: async () => KEY,
    writeApiKey: async () => undefined,
    deleteApiKey: async () => undefined,
  };
  const bridge: DesktopBridge = {
    info: async () => ({ version: "test", user_data_root: root, board_root: join(root, "画板"), features: { generation: true, usage: false, pack_export: false } }),
    local,
    gateway,
  };
  const { port } = await createDesktopPort(bridge);

  // 画布替身：按真实 PNG 字节解出尺寸与 alpha；编码只用于需要缩放的场景（本测试不缩放）。
  const codec: ImageCodec = {
    decode: async (bytes: Uint8Array): Promise<DecodedImage> => {
      const info = decodePng(bytes);
      return {
        width: info.width,
        height: info.height,
        hasAlpha: () => info.hasAlpha,
        encode: async (width, height) => bytesOfPng(width, height, true),
        close: () => undefined,
      };
    },
  };

  let current = layerBoard("导入参考图/ref.png", { model, ...patch });
  const changes: RunnerChange[] = [];
  const apply = (_key: string, change: RunnerChange) => {
    changes.push(change);
    if (change.kind === "submitted")
      current = { ...current, nodes: current.nodes.map((n) => n.id === change.taskId && n.type === "task" ? { ...n, last_submitted: change.lastSubmitted } : n) };
    if (change.kind === "runResult") current = addResultNode(current, { ...change.result, id: "result-" + change.result.submittedTaskId });
  };
  let clock = Date.parse("2026-11-17T00:00:00Z");
  const deps: RunDeps = { ...port.core.runDeps, imageCodec: codec, now: () => new Date(clock++) };
  const runner = createRunner({ deps, apply, log: () => undefined, concurrency: 1 });
  const target: RunTarget = { boardKey: "A", boardFile: "画板/test.ugcboard.json", table: BUILTIN_TABLE, userRoot: root, baseUrl, apiKey: KEY };
  return {
    root, port, runner, changes, writes, generated, target,
    get board() { return current; },
    setBoard(next: Board) { current = next; },
    failWriteSuffix(value: string | null) { failSuffix = value; },
  };
}

function absOf(root: string, rel: string): string {
  return resolve(root, ...rel.split("/"));
}

function resultNode(s: Setup): ResultNode {
  const node = s.board.nodes.find((n): n is ResultNode => n.type === "result");
  if (!node) throw new Error("画板上没有结果节点");
  return node;
}

async function savedBoard(s: Setup, boardToSave: Board): Promise<Board> {
  const path = join(s.root, "画板", "test.ugcboard.json");
  await writeFile(path, JSON.stringify(boardToSave, null, 2));
  return JSON.parse(await readFile(path, "utf8")) as Board;
}

async function reopen(s: Setup, fs: TaskFs = s.port.core.taskFs): Promise<Board> {
  return restoreResultLayers(fs, s.root, await savedBoard(s, s.board));
}

describe("桌面端口的透明背景与图层拆分（#156）", () => {
  it("拆分图层：请求、图层次序 / 定位与透明通道经桌面端口真实落盘，画板得到带图层的结果", async () => {
    const s = await setup("layers");
    expect(await s.runner.submit(s.target, s.board, ["t"])).toEqual([]);
    const change = await until(() => s.changes.find((c) => c.kind === "runResult"));
    expect(change.kind).toBe("runResult");
    if (change.kind !== "runResult") return;

    // 请求按 Flash 图层契约：一张参考图、拆分开关、图层尺寸档；没有提示词时不发空 prompt。
    expect(s.generated).toHaveLength(1);
    const body = s.generated[0];
    expect(body).toMatchObject({ model: FLASH, layer_decomposition: true, size: "1K", response_format: "url", output_format: "png", watermark: false });
    expect(body.prompt).toBeUndefined();
    expect(body.image).toEqual(["data:image/png;base64," + base64Of(REFERENCE)]);

    // 文件：底图 result.png、layers/01..02.png、layers.json，全部只写一次。
    const dir = dirname(absOf(s.root, change.result.path));
    expect(new Uint8Array(await readFile(join(dir, "result.png")))).toEqual(BASE);
    expect(new Uint8Array(await readFile(join(dir, "layers", "01.png")))).toEqual(LAYER1);
    expect(new Uint8Array(await readFile(join(dir, "layers", "02.png")))).toEqual(LAYER2);
    expect(decodePng(await readFile(join(dir, "layers", "01.png")))).toEqual({ width: 800, height: 800, hasAlpha: true });
    expect(decodePng(await readFile(join(dir, "layers", "02.png")))).toEqual({ width: 1024, height: 1024, hasAlpha: true });
    expect(decodePng(await readFile(join(dir, "result.png")))).toEqual({ width: 1024, height: 1024, hasAlpha: true });
    const layersJson = JSON.parse(await readFile(join(dir, "layers.json"), "utf8"));
    expect(layersJson).toEqual({
      base: { z_index: 0, description: "合成底图" },
      layers: [
        { file: "layers/01.png", z_index: 1, bounding_box: { absolute: [100, 120, 700, 820], normalized: [100, 120, 700, 820] }, name: "主体" },
        { file: "layers/02.png", z_index: 2, bounding_box: { absolute: [0, 0, 1024, 1024], normalized: [0, 0, 1000, 1000] }, description: "阴影" },
      ],
    });
    expect(new Set(s.writes).size).toBe(s.writes.length);

    // 画板上的结果带图层；界面探测同一份文件时看到透明通道。
    const node = resultNode(s);
    expect(node.layer_count).toBe(2);
    expect(node.record.layers).toEqual(layersJson.layers);
    expect((await s.port.core.imageProbe.inspectImage(join(dir, "layers", "01.png"))).has_alpha).toBe(true);
    // 图层属于结果，不是新节点：画板上仍只有参考图与任务、结果两个节点语义之外的节点。
    expect(s.board.nodes.filter((n) => n.type === "result")).toHaveLength(1);
  });

  it("保存重开后按 layers.json 还原底图与图层，选择来源图层继续编辑保持谱系与实际字节", async () => {
    const s = await setup("layers");
    expect(await s.runner.submit(s.target, s.board, ["t"])).toEqual([]);
    const first = await until(() => s.changes.find((c) => c.kind === "runResult"));
    expect(first.kind).toBe("runResult");
    if (first.kind !== "runResult") return;
    const firstTaskId = first.result.submittedTaskId;
    const resultId = resultNode(s).id;

    // 重开：画板文件只是视图，图层身份与定位按任务目录的 layers.json 还原。
    const reopened = await reopen(s);
    const restored = reopened.nodes.find((n): n is ResultNode => n.type === "result");
    expect(restored).toMatchObject({ id: resultId, layer_count: 2 });
    expect(restored!.record.layers).toHaveLength(2);
    expect(restored!.record.layers![1]).toMatchObject({ file: "layers/02.png", z_index: 2, description: "阴影" });

    // 预览弹窗的「以此继续编辑」：接的是选中的那一层，不是底图。
    const action = continueEditing(reopened, BUILTIN_TABLE, { source: "none" }, [resultId], resultId, { taskId: "t2", promptId: "p2" }, new Map([[resultId, 2]]));
    expect(action.ok).toBe(true);
    if (!action.ok) return;
    const next: Board = { ...action.board, nodes: action.board.nodes.map((n) => (n.id === "p2" && n.type === "prompt" ? { ...n, text: "把@图1 改成金属质感" } : n)) };
    s.setBoard(next);
    expect(await s.runner.submit(s.target, next, ["t2"])).toEqual([]);
    const second = await until(() => s.changes.find((c) => c.kind === "runResult" && c.result.submittedTaskId !== firstTaskId));
    expect(second.kind).toBe("runResult");
    if (second.kind !== "runResult") return;

    // 实际发出的就是图层文件字节；不会退回底图。
    expect(s.generated).toHaveLength(2);
    expect(s.generated[1].image).toEqual(["data:image/png;base64," + base64Of(LAYER2)]);
    expect(s.generated[1].layer_decomposition).toBeUndefined();

    // 任务记录保留谱系：来源是那次结果的第 2 层；参考图快照也是该层字节。
    const recordPath = taskFilePath(s.root, second.result.submittedTaskId, "task.json");
    expect(recordPath).not.toBeNull();
    const record = JSON.parse(await readFile(recordPath!, "utf8"));
    expect(record.references[0]).toMatchObject({
      media_type: "image/png",
      source: { kind: "result", task_id: firstTaskId, file: "result.png", source_layer: 2 },
    });
    const snapshotPath = taskFilePath(s.root, second.result.submittedTaskId, record.references[0].file);
    expect(new Uint8Array(await readFile(snapshotPath!))).toEqual(LAYER2);
    expect(decodePng(await readFile(snapshotPath!))).toEqual({ width: 1024, height: 1024, hasAlpha: true });

    // 再重开：新任务指向来源结果图层的连线还在，谱系不因保存丢失。
    const reopenedAgain = await reopen(s);
    const lineage = reopenedAgain.edges.find((e) => e.to[0] === "t2" && e.to[1] === "image:0");
    expect(lineage).toMatchObject({ from: [resultId, "out"], source_layer: 2 });
  });

  it.each([
    ["Flash", FLASH, { tier: "1K" as const, ratio: "1:1" as const, width: null, height: null }],
    ["Seedream pro", PRO, { tier: "2K" as const, ratio: "1:1" as const, width: null, height: null }],
  ])("透明背景（%s）：请求带 transparent 与 PNG 输出，结果实际保留透明通道并重开可见", async (_name, model, sizeSpec) => {
    const s = await setup("transparent", { transparent_background: true, layer_decomposition: false, size_spec: sizeSpec }, model);
    const facts = { ...await collectRunFacts(s.port.core.imageProbe, s.board, ["t"], s.root), discovery: { source: "none" as const }, concurrency: 1 };
    expect(taskView(s.board, BUILTIN_TABLE, "t", facts)!.toggles.transparentBackground.canEnable).toBe(true);
    expect(await s.runner.submit(s.target, s.board, ["t"])).toEqual([]);
    const change = await until(() => s.changes.find((c) => c.kind === "runResult"));
    expect(change.kind).toBe("runResult");
    if (change.kind !== "runResult") return;

    expect(s.generated).toHaveLength(1);
    expect(s.generated[0]).toMatchObject({ background: "transparent", output_format: "png", response_format: "url", model });
    expect(s.generated[0].image).toEqual(["data:image/png;base64," + base64Of(REFERENCE)]);

    const dir = dirname(absOf(s.root, change.result.path));
    const resultBytes = new Uint8Array(await readFile(join(dir, "result.png")));
    expect(resultBytes).toEqual(BASE);
    expect(decodePng(resultBytes)).toEqual({ width: 1024, height: 1024, hasAlpha: true });
    expect((await s.port.core.imageProbe.inspectImage(join(dir, "result.png"))).has_alpha).toBe(true);
    const record = JSON.parse(await readFile(join(dir, "task.json"), "utf8"));
    expect(record).toMatchObject({ transparent_background: true, layer_decomposition: false });

    const reopened = await reopen(s);
    const task = reopened.nodes.find((n): n is TaskNode => n.type === "task");
    expect(task).toMatchObject({ transparent_background: true });
    expect(reopened.nodes.some((n) => n.type === "result")).toBe(true);
  });

  it.each([
    ["Flash", FLASH, { tier: "1K" as const, ratio: "1:1" as const, width: null, height: null }],
    ["Seedream pro", PRO, { tier: "2K" as const, ratio: "1:1" as const, width: null, height: null }],
  ])("透明结果实际不带 alpha（%s）：落明确失败结局，不保存、不冒充成功", async (_name, model, sizeSpec) => {
    const s = await setup("transparentOpaque", { transparent_background: true, layer_decomposition: false, size_spec: sizeSpec }, model);
    expect(await s.runner.submit(s.target, s.board, ["t"])).toEqual([]);
    const outcomePath = await until(() => s.writes.find((p) => p.endsWith("outcome.json")));
    let raw = "";
    for (let i = 0; i < 500 && !raw; i++) {
      try { raw = await readFile(outcomePath, "utf8"); } catch { await new Promise((r) => setTimeout(r, 10)); }
    }
    expect(JSON.parse(raw)).toEqual({ outcome: "failed", label: "响应无效" });
    expect(s.changes.some((c) => c.kind === "runResult")).toBe(false);
    expect(s.writes.some((p) => p.endsWith("result.png"))).toBe(false);
    expect(s.board.nodes.some((n) => n.type === "result")).toBe(false);
  });

  it("透明背景的参考图不带 alpha：提交前拦下，不发请求、不写任务目录", async () => {
    const s = await setup("transparent", { transparent_background: true, layer_decomposition: false });
    const b: Board = { ...s.board, nodes: s.board.nodes.map((n) => (n.id === "r" && n.type === "reference" ? { ...n, path: "导入参考图/opaque.png" } : n)) };
    await writeFile(join(s.root, "导入参考图", "opaque.png"), OPAQUE);
    s.setBoard(b);
    const problems = await s.runner.submit(s.target, b, ["t"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("透明背景需要已确认带透明通道的参考图快照");
    expect(s.generated).toHaveLength(0);
    expect(s.writes).toEqual([]);
  });

  it.each([
    ["partialDownload", "网关拒绝"],
    ["corruptLayer", "响应无效"],
  ] as const)("部分图层不可用时明确失败（%s）：不落底图 / 图层 / 成功节点", async (mode, label) => {
    const s = await setup(mode);
    expect(await s.runner.submit(s.target, s.board, ["t"])).toEqual([]);
    const outcomePath = await until(() => s.writes.find((p) => p.endsWith("outcome.json")));
    let raw = "";
    for (let i = 0; i < 500 && !raw; i++) {
      try { raw = await readFile(outcomePath, "utf8"); } catch { await new Promise((r) => setTimeout(r, 10)); }
    }
    expect(JSON.parse(raw)).toEqual({ outcome: "failed", label });
    expect(s.changes.some((c) => c.kind === "runResult")).toBe(false);
    expect(s.board.nodes.some((n) => n.type === "result")).toBe(false);
    // 下载全部完成并通过校验才写盘：不完整的结果不会留下底图或 layers.json。
    expect(s.writes.some((p) => p.endsWith("result.png"))).toBe(false);
    expect(s.writes.some((p) => p.endsWith("layers.json"))).toBe(false);
    expect(s.writes.some((p) => p.includes(`${sep}layers${sep}`))).toBe(false);
  });

  it("图层写入失败：明确失败结局，不把写了一半的任务当完整结果", async () => {
    const s = await setup("layers");
    s.failWriteSuffix(join("layers", "02.png"));
    expect(await s.runner.submit(s.target, s.board, ["t"])).toEqual([]);
    const outcomePath = await until(() => s.writes.find((p) => p.endsWith("outcome.json")));
    let raw = "";
    for (let i = 0; i < 500 && !raw; i++) {
      try { raw = await readFile(outcomePath, "utf8"); } catch { await new Promise((r) => setTimeout(r, 10)); }
    }
    expect(JSON.parse(raw)).toEqual({ outcome: "failed", label: "本地文件错误" });
    expect(s.changes.some((c) => c.kind === "runResult")).toBe(false);
    expect(s.board.nodes.some((n) => n.type === "result")).toBe(false);
    expect(s.writes.some((p) => p.endsWith("result.png"))).toBe(false);
    expect(s.writes.some((p) => p.endsWith("layers.json"))).toBe(false);
    // 已经写下的那一层仍在盘上（文件只写一次、不覆盖），但没有 layers.json 与底图，重开不会被当成完整结果。
    expect(s.writes.some((p) => p.endsWith(join("layers", "01.png")))).toBe(true);
    const reopened = await savedBoard(s, s.board);
    expect(reopened.nodes.some((n) => n.type === "result")).toBe(false);
  });

  it("入口只对已支持并上架的模型露出：不支持透明 / 拆层的模型没有开关", async () => {
    const s = await setup("layers");
    const flash = layerBoard("导入参考图/ref.png");
    expect(taskPorts(flash, BUILTIN_TABLE, "t")).toMatchObject({ layerDecomposition: true, transparentBackground: true });
    const unsupported = layerBoard("导入参考图/ref.png", { model: QWEN, layer_decomposition: false });
    expect(taskPorts(unsupported, BUILTIN_TABLE, "t")).toMatchObject({ layerDecomposition: false, transparentBackground: false });
    // 透明入口即使露出，也要等参考图的 alpha 事实确认后才能打开。
    const facts = await collectRunFacts(s.port.core.imageProbe, flash, ["t"], s.root);
    const noRef: Board = { ...flash, edges: [] };
    expect(taskView(noRef, BUILTIN_TABLE, "t", { ...facts, discovery: { source: "none" }, concurrency: 1 })!.toggles.transparentBackground).toEqual({ canEnable: false, hint: "需要恰好一张实际参考图" });
  });
});

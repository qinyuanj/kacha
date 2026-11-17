// 参考图编辑闭环（#154）：本机选图 / 粘贴的图片经桌面端口进参考图，带区域地提交给图片编辑模型，
// 真实落在临时数据根的任务目录；确认文本、实际请求与任务记录三处发送文本一致，快照就是实际发送的处理版本，
// 原图不动；保存画板后重开仍见结果。迭代动作（继续编辑 / 加为参考图 / 变体）与重新生成在这里按端口行为验证。
//
// 这里不起 MyGo 窗口：桥下面的 Go 服务（选图对话框、读写文件、任务目录）由 desktop/internal/localservice、
// localstore 与 gateway 的临时目录 / httptest 测试单独证明。画布像素处理（缩放转码、区域叠加）只在 WebView 里有，
// 所以 imageCodec 与 composeOverlay 用同形替身——它们是注入 RunDeps 的两个依赖，像素算法本身由
// core/fitImage.test.ts、core/overlay.test.ts 与 shell 的 canvas 包装负责。
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cp } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";

import type { Board } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { base64Of, base64ToBytes } from "../core/base64";
import type { DecodedImage } from "../core/fitImage";
import { addResultNode } from "../core/layout";
import type { RunDeps } from "../core/run";
import { createRunner, type RunTarget, type Runner, type RunnerChange } from "../core/runner";
import { buildConfirmItems, collectRunFacts } from "../core/submission";
import { PNG_1X1 } from "../core/testing/png";
import { createDesktopPort, type DesktopBridge, type DesktopGatewayBridge, type DesktopLocalBridge } from "./desktop";
import { PortError } from "./port";

const KEY = "sk-synthetic-153";
const MODEL = "qwen-image-3.0-pro";
// 原图尺寸由替身给：真实解码在 WebView（shell/imageCodec.ts）与 Go（localservice.InspectImage）各有验证。
const SOURCE = { width: 8000, height: 6000 };
// 按 qwen 的 max_total_pixels=4194304 等比缩小后的尺寸（fitImage.planFit 的取整结果）。
const FITTED = { width: 2364, height: 1773 };
const REGION = [0.1, 0.2, 0.3, 0.4] as [number, number, number, number];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function boardOf(refPath: string, options: { refs?: number; prompt?: string; regions?: boolean } = {}): Board {
  const count = options.refs ?? 1;
  const refs = Array.from({ length: count }, (_, i) => ({
    id: "r" + i,
    type: "reference" as const,
    pos: [0, i * 170] as [number, number],
    size: [200, 150] as [number, number],
    extra: {},
    path: refPath,
    sha256: "x".repeat(64),
    display_name: i === 0 ? "橘猫.png" : "参考" + (i + 1) + ".png",
  }));
  return {
    format_version: 1,
    title: "参考图编辑",
    viewport: { zoom: 1, x: 0, y: 0 },
    nodes: [
      ...refs,
      { id: "p", type: "prompt", pos: [0, 600], size: [240, 140], extra: {}, text: options.prompt ?? "把@图1 的背景改成蓝色" },
      { id: "t", type: "task", pos: [300, 0], size: [280, 260], extra: {}, model: MODEL, size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, image_ports: count, layer_decomposition: false, transparent_background: false, last_submitted: null },
    ],
    edges: [
      { from: ["p", "out"], to: ["t", "positive"], source_layer: null, region: null, system: false, extra: {} },
      ...refs.map((r, i) => ({ from: [r.id, "out"] as [string, string], to: ["t", "image:" + i] as [string, string], source_layer: null, region: options.regions === false ? null : { rects: [REGION], render: "highlight_overlay" as const }, system: false, extra: {} })),
    ],
    extra: {},
  };
}

function bodyOf(req: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

async function until<T>(check: () => T | undefined | null | false, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待桌面参考图编辑闭环超时");
}

type Mode = "success" | "auth";

interface Setup {
  root: string;
  local: DesktopLocalBridge;
  port: Awaited<ReturnType<typeof createDesktopPort>>["port"];
  board: Board;
  runner: Runner;
  changes: RunnerChange[];
  writes: string[];
  generated: Record<string, unknown>[];
  target: RunTarget;
  /** 换网关行为：同一个任务节点先失败、修好密钥后再重新生成。 */
  setMode(mode: Mode): void;
  picked: { multiple: boolean[] };
  setBoard(next: Board): void;
}

async function setup(options: { mode?: Mode; refPath?: string; refs?: number; prompt?: string; regions?: boolean } = {}): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "kacha-154-"));
  roots.push(root);
  await mkdir(join(root, "画板"), { recursive: true });
  let mode: Mode = options.mode ?? "success";
  let baseUrl = "";
  const generated: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const body = await bodyOf(req);
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      generated.push(JSON.parse(body));
      if (mode === "auth") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ metadata: { output: { choices: [{ message: { content: [{ image: baseUrl + "/result.png" }] } }] } } }));
      return;
    }
    if (req.method === "GET" && req.url === "/result.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG_1X1);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  baseUrl = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  const writes: string[] = [];
  const picked: { multiple: boolean[] } = { multiple: [] };
  const pickRoot = await mkdtemp(join(tmpdir(), "kacha-154-pick-"));
  roots.push(pickRoot);
  // 用户选中的本机图片在数据根之外：Go 侧读成 base64 给页面，页面不碰本机路径。
  const pickedFile = join(pickRoot, "橘猫.png");
  await writeFile(pickedFile, PNG_1X1);
  // 默认画板里的参考图是数据根里真实存在的一张图（缺图另有专门的用例）。
  await mkdir(join(root, "导入参考图"), { recursive: true });
  await writeFile(join(root, "导入参考图", "seed.png"), PNG_1X1);

  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_t, prop: string) => {
      if (prop === "pickImages") return async (multiple: boolean) => {
        picked.multiple.push(multiple);
        return multiple ? [{ name: "橘猫.png", data: base64Of(PNG_1X1) }] : [];
      };
      if (prop === "writeNewFileBase64") return async (abs: string, data: string) => {
        const target = resolve(abs);
        if (!target.startsWith(resolve(root) + sep)) throw new Error("写入越出数据根");
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
      if (prop === "readFile") return async (abs: string) => base64Of(await readFile(resolve(abs)));
      if (prop === "isFile") return async (abs: string) => {
        try { await readFile(resolve(abs)); return true; } catch { return false; }
      };
      // 与 Go 的 InspectImage 同形：文件不在就报 missing，界面据此标「图片缺失」。
      if (prop === "inspectImage") return async (abs: string) => {
        const bytes = await readFile(resolve(abs)).catch(() => null);
        if (!bytes) throw new PortError({ kind: "missing", code: "missing", message: "文件不存在", status: 404 });
        return { sha256: "x".repeat(64), bytes: bytes.length, width: SOURCE.width, height: SOURCE.height, format: "png", has_alpha: false };
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
    // 截图粘贴走同一条导入链路：Go 侧快照给 base64 的 PNG，页面还原成 File。
    clipboard: {
      read: async () => ({ kind: "image", text: "", images: [base64Of(PNG_1X1)], reason: "", formats: ["PNG"] }),
      writeText: async () => ({ ok: true, kind: "", message: "" }),
      copyImage: async () => ({ ok: true, kind: "", message: "", container: "png", bytes: PNG_1X1.length }),
    },
  };
  const { port } = await createDesktopPort(bridge);

  let current = boardOf(options.refPath ?? "导入参考图/seed.png", options);
  const changes: RunnerChange[] = [];
  const apply = (_key: string, change: RunnerChange) => {
    changes.push(change);
    if (change.kind === "submitted")
      current = { ...current, nodes: current.nodes.map((n) => n.id === change.taskId && n.type === "task" ? { ...n, last_submitted: change.lastSubmitted } : n) };
    if (change.kind === "runResult")
      current = addResultNode(current, { ...change.result, id: "result-" + change.result.submittedTaskId });
  };
  // 画布替身：解码尺寸由 SOURCE 给，编码字节带上尺寸与源长度，便于断言「发出去的就是落盘的那份」。
  const codec = {
    decode: async (bytes: Uint8Array): Promise<DecodedImage> => ({
      width: SOURCE.width,
      height: SOURCE.height,
      hasAlpha: () => false,
      // 编码结果的字节要能被 sniffImage 认成 PNG（写任务目录前会按字节认格式）。
      encode: async (width: number, height: number) => Uint8Array.from([...PNG_SIGNATURE, width >> 8, width & 255, height >> 8, height & 255, bytes.length >> 8, bytes.length & 255]),
      close: () => undefined,
    }),
  };
  const overlayCalls: { rects: [number, number, number, number][]; firstRegion: number }[] = [];
  const deps: RunDeps = {
    ...port.core.runDeps,
    imageCodec: codec,
    composeOverlay: async (_bytes: Uint8Array, rects: [number, number, number, number][], firstRegion = 0) => {
      overlayCalls.push({ rects, firstRegion });
      // 标注版：PNG 头 + 标记，和原图字节不同（发送的是它，盘上快照也该是它）。
      return Uint8Array.from([...PNG_SIGNATURE, 0xaa, 0xbb]);
    },
  };
  const runner = createRunner({ deps, apply, log: () => undefined, concurrency: 1 });
  const target: RunTarget = { boardKey: "A", boardFile: "画板/test.ugcboard.json", table: BUILTIN_TABLE, userRoot: root, baseUrl, apiKey: KEY };
  return {
    root, local, port, runner, changes, writes, generated, target, picked,
    get board() { return current; },
    setBoard(next: Board) { current = next; },
    setMode(next: Mode) { mode = next; },
  };
}

async function factsOf(s: Setup) {
  return { ...await collectRunFacts(s.port.core.imageProbe, s.board, ["t"], s.root), discovery: { source: "live" as const, ids: [MODEL], fetchedAt: new Date().toISOString() }, concurrency: 1 };
}

/** 读一份结局：写到盘上再读，写到一半会读空，按重试等它写完。 */
async function outcomeOf(s: Setup): Promise<{ path: string; record: Record<string, unknown> }> {
  const path = await until(() => s.writes.find((p) => p.endsWith("outcome.json")));
  let raw = "";
  for (let i = 0; i < 500 && !raw; i++) {
    try { raw = await readFile(path, "utf8"); } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  expect(raw).not.toBe("");
  return { path, record: JSON.parse(raw) as Record<string, unknown> };
}

async function storedTask(absPath: string): Promise<{ dir: string; record: Record<string, unknown> }> {
  const dir = dirname(absPath);
  let raw = "";
  for (let i = 0; i < 500 && !raw; i++) {
    try { raw = await readFile(join(dir, "task.json"), "utf8"); } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  expect(raw).not.toBe("");
  return { dir, record: JSON.parse(raw) as Record<string, unknown> };
}

describe("桌面端口选本机图片（#154）", () => {
  it("选中的图片还原成 File：文件名与字节原样，多选标志照传，取消为空", async () => {
    const s = await setup();
    const files = await s.port.media.pickImages(true);
    expect(s.picked.multiple).toEqual([true]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("橘猫.png");
    expect(files[0].type).toBe("image/png");
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(PNG_1X1);
    await expect(s.port.media.pickImages(false)).resolves.toEqual([]);
    expect(s.picked.multiple).toEqual([true, false]);
    // 截图粘贴进的是同一个参考图入口：快照里的 PNG 还原成 File，字节不变。
    const pasted = await s.port.media.readClipboard();
    expect(pasted?.images).toHaveLength(1);
    expect(new Uint8Array(await pasted!.images[0].arrayBuffer())).toEqual(PNG_1X1);
    await expect(s.port.media.uploadReference(pasted!.images[0])).resolves.toMatchObject({ path: expect.stringContaining("导入参考图/") });
  });

  it("本机图片进 导入参考图/：按内容 sha256 命名，原图字节不动，重复导入算成功", async () => {
    const s = await setup();
    const [file] = await s.port.media.pickImages(true);
    const first = await s.port.media.uploadReference(file);
    expect(first.path.startsWith("导入参考图/")).toBe(true);
    expect(first.path.endsWith(".png")).toBe(true);
    expect(new Uint8Array(await readFile(resolve(s.root, first.path)))).toEqual(PNG_1X1);
    // 同一张图再导一次：内容已在盘上，按成功处理（去重），不覆盖也不报错，也不会多出一个文件。
    const before = await readdir(resolve(s.root, "导入参考图"));
    await expect(s.port.media.uploadReference(file)).resolves.toMatchObject({ path: first.path });
    expect(await readdir(resolve(s.root, "导入参考图"))).toEqual(before);
  });
});

describe("桌面端口的参考图编辑闭环（#154）", () => {
  it("区域叠加按能力生成：确认文本、请求与任务记录一致；快照是发送的处理版本，原图不变；重开仍见结果", async () => {
    const s = await setup();
    const [file] = await s.port.media.pickImages(true);
    const uploaded = await s.port.media.uploadReference(file);
    s.setBoard(boardOf(uploaded.path));

    const [item] = buildConfirmItems(s.board, BUILTIN_TABLE, ["t"], await factsOf(s));
    expect(item.reasons).toEqual([]);
    const sendText = item.send!.text;
    // 区域表达按能力表模板：第 2 张参考图是第 1 张的标注版，配色名来自区域内核。
    expect(sendText).toContain("图2 是图1 的标注版");
    expect(sendText).toContain("紫色");
    expect(sendText).toContain("背景改成蓝色");

    expect(await s.runner.submit(s.target, s.board, ["t"], { t: 1 })).toEqual([]);
    const result = await until(() => s.changes.find((c) => c.kind === "runResult"));
    if (result.kind !== "runResult") return;

    // 请求：两张参考图（原图 + 标注版），发送文本就是确认框里那条。
    expect(s.generated).toHaveLength(1);
    expect(s.generated[0].prompt).toBe(sendText);
    const sent = s.generated[0].image as string[];
    expect(sent).toHaveLength(2);
    expect(sent[0].startsWith("data:image/png;base64,")).toBe(true);
    expect(base64ToBytes(sent[0].slice(sent[0].indexOf(";base64,") + 8))).toEqual(
      Uint8Array.from([...PNG_SIGNATURE, FITTED.width >> 8, FITTED.width & 255, FITTED.height >> 8, FITTED.height & 255, PNG_1X1.length >> 8, PNG_1X1.length & 255]),
    );

    // 任务目录：快照就是发出去的那两份字节；处理记录、来源、区域都在。
    const { dir, record } = await storedTask(s.writes.find((p) => p.endsWith("task.json"))!);
    expect(record.send_text).toBe(sendText);
    const refs = record.references as Record<string, unknown>[];
    expect(refs).toHaveLength(2);
    expect(refs[0].file).toBe("reference-1.png");
    expect(refs[0].fitted).toMatchObject({ from: { width: SOURCE.width, height: SOURCE.height }, to: { width: FITTED.width, height: FITTED.height } });
    expect(new Uint8Array(await readFile(join(dir, "reference-1.png")))).toEqual(base64ToBytes(sent[0].slice(sent[0].indexOf(";base64,") + 8)));
    // 叠加图的来源是用户序号（第 1 张参考图），区域句里的端口是发送端口。
    expect(refs[1].source).toEqual({ kind: "overlay", of: 1 });
    // 区域记录的 source_port 是用户序号（第 1 张参考图），重新生成时据此还原叠加槽。
    expect(refs[1].region).toEqual({ rects: [REGION], render: "highlight_overlay", source_port: 1 });
    expect(new Uint8Array(await readFile(join(dir, "reference-2.png")))).toEqual(base64ToBytes(sent[1].slice(sent[1].indexOf(";base64,") + 8)));
    // 原图（用户导入的那份）没有被改写：只处理发给模型的那份。
    expect(new Uint8Array(await readFile(resolve(s.root, uploaded.path)))).toEqual(PNG_1X1);

    // 结果按任务落盘，画板保存后重开仍见结果与连线。
    const resultPath = resolve(s.root, ...result.result.path.split("/"));
    expect(new Uint8Array(await readFile(resultPath))).toEqual(PNG_1X1);
    const boardPath = join(s.root, "画板", "test.ugcboard.json");
    await writeFile(boardPath, JSON.stringify(s.board, null, 2));
    const reopened = JSON.parse(await readFile(boardPath, "utf8")) as Board;
    expect(reopened.nodes.some((n) => n.type === "result" && n.task_id === result.result.submittedTaskId)).toBe(true);
    expect(reopened.edges.some((e) => e.system && e.from[0] === "t")).toBe(true);
    expect((await readdir(dir)).some((name) => name.endsWith("outcome.json"))).toBe(false);
  });

  it("参考图超额与越界引用在提交前拦下，界面原因与提交校验一致，且不调网关", async () => {
    const s = await setup({ refs: 4, regions: false });
    const [item] = buildConfirmItems(s.board, BUILTIN_TABLE, ["t"], await factsOf(s));
    const uiReasons = item.reasons.map((r) => r.text);
    expect(uiReasons).toContain("参考图 4 张超出模型上限 3 张");
    // 提交校验说同一句话：界面标红的原因和真正拦下的是同一处判断。
    expect(await s.runner.submit(s.target, s.board, ["t"], { t: 1 })).toEqual(uiReasons);
    expect(s.generated).toHaveLength(0);
    expect(s.writes.filter((p) => p.endsWith("task.json"))).toEqual([]);

    // 越界引用（@图9 但只接了 1 张）同样是提交前拦下，不落任务目录、不调网关。
    const outOfRange = await setup({ prompt: "把@图9 换成蓝色" });
    const [item2] = buildConfirmItems(outOfRange.board, BUILTIN_TABLE, ["t"], await factsOf(outOfRange));
    const reasons2 = item2.reasons.map((r) => r.text);
    expect(reasons2).toContain("提示词引用了图9，但只接了 1 张参考图");
    expect(await outOfRange.runner.submit(outOfRange.target, outOfRange.board, ["t"], { t: 1 })).toEqual(reasons2);
    expect(outOfRange.generated).toHaveLength(0);
  });

  it("缺图在提交前按界面同一句话拦下，不落任务目录、不调网关", async () => {
    const s = await setup({ refPath: "导入参考图/不存在.png", regions: false });
    const [item] = buildConfirmItems(s.board, BUILTIN_TABLE, ["t"], await factsOf(s));
    const reasons = item.reasons.map((r) => r.text);
    expect(reasons).toContain("图1 图片缺失：橘猫.png");
    expect(await s.runner.submit(s.target, s.board, ["t"], { t: 1 })).toEqual(reasons);
    expect(s.generated).toHaveLength(0);
    expect(s.writes.filter((p) => p.endsWith("task.json"))).toEqual([]);
  });

  it("取消与中断的任务都能主动重新生成：按任务目录重算，不自动续算", async () => {
    const s = await setup({ regions: false });
    const [file] = await s.port.media.pickImages(true);
    const uploaded = await s.port.media.uploadReference(file);
    s.setBoard(boardOf(uploaded.path, { regions: false }));

    // 取消：派发后取消，落已取消结局，不产结果，也不自动再来一次。
    await s.runner.submit(s.target, s.board, ["t"], { t: 1 });
    const taskJson = await until(() => s.writes.find((p) => p.endsWith("task.json")));
    s.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t" });
    expect((await outcomeOf(s)).record).toMatchObject({ outcome: "cancelled" });
    const sent = s.generated.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(s.generated).toHaveLength(sent);
    expect(s.changes.some((c) => c.kind === "runResult")).toBe(false);

    // 主动重新生成：读上次的任务目录重算发送计划，出新结果。
    expect(await s.runner.regenerate(s.target, s.board, "t")).toBeNull();
    const first = await until(() => s.changes.find((c) => c.kind === "runResult"));
    if (first.kind !== "runResult") return;
    expect(s.generated.at(-1)!.prompt).toContain("背景改成蓝色");

    // 中断：任务目录在、没有结局（应用重启后），节点记着这个任务编号，同样可主动重新生成。
    const interruptedId = "20261117T000000Z-99999999";
    const from = dirname(taskJson);
    const to = join(dirname(from), interruptedId);
    await cp(from, to, { recursive: true });
    const raw = JSON.parse(await readFile(join(to, "task.json"), "utf8"));
    await writeFile(join(to, "task.json"), JSON.stringify({ ...raw, task_id: interruptedId }));
    s.setBoard({ ...s.board, nodes: s.board.nodes.map((n) => n.id === "t" && n.type === "task" ? { ...n, last_submitted: { ...n.last_submitted!, task_id: interruptedId } } : n) });
    const before = s.changes.filter((c) => c.kind === "runResult").length;
    expect(await s.runner.regenerate(s.target, s.board, "t")).toBeNull();
    expect(await until(() => s.changes.filter((c) => c.kind === "runResult").length > before)).toBe(true);
    expect(s.generated).toHaveLength(sent + 2);
  });

  it("生成变体固定一份、进同一结果列不覆盖已有结果；失败后重新生成按当前能力重算发送文本", async () => {
    const s = await setup();
    const [file] = await s.port.media.pickImages(true);
    const uploaded = await s.port.media.uploadReference(file);
    s.setBoard(boardOf(uploaded.path, { prompt: "把@图1 的背景改成蓝色" }));

    // 先让第一次提交失败：密钥不对。
    s.setMode("auth");
    await s.runner.submit(s.target, s.board, ["t"], { t: 1 });
    const failed = await outcomeOf(s);
    expect(failed.record).toMatchObject({ outcome: "failed" });
    const failedPath = failed.path;
    expect(s.changes.some((c) => c.kind === "runResult")).toBe(false);

    // 旧任务记录里的发送文本改成过时口径：重新生成必须按当前能力重算，不重放它。
    const oldTask = join(dirname(failedPath), "task.json");
    const oldRecord = JSON.parse(await readFile(oldTask, "utf8"));
    const recomputed = oldRecord.send_text as string;
    await writeFile(oldTask, JSON.stringify({ ...oldRecord, send_text: "旧口径的发送文本 图1 图3" }));

    s.setMode("success");
    expect(await s.runner.regenerate(s.target, s.board, "t")).toBeNull();
    const first = await until(() => s.changes.find((c) => c.kind === "runResult"));
    if (first.kind !== "runResult") return;
    expect(s.generated.at(-1)!.prompt).toBe(recomputed);
    expect(s.generated.at(-1)!.prompt).not.toContain("旧口径");

    // 生成变体：按那次提交重跑，固定一份；新结果进同一结果列，旧结果节点还在。
    const before = s.changes.filter((c) => c.kind === "runResult").length;
    const boardWithResult = s.board;
    expect(await s.runner.regenerate(s.target, boardWithResult, "t", { kind: "variant", fromTaskId: first.result.submittedTaskId })).toBeNull();
    const second = await until(() => s.changes.filter((c) => c.kind === "runResult").length > before && s.changes.filter((c) => c.kind === "runResult").at(-1));
    if (!second || second.kind !== "runResult") return;
    expect(second.result.submittedTaskId).not.toBe(first.result.submittedTaskId);
    expect(s.generated).toHaveLength(3);
    const results = s.board.nodes.filter((n) => n.type === "result" && n.task_id !== undefined);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // 结果列不覆盖：每个结果各在自己的任务目录里，旧的还在盘上。
    expect(new Uint8Array(await readFile(resolve(s.root, ...first.result.path.split("/"))))).toEqual(PNG_1X1);
    expect(new Uint8Array(await readFile(resolve(s.root, ...second.result.path.split("/"))))).toEqual(PNG_1X1);
  });
});

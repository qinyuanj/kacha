// 桌面生成闭环（#153）：从桌面端口提交一份文生图，经受控网关替身拿到一张结果，
// 真实落在临时数据根的任务目录，保存画板后重开能读到结果与结局。这里不起 MyGo 窗口，
// 桥下面的 Go 服务由 desktop/internal/gateway 与 localservice 的 httptest/临时目录测试单独证明。
import { afterEach, describe, expect, it } from "vitest";
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";

import type { Board } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { base64Of } from "../core/base64";
import { addResultNode } from "../core/layout";
import { createRunner, type RunTarget, type Runner, type RunnerChange } from "../core/runner";
import { buildConfirmItems, collectRunFacts, storedStatuses } from "../core/submission";
import { PNG_1X1 } from "../core/testing/png";
import { createDesktopPort, type DesktopBridge, type DesktopGatewayBridge, type DesktopLocalBridge } from "./desktop";
import { PortError } from "./port";

const KEY = "sk-synthetic-153";
const MODEL = "qwen-image-3.0-pro";
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function board(): Board {
  return {
    format_version: 1,
    title: "文生图闭环",
    viewport: { zoom: 1, x: 0, y: 0 },
    nodes: [
      { id: "p", type: "prompt", pos: [0, 0], size: [240, 140], extra: {}, text: "一只橘猫" },
      { id: "t", type: "task", pos: [300, 0], size: [280, 260], extra: {}, model: MODEL, size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null },
    ],
    edges: [{ from: ["p", "out"], to: ["t", "positive"], source_layer: null, region: null, system: false, extra: {} }],
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
  throw new Error("等待桌面生成闭环超时");
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (e) => e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
  return nested.flat();
}

type Mode = "success" | "auth" | "server" | "malformed" | "downloadFail" | "rate" | "offline";

interface Setup {
  root: string;
  port: Awaited<ReturnType<typeof createDesktopPort>>["port"];
  board: Board;
  runner: Runner;
  changes: RunnerChange[];
  writes: string[];
  generated: Record<string, unknown>[];
  resultDownloads: number;
  target: RunTarget;
  /** 推进假时钟并触发到点的退避定时（429 用）；先等退避定时登记好，别抢在它前面。 */
  advance(ms: number): Promise<void>;
}

async function setup(mode: Mode): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "kacha-153-"));
  roots.push(root);
  await mkdir(join(root, "画板"), { recursive: true });
  let baseUrl = "";
  let resultDownloads = 0;
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
      if (mode === "server") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      if (mode === "rate") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "slow down" } }));
        return;
      }
      if (mode === "malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{ 不是 JSON");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ metadata: { output: { choices: [{ message: { content: [{ image: baseUrl + "/result.png" }] } }] } } }));
      return;
    }
    if (req.method === "GET" && req.url === "/result.png") {
      resultDownloads++;
      if (mode === "downloadFail") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "gone" } }));
        return;
      }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG_1X1);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  // offline：指向一个没有监听者的端口，模拟网关不可达（连接立刻被拒绝）。
  baseUrl = mode === "offline" ? "http://127.0.0.1:1" : "http://127.0.0.1:" + (server.address() as { port: number }).port;

  const writes: string[] = [];
  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_t, prop: string) => {
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
      if (prop === "inspectImage") return async () => ({ sha256: "x".repeat(64), bytes: PNG_1X1.length, width: 1, height: 1, format: "png", has_alpha: false });
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

  let current = board();
  const changes: RunnerChange[] = [];
  const apply = (_key: string, change: RunnerChange) => {
    changes.push(change);
    if (change.kind === "submitted")
      current = { ...current, nodes: current.nodes.map((n) => n.id === change.taskId && n.type === "task" ? { ...n, last_submitted: change.lastSubmitted } : n) };
    if (change.kind === "runResult")
      current = addResultNode(current, { ...change.result, id: "result-" + change.result.submittedTaskId });
  };
  // 假时钟：429 退避按 30s / 60s / 120s 触发，不真的等。
  let clock = Date.parse("2026-11-17T00:00:00Z");
  let timers: { at: number; fn: () => void }[] = [];
  const runner = createRunner({
    deps: {
      ...port.core.runDeps,
      now: () => new Date(clock),
      schedule: (ms, fn) => {
        const timer = { at: clock + ms, fn };
        timers.push(timer);
        return () => { timers = timers.filter((t) => t !== timer); };
      },
    },
    apply,
    log: () => undefined,
    concurrency: 1,
  });
  const target: RunTarget = { boardKey: "A", boardFile: "画板/test.ugcboard.json", table: BUILTIN_TABLE, userRoot: root, baseUrl, apiKey: KEY };
  return {
    root, port, get board() { return current; }, runner, changes, writes,
    generated, get resultDownloads() { return resultDownloads; }, target,
    async advance(ms: number) {
      // 429 的退避定时是响应处理完才登记的：先等它出现再推进时钟，否则会「推了空档、下一档才触发」。
      const deadline = Date.now() + 5000;
      while (timers.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      clock += ms;
      const due = timers.filter((t) => t.at <= clock);
      timers = timers.filter((t) => t.at > clock);
      due.forEach((t) => t.fn());
    },
  };
}

async function savedBoard(s: Setup, boardToSave: Board): Promise<Board> {
  const path = join(s.root, "画板", "test.ugcboard.json");
  await writeFile(path, JSON.stringify(boardToSave, null, 2));
  return JSON.parse(await readFile(path, "utf8")) as Board;
}

async function outcomeOf(s: Setup): Promise<{ path: string; record: Record<string, unknown> }> {
  const path = await until(() => s.writes.find((p) => p.endsWith("outcome.json")));
  let raw = "";
  for (let i = 0; i < 500 && !raw; i++) {
    try { raw = await readFile(path, "utf8"); } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  expect(raw).not.toBe("");
  return { path, record: JSON.parse(raw) as Record<string, unknown> };
}

describe("桌面端口的单份文生图闭环（#153）", () => {
  it("确认文本、请求与任务记录一致；一份一结果；保存到任务目录且重开仍见结果", async () => {
    const s = await setup("success");
    const facts = { ...await collectRunFacts(s.port.core.imageProbe, s.board, ["t"], s.root), discovery: { source: "live" as const, ids: [MODEL], fetchedAt: new Date().toISOString() }, concurrency: 1 };
    const [item] = buildConfirmItems(s.board, BUILTIN_TABLE, ["t"], facts);
    expect(item.reasons).toEqual([]);
    const sendText = item.send!.text;
    expect(sendText).toContain("一只橘猫");

    await s.runner.submit(s.target, s.board, ["t"], { t: 1 });
    const result = await until(() => s.changes.find((c) => c.kind === "runResult"));
    expect(result.kind).toBe("runResult");
    if (result.kind !== "runResult") return;
    expect(s.generated).toHaveLength(1);
    expect(s.resultDownloads).toBe(1);
    expect(s.generated[0].prompt).toBe(sendText);
    expect(s.generated[0].model).toBe(MODEL);
    expect(s.generated[0].size).toBe("1024x1024");
    expect(s.generated[0].n).toBe(1);
    expect(s.changes.filter((c) => c.kind === "runResult")).toHaveLength(1);
    expect(s.board.nodes.filter((n) => n.type === "result" && n.task_id === result.result.submittedTaskId)).toHaveLength(1);

    const taskDir = resolve(s.root, ...dirname(result.result.path).split("/"));
    const record = JSON.parse(await readFile(join(taskDir, "task.json"), "utf8"));
    expect(record.send_text).toBe(sendText);
    expect(record.model).toBe(MODEL);
    expect(record.references).toEqual([]);
    const resultBytes = await readFile(resolve(s.root, ...result.result.path.split("/")));
    expect(new Uint8Array(resultBytes)).toEqual(PNG_1X1);
    expect(new Set(s.writes).size).toBe(s.writes.length);
    await expect(s.port.core.taskFs.writeNewFile(resolve(s.root, ...result.result.path.split("/")), PNG_1X1)).rejects.toMatchObject({ kind: "alreadyExists" });
    expect((await listFiles(taskDir)).some((p) => p.endsWith("outcome.json"))).toBe(false);

    const reopened = await savedBoard(s, s.board);
    const again = reopened.nodes.find((n) => n.type === "result" && n.task_id === result.result.submittedTaskId);
    expect(again).toBeTruthy();
    const reopenedStatuses = await storedStatuses(s.port.core.taskFs, reopened, new Set(), s.root, "画板/test.ugcboard.json");
    expect(reopenedStatuses.statuses.size).toBe(0);
    expect(reopened.edges.some((e) => e.system && e.from[0] === "t")).toBe(true);
  });

  it("401 落失败结局、不落结果；重开按结局区分失败与已中断", async () => {
    const s = await setup("auth");
    await s.runner.submit(s.target, s.board, ["t"], { t: 1 });
    const { record: outcome } = await outcomeOf(s);
    expect(s.changes.some((c) => c.kind === "runResult")).toBe(false);
    expect(outcome).toMatchObject({ outcome: "failed", label: "鉴权失败" });
    expect(JSON.stringify(outcome)).not.toContain(KEY);

    const reopened = await savedBoard(s, s.board);
    const failed = await storedStatuses(s.port.core.taskFs, reopened, new Set(), s.root, "画板/test.ugcboard.json");
    expect(failed.statuses.get("t")!.copies[0].status).toEqual({ kind: "failed", label: "鉴权失败" });

    // 同一份画板换成「提交了但没有结果也没有结局」的任务编号，重开应识别为已中断。
    const oldId = reopened.nodes.find((n) => n.type === "task")?.last_submitted?.task_id as string;
    const interruptedId = "20261117T000000Z-99999999";
    const dateDir = dirname((await outcomeOf(s)).path);
    const interruptedDir = join(dirname(dateDir), interruptedId);
    await mkdir(interruptedDir, { recursive: true });
    const record = JSON.parse(await readFile(join(dateDir, "task.json"), "utf8"));
    await writeFile(join(interruptedDir, "task.json"), JSON.stringify({ ...record, task_id: interruptedId }));
    const interruptedBoard: Board = { ...reopened, nodes: reopened.nodes.map((n) => n.id === "t" && n.type === "task" ? { ...n, last_submitted: { ...n.last_submitted!, task_id: interruptedId } } : n) };
    const statuses = await storedStatuses(s.port.core.taskFs, interruptedBoard, new Set(), s.root, "画板/test.ugcboard.json");
    expect(statuses.statuses.get("t")!.copies[0].status).toEqual({ kind: "interrupted" });
    expect(oldId).not.toBe(interruptedId);
  });

  it("5xx、畸形响应与下载失败都落明确失败结局，且不产结果", async () => {
    for (const [mode, label] of [["server", "服务错误"], ["malformed", "响应无效"], ["downloadFail", "网关拒绝"]] as const) {
      const s = await setup(mode);
      await s.runner.submit(s.target, s.board, ["t"], { t: 1 });
      const { record: outcome } = await outcomeOf(s);
      expect(outcome, mode).toMatchObject({ outcome: "failed", label });
      // 失败不换模型、不重发：请求始终只有那一次、模型始终是任务上的那个。
      expect(new Set(s.generated.map((g) => g.model)), mode).toEqual(new Set([MODEL]));
      expect(s.changes.some((c) => c.kind === "runResult"), mode).toBe(false);
      expect(s.board.nodes.some((n) => n.type === "result"), mode).toBe(false);
    }
  });

  it("取消落已取消结局；重开按结局记为已取消，不当成已中断", async () => {
    const s = await setup("success");
    await s.runner.submit(s.target, s.board, ["t"], { t: 1 });
    await until(() => s.writes.some((p) => p.endsWith("task.json")));
    s.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t" });
    const { record: outcome } = await outcomeOf(s);
    expect(outcome).toMatchObject({ outcome: "cancelled" });
    expect(s.changes.some((c) => c.kind === "runResult")).toBe(false);
    const reopened = await savedBoard(s, s.board);
    const statuses = await storedStatuses(s.port.core.taskFs, reopened, new Set(), s.root, "画板/test.ugcboard.json");
    expect(statuses.statuses.get("t")!.copies[0].status).toMatchObject({ kind: "cancelled" });
  });

  it("任务目录写入失败时不呈现成功，也不调网关", async () => {
    const s = await setup("success");
    const failing = await createDesktopPort({
      info: async () => ({ version: "test", user_data_root: s.root, board_root: join(s.root, "画板"), features: { generation: true, usage: false, pack_export: false } }),
      local: new Proxy({} as DesktopLocalBridge, {
        get: () => async () => { throw new PortError({ kind: "conflict", code: "storageFull", message: "磁盘空间不足", status: 0 }); },
      }),
      gateway: {
        request: async () => { throw new Error("不该调网关"); },
        readApiKey: async () => KEY,
        writeApiKey: async () => undefined,
        deleteApiKey: async () => undefined,
      },
    });
    const runner = createRunner({ deps: failing.port.core.runDeps, apply: () => undefined, log: () => undefined, concurrency: 1 });
    const problem = await runner.submit(s.target, s.board, ["t"], { t: 1 });
    expect(problem).not.toBeNull();
    expect(s.generated).toHaveLength(0);
    expect(s.changes.some((c) => c.kind === "runResult")).toBe(false);
  });

  it("提交前不可运行的原因拦下任务，不调网关", async () => {
    const s = await setup("success");
    // 模型不在能力表里：任务视图给出不可运行原因，提交在网关之前被拦下。
    const unknown: Board = { ...s.board, nodes: s.board.nodes.map((n) => (n.type === "task" ? { ...n, model: "not-in-table" } : n)) };
    const facts = { ...await collectRunFacts(s.port.core.imageProbe, unknown, ["t"], s.root), discovery: { source: "live" as const, ids: [MODEL], fetchedAt: new Date().toISOString() }, concurrency: 1 };
    const [item] = buildConfirmItems(unknown, BUILTIN_TABLE, ["t"], facts);
    expect(item.reasons.length).toBeGreaterThan(0);
    expect(item.send).toBeNull();
    expect(s.generated).toHaveLength(0);
  });

  it("网关不可达时落网络失败结局，不冒充成功", async () => {
    const s = await setup("offline");
    await s.runner.submit(s.target, s.board, ["t"], { t: 1 });
    const { record: outcome } = await outcomeOf(s);
    expect(outcome).toMatchObject({ outcome: "failed", label: "网络不可达" });
    expect(s.changes.some((c) => c.kind === "runResult")).toBe(false);
  });

  // 等到这一份真的进了退避：429 的响应处理与定时器挂上都发生在请求返回之后，
  // 先推进假时钟会让 30s 定时器挂到已经走过的时刻上，永远不触发（与产品的退避无关）。
  async function untilBackoff(s: Setup): Promise<void> {
    await until(() => s.runner.getSnapshot().board("A").nodes.get("t")?.copies.some((c) => c.status.kind === "backoff"));
  }

  it("429 按既有退避重试后失败，不新增自动收费重试", async () => {
    const s = await setup("rate");
    await s.runner.submit(s.target, s.board, ["t"], { t: 1 });
    await untilBackoff(s);
    expect(s.generated).toHaveLength(1);
    await s.advance(30_000);
    await until(() => s.generated.length >= 2);
    await s.advance(60_000);
    await until(() => s.generated.length >= 3);
    await s.advance(120_000);
    const { record: outcome } = await outcomeOf(s);
    expect(outcome).toMatchObject({ outcome: "failed", label: "网关限流" });
    expect(s.generated).toHaveLength(4);
    expect(s.changes.some((c) => c.kind === "runResult")).toBe(false);
  }, 30000);
});

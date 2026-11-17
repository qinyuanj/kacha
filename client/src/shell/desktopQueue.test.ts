// 跨画板队列、份数、取消与退避的端口级验收（#155）：一个客户端实例只有一条队列，
// 并发上限来自全局高级设置；两块画板与任务目录都真的落在临时数据根里，网关是 node:http 受控替身，
// 不连真网关、不花额度。取消按「客户端不再等待 / 不再落结果」验，不假设网关停算。
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";

import type { Board } from "../core/board";
import { base64Of } from "../core/base64";
import { BUILTIN_TABLE } from "../core/capabilities";
import { addResultNode } from "../core/layout";
import { createRunner, type RunTarget, type Runner, type RunnerChange } from "../core/runner";
import { storedStatuses } from "../core/submission";
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

/** 提示词 p 接到任务节点 t1 / t9。 */
function board(taskId: string, prompt: string): Board {
  return {
    format_version: 1,
    title: prompt,
    viewport: { zoom: 1, x: 0, y: 0 },
    nodes: [
      { id: "p", type: "prompt", pos: [0, 0], size: [240, 140], extra: {}, text: prompt },
      { id: taskId, type: "task", pos: [300, 0], size: [280, 260], extra: {}, model: MODEL, size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null },
    ],
    edges: [{ from: ["p", "out"], to: [taskId, "positive"], source_layer: null, region: null, system: false, extra: {} }],
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

async function until(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待跨画板队列超时");
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)])));
  return nested.flat();
}

interface Setup {
  root: string;
  port: Awaited<ReturnType<typeof createDesktopPort>>["port"];
  runner: Runner;
  target(boardKey: string): RunTarget;
  boards: Map<string, Board>;
  changes: { boardKey: string; change: RunnerChange }[];
  /** 每次生成请求的 JSON 请求体。 */
  requests: Record<string, unknown>[];
  /** 结果图下载次数。 */
  downloads(): number;
  /** 同时挂起的生成请求数峰值。 */
  maxInflight(): number;
  /** 关闸：之后的生成请求挂起，直到 release（模拟网关还没回）。 */
  hold(): void;
  release(): void;
  /** 前 n 次生成请求回 429（受控替身，不花额度）。 */
  rateLimitFirst(n: number): void;
  advance(ms: number): void;
  /** 任务目录（真实路径）。 */
  taskDirs(): Promise<string[]>;
  /** 某块画板的 runResult 次数。 */
  results(boardKey: string): number;
}

async function setup(opts: { concurrency: number }): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "kacha-155-"));
  roots.push(root);
  await mkdir(join(root, "画板"), { recursive: true });

  let holding = false;
  const held: (() => void)[] = [];
  const requests: Record<string, unknown>[] = [];
  let downloads = 0;
  let inflight = 0;
  let peak = 0;
  let rateLimited = 0;
  let rateLimitFor = 0;
  let baseUrl = "";
  const server = createServer(async (req, res) => {
    const body = await bodyOf(req);
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      if (rateLimited < rateLimitFor) {
        rateLimited++;
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "slow down" } }));
        return;
      }
      inflight++;
      peak = Math.max(peak, inflight);
      const finish = () => {
        inflight--;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ metadata: { output: { choices: [{ message: { content: [{ image: baseUrl + "/result.png" }] } }] } } }));
      };
      if (holding) held.push(finish);
      else finish();
      return;
    }
    if (req.method === "GET" && req.url === "/result.png") {
      downloads++;
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

  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_t, prop: string) => {
      if (prop === "writeNewFileBase64") return async (abs: string, data: string) => {
        const target = resolve(abs);
        if (!target.startsWith(resolve(root) + sep)) throw new Error("写入越出数据根");
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

  const boards = new Map<string, Board>([["A", board("t1", "一块画板")], ["B", board("t9", "另一块画板")]]);
  const changes: { boardKey: string; change: RunnerChange }[] = [];
  const apply = (boardKey: string, change: RunnerChange) => {
    changes.push({ boardKey, change });
    const current = boards.get(boardKey);
    if (!current) throw new Error("没有这块画板：" + boardKey);
    if (change.kind === "submitted")
      boards.set(boardKey, { ...current, nodes: current.nodes.map((n) => (n.id === change.taskId && n.type === "task" ? { ...n, last_submitted: change.lastSubmitted } : n)) });
    if (change.kind === "runResult") boards.set(boardKey, addResultNode(current, { ...change.result, id: "result-" + change.result.submittedTaskId }));
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
    concurrency: opts.concurrency,
  });
  return {
    root, port, runner,
    boards,
    changes,
    requests,
    downloads: () => downloads,
    maxInflight: () => peak,
    hold: () => { holding = true; },
    release: () => { holding = false; held.splice(0).forEach((finish) => finish()); },
    rateLimitFirst: (n) => { rateLimitFor = n; },
    target: (boardKey) => ({ boardKey, boardFile: `画板/${boardKey}.ugcboard.json`, table: BUILTIN_TABLE, userRoot: root, baseUrl, apiKey: KEY }),
    advance(ms) {
      clock += ms;
      const due = timers.filter((t) => t.at <= clock);
      timers = timers.filter((t) => t.at > clock);
      due.forEach((t) => t.fn());
    },
    /** 数据根下的任务目录（<UTC 日期>/<task_id>）。 */
    async taskDirs() {
      const days = await readdir(root, { withFileTypes: true }).catch(() => []);
      const dirs: string[] = [];
      for (const day of days.filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))) {
        const entries = await readdir(join(root, day.name), { withFileTypes: true });
        for (const e of entries.filter((x) => x.isDirectory())) dirs.push(join(root, day.name, e.name));
      }
      return dirs;
    },
    results: (boardKey) => changes.filter((c) => c.boardKey === boardKey && c.change.kind === "runResult").length,
  };
}

describe("桌面端口的跨画板队列（#155）", () => {
  it("一条队列跨两块画板：并发上限按全局设置，份数展开为独立任务、每份一张结果", async () => {
    const s = await setup({ concurrency: 2 });
    s.hold();
    await s.runner.submit(s.target("A"), s.boards.get("A")!, ["t1"], { t1: 2 });
    await s.runner.submit(s.target("B"), s.boards.get("B")!, ["t9"], { t9: 1 });
    await until(() => s.requests.length === 2);
    // 两块画板共用一条队列：A 的两份先派发，B 的份还在排队。
    expect(s.requests.map((r) => r.prompt)).toEqual(["一块画板", "一块画板"]);
    expect(s.runner.getSnapshot().activity).toEqual({ busy: true, pending: 3, reading: 0, waiting: 1, running: 2, backoff: 0, boards: ["A", "B"] });
    expect(s.maxInflight()).toBe(2);

    s.release();
    await until(() => s.results("A") === 2 && s.results("B") === 1);
    expect(s.maxInflight()).toBe(2);
    // 每份各自一张结果、各自一个任务目录，成功的份没有结局记录。
    const dirs = await s.taskDirs();
    expect(dirs).toHaveLength(3);
    for (const dir of dirs) {
      const files = await listFiles(dir);
      expect(files.filter((f) => /result\.(png|jpg|webp)$/.test(f))).toHaveLength(1);
      expect(files.some((f) => f.endsWith("outcome.json"))).toBe(false);
    }
    // 多份时画板记住同一次提交的各份任务编号（ADR 0011）。
    const node = s.boards.get("A")!.nodes.find((n) => n.id === "t1");
    expect(node && node.type === "task" && node.last_submitted?.copy_task_ids).toHaveLength(2);
    expect(s.runner.getSnapshot().activity).toEqual({ busy: false, pending: 0, reading: 0, waiting: 0, running: 0, backoff: 0, boards: [] });
  });

  it("逐份取消：迟到响应不落结果但有取消结局，另一份照常成功", async () => {
    const s = await setup({ concurrency: 2 });
    s.hold();
    await s.runner.submit(s.target("A"), s.boards.get("A")!, ["t1"], { t1: 2 });
    await until(() => s.requests.length === 2);
    const copies = s.runner.getSnapshot().board("A").nodes.get("t1")!.copies;
    expect(copies).toHaveLength(2);
    const cancelledTaskId = copies[0].taskId!;
    const keptTaskId = copies[1].taskId!;
    s.runner.cancel({ kind: "copy", taskId: cancelledTaskId });
    const afterCancel = s.runner.getSnapshot().board("A").nodes.get("t1")!.copies;
    expect(afterCancel.find((c) => c.taskId === cancelledTaskId)!.status).toEqual({ kind: "cancelled", gatewayMayContinue: true });

    // 网关侧算完才回：迟到响应必须被丢弃，且不再补发请求。
    s.release();
    await until(() => s.results("A") === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.requests).toHaveLength(2);
    // 成功的份不在状态表里，只剩被取消的那一份。
    const node = s.runner.getSnapshot().board("A").nodes.get("t1")!;
    expect(node.copies.map((c) => c.status.kind)).toEqual(["cancelled"]);

    const dirs = await s.taskDirs();
    expect(dirs).toHaveLength(2);
    const withOutcome = [];
    for (const dir of dirs) {
      const files = await listFiles(dir);
      if (files.some((f) => f.endsWith("outcome.json"))) withOutcome.push(dir);
      const results = files.filter((f) => /result\.(png|jpg|webp)$/.test(f));
      expect(results).toHaveLength(files.some((f) => f.endsWith("outcome.json")) ? 0 : 1);
    }
    expect(withOutcome).toHaveLength(1);
    expect(JSON.parse(await readFile(join(withOutcome[0], "outcome.json"), "utf8"))).toEqual({ outcome: "cancelled", gateway_may_continue: true });

    // 重开画板：取消的份按结局显示，成功的那份按结果节点显示。
    const saved = join(s.root, "画板", "A.ugcboard.json");
    await writeFile(saved, JSON.stringify(s.boards.get("A"), null, 2));
    const reopened = JSON.parse(await readFile(saved, "utf8")) as Board;
    const stored = await storedStatuses(s.port.core.taskFs, reopened, new Set(), s.root, "画板/A.ugcboard.json");
    expect(stored.statuses.get("t1")!.copies.map((c) => c.status)).toEqual([{ kind: "cancelled", gatewayMayContinue: true }]);
    expect(reopened.nodes.some((n) => n.type === "result" && n.task_id === keptTaskId)).toBe(true);
  });

  it("429 退避暂停整条队列：另一块画板也等；退避结束后重试成功，两份都落盘", async () => {
    const s = await setup({ concurrency: 1 });
    s.rateLimitFirst(1);
    await s.runner.submit(s.target("A"), s.boards.get("A")!, ["t1"], { t1: 1 });
    await s.runner.submit(s.target("B"), s.boards.get("B")!, ["t9"], { t9: 1 });
    await until(() => s.runner.getSnapshot().activity.backoff === 1);
    expect(s.runner.getSnapshot().activity).toMatchObject({ busy: true, pending: 2, waiting: 1, backoff: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.requests).toHaveLength(1);

    s.advance(30_000);
    await until(() => s.results("A") === 1 && s.results("B") === 1);
    expect(s.requests.map((r) => r.prompt)).toEqual(["一块画板", "一块画板", "另一块画板"]);
    expect((await s.taskDirs()).length).toBe(2);
  });

  it("退避中取消：不再发调用、取消结局落盘，另一块画板立刻派发", async () => {
    const s = await setup({ concurrency: 1 });
    s.rateLimitFirst(1);
    await s.runner.submit(s.target("A"), s.boards.get("A")!, ["t1"], { t1: 1 });
    await until(() => s.runner.getSnapshot().activity.backoff === 1);
    await s.runner.submit(s.target("B"), s.boards.get("B")!, ["t9"], { t9: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.requests).toHaveLength(1);

    s.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    await until(() => s.results("B") === 1);
    expect(s.requests.map((r) => r.prompt)).toEqual(["一块画板", "另一块画板"]);
    // 退避中取消：网关没接这次请求，明确不承诺停算。
    const dirs = await s.taskDirs();
    expect(dirs).toHaveLength(2);
    const cancelled = await Promise.all(dirs.map(async (dir) => {
      const files = await listFiles(dir);
      return files.some((f) => f.endsWith("outcome.json")) ? JSON.parse(await readFile(join(dir, "outcome.json"), "utf8")) : null;
    }));
    expect(cancelled.filter(Boolean)).toEqual([{ outcome: "cancelled", gateway_may_continue: false }]);
  });
});


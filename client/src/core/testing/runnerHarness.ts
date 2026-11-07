import type { Board, BoardEdge, BoardNode, TaskNode } from "../board";
import { BUILTIN_TABLE } from "../capabilities";
import type { RunDeps } from "../run";
import { createRunner, nodeStatus, type RunTarget, type RunnerChange } from "../runner";
import { memoryTaskFs } from "./memoryTaskFs";
import { PNG_1X1 as PNG, PNG_1X1_BASE64 } from "./png";

const OK_BODY = JSON.stringify({ metadata: { output: { choices: [{ message: { content: [{ image: PNG_1X1_BASE64 }] } }] } } });

/** 提示词 p 接到每个任务节点；withReference 时 t1 另接参考图 r。 */
export function board(taskIds: string[] = ["t1"], withReference = false): Board {
  const nodes: BoardNode[] = [{ id: "p", type: "prompt", pos: [0, 0], size: [100, 100], extra: {}, text: "一只橘猫" }];
  const edges: BoardEdge[] = [];
  for (const [i, id] of taskIds.entries()) {
    const ports = withReference && i === 0 ? 1 : 0;
    nodes.push({ id, type: "task", pos: [200, i * 300], size: [280, 260], extra: {}, model: "qwen-image-3.0-pro", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, image_ports: ports, layer_decomposition: false, transparent_background: false, last_submitted: null } satisfies TaskNode);
    edges.push({ from: ["p", "out"], to: [id, "positive"], source_layer: null, region: null, system: false, extra: {} });
  }
  if (withReference) {
    nodes.push({ id: "r", type: "reference", pos: [0, 200], size: [100, 100], extra: {}, path: "refs/cat.png", sha256: "a".repeat(64), display_name: "cat.png" });
    edges.push({ from: ["r", "out"], to: [taskIds[0], "image:0"], source_layer: null, region: null, system: false, extra: {} });
  }
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

/** 一道闸：关着时调用挂起，开闸后逐个放行。 */
function gate() {
  const waiting: (() => void)[] = [];
  return {
    closed: false,
    /** 还放行几次后自动关闸；null = 不自动关。 */
    remaining: null as number | null,
    pass(): Promise<void> {
      if (this.remaining !== null && this.remaining-- <= 0) {
        this.remaining = null;
        this.closed = true;
      }
      return this.closed ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve();
    },
    closeAfter(passes: number) {
      this.remaining = passes;
    },
    get held() {
      return waiting.length;
    },
    open() {
      this.closed = false;
      waiting.splice(0).forEach((f) => f());
    },
  };
}

type Reply = { status: number; body: string; bytes?: Uint8Array };

/** 内存 RunDeps + 手摇假时钟 + 记录式画板写入 / 日志；网关按 replies 依次应答（用完后一律成功）。 */
export function harness(opts: { concurrency?: number; imageCodec?: RunDeps["imageCodec"] } = {}) {
  const fs = memoryTaskFs();
  const files = fs.files;
  const requests: string[] = [];
  /** 每次请求的 JSON 请求体（GET 等无请求体的为 null）。 */
  const bodies: unknown[] = [];
  const replies: Reply[] = [];
  /** 每次读文件的路径（含挂在读图闸上的）。 */
  const reads: string[] = [];
  const read = gate();
  const write = gate();
  const gateway = gate();
  let now = Date.parse("2026-09-16T09:15:00Z");
  let timers: { at: number; fn: () => void }[] = [];
  const deps: RunDeps = {
    imageCodec: opts.imageCodec,
    readFile: async (path) => {
      reads.push(path);
      await read.pass();
      return path === "/root/refs/cat.png" ? PNG : fs.readFile(path);
    },
    writeNewFile: async (path, bytes) => {
      await write.pass();
      return fs.writeNewFile(path, bytes);
    },
    fetch: async (url, init) => {
      requests.push(url);
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
      await gateway.pass();
      const r = replies.shift() ?? { status: 200, body: OK_BODY };
      return { status: r.status, headers: { get: () => null }, text: async () => r.body, arrayBuffer: async () => (r.bytes ?? new TextEncoder().encode(r.body)).slice().buffer as ArrayBuffer };
    },
    now: () => new Date(now),
    schedule: (ms, fn) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
  };
  const changes: { boardKey: string; change: RunnerChange }[] = [];
  const logs: { kind: string; fields: Record<string, unknown> }[] = [];
  const runner = createRunner({ deps, apply: (boardKey, change) => changes.push({ boardKey, change }), log: (kind, fields) => logs.push({ kind, fields }), concurrency: opts.concurrency ?? 3 });
  const target = (boardKey = "A"): RunTarget => ({ boardKey, boardFile: `${boardKey}.ugcboard`, table: BUILTIN_TABLE, userRoot: "/root", baseUrl: "http://gw", apiKey: "k" });
  return {
    runner,
    files,
    requests,
    bodies,
    replies,
    reads,
    read,
    write,
    gateway,
    changes,
    logs,
    target,
    /** 把时钟拨到 ms 之后，触发到点的定时。 */
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      due.forEach((t) => t.fn());
    },
    /** 单份时各任务节点的状态。 */
    statuses: (boardKey = "A") => Object.fromEntries([...runner.getSnapshot().board(boardKey).nodes].map(([id, n]) => [id, nodeStatus(n)])),
    locked: (boardKey = "A") => [...runner.getSnapshot().board(boardKey).locked],
    taskDirs: () => new Set([...files.keys()].map((k) => k.split("/").slice(0, 4).join("/"))),
    transitions: () => logs.filter((l) => l.kind === "task").map((l) => `${l.fields.task_node_id}:${l.fields.from_status}→${l.fields.to_status}`),
  };
}

/** 让挂起的 promise 链（含 SHA-256 摘要）走完。 */
export async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

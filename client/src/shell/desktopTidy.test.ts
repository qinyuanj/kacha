// 桌面端口上的完整整理流程（#158）：真实临时数据根、真实任务目录与图片、真实画板文件。
// 验的是端口与界面口径：列表体量与整理模式的度量一致（唯一任务目录 + 独立图片，板内只算一次），
// 阶段体量与「收掉未定稿」的预计减少量按同一份度量做集合运算，整理后重开仍见阶段与定稿。
// 不起 MyGo 窗口：本机桥在这里是替身，量字节的那份口径由 desktop/internal/boardmeasure 的测试
// 用真实实现（含导入的既有画板包）证明；这里验的是页面这一侧拿到的数怎么用。
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Buffer } from "node:buffer";

import { isFinal, openBoard, serializeBoard, stagesOf } from "../core/board";
import { editBoard, type EditEnv } from "../core/edit";
import { emptyHistory, recordChange, redo, undo } from "../core/history";
import { BUILTIN_TABLE } from "../core/capabilities";
import { boardBytes, nodesBytes, pruneSavings, type BoardMeasure } from "../core/tidy";
import { prunableResults } from "../core/stages";
import { createDesktopPort, type DesktopBridge, type DesktopLocalBridge, type DesktopOutcome } from "./desktop";
import { portFailureOf } from "./port";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** 一块画板：两个结果（各占一个任务目录）、一张导入参考图，结果都在阶段 s1 里，第一个定稿。 */
function boardText(): string {
  return JSON.stringify({
    format_version: 2,
    title: "整理闭环",
    viewport: { zoom: 1, x: 0, y: 0 },
    nodes: [
      resultNode("keep", "20260101T000000Z-aaaaaaaa", true),
      resultNode("drop", "20260101T000000Z-bbbbbbbb", false),
      { id: "ref", type: "reference", pos: [0, 0], size: [200, 200], extra: {}, path: "导入参考图/cccc.png", sha256: "c".repeat(64), display_name: "参考.png" },
    ],
    edges: [],
    stages: [{ id: "s1", name: "第一轮", nodes: ["keep", "drop"], collapsed: true, extra: {} }],
  }, null, 2);
}

function resultNode(id: string, taskId: string, final: boolean): Record<string, unknown> {
  return {
    id,
    type: "result",
    pos: [0, 0],
    size: [220, 280],
    task_id: taskId,
    file: "result.png",
    path: "2026-01-01/" + taskId + "/result.png",
    layer_count: 0,
    ...(final ? { final: true } : {}),
    record: { model: "m", prompt: "p", negative_prompt: "", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-01-01T00:00:00.000Z" },
  };
}

/** 目录（或文件）的字节数：按文件长度累加，与 Go 侧的 tree_bytes 同口径。 */
async function bytesOf(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) total += await bytesOf(join(path, entry.name));
  return total;
}

/** 桥上的度量：按画板原文里出现的条目量字节（与 Go 侧同一份口径，这里只是把结果送回页面）。 */
async function measureOf(root: string, text: string): Promise<BoardMeasure> {
  const nodes: Record<string, string[]> = {};
  const dirs: Record<string, number> = {};
  const board = JSON.parse(text) as { nodes?: { id?: string; type?: string; path?: string; task_id?: string }[] };
  if (!board.nodes) throw new Error("读不懂这块画板");
  for (const node of board.nodes) {
    const items = itemsOf(node);
    if (!node.id || items.length === 0) continue;
    nodes[node.id] = items;
    for (const item of items) if (!(item in dirs)) dirs[item] = await bytesOf(join(root, item));
  }
  return { nodes, dirs };
}

/** 一个节点引用的条目：结果与参考图按路径，任务节点按任务编号还原目录。 */
function itemsOf(node: { type?: string; path?: string; task_id?: string }): string[] {
  const out: string[] = [];
  const rel = node.path?.replace(/\\/g, "/");
  if (rel) {
    const parts = rel.split("/");
    out.push(parts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) ? parts[0] + "/" + parts[1] : rel);
  }
  const stamp = /^(\d{4})(\d{2})(\d{2})T\d{6}Z-/.exec(node.task_id ?? "");
  if (stamp) out.push(stamp[1] + "-" + stamp[2] + "-" + stamp[3] + "/" + node.task_id);
  return [...new Set(out)];
}

interface Harness {
  root: string;
  boardPath: string;
  port: Awaited<ReturnType<typeof createDesktopPort>>["port"];
  /** 本地服务这一侧真的读写了哪些画板。 */
  writes: string[];
}

/** 起一个数据根：真实任务目录、真实参考图、真实画板文件，本地桥只做读写与度量转发。 */
async function setup(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "kacha-158-"));
  roots.push(root);
  await mkdir(join(root, "画板"), { recursive: true });
  const sizes: [string, number][] = [
    ["2026-01-01/20260101T000000Z-aaaaaaaa/task.json", 400],
    ["2026-01-01/20260101T000000Z-aaaaaaaa/result.png", 600],
    ["2026-01-01/20260101T000000Z-bbbbbbbb/task.json", 500],
    ["2026-01-01/20260101T000000Z-bbbbbbbb/result.png", 500],
    ["导入参考图/cccc.png", 60],
  ];
  for (const [rel, size] of sizes) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.alloc(size));
  }
  const boardPath = join(root, "画板", "整理闭环.ugcboard.json");
  await writeFile(boardPath, boardText());

  const writes: string[] = [];
  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_t, prop: string) => {
      if (prop === "readBoard") return async (path: string) => {
        try {
          return { main: await readFile(resolve(path), "utf8"), bak: null, version: "v1" };
        } catch {
          return { main: null, bak: null, version: null };
        }
      };
      if (prop === "writeBoard") return async (path: string, text: string): Promise<DesktopOutcome> => {
        writes.push(resolve(path));
        await writeFile(resolve(path), text);
        return { ok: true, kind: "", message: "", version: "v2" };
      };
      if (prop === "measureBoard") return async (text: string) => measureOf(root, text);
      if (prop === "listBoards") return async () => ({
        boards: [{ name: "整理闭环.ugcboard.json", path: "画板/整理闭环.ugcboard.json", archived: false, bytes: totalOf(await measureOf(root, boardText())) }],
        slots: { used: 1, total: 20 },
        size_lines: { warn: 1, alert: 2 },
      });
      if (prop === "listBoardNames") return async () => ["整理闭环.ugcboard.json"];
      return () => Promise.reject(new Error("Unexpected local." + prop));
    },
  });
  const bridge: DesktopBridge = {
    info: async () => ({ version: "test", user_data_root: root, board_root: join(root, "画板"), features: { generation: false, usage: false, pack_export: false, tidy: true } }),
    local,
  };
  const { port } = await createDesktopPort(bridge);
  return { root, boardPath, port, writes };
}

function totalOf(m: BoardMeasure): number {
  return Object.values(m.dirs).reduce((s, n) => s + n, 0);
}

function env(): EditEnv {
  return { table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set(), imageSize: () => undefined, newId: () => "new-" + Math.random().toString(16).slice(2) };
}

describe("桌面端口上的整理闭环（#158）", () => {
  it("列表体量与整理模式的度量一致：唯一任务目录 + 独立图片，同一目录板内只算一次", async () => {
    const h = await setup();
    expect(h.port.features.tidy).toBe(true);

    const measure = await h.port.board.measure(boardText());
    // 1000（keep 的目录）+ 1000（drop 的目录）+ 60（导入参考图）。
    expect(measure.dirs).toEqual({
      "2026-01-01/20260101T000000Z-aaaaaaaa": 1000,
      "2026-01-01/20260101T000000Z-bbbbbbbb": 1000,
      "导入参考图/cccc.png": 60,
    });
    expect(boardBytes(measure)).toBe(2060);

    const listing = await h.port.board.list();
    expect(listing.boards[0].bytes).toBe(2060);
  });

  it("阶段体量与预计减少量按同一份度量做集合运算：收掉后画板真的变小", async () => {
    const h = await setup();
    const board = openBoard(boardText(), null);
    if (board.kind !== "ok") throw new Error("画板读不懂");
    const measure = await h.port.board.measure(boardText());

    expect(nodesBytes(measure, stagesOf(board.board)[0].nodes)).toBe(2000);
    const prunable = prunableResults(board.board, ["s1"]);
    expect(prunable).toEqual(["drop"]);
    expect(pruneSavings(measure, prunable)).toBe(1000);

    const pruned = editBoard(board.board, { kind: "pruneUnfinal", stageIds: ["s1"] }, env());
    expect(pruned.step).toEqual({ label: "收掉 1 张未定稿" });
    // 未保存的改动也能量到：直接量收掉之后的画板原文，不落盘。
    expect(boardBytes(await h.port.board.measure(serializeBoard(pruned.board)))).toBe(1060);
  });

  it("整理之后重开：阶段、收起状态与定稿都在，画板体量按新的引用算", async () => {
    const h = await setup();
    const opened = openBoard(boardText(), null);
    if (opened.kind !== "ok") throw new Error("画板读不懂");
    const pruned = editBoard(opened.board, { kind: "pruneUnfinal", stageIds: ["s1"] }, env());

    await h.port.board.write(h.boardPath, serializeBoard(pruned.board), { version: "v1" });
    expect(h.writes).toEqual([resolve(h.boardPath)]);

    const texts = await h.port.board.read(h.boardPath);
    const reopened = openBoard(texts.main, texts.bak);
    if (reopened.kind !== "ok") throw new Error("重开的画板读不懂");
    expect(stagesOf(reopened.board).map((s) => [s.name, s.collapsed, s.nodes])).toEqual([["第一轮", true, ["keep"]]]);
    const keep = reopened.board.nodes.find((n) => n.id === "keep");
    expect(keep ? isFinal(keep) : false).toBe(true);
    expect(boardBytes(await h.port.board.measure(texts.main ?? ""))).toBe(1060);
  });

  it("撤销与重做：一步回到整理前，再走回整理后；体量跟着来回", async () => {
    const h = await setup();
    const opened = openBoard(boardText(), null);
    if (opened.kind !== "ok") throw new Error("画板读不懂");
    const pruned = editBoard(opened.board, { kind: "pruneUnfinal", stageIds: ["s1"] }, env());
    if (!pruned.step) throw new Error("应构成撤销步");

    const history = recordChange(emptyHistory(), opened.board, pruned.step, 0);
    const bytesOfBoard = async (board: typeof opened.board) => boardBytes(await h.port.board.measure(serializeBoard(board)));
    expect(await bytesOfBoard(pruned.board)).toBe(1060);

    const back = undo(history, pruned.board, new Set());
    if (!back) throw new Error("撤销应可用");
    expect(back.board.nodes.map((n) => n.id)).toEqual(["keep", "drop", "ref"]);
    expect(stagesOf(back.board)[0].nodes).toEqual(["keep", "drop"]);
    expect(await bytesOfBoard(back.board)).toBe(2060);

    const forward = redo(back.history, back.board, new Set());
    if (!forward) throw new Error("重做应可用");
    expect(forward.board.nodes.map((n) => n.id)).toEqual(["keep", "ref"]);
    expect(await bytesOfBoard(forward.board)).toBe(1060);
  });

  it("读不懂的画板：度量的失败原样带回界面，不假装量出 0 字节", async () => {
    const h = await setup();
    const failure = await h.port.board.measure("{ 坏了").then(() => null, portFailureOf);
    expect(failure?.kind).toBe("failed");
  });

  it("能力关着时度量报 unavailable（不假装成功），整理入口据此标尚不可用", async () => {
    const root = await mkdtemp(join(tmpdir(), "kacha-158-off-"));
    roots.push(root);
    const bridge: DesktopBridge = {
      info: async () => ({ version: "test", user_data_root: root, board_root: join(root, "画板"), features: { generation: false, usage: false, pack_export: false } }),
      local: new Proxy({} as DesktopLocalBridge, { get: () => () => Promise.reject(new Error("不该被调用")) }),
    };
    const { port } = await createDesktopPort(bridge);
    expect(port.features.tidy).toBe(false);
    await expect(port.board.measure("{}")).rejects.toMatchObject({ kind: "unavailable", feature: "tidy" });
  });
});

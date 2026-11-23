// 移出为新画板的最后两步（#137）：写新画板与从原画板删节点。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newBoard, openBoard, type Board, type TaskNode } from "../core/board";
import { prepareStageSplit } from "../core/moveOut";
import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge, type DesktopOutcome } from "../shell/desktop";
import { finishMoveOut, moveOutWrite, moveOutRefusal, writeMovedOut } from "./boardSessionsMoveOut";

const board = (title = "新"): Board => ({ format_version: 2, title, viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} });

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 真桌面端口：本地桥把画板正文落到真实临时文件，读回也经同一个端口。 */
async function desktopPortIn(root: string) {
  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_target, prop: string) => {
      if (prop === "writeBoard")
        return async (path: string, text: string): Promise<DesktopOutcome> => {
          await writeFile(path, text);
          return { ok: true, kind: "", message: "", version: "v1" };
        };
      if (prop === "readBoard")
        return async (path: string) => {
          try {
            return { main: await readFile(path, "utf8"), bak: null, version: "v1" };
          } catch {
            return { main: null, bak: null, version: null };
          }
        };
      return () => Promise.reject(new Error("未实现：" + prop));
    },
  });
  const info: DesktopInfo = { version: "test", user_data_root: root, board_root: join(root, "画板"), features: { generation: false, usage: false, pack_export: false, tidy: false } };
  const bridge: DesktopBridge = { info: async () => info, local };
  return (await createDesktopPort(bridge)).port;
}

describe("写新画板", () => {
  it("经真实壳端口写盘：落盘后读回能重新解析，内容等于从原画板拆出的结果", async () => {
    const root = await mkdtemp(join(tmpdir(), "kacha-228-"));
    roots.push(root);
    const path = join(root, "画板", "新.ugcboard.json");
    await mkdir(dirname(path), { recursive: true });
    const port = await desktopPortIn(root);
    const original = stagedBoard();
    let seq = 0;
    const prepared = await prepareStageSplit(() => original, "s1", async () => "sha", () => `n${++seq}`);
    if (!prepared) throw new Error("阶段应能拆出新画板");

    const message = await writeMovedOut(port, path, prepared.board);
    expect(message).toBeNull();

    // 端口只收文本：落到文件里的必须是画板正文，而不是画板对象。
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("format_version", 2);
    const texts = await port.board.read(path);
    const reopened = openBoard(texts.main, texts.bak);
    if (reopened.kind !== "ok") throw new Error("写出的新画板读不回来：" + reopened.kind);
    expect(reopened.board).toEqual(prepared.board);
  });

  it("写不进去：给错误说明", async () => {
    const write = vi.fn(async () => {
      throw new Error("offline");
    });
    const message = await writeMovedOut({ board: { write } } as never, "/~/a.ugcboard.json", board());
    expect(message).toContain("offline");
  });
});

describe("从原画板删节点", () => {
  it("没有新改动：删掉并说移出成功", () => {
    const latest = board("旧");
    const apply = vi.fn(() => ({ step: {} } as never));
    const message = finishMoveOut(() => latest, apply, "k1", "s1", board("新"), latest);
    expect(apply).toHaveBeenCalledWith("k1", { kind: "moveOutStage", stageId: "s1" });
    expect(message).toContain("新");
  });

  it("期间有新改动：新画板留着，原画板不动", () => {
    const apply = vi.fn();
    const message = finishMoveOut(() => board("变了"), apply, "k1", "s1", board("新"), board("旧"));
    expect(apply).not.toHaveBeenCalled();
    expect(message).toContain("移出期间本画板有了新的改动");
  });

  it("写好之后才被拒：新画板留着", () => {
    const latest = board("旧");
    const apply = vi.fn(() => ({ step: null, hint: "有任务在跑" } as never));
    const message = finishMoveOut(() => latest, apply, "k1", "s1", board("新"), latest);
    expect(message).toContain("新");
  });
});

describe("移出前的画板位预检", () => {
  it("画板位够：放行", async () => {
    const refusal = await moveOutRefusal({ board: { list: async () => ({ slots: { used: 1, total: 10 } }) } });
    expect(refusal).toBeNull();
  });

  it("读不到列表：不拦", async () => {
    const refusal = await moveOutRefusal({ board: { list: async () => { throw new Error("offline"); } } });
    expect(refusal).toBeNull();
  });
});

describe("移出流程", () => {
  const fresh = board("新");

  function deps(patch: Record<string, unknown> = {}) {
    const d: Record<string, unknown> = {
      freePathIn: vi.fn(async () => "/~/新.ugcboard.json"),
      sha256: vi.fn(async () => "sha"),
      write: vi.fn(async () => null),
      boardOf: vi.fn(() => fresh),
      tryRemove: vi.fn(() => ({ step: {} } as never)),
      apply: vi.fn(() => ({ step: {} } as never)),
      board: { list: async () => ({ slots: { used: 1, total: 10 } }) },
      ...patch,
    };
    return d as unknown as Parameters<typeof moveOutWrite>[0] & {
      write: ReturnType<typeof vi.fn>;
      apply: ReturnType<typeof vi.fn>;
    };
  }

  it("画板位满了：直接拒绝", async () => {
    const d = deps({ board: { list: async () => ({ slots: { used: 10, total: 10 } }) } });
    const message = await moveOutWrite(d, "s1", "k1");
    expect(message).toContain("画板位满了");
    expect(d.write).not.toHaveBeenCalled();
  });

  it("阶段没了：给出说明", async () => {
    const d = deps({ tryRemove: vi.fn(() => ({ step: null, hint: "阶段不在了" } as never)) });
    const message = await moveOutWrite(d, "s1", "k1");
    expect(message).toContain("阶段");
  });

  it("没有画板：给出说明", async () => {
    const d = deps({ boardOf: vi.fn(() => null) });
    const message = await moveOutWrite(d, "s1", "k1");
    expect(message).toContain("阶段");
  });

  it("新画板写不进去：原画板不动（一步都不删）", async () => {
    const staged = stagedBoard();
    const d = deps({ boardOf: vi.fn(() => staged), write: vi.fn(async () => "磁盘满了") });
    const message = await moveOutWrite(d, "s1", "k1");
    expect(message).toBe("磁盘满了");
    expect(d.write).toHaveBeenCalledTimes(1);
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("阶段还在：拆出新画板、写好并从原画板删掉节点", async () => {
    const staged = stagedBoard();
    const d = deps({ boardOf: vi.fn(() => staged) });
    const message = await moveOutWrite(d, "s1", "k1");
    expect(d.write).toHaveBeenCalled();
    expect(d.apply).toHaveBeenCalledWith("k1", { kind: "moveOutStage", stageId: "s1" });
    expect(message).toContain("移出");
  });
});

/** 一块带阶段的画板：阶段 s1 里有一个任务节点。 */
function stagedBoard(): Board {
  const taskNode: TaskNode = {
    id: "t1",
    type: "task",
    pos: [0, 0],
    size: [280, 260],
    extra: {},
    model: "doubao-seedream-5-0-pro-260628",
    size_spec: { tier: "2K", ratio: "1:1", width: null, height: null },
    image_ports: 0,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
  };
  return {
    ...newBoard("原画板"),
    nodes: [taskNode],
    edges: [],
    stages: [{ id: "s1", name: "第二轮", nodes: ["t1"], collapsed: false, extra: {} }],
  };
}
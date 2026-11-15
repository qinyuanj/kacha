// 桌面壳的画板包导入（#131）：选包走系统对话框，导入在本机跑，进度与结局经端口回到界面。
import { describe, expect, it } from "vitest";

import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge, type DesktopPackBridge, type DesktopPackOutcome, type DesktopPackSnapshot } from "./desktop";
import type { ImportOptions, ImportPhase } from "../core/boardPack";

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/Kacha/data",
  board_root: "C:/Kacha/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

const idle: DesktopPackSnapshot = {
  running: false,
  progress: { step: "done", done: 0, total: 0, detail: "", bytes_done: 0, bytes_total: 0 },
  outcome: null,
};

/** 假桥：Pack 服务按脚本给出 pick 的路径、start 的结局与依次的 snapshot。 */
function fakeBridge(options: { picked?: string; start?: DesktopPackOutcome; snapshots?: DesktopPackSnapshot[] } = {}) {
  const calls = { pick: 0, start: [] as string[], snapshot: 0, cancel: 0 };
  const snapshots = [...(options.snapshots ?? [])];
  const local = new Proxy({} as DesktopLocalBridge, { get: () => () => Promise.reject(new Error("没实现的本地调用")) });
  const pack: DesktopPackBridge = {
    pick: async () => {
      calls.pick += 1;
      return options.picked ?? "";
    },
    start: async (path) => {
      calls.start.push(path);
      return options.start ?? { ok: true, kind: "", step: "", message: "", report: null };
    },
    snapshot: async () => {
      calls.snapshot += 1;
      return snapshots.shift() ?? idle;
    },
    cancel: async () => {
      calls.cancel += 1;
    },
  };
  const bridge: DesktopBridge = { info: () => Promise.resolve(INFO), local, pack };
  return { bridge, calls };
}

/** 界面侧给的导入选项：打开画板、记阶段、记日志。 */
function options(opened: string[] = [], phases: ImportPhase[] = []): ImportOptions & { stages: string[] } {
  const stages: string[] = [];
  return {
    file: new File([], "包.ugcpack"),
    openBoard: async (path: string) => {
      opened.push(path);
    },
    onStage: (stage) => stages.push(stage),
    onPhase: (phase) => phases.push(phase),
    log: () => undefined,
    stages,
  };
}

const report = (overrides: Partial<NonNullable<DesktopPackOutcome["report"]>> = {}) => ({
  outcomes: [{ path: "2026-01-02/t1", outcome: "moved" }],
  bytes: 42,
  boards: ["画板/画板一.ugcboard.json"],
  imported: 1,
  skipped: 0,
  conflicts: [],
  missing: [],
  message: "导入 1 个任务，跳过 0 个",
  ...overrides,
});

describe("桌面壳：画板包导入（#131）", () => {
  it("桥上有 Pack 服务时导入可用，选包走系统对话框并记住路径", async () => {
    const { bridge, calls } = fakeBridge({ picked: "C:/Users/me/包.ugcpack" });
    const { port } = await createDesktopPort(bridge);
    expect(port.features.packImport).toBe(true);

    const file = await port.media.pickPackFile();
    expect(calls.pick).toBe(1);
    expect(file?.name).toBe("包.ugcpack");
  });

  it("取消选包返回 null，不开始导入", async () => {
    const { bridge, calls } = fakeBridge({ picked: "" });
    const { port } = await createDesktopPort(bridge);
    expect(await port.media.pickPackFile()).toBeNull();
    expect(calls.start).toEqual([]);
  });

  it("导入成功：用选中的路径开始，结局折成 done 并逐个打开画板", async () => {
    const { bridge, calls } = fakeBridge({
      picked: "C:/Users/me/包.ugcpack",
      snapshots: [{ running: true, progress: { step: "extract", done: 1, total: 2, detail: "t1", bytes_done: 10, bytes_total: 20 }, outcome: null }, idle],
    });
    const { port } = await createDesktopPort(bridge);
    const file = (await port.media.pickPackFile())!;
    const opened: string[] = [];
    const phases: ImportPhase[] = [];

    // 结局要等导入结束才给：snapshot 的最后一个说 running = false，带报告。
    const done = { ...idle, outcome: { ok: true, kind: "", step: "done", message: "", report: report() } };
    (bridge.pack as DesktopPackBridge).snapshot = async () => (calls.snapshot++ === 0 ? { running: true, progress: { step: "extract", done: 1, total: 2, detail: "t1", bytes_done: 10, bytes_total: 20 }, outcome: null } : done);

    const result = await port.pack.import(file, options(opened, phases));
    expect(calls.start).toEqual(["C:/Users/me/包.ugcpack"]);
    expect(result).toEqual({
      kind: "done",
      summary: { imported: 1, skipped: 0, conflicts: [], message: "导入 1 个任务，跳过 0 个" },
      written: ["画板一.ugcboard.json"],
      writeError: null,
    });
    expect(opened).toEqual(["画板/画板一.ugcboard.json"]);
    // 本地解压合并的那几步按 Go 侧的步骤报给界面。
    expect(phases).toEqual(["extract"]);
  });

  it("包损坏：结局是 corrupt，画板一个都不打开", async () => {
    const { bridge } = fakeBridge({ picked: "C:/包.ugcpack", start: { ok: true, kind: "", step: "", message: "" } });
    (bridge.pack as DesktopPackBridge).start = async () => ({ ok: false, kind: "corrupt", step: "check", message: "包内路径无效：../逃出去.txt" });
    const { port } = await createDesktopPort(bridge);
    const file = (await port.media.pickPackFile())!;
    const opened: string[] = [];

    const result = await port.pack.import(file, options(opened));
    expect(result).toEqual({ kind: "corrupt", reason: "包内路径无效：../逃出去.txt" });
    expect(opened).toEqual([]);
  });

  it("写入画板失败：结局是 commitFailed，界面据此说「画板没有写入」", async () => {
    const { bridge } = fakeBridge({ picked: "C:/包.ugcpack" });
    (bridge.pack as DesktopPackBridge).start = async () => ({ ok: false, kind: "failed", step: "boards", message: "画板没有写入：磁盘写满" });
    const { port } = await createDesktopPort(bridge);
    const file = (await port.media.pickPackFile())!;

    expect(await port.pack.import(file, options())).toEqual({ kind: "commitFailed", error: "画板没有写入：磁盘写满" });
  });

  it("取消导入：结局是 cancelled", async () => {
    const { bridge } = fakeBridge({ picked: "C:/包.ugcpack" });
    (bridge.pack as DesktopPackBridge).start = async () => ({ ok: true, kind: "", step: "", message: "" });
    (bridge.pack as DesktopPackBridge).snapshot = async () => ({ running: false, progress: { step: "merge", done: 1, total: 3, detail: "", bytes_done: 0, bytes_total: 0 }, outcome: { ok: false, kind: "cancelled", step: "merge", message: "已取消导入" } });
    const { port } = await createDesktopPort(bridge);
    const file = (await port.media.pickPackFile())!;

    expect(await port.pack.import(file, options())).toEqual({ kind: "cancelled" });
  });

  it("进度经 ui.onPackProgress 推给界面，按字节算", async () => {
    const { bridge } = fakeBridge({ picked: "C:/包.ugcpack" });
    const { port } = await createDesktopPort(bridge);
    const seen: { done: number; total: number }[] = [];
    const off = await port.ui.onPackProgress((p) => seen.push(p));
    const file = (await port.media.pickPackFile())!;
    (bridge.pack as DesktopPackBridge).snapshot = async () => ({
      running: false,
      progress: { step: "extract", done: 2, total: 2, detail: "", bytes_done: 2048, bytes_total: 4096 },
      outcome: { ok: true, kind: "", step: "done", message: "", report: report() },
    });

    await port.pack.import(file, options());
    expect(seen).toContainEqual({ done: 2048, total: 4096 });
    off();
  });

  it("取消导入经 io.cancel 落到 Pack.Cancel；其余去重上传方法仍报「尚不可用」", async () => {
    const { bridge, calls } = fakeBridge({ picked: "C:/包.ugcpack" });
    const { port } = await createDesktopPort(bridge);
    await port.pack.io.cancel(true);
    expect(calls.cancel).toBe(1);
    // false 只是复位取消标记，不该再打扰 Go 侧。
    await port.pack.io.cancel(false);
    expect(calls.cancel).toBe(1);
    await expect(port.pack.io.stage()).rejects.toMatchObject({ kind: "unavailable", feature: "packExport" });
  });

  it("桥上没有 Pack 服务：导入与选包都报 unavailable", async () => {
    const local = new Proxy({} as DesktopLocalBridge, { get: () => () => Promise.reject(new Error("没实现的本地调用")) });
    const bridge: DesktopBridge = { info: () => Promise.resolve(INFO), local };
    const { port } = await createDesktopPort(bridge);
    expect(port.features.packImport).toBe(false);
    await expect(port.media.pickPackFile()).rejects.toMatchObject({ kind: "unavailable", feature: "packImport" });
  });
});

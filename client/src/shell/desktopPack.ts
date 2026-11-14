// 桌面壳的画板包导入（#131）：选包走系统对话框，导入在本机跑，进度与结局经端口回到界面。
//
// Go 侧 Pack 服务（desktop/internal/packservice）把导入跑在后台 goroutine 里：这里只负责
// 选包、开始导入、轮询快照，并把 Go 的结局折成 core 的 ImportResult（界面按 kind 分支的那一套）。
// 从 shell/desktop.ts 拆出来（#137）：一组能力一个模块，函数复杂度单独看得到。
import { PortError, type PackStore } from "./port";
import type { ImportOptions, ImportPhase, ImportResult, PackIo } from "../core/boardPack";
import { unavailable } from "./desktopStores";
import type { DesktopBridge, DesktopPackBridge, DesktopPackSnapshot } from "./desktop";

/** 一次本地调用：Go 侧异常折成 failed（消息保持原文）。 */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PortError) throw e;
    throw new PortError({ kind: "failed", code: "local", message: e instanceof Error ? e.message : String(e), status: 0 });
  }
}

/** 导入进度（字节）：进度对话框经 ui.onPackProgress 订阅。 */
export interface PackProgress {
  done: number;
  total: number;
}

/** Go 侧步骤名 → core 的 ImportPhase（本地解压合并的那几步）。 */
const PHASES: Record<string, ImportPhase> = { extract: "extract", restore: "restore", merge: "merge", boards: "boards" };

/** 桌面壳的画板包能力：端口上的 PackStore、选包与进度订阅。 */
export interface DesktopPack {
  store: PackStore;
  /** 选一个画板包；取消返回 null。 */
  pickPackFile(): Promise<File | null>;
  /** 订阅导入进度，返回退订函数。 */
  onProgress(handler: (progress: PackProgress) => void): () => void;
}

/**
 * 造桌面壳的画板包能力。
 *
 * 选中的包文件 → 本机绝对路径：路径记在 WeakMap 里而不是把整个包读进内存，大包不该被复制一遍。
 */
export function createDesktopPack(bridge: DesktopBridge): DesktopPack {
  const pack: DesktopPackBridge | undefined = bridge.pack;
  const pickedPacks = new WeakMap<File, string>();
  const handlers = new Set<(progress: PackProgress) => void>();

  /** 把一次快照的字节进度报给订阅者。 */
  const publish = (progress: { bytes_done: number; bytes_total: number }): void => {
    for (const handler of handlers) handler({ done: progress.bytes_done, total: progress.bytes_total });
  };

  /** 等一次导入跑完：每 100ms 取一次快照，直到 running 变 false（大包不会让界面卡住）。 */
  const awaitImport = async (options: ImportOptions): Promise<DesktopPackSnapshot> => {
    let lastStep = "";
    for (;;) {
      const snapshot = await run(() => pack!.snapshot());
      publish(snapshot.progress);
      const phase = PHASES[snapshot.progress.step];
      if (phase && snapshot.progress.step !== lastStep) {
        lastStep = snapshot.progress.step;
        options.onPhase?.(phase);
      }
      if (!snapshot.running) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  /** 把 Go 侧的结局折成 core 的 ImportResult。 */
  const resultOf = async (snapshot: DesktopPackSnapshot, options: ImportOptions): Promise<ImportResult> => {
    const outcome = snapshot.outcome;
    if (!outcome) return { kind: "failed", error: "导入没有给出结局" };
    if (!outcome.ok) {
      switch (outcome.kind) {
        case "corrupt":
          return { kind: "corrupt", reason: outcome.message };
        case "newer":
          return { kind: "newer", message: outcome.message };
        case "cancelled":
          return { kind: "cancelled" };
        case "conflict":
        case "failed":
          // 画板没有写入；合并中途失败时已移入的任务目录保留（与 Web 版同一说法）。
          return { kind: "commitFailed", error: outcome.message };
        default:
          return { kind: "failed", error: outcome.message };
      }
    }
    const report = outcome.report;
    if (!report) return { kind: "failed", error: "导入没有给出报告" };
    const written: string[] = [];
    let writeError: string | null = null;
    try {
      for (const path of report.boards) {
        await options.openBoard(path);
        written.push(path.slice(path.lastIndexOf("/") + 1));
      }
    } catch (e) {
      writeError = e instanceof Error ? e.message : String(e);
    }
    return {
      kind: "done",
      summary: { imported: report.imported, skipped: report.skipped, conflicts: report.conflicts, message: report.message },
      written,
      writeError,
    };
  };

  /** 空快照：开始导入就被拒时用它把结局交给 resultOf。 */
  const snapshotOf = (outcome: NonNullable<DesktopPackSnapshot["outcome"]>): DesktopPackSnapshot => ({
    running: false,
    progress: { step: outcome.step, done: 0, total: 0, detail: "", bytes_done: 0, bytes_total: 0 },
    outcome,
  });

  const store: PackStore = {
    // 去重上传协议是 Web 版的路子：桌面壳整包在本机合并，不走 io。
    // 只有取消是真的：进度对话框上的「取消」经 io.cancel 落到 Pack.Cancel。
    io: new Proxy({} as PackIo, {
      get: (_target, prop: string) =>
        prop === "cancel"
          ? async (cancelled: boolean): Promise<void> => {
              if (cancelled && pack) await run(() => pack.cancel());
            }
          : async (): Promise<never> => unavailable("packExport"),
    }),
    /** 导入画板包：本机解压合并，画板作为新画板提交。 */
    import: async (file: File, options: ImportOptions): Promise<ImportResult> => {
      if (!pack) unavailable("packImport");
      const path = pickedPacks.get(file);
      if (!path) return { kind: "failed", error: "没有选中画板包" };
      options.onStage("progress");
      const started = await run(() => pack!.start(path));
      // 开不了就按结局处理：不必再轮询（start 已把原因说清）。
      if (!started.ok) return resultOf(snapshotOf(started), options);
      return resultOf(await awaitImport(options), options);
    },
    facts: async (): Promise<never> => unavailable("packExport"),
    exportPack: async (): Promise<never> => unavailable("packExport"),
  };

  return {
    store,
    pickPackFile: async (): Promise<File | null> => {
      if (!pack) unavailable("packImport");
      const path = await run(() => pack!.pick());
      if (!path) return null;
      const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
      const file = new File([], name, { type: "application/zip" });
      pickedPacks.set(file, path);
      return file;
    },
    onProgress: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

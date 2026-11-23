// 桌面壳的画板包导入（#131）：选包走系统对话框，导入在本机跑，进度与结局经端口回到界面。
//
// Go 侧 Pack 服务（desktop/internal/packservice）把导入跑在后台 goroutine 里：这里只负责
// 选包、开始导入、轮询快照，并把 Go 的结局折成 core 的 ImportResult（界面按 kind 分支的那一套）。
// 从 shell/desktop.ts 拆出来（#137）：一组能力一个模块，判定放在纯函数里，函数复杂度单独看得到。
import { PortError, type PackStore } from "./port";
import type { ImportOptions, ImportPhase, ImportResult, PackEntryFact, PackExportSpec, PackIo } from "../core/boardPack";
import { localRun, unavailable } from "./desktopStores";
import type { DesktopBridge, DesktopExportOutcome, DesktopPackBridge, DesktopPackOutcome, DesktopPackSnapshot } from "./desktop";

/** 导入进度（字节）：进度对话框经 ui.onPackProgress 订阅。 */
export interface PackProgress {
  done: number;
  total: number;
}

/** 桌面壳的画板包能力：端口上的 PackStore、选包与进度订阅。 */
export interface DesktopPack {
  store: PackStore;
  /** 选一个画板包；取消返回 null。 */
  pickPackFile(): Promise<File | null>;
  /** 订阅导入进度，返回退订函数。 */
  onProgress(handler: (progress: PackProgress) => void): () => void;
}

/** 轮询间隔：大包也在动，界面每 100ms 就能看到一笔新进度。 */
const POLL_MS = 100;

/** Go 侧步骤名 → core 的 ImportPhase（本地解压合并的那几步）。 */
const PHASES: Record<string, ImportPhase> = { extract: "extract", restore: "restore", merge: "merge", boards: "boards" };

/** 等 millis 毫秒。 */
function sleep(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

/** 路径的最后一段（Windows 与 POSIX 分隔符都认）。 */
function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
}

/** 失败结局 → core 的 ImportResult（界面按 kind 分支的那一套）。 */
function failureResult(outcome: DesktopPackOutcome): ImportResult {
  if (outcome.kind === "corrupt") return { kind: "corrupt", reason: outcome.message };
  if (outcome.kind === "newer") return { kind: "newer", message: outcome.message };
  if (outcome.kind === "cancelled") return { kind: "cancelled" };
  // 画板位由本机存储执行：导入撞满位时给界面统一文案，不折成笼统的写入失败。
  if (outcome.kind === "slotsFull") return { kind: "slotsFull", message: outcome.message };
  // 画板没有写入；合并中途失败时已移入的任务目录保留。
  if (outcome.kind === "conflict" || outcome.kind === "failed") return { kind: "commitFailed", error: outcome.message };
  return { kind: "failed", error: outcome.message };
}

/** 打开导入的画板：给出打开成功的文件名与第一个打开失败的原因。 */
async function openImportedBoards(boards: string[], open: (path: string) => Promise<void>): Promise<{ written: string[]; writeError: string | null }> {
  const written: string[] = [];
  try {
    for (const path of boards) {
      await open(path);
      written.push(baseName(path));
    }
    return { written, writeError: null };
  } catch (e) {
    return { written, writeError: e instanceof Error ? e.message : String(e) };
  }
}

/** 成功结局 → done：汇总计数并逐个打开画板。 */
async function doneResult(report: NonNullable<DesktopPackOutcome["report"]>, options: ImportOptions): Promise<ImportResult> {
  const { written, writeError } = await openImportedBoards(report.boards, (path) => options.openBoard(path));
  const summary = { imported: report.imported, skipped: report.skipped, conflicts: report.conflicts, message: report.message };
  return { kind: "done", summary, written, writeError };
}

/** 一次导入的快照 → core 的 ImportResult。 */
async function resultOf(snapshot: DesktopPackSnapshot, options: ImportOptions): Promise<ImportResult> {
  const outcome = snapshot.outcome;
  if (!outcome) return { kind: "failed", error: "导入没有给出结局" };
  if (!outcome.ok) return failureResult(outcome);
  if (!outcome.report) return { kind: "failed", error: "导入没有给出报告" };
  return doneResult(outcome.report, options);
}

/** 空快照：开始导入就被拒时用它把结局交给 resultOf。 */
function snapshotOf(outcome: DesktopPackOutcome): DesktopPackSnapshot {
  return {
    running: false,
    progress: { step: outcome.step, done: 0, total: 0, detail: "", bytes_done: 0, bytes_total: 0 },
    outcome,
  };
}

/** 步骤变了就报一次 phase，返回记下的新步骤名。 */
function nextPhase(step: string, lastStep: string, onPhase?: (phase: ImportPhase) => void): string {
  const phase = PHASES[step];
  if (!phase || step === lastStep) return lastStep;
  onPhase?.(phase);
  return step;
}

/** 等一次导入跑完：每 100ms 取一次快照，直到 running 变 false，边等边报进度与步骤。 */
async function awaitImport(pack: DesktopPackBridge, options: ImportOptions, publish: (progress: { bytes_done: number; bytes_total: number }) => void): Promise<DesktopPackSnapshot> {
  let lastStep = "";
  for (;;) {
    const snapshot = await localRun(() => pack.snapshot());
    publish(snapshot.progress);
    lastStep = nextPhase(snapshot.progress.step, lastStep, options.onPhase);
    if (!snapshot.running) return snapshot;
    await sleep(POLL_MS);
  }
}

/** 开始导入并按结局折成 ImportResult。 */
async function importPackFile(pack: DesktopPackBridge, path: string, options: ImportOptions, publish: (progress: { bytes_done: number; bytes_total: number }) => void): Promise<ImportResult> {
  options.onStage("progress");
  const started = await localRun(() => pack.start(path));
  // 开不了就按结局处理：不必再轮询（start 已把原因说清）。
  if (!started.ok) return resultOf(snapshotOf(started), options);
  return resultOf(await awaitImport(pack, options, publish), options);
}

/** 取消本机导入与导出；false 复位由 Go 在开启新任务时处理。 */
function packIo(pack: DesktopPackBridge | undefined): PackIo {
  return {
    cancel: async (cancelled) => {
      if (!cancelled || !pack) return;
      // 导入与导出各自取消：其中一项没在跑也不该挡住另一项。
      await localRun(() => pack.cancel()).catch(() => undefined);
      if (pack.cancelExport) await localRun(() => pack.cancelExport!()).catch(() => undefined);
    },
  };
}

/** Go 的导出失败 → 端口失败：界面按 kind 分支，不读英文文案。 */
function exportFailure(outcome: DesktopExportOutcome): PortError {
  const kind = outcome.kind === "cancelled" ? "cancelled" : outcome.kind === "invalid" ? "invalid" : "failed";
  return new PortError({ kind, code: outcome.kind || "failed", message: outcome.message || "导出失败", status: 0 });
}

/** 等导出跑完：轮询 Go 快照并上报真实字节进度。 */
async function awaitExport(pack: DesktopPackBridge, publish: (progress: { bytes_done: number; bytes_total: number }) => void): Promise<{ task_dirs: number; bytes: number }> {
  for (;;) {
    const snapshot = await localRun(() => pack.exportSnapshot!());
    publish(snapshot.progress);
    if (snapshot.running) {
      await sleep(POLL_MS);
      continue;
    }
    const outcome = snapshot.outcome;
    if (!outcome) throw new PortError({ kind: "failed", code: "noOutcome", message: "导出没有给出结局", status: 0 });
    if (!outcome.ok) throw exportFailure(outcome);
    if (!outcome.result) throw new PortError({ kind: "failed", code: "noResult", message: "导出没有给出报告", status: 0 });
    return outcome.result;
  }
}

/** 导出画板包：系统选目标 → 本机打包 → 轮询真实进度；取消与失败都不报成功。 */
async function exportPackThroughGo(pack: DesktopPackBridge | undefined, name: string, spec: PackExportSpec, publish: (progress: { bytes_done: number; bytes_total: number }) => void): Promise<{ task_dirs: number; bytes: number; target: string }> {
  if (!pack?.pickExport || !pack.exportPack || !pack.exportSnapshot) unavailable("packExport");
  const picked = await localRun(() => pack.pickExport!(name));
  if (!picked?.path) throw new PortError({ kind: "cancelled", code: "cancelled", message: "已取消导出", status: 0 });
  // 覆盖许可只在用户确认过时为 true：导出 owner 据此才替换已存在的目标。
  const started = await localRun(() => pack.exportPack!(picked.path, spec, picked.overwrite));
  if (!started.ok) throw exportFailure(started);
  const result = await awaitExport(pack, publish);
  return { ...result, target: picked.path };
}

/** 画板包那一组：导入与导出都走本机 Pack 服务。 */
function packStore(pack: DesktopPackBridge | undefined, pickedPacks: WeakMap<File, string>, publish: (progress: { bytes_done: number; bytes_total: number }) => void): PackStore {
  return {
    io: packIo(pack),
    /** 导入画板包：本机解压合并，画板作为新画板提交。 */
    import: async (file: File, options: ImportOptions): Promise<ImportResult> => {
      if (!pack) unavailable("packImport");
      const path = pickedPacks.get(file);
      if (!path) return { kind: "failed", error: "没有选中画板包" };
      return importPackFile(pack, path, options, publish);
    },
    facts: async (spec: Pick<PackExportSpec, "task_dirs" | "files">): Promise<PackEntryFact[]> => {
      if (!pack?.facts) unavailable("packExport");
      return localRun(() => pack.facts!(spec));
    },
    exportPack: (name, spec) => exportPackThroughGo(pack, name, spec, publish),
  };
}

/** 选包：系统对话框给出本机路径，之后交给 Pack.Start（路径记在 pickedPacks 里，不读整包）。 */
async function pickPack(pack: DesktopPackBridge | undefined, pickedPacks: WeakMap<File, string>): Promise<File | null> {
  if (!pack) unavailable("packImport");
  const path = await localRun(() => pack.pick());
  if (!path) return null;
  const file = new File([], baseName(path), { type: "application/zip" });
  pickedPacks.set(file, path);
  return file;
}

/**
 * 造桌面壳的画板包能力。
 *
 * 选中的包文件 → 本机绝对路径：路径记在 WeakMap 里而不是把整个包读进内存，大包不该被复制一遍。
 */
export function createDesktopPack(bridge: DesktopBridge): DesktopPack {
  const pack = bridge.pack;
  const pickedPacks = new WeakMap<File, string>();
  const handlers = new Set<(progress: PackProgress) => void>();

  /** 把一次快照的字节进度报给订阅者。 */
  const publish = (progress: { bytes_done: number; bytes_total: number }): void => {
    for (const handler of handlers) handler({ done: progress.bytes_done, total: progress.bytes_total });
  };

  return {
    store: packStore(pack, pickedPacks, publish),
    pickPackFile: () => pickPack(pack, pickedPacks),
    onProgress: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

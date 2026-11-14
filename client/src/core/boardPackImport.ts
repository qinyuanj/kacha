// 画板包导入（ADR 0013/#62/#89/#128）：本地检查 → 去重上传合并，或整包上传交服务端；结局折成 ImportResult。
// 从 boardPack.ts 拆出（#137）：按内容去重与导入编排各拆成小函数，文档里的一步步在这里是一段段。行为与原实现逐字一致。
import { serializeBoard } from "./board";
import { BOARDS_DIR_NAME, basename } from "./paths";
import { sha256Hex } from "./sha256";
import { blobSource, readEntryBytes, type ZipEntry } from "./zipIndex";
import { errorText } from "./errors";
import { inspectPack, readPackLocally, type LocalPack } from "./boardPackInspect";
import {
  MAX_CONTENT_BYTES,
  PACK_CANCELLED,
  PACK_MANIFEST,
  byPath,
  type ExistingUnit,
  type ImportOptions,
  type ImportPhase,
  type ImportResult,
  type ImportSummary,
  type MergeOutcome,
  type MergeReport,
  type MergeUnit,
  type Outcome,
  type PackCheck,
  type PackDuplicates,
  type PackIo,
  type PlacedFile,
  type Rejected,
} from "./boardPackTypes";

type OkCheck = Extract<PackCheck, { kind: "ok" }>;
type Merged = { check: OkCheck; report: MergeReport };
type SlotsFull = Extract<ImportResult, { kind: "slotsFull" }>;

const preparedBoards = (check: OkCheck) => check.boards.map(({ board }) => ({ title: board.title, text: serializeBoard(board) }));

const isTextEntry = (name: string) => name === PACK_MANIFEST || name.startsWith(BOARDS_DIR_NAME + "/");

/** 单份内容不超过上传上限时可按内容去重上传，否则整包上传。 */
function isSmallEnough(entries: ZipEntry[]): boolean {
  return entries.every((e) => e.size <= MAX_CONTENT_BYTES);
}

/** 包内路径到承载条目：v2 被省略的路径指向代表条目；同时给出按路径排序的非文本条目名，供逐单元列举。 */
interface PackContentIndex {
  entryOf(path: string): ZipEntry;
  paths: string[];
}

function indexContents(entries: ZipEntry[], duplicates: PackDuplicates): PackContentIndex {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const omitted = new Map(Object.entries(duplicates));
  return {
    entryOf: (path) => byName.get(omitted.get(path) ?? path)!,
    paths: [...byName.keys(), ...omitted.keys()].filter((name) => !isTextEntry(name)).sort(byPath),
  };
}

/** 合并单元与「本机已有」的比对结果：要搬的单元、已定结局、以及要按 hash 比对的参考图。 */
interface UnitClassification {
  needed: MergeUnit[];
  settled: MergeReport["outcomes"];
  compareAfterHash: { path: string; sha256: string }[];
}

/** 逐个合并单元比对：缺失 → 待搬；读不出 → 冲突；参考图留待 hash 比对；任务目录按 task.json 的 sha256 判跳过 / 冲突。 */
async function classifyUnits(units: MergeUnit[], present: Map<string, ExistingUnit>, contentShaOf: (relPath: string) => Promise<string>): Promise<UnitClassification> {
  const settled: MergeReport["outcomes"] = [];
  const needed: MergeUnit[] = [];
  const compareAfterHash: { path: string; sha256: string }[] = [];
  for (const unit of units) {
    const theirs = present.get(unit.path) ?? { state: "absent" };
    if (theirs.state === "absent") needed.push(unit);
    else if (theirs.state === "unreadable") settled.push({ path: unit.path, outcome: "conflict" });
    else if (unit.identity === null) compareAfterHash.push({ path: unit.path, sha256: theirs.sha256 });
    else {
      const ours = await contentShaOf(unit.path + "/" + unit.identity);
      settled.push({ path: unit.path, outcome: ours === theirs.sha256 ? "identical" : "conflict" });
    }
  }
  return { needed, settled, compareAfterHash };
}

/** 要给哪些条目算 sha256（按条目名去重、排序），算完返回 条目名 → sha256。 */
async function hashNeeded(io: PackIo, file: File, neededPaths: string[], compareAfterHash: { path: string; sha256: string }[], index: PackContentIndex, phase: (p: ImportPhase) => void): Promise<Map<string, string>> {
  const toHash = [...new Map([...neededPaths, ...compareAfterHash.map((c) => c.path)].map((p) => [index.entryOf(p).name, index.entryOf(p)])).values()].sort((a, b) => byPath(a.name, b.name));
  const shaOf = new Map<string, string>();
  if (toHash.length > 0) {
    phase("hash");
    for (const fact of await io.hash(file, toHash)) shaOf.set(fact.entry, fact.sha256);
  }
  return shaOf;
}

/** 上传去重后的内容并让服务端落盘合并；失败时放弃暂存再原样抛出。 */
async function uploadAndMerge(io: PackIo, file: File, needed: MergeUnit[], files: PlacedFile[], settled: MergeReport["outcomes"], check: OkCheck, index: PackContentIndex, phase: (p: ImportPhase) => void): Promise<MergeReport & { boards: string[] }> {
  const contents = new Map<string, ZipEntry>();
  for (const file_ of files) if (!contents.has(file_.sha256)) contents.set(file_.sha256, index.entryOf(file_.path));
  const total = [...contents.values()].reduce((n, e) => n + e.size, 0);

  phase("upload");
  const staging = await io.stage();
  return discardOnError(
    async () => {
      let done = 0;
      for (const [sha256, entry] of contents) {
        await io.uploadContent(staging, sha256, { file, entry }, { done, total });
        done += entry.size;
      }
      phase("merge");
      const merged = await io.importContent(staging, needed, files, preparedBoards(check));
      return { boards: merged.boards, outcomes: [...settled, ...merged.outcomes], bytes: merged.bytes };
    },
    () => io.discardStaging?.(staging),
  );
}

/**
 * 去重上传（#62，ADR 0018 补记）：先问服务端哪些合并单元已有——已有的任务目录按 ADR 0013 比 task.json 判跳过 / 冲突，
 * 连 hash 都不算；剩下的条目算 sha256，相同内容只上传一份（v1 包在这里按 sha256 合并；v2 包被省略的路径直接用代表条目的内容，
 * 只为代表条目算 hash），再按「路径 → sha256」的落盘清单让服务端落盘合并。导入参考图要整文件比对，已有的也要算 hash（只读本地）。
 */
async function importByContent(io: PackIo, file: File, check: OkCheck, entries: ZipEntry[], phase: (p: ImportPhase) => void): Promise<MergeReport & { boards: string[] }> {
  const src = blobSource(file);
  const index = indexContents(entries, check.duplicates);
  const filesOf = (unit: MergeUnit) => (unit.identity === null ? [unit.path] : index.paths.filter((p) => p.startsWith(unit.path + "/")));

  phase("existing");
  const present = new Map((await io.existing(check.units)).map((p) => [p.path, p]));
  const { needed, settled, compareAfterHash } = await classifyUnits(check.units, present, async (rel) => sha256Hex(await readEntryBytes(src, index.entryOf(rel))));
  const neededPaths = needed.flatMap(filesOf);
  const shaOf = await hashNeeded(io, file, neededPaths, compareAfterHash, index, phase);
  for (const c of compareAfterHash) settled.push({ path: c.path, outcome: shaOf.get(index.entryOf(c.path).name) === c.sha256 ? "identical" : "conflict" });
  // 即便内容全已存在，也要提交画板；此时上传清单为空。
  const files: PlacedFile[] = neededPaths.map((path) => ({ path, sha256: shaOf.get(index.entryOf(path).name)! }));
  return uploadAndMerge(io, file, needed, files, settled, check, index, phase);
}

/**
 * 服务端在合并结束时自己删上传的包 / 暂存；合并之前就被取消或失败时由这里放弃（幂等，放弃失败不掩盖原错误），再原样抛出。
 */
async function discardOnError<T>(run: () => Promise<T>, discard: () => Promise<void> | undefined): Promise<T> {
  try {
    return await run();
  } catch (e) {
    await discard()?.catch(() => undefined);
    throw e;
  }
}

/** 先复位取消标记，复位之后才进入进度阶段（调用方在此弹进度），再跑命令：进度弹出后立刻点的取消才不会丢。 */
export async function runCancellable<T>(io: Pick<PackIo, "cancel">, onStage: (stage: "progress") => void, run: () => Promise<T>): Promise<Outcome<T>> {
  await io.cancel(false);
  onStage("progress");
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    const error = errorText(e);
    return { ok: false, result: error === PACK_CANCELLED ? "cancelled" : "failed", error };
  }
}

/** 只按任务目录计导入与跳过数；参考图冲突也列出。 */
export function importSummary(units: MergeUnit[], outcomes: { path: string; outcome: MergeOutcome }[]): ImportSummary {
  const taskDirs = new Set(units.filter((u) => u.identity !== null).map((u) => u.path));
  const count = (outcome: MergeOutcome) => outcomes.filter((o) => o.outcome === outcome && taskDirs.has(o.path)).length;
  const imported = count("moved");
  const skipped = count("identical");
  const conflicts = outcomes.filter((o) => o.outcome === "conflict").map((o) => o.path);
  const conflictText = conflicts.length ? "，" + conflicts.length + " 项冲突未覆盖" : "";
  return { imported, skipped, conflicts, message: "导入 " + imported + " 个任务，跳过 " + skipped + " 个" + conflictText };
}

// ---- 导入编排 ----

/** 一次导入的过程状态：最近进入的阶段、通过检查的包、已打开的画板路径。 */
interface ImportRunState {
  reached: ImportPhase | null;
  checked?: OkCheck;
  importedPaths: string[];
}

/** 把「最近进入的阶段」记进状态并转给调用方（失败在服务端合并步时结局要用它）。 */
function phaseReporter(state: ImportRunState, opts: ImportOptions): (phase: ImportPhase) => void {
  return (phase) => {
    state.reached = phase;
    opts.onPhase?.(phase);
  };
}

/** 画板位预检：放不下时给出结局，放得下为 null。 */
async function slotsFullOutcome(opts: ImportOptions, check: OkCheck): Promise<SlotsFull | null> {
  const message = (await opts.slotsRefusal?.(check.boards.length)) ?? null;
  return message === null ? null : { kind: "slotsFull", message };
}

/** 整包上传后由服务端列条目与文本判定版本与布局；读取被取消时原样抛，其他错误判为损坏。 */
async function readServerCheck(io: PackIo, pack: string): Promise<PackCheck> {
  try {
    const entries = await io.entries(pack);
    return await inspectPack(entries, (names) => io.readTexts(pack, names));
  } catch (e) {
    if (errorText(e) === PACK_CANCELLED) throw e;
    return { kind: "corrupt", reason: errorText(e) };
  }
}

/** 整包上传路径：上传后判版本与布局（可能用本地已知的判定）、预检画板位，再让服务端按合并单元导入。 */
async function uploadAndImport(io: PackIo, file: File, local: OkCheck | null, opts: ImportOptions, state: ImportRunState, phase: (p: ImportPhase) => void): Promise<Rejected | SlotsFull | Merged> {
  phase("upload");
  const pack = await io.upload(file);
  const discard = () => io.discard?.(pack);
  return discardOnError(async () => {
    const check = local ?? (await readServerCheck(io, pack));
    if (check.kind !== "ok") {
      await discard()?.catch(() => undefined);
      return check;
    }
    if (!local) {
      state.checked = check;
      const full = await slotsFullOutcome(opts, check);
      if (full) {
        await discard()?.catch(() => undefined);
        return full;
      }
    }
    phase("merge");
    const merged = await io.importUnits(pack, check.units, check.duplicates, preparedBoards(check));
    state.importedPaths = merged.boards;
    return { check, report: merged };
  }, discard);
}

/** 可取消阶段的主体：本地检查 → 去重上传合并或整包上传。 */
async function runImport(io: PackIo, opts: ImportOptions, state: ImportRunState): Promise<Rejected | SlotsFull | Merged> {
  const { file } = opts;
  const phase = phaseReporter(state, opts);
  phase("check");
  const read: LocalPack | null = await readPackLocally(blobSource(file));
  const local = read?.check ?? null;
  if (local && local.kind !== "ok") return local;
  if (local) {
    state.checked = local;
    const full = await slotsFullOutcome(opts, local);
    if (full) return full;
  }
  if (read && local && isSmallEnough(read.entries)) {
    const merged = await importByContent(io, file, local, read.entries, phase);
    state.importedPaths = merged.boards;
    return { check: local, report: merged };
  }
  return uploadAndImport(io, file, local, opts, state, phase);
}

/** 成功结局 → done：汇总计数并逐个打开画板（第一个打开失败即停，记下报错）。 */
async function finishDone(value: Merged, importedPaths: string[], opts: ImportOptions): Promise<ImportResult> {
  const { check, report } = value;
  const summary = importSummary(check.units, report.outcomes);
  const written: string[] = [];
  let writeError: string | null = null;
  try {
    for (const path of importedPaths) {
      await opts.openBoard(path);
      written.push(basename(path));
    }
  } catch (e) {
    writeError = errorText(e);
  }
  const packBoards = check.boards.map((b) => basename(b.entry)).join(", ");
  opts.log("board_pack", {
    action: "import",
    pack_file: opts.file.name,
    task_dirs: summary.imported,
    skipped: summary.skipped,
    conflicts: summary.conflicts.length,
    bytes: report.bytes,
    board_file: writeError ? packBoards : written.join(", "),
    result: writeError ? "board_write_failed" : "ok",
  });
  return { kind: "done", summary, written, writeError };
}

/** 结局 → ImportResult 并记脱敏日志。 */
async function finishImport(outcome: Outcome<Rejected | SlotsFull | Merged>, state: ImportRunState, opts: ImportOptions): Promise<ImportResult> {
  const packBoards = state.checked?.boards.map((b) => basename(b.entry)).join(", ");
  const boardField = packBoards === undefined ? {} : { board_file: packBoards };
  const fields = { action: "import", pack_file: opts.file.name };
  if (!outcome.ok) {
    opts.log("board_pack", { ...fields, ...boardField, result: outcome.result });
    if (outcome.result === "cancelled") return { kind: "cancelled" };
    return { kind: state.reached === "merge" ? "commitFailed" : "failed", error: outcome.error };
  }
  const value = outcome.value;
  if ("kind" in value && value.kind === "slotsFull") {
    opts.log("board_pack", { ...fields, ...boardField, result: "board_slots_full" });
    return value;
  }
  if (!("report" in value)) {
    opts.log("board_pack", { ...fields, result: value.kind });
    return value;
  }
  return finishDone(value, state.importedPaths, opts);
}

/**
 * 导入画板包（#128）：同一个可取消的进度阶段里依次本地检查（#61）→ 上传 → 服务端合并并提交画板，之后逐个打开返回路径。
 * 本地检查判为版本过新或损坏时直接返回，一个字节都不上传；检查通过就按内容去重上传（#62），只传服务端缺少的内容。
 * zip 读取器读不了的包，或有条目超过单份上限的包，整包上传（#59）；读不了的由服务端读条目与文本判定（不合格不合并）。
 * 从「已拿到用户选的包文件」开始；选包、进度、结果弹窗与文案都留在 ui（弹窗不是端口，见 #128），这里只返回结局。
 * 任何一步被取消或失败都不进入后续各步，并放弃已上传的内容。取消或失败时已移入的任务目录保留；打开画板失败不回滚服务端已提交内容。
 */
export async function importPack(io: PackIo, opts: ImportOptions): Promise<ImportResult> {
  const state: ImportRunState = { reached: null, importedPaths: [] };
  const outcome = await runCancellable(io, opts.onStage, () => runImport(io, opts, state));
  return finishImport(outcome, state, opts);
}

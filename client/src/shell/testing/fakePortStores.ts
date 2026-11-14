// 内存壳端口的各个分组（#137）：从 shell/testing/fakePort.ts 拆出，一个分组一个函数。
// 拆开之后每个函数的复杂度单独看得到，门禁也按函数计。
import type { ImportOptions, ImportResult, MergeReport, PackEntryFact } from "../../core/boardPack";
import type { BoardListing, BoardTexts, BoardWriteOptions, BrowserOptions, ImageInfo, SessionPort, UsagePort } from "../types";
import { PortError, type BoardStore, type FeatureId, type FileStore, type MediaStore, type MetaStore, type PackStore, type PortFailureKind, type UiStore } from "../port";
import type { FakeBoard, FakeCalls, FakeImportOutcome, FakePortOptions } from "./fakePortTypes";

/** 造一个端口失败（界面按 kind 分支）。 */
export const fakeFailureOf = (kind: PortFailureKind, message: string = kind, feature?: FeatureId): PortError =>
  new PortError({ kind, code: kind, message, status: kind === "conflict" ? 409 : 0, ...(feature ? { feature } : {}) });

/** 把导入结局折成 core 的 ImportResult（界面按 kind 分支的那套）。 */
export function toImportResult(outcome: FakeImportOutcome): ImportResult {
  switch (outcome.kind) {
    case "done":
      return {
        kind: "done",
        summary: { imported: outcome.summary.imported, skipped: outcome.summary.skipped, conflicts: outcome.summary.conflicts, message: outcome.summary.message },
        written: outcome.written,
        writeError: outcome.writeError ?? null,
      };
    case "partial":
      return {
        kind: "done",
        summary: { imported: 1, skipped: 1, conflicts: outcome.conflicts, message: outcome.message },
        written: [],
        writeError: null,
      };
    case "failed":
      return { kind: "commitFailed", error: outcome.error };
    case "slotsFull":
      return { kind: "slotsFull", message: outcome.message };
    case "corrupt":
      return { kind: "corrupt", reason: outcome.reason };
    case "newer":
      return { kind: "newer", message: outcome.message };
    case "cancelled":
      return { kind: "cancelled" };
  }
}

/** 写一份画板：新建则只新建不覆盖；版本不符是冲突。 */
export function fakeWrite(boards: Map<string, FakeBoard>, calls: FakeCalls, options: FakePortOptions) {
  return async (path: string, text: string, writeOptions?: BoardWriteOptions) => {
    calls.write.push({ path, text, options: writeOptions });
    const failure = options.writeFailures?.get(path);
    if (failure) throw fakeFailureOf(failure, failure === "conflict" ? "画板已在别处修改" : "写入失败");
    const existing = boards.get(path);
    if (writeOptions?.createOnly && existing) throw fakeFailureOf("alreadyExists", "目标已存在，只新建不覆盖");
    if (writeOptions?.version && existing && existing.version !== writeOptions.version) throw fakeFailureOf("conflict", "画板已在别处修改");
    boards.set(path, { path, main: text, bak: existing?.main ?? null, version: `v-${calls.write.length}` });
  };
}

/** 搬一块画板：源不存在就报 missing。 */
export function fakeMove(boards: Map<string, FakeBoard>) {
  return async (from: string, to: string, archived: boolean) => {
    const found = boards.get(from);
    if (!found) throw fakeFailureOf("missing", "画板不存在");
    boards.delete(from);
    boards.set(to, { ...found, path: to, archived });
  };
}

/** 画板那一组：内存里的画板文件。 */
export function fakeBoardStore(boards: Map<string, FakeBoard>, calls: FakeCalls, options: FakePortOptions): BoardStore {
  const slots = options.slots ?? { used: 0, total: 20 };
  const write = fakeWrite(boards, calls, options);
  const move = fakeMove(boards);
  return {
    read: async (path) => {
      calls.read.push(path);
      const found = boards.get(path);
      const texts: BoardTexts = found ? { main: found.main, bak: found.bak ?? null, version: found.version } : { main: null, bak: null, version: null };
      return texts;
    },
    write,
    rename: async (from, to, version) => {
      calls.rename.push({ from, to, version });
      await move(from, to, false);
    },
    remove: async (path, version) => {
      calls.remove.push({ path, version });
      if (!boards.delete(path)) throw fakeFailureOf("missing", "画板不存在");
    },
    archive: async (from, to, version) => {
      calls.archive.push({ from, to, version });
      await move(from, to, true);
    },
    unarchive: async (from, to) => {
      calls.unarchive.push({ from, to });
      await move(from, to, false);
    },
    listNames: async (dir) => [...boards.keys()].filter((p) => p.startsWith(dir)).map((p) => p.slice(p.lastIndexOf("/") + 1)),
    list: async (): Promise<BoardListing> => {
      calls.list += 1;
      return {
        boards: [...boards.values()].map((b) => ({ name: b.path.slice(b.path.lastIndexOf("/") + 1), path: b.path, archived: b.archived ?? false, bytes: b.bytes ?? null })),
        slots,
        size_lines: { warn: 500 * 1024 * 1024, alert: 1024 * 1024 * 1024 },
      };
    },
    measure: async () => ({ nodes: {}, dirs: {} }),
  };
}

/** 统一成正斜杠并去掉尾部斜杠，便于比较目录前缀。 */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 一个路径的字节：画板取正文，其余取注入的 files。 */
function fakeBytesOf(boards: Map<string, FakeBoard>, files: Map<string, Uint8Array>, absPath: string): Uint8Array | undefined {
  const board = boards.get(absPath);
  return board ? new TextEncoder().encode(board.main ?? "") : files.get(absPath);
}

/** 目录在不在：显式声明的目录，或有文件落在它下面。 */
function fakeDirExists(extraDirs: Set<string>, paths: readonly string[], absDir: string): boolean {
  if (extraDirs.has(absDir) || extraDirs.has(normPath(absDir))) return true;
  return paths.some((p) => normPath(p).startsWith(normPath(absDir) + "/"));
}

/** 列目录的直接子项（文件名 + 是否目录）。 */
function fakeChildrenOf(paths: readonly string[], absDir: string): { name: string; is_dir: boolean }[] {
  const dir = normPath(absDir) + "/";
  const entries = new Map<string, boolean>();
  for (const p of paths) {
    const path = normPath(p);
    if (!path.startsWith(dir)) continue;
    const rest = path.slice(dir.length);
    const slash = rest.indexOf("/");
    entries.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
  }
  return [...entries].map(([name, is_dir]) => ({ name, is_dir }));
}

/** 文件那一组：与真实 FileStore 同形——路径不存在就报 missing，不假装读到空内容（B3）。 */
export function fakeFileStore(boards: Map<string, FakeBoard>, calls: FakeCalls, options: FakePortOptions = {}): FileStore {
  const files = new Map<string, Uint8Array>(Object.entries(options.files ?? {}));
  const extraDirs = new Set(options.dirs ?? []);
  const bytesOf = (absPath: string): Uint8Array | undefined => fakeBytesOf(boards, files, absPath);
  const paths = (): string[] => [...boards.keys(), ...files.keys()];
  return {
    readFile: async (absPath) => {
      const bytes = bytesOf(absPath);
      if (!bytes) throw fakeFailureOf("missing", "文件不存在：" + absPath);
      return bytes;
    },
    writeNewFile: async (absPath, bytes) => {
      if (bytesOf(absPath)) throw fakeFailureOf("alreadyExists", "目标已存在，只新建不覆盖");
      calls.writeNewFile = [...(calls.writeNewFile ?? []), { absPath, bytes }];
      files.set(absPath, bytes);
    },
    isFile: async (absPath) => bytesOf(absPath) !== undefined,
    listDir: async (absDir) => {
      if (!fakeDirExists(extraDirs, paths(), absDir)) throw fakeFailureOf("missing", "目录不存在：" + absDir);
      return fakeChildrenOf(paths(), absDir);
    },
    sha256: async (absPath) => {
      if (!bytesOf(absPath)) throw fakeFailureOf("missing", "文件不存在：" + absPath);
      return `sha-${absPath}`;
    },
    inspectImage: async (absPath): Promise<ImageInfo> => {
      if (!bytesOf(absPath)) throw fakeFailureOf("missing", "文件不存在：" + absPath);
      calls.inspectImage.push(absPath);
      return { sha256: `sha-${absPath}`, bytes: 10, width: 64, height: 48, format: "png", has_alpha: false };
    },
  };
}

/** 元数据那一组。 */
export function fakeMetaStore(calls: FakeCalls): MetaStore {
  return {
    readSettings: async () => null,
    writeSettings: async () => undefined,
    readUiState: async () => null,
    writeUiState: async (text) => {
      calls.uiStateWrites.push(text);
    },
    readModelsCache: async () => null,
    writeModelsCache: async () => undefined,
    readCapabilityOverride: async () => null,
  };
}

/** 浏览器能力那一组。 */
export function fakeMediaStore(options: FakePortOptions, calls: FakeCalls, pickImages: File[][], pickPacks: (File | null)[]): MediaStore {
  return {
    imageUrl: (absPath) => `fake://file${absPath}`,
    thumbUrl: (absPath) => `fake://thumb${absPath}`,
    pickImages: async (multiple) => {
      const next = pickImages.shift() ?? [];
      calls.pickImages.push({ multiple, files: next });
      return next;
    },
    pickPackFile: async () => {
      const next = pickPacks.shift() ?? null;
      calls.pickPackFile.push(next);
      return next;
    },
    uploadReference: async (file) => {
      calls.uploadReference.push(file);
      return { path: `导入参考图/${file.name}`, sha256: `sha-${file.name}` };
    },
    copyText: async (text) => {
      calls.copyText.push(text);
    },
    copyImage: async (absPath, format) => {
      calls.copyImage.push({ path: absPath, format });
      const result = typeof options.copyImage === "function" ? options.copyImage(absPath, format) : options.copyImage;
      return result ?? { ok: true };
    },
    readClipboard: async () => options.clipboard ?? null,
    saveCopyAs: async (absPath) => {
      calls.saveCopyAs.push(absPath);
    },
    downloadImage: (path) => {
      calls.downloadImage = [...(calls.downloadImage ?? []), path];
    },
    downloadBoardResults: (boardPath) => {
      calls.downloadBoardResults = [...(calls.downloadBoardResults ?? []), boardPath];
    },
  };
}

/** 跑一次导入：记住调用，把结局折成 core 的 ImportResult。 */
export async function runImport(
  imports: FakeImportOutcome[],
  calls: FakeCalls,
  file: File,
  importOptions: ImportOptions,
): Promise<ImportResult> {
  calls.import.push({ file, options: importOptions });
  const outcome = imports.shift() ?? { kind: "done", summary: { imported: 0, skipped: 0, conflicts: [], message: "已导入" }, written: [] };
  const result = toImportResult(outcome);
  // 与真实导入一致：结局是 done 时逐个打开导入的画板，打开失败记进 writeError。
  if (result.kind !== "done") return result;
  try {
    for (const path of outcome.kind === "done" ? outcome.written : []) await importOptions.openBoard(path);
    return result;
  } catch (e) {
    return { ...result, writeError: e instanceof Error ? e.message : String(e) };
  }
}

/** 画板包那一组。 */
export function fakePackStore(imports: FakeImportOutcome[], calls: FakeCalls): PackStore {
  const io = {
    cancel: async () => undefined,
    existing: async () => [],
    hash: async (): Promise<PackEntryFact[]> => [],
    stage: async () => "staging-1",
    uploadContent: async () => undefined,
    importContent: async (): Promise<MergeReport & { boards: string[] }> => ({ outcomes: [], bytes: 0, boards: [] }),
    discardStaging: async () => undefined,
    upload: async () => "pack-1",
    entries: async () => [],
    readTexts: async () => ({}),
    importUnits: async (): Promise<MergeReport & { boards: string[] }> => ({ outcomes: [], bytes: 0, boards: [] }),
    discard: async () => undefined,
  };
  return {
    io,
    import: async (file, importOptions: ImportOptions) => runImport(imports, calls, file, importOptions),
    facts: async () => [],
    exportPack: async () => ({ task_dirs: 0, bytes: 0 }),
  };
}

/** 界面能力那一组。 */
export function fakeUiStore(calls: FakeCalls): UiStore {
  return {
    ask: async (_message: string, _options?: BrowserOptions) => calls.ask !== false,
    message: async (text) => {
      calls.messages = [...(calls.messages ?? []), text];
    },
    onPackProgress: async () => () => undefined,
    openExternal: (url) => {
      calls.openExternal = [...(calls.openExternal ?? []), url];
    },
    version: async () => "9.9.9",
    log: (kind, fields) => {
      calls.log.push({ kind, fields });
    },
    isEditableTarget: (target) => target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null,
    installInputTakeover: () => () => undefined,
  };
}

/** 用量统计那一组。 */
export function fakeUsageStore(missing: Set<string>): UsagePort {
  return {
    usage: async () => {
      if (missing.has("usage")) throw fakeFailureOf("unavailable", "桌面版没有用量统计", "usage");
      return { total_bytes: 0, boards_bytes: 0, meta_bytes: 0, last_access: 0, by_date: [], unreferenced: null, unreadable_board: null, limit_bytes: null, limit_level: null };
    },
    cleanupUnreferenced: async () => ({ moved: [], skipped: [] }),
  };
}

/** 会话那一组。 */
export function fakeSessionStore(options: { requiresLogin?: boolean; storedKey?: string | null } = {}): SessionPort {
  return {
    // requiresLogin 可改：桌面壳（不登录）与 Web 版（要登录）用同一个替身。
    requiresLogin: options.requiresLogin ?? true,
    login: async () => ({ fingerprint: "fake" }),
    current: async () => ({ fingerprint: "fake" }),
    logout: async () => undefined,
    config: async () => ({ version: "9.9.9", gateway_url: "http://gateway.invalid" }),
    onExpired: () => () => undefined,
    readStoredKey: () => options.storedKey ?? null,
    storeKey: () => undefined,
    clearStoredKey: () => undefined,
  };
}
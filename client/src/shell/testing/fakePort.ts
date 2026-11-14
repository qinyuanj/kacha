// 测试用的内存壳端口（#126）：驱动打开画板、复制图片、粘贴图片、导入画板包，
// 并能返回成功、部分成功与失败结局，让界面把这些结局原样传出去（不必起 MyGo runtime、不发请求）。
// 形状与真实适配器一致：失败一律是 PortError，类别（conflict / missing / slotsFull / alreadyExists / ...）与
// Web 实现折出来的同一套，界面按类别分支的分支点因此在替身下也走得到。
import { buildZip, type FixtureEntry } from "../../core/testing/zipFixture";
import type { ImportOptions, ImportResult, MergeReport, PackEntryFact } from "../../core/boardPack";
import type { BoardListing, BoardTexts, BoardWriteOptions, BrowserOptions, ImageInfo, SessionPort, UsagePort } from "../types";
import { PortError, type BoardStore, type ClipboardContent, type CorePorts, type FeatureId, type FileStore, type ImageCopyResult, type MediaStore, type MetaStore, type PackStore, type PortFailureKind, type ShellPort, type UiStore } from "../port";

/** 造一个端口失败（界面按 kind 分支）。 */
export const fakeFailure = (kind: PortFailureKind, message: string = kind, feature?: FeatureId): PortError =>
  new PortError({ kind, code: kind, message, status: kind === "conflict" ? 409 : 0, ...(feature ? { feature } : {}) });

export interface FakeBoard {
  path: string;
  main: string | null;
  bak?: string | null;
  version: string | null;
  archived?: boolean;
  bytes?: number | null;
}

/** 画板包导入的脚本化结局：success / partial / failure 都由它给出。 */
export type FakeImportOutcome =
  | { kind: "done"; summary: { imported: number; skipped: number; conflicts: string[]; message: string }; written: string[]; writeError?: string | null }
  | { kind: "partial"; message: string; conflicts: string[] }
  | { kind: "failed"; error: string }
  | { kind: "slotsFull"; message: string }
  | { kind: "corrupt"; reason: string }
  | { kind: "newer"; message: string }
  | { kind: "cancelled" };

export interface FakePortOptions {
  userRoot?: string;
  boards?: FakeBoard[];
  /** 系统剪贴板内容：readClipboard 返回它（null = 读不到，按 paste 事件走）。 */
  clipboard?: ClipboardContent | null;
  /** copyImage 的结局：默认成功。 */
  copyImage?: ImageCopyResult | ((absPath: string) => ImageCopyResult);
  /** pickImages / pickPackFile 依次返回的文件（空了返回空 / null）。 */
  pickImages?: File[][];
  pickPackFiles?: (File | null)[];
  /** importPack 依次返回的结局；空了回 done。 */
  imports?: FakeImportOutcome[];
  /** write 的失败：命中路径时抛（用来验保存冲突）。 */
  writeFailures?: Map<string, PortFailureKind>;
  /** 没有的能力。 */
  missing?: FeatureId[];
  /** 是否需要登录界面：默认要（Web 版）；桌面壳给 false。 */
  requiresLogin?: boolean;
  /** 本地存着的密钥：有它时界面直接进工作台（Web 版已登录的样子）。 */
  storedKey?: string | null;
  slots?: { used: number; total: number };
}

/** 把导入结局折成 core 的 ImportResult（界面按 kind 分支的那套）。 */
function toImportResult(outcome: FakeImportOutcome): ImportResult {
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

/** 画板包 fixture：manifest + 一块画板（导入用例用来验「选中的包文件被交给端口」）。 */
export function fakePackFile(entries: FixtureEntry[] = []): File {
  const bytes = buildZip(entries);
  return new File([bytes as unknown as BlobPart], "包.ugcpack", { type: "application/zip" });
}

/** 内存壳端口：所有分组都是可断言的替身，行为按选项脚本化。 */
export type FakePort = ShellPort & { calls: FakeCalls };

export function createFakePort(options: FakePortOptions = {}): FakePort {
  const boards = new Map<string, FakeBoard>((options.boards ?? []).map((b) => [b.path, { ...b }]));
  const pickImages = [...(options.pickImages ?? [])];
  const pickPacks = [...(options.pickPackFiles ?? [])];
  const imports = [...(options.imports ?? [])];
  const calls: FakeCalls = { write: [], read: [], rename: [], remove: [], archive: [], unarchive: [], import: [], copyImage: [], copyText: [], pickImages: [], pickPackFile: [], saveCopyAs: [], log: [], uploadReference: [], inspectImage: [], list: 0, uiStateWrites: [] };
  const missing = new Set<FeatureId>(options.missing ?? []);
  const slots = options.slots ?? { used: 0, total: 20 };

  const board: BoardStore = {
    read: async (path) => {
      calls.read.push(path);
      const found = boards.get(path);
      const texts: BoardTexts = found ? { main: found.main, bak: found.bak ?? null, version: found.version } : { main: null, bak: null, version: null };
      return texts;
    },
    write: async (path, text, writeOptions?: BoardWriteOptions) => {
      calls.write.push({ path, text, options: writeOptions });
      const failure = options.writeFailures?.get(path);
      if (failure) throw fakeFailure(failure, failure === "conflict" ? "画板已在别处修改" : "写入失败");
      const existing = boards.get(path);
      if (writeOptions?.createOnly && existing) throw fakeFailure("alreadyExists", "目标已存在，只新建不覆盖");
      if (writeOptions?.version && existing && existing.version !== writeOptions.version) throw fakeFailure("conflict", "画板已在别处修改");
      boards.set(path, { path, main: text, bak: existing?.main ?? null, version: `v-${calls.write.length}` });
    },
    rename: async (from, to, version) => {
      calls.rename.push({ from, to, version });
      const found = boards.get(from);
      if (!found) throw fakeFailure("missing", "画板不存在");
      boards.delete(from);
      boards.set(to, { ...found, path: to });
    },
    remove: async (path, version) => {
      calls.remove.push({ path, version });
      if (!boards.delete(path)) throw fakeFailure("missing", "画板不存在");
    },
    archive: async (from, to, version) => {
      calls.archive.push({ from, to, version });
      const found = boards.get(from);
      if (!found) throw fakeFailure("missing", "画板不存在");
      boards.delete(from);
      boards.set(to, { ...found, path: to, archived: true });
    },
    unarchive: async (from, to) => {
      calls.unarchive.push({ from, to });
      const found = boards.get(from);
      if (!found) throw fakeFailure("missing", "画板不存在");
      boards.delete(from);
      boards.set(to, { ...found, path: to, archived: false });
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

  const files: FileStore = {
    readFile: async () => new Uint8Array(),
    writeNewFile: async (absPath, bytes) => {
      calls.writeNewFile = [...(calls.writeNewFile ?? []), { absPath, bytes }];
    },
    isFile: async (absPath) => boards.has(absPath),
    listDir: async () => [],
    sha256: async (absPath) => `sha-${absPath}`,
    inspectImage: async (absPath): Promise<ImageInfo> => {
      calls.inspectImage.push(absPath);
      return { sha256: `sha-${absPath}`, bytes: 10, width: 64, height: 48, format: "png", has_alpha: false };
    },
  };

  const meta: MetaStore = {
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

  const media: MediaStore = {
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
    copyImage: async (absPath) => {
      calls.copyImage.push(absPath);
      const result = typeof options.copyImage === "function" ? options.copyImage(absPath) : options.copyImage;
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

  const pack: PackStore = {
    io,
    import: async (file, importOptions: ImportOptions) => {
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
    },
    facts: async () => [],
    exportPack: async () => ({ task_dirs: 0, bytes: 0 }),
  };

  const ui: UiStore = {
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

  const usage: UsagePort = {
    usage: async () => {
      if (missing.has("usage")) throw fakeFailure("unavailable", "桌面版没有用量统计", "usage");
      return { total_bytes: 0, boards_bytes: 0, meta_bytes: 0, last_access: 0, by_date: [], unreferenced: null, unreadable_board: null, limit_bytes: null, limit_level: null };
    },
    cleanupUnreferenced: async () => ({ moved: [], skipped: [] }),
  };

  const session: SessionPort = {
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

  const core: CorePorts = {
    taskFs: { readFile: files.readFile, writeNewFile: files.writeNewFile },
    runDeps: {
      readFile: files.readFile,
      writeNewFile: files.writeNewFile,
      fetch: async () => new Response(null, { status: 500 }),
      now: () => new Date(0),
      schedule: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    relocateFs: { listDir: files.listDir, isFile: files.isFile, sha256: files.sha256 },
    packFs: { isFile: files.isFile, sha256: files.sha256 },
    imageProbe: { inspectImage: files.inspectImage },
    settingsPorts: {
      readSettings: meta.readSettings,
      defaultBaseUrl: async () => "http://gateway.invalid",
      writeSettings: meta.writeSettings,
      readModelsCache: meta.readModelsCache,
      writeModelsCache: meta.writeModelsCache,
      readApiKey: async () => null,
      writeApiKey: async () => undefined,
      deleteApiKey: async () => undefined,
      fetch: async () => new Response(null, { status: 500 }),
      now: () => new Date(0),
      log: () => undefined,
    },
  };

  const port: FakePort = {
    userRoot: options.userRoot ?? "/~",
    features: {
      generation: !missing.has("generation"),
      usage: !missing.has("usage"),
      packExport: !missing.has("packExport"),
      // 导入与导出是两项能力（#131）：替身默认都有。
      packImport: !missing.has("packImport"),
    },
    board,
    files,
    meta,
    media,
    pack,
    ui,
    usage,
    session,
    core,
    calls,
  };
  return port;
}

/** 替身记下的调用：断言界面把结局传出去时用。 */
export interface FakeCalls {
  write: { path: string; text: string; options?: BoardWriteOptions }[];
  read: string[];
  rename: { from: string; to: string; version?: string }[];
  remove: { path: string; version?: string }[];
  archive: { from: string; to: string; version?: string }[];
  unarchive: { from: string; to: string }[];
  import: { file: File; options: ImportOptions }[];
  copyImage: string[];
  copyText: string[];
  pickImages: { multiple: boolean; files: File[] }[];
  pickPackFile: (File | null)[];
  saveCopyAs: string[];
  log: { kind: string; fields: Record<string, unknown> }[];
  uploadReference: File[];
  inspectImage: string[];
  list: number;
  uiStateWrites: string[];
  ask?: boolean;
  messages?: string[];
  openExternal?: string[];
  downloadImage?: string[];
  downloadBoardResults?: string[];
  writeNewFile?: { absPath: string; bytes: Uint8Array }[];
}

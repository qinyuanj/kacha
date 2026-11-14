// 桌面壳端口（#127）：壳端口（#126）的桌面实现。
//
// 界面只认 ShellPort（见 shell/port.ts）：Web 实现在 webPort.ts，本文件是同一接口的桌面版本。
// 画板、文件与元数据经 MyGo 绑定（Go 侧 internal/localstore 与 internal/localservice）落到本机用户数据根；
// 本切片还没有的能力（生成、用量、画板包导出、归档、整理、结果中转）按 features 关掉，
// 调用时以 kind: "unavailable" 拒绝：界面据此标「尚不可用」，不失败得更晚，也不伪装成功。
//
// 桥（DesktopBridge）是 Go 绑定在页面侧的形状；测试用假桥，不必起窗口。
import { PortError, type FeatureId, type ShellFeatures, type ShellPort } from "./port";
import { copyTextToClipboard } from "./clipboard";
import { installPageInputTakeover, isEditableTarget } from "./pageInput";
import type { BoardListing, BoardTexts, BoardWriteOptions, BrowserOptions, ImageInfo, SessionPort, UsagePort } from "./types";
import type { DirEntry } from "../core/relocate";
import type { ImportOptions, ImportPhase, ImportResult, PackIo } from "../core/boardPack";
import type { LogKind } from "./log";
import { base64Of, clipboardContentOf, extensionOf } from "./desktopClipboard";
import { sha256Hex } from "../core/sha256";
import { IMPORTED_REFERENCES_DIR } from "../core/boardPack";
import { joinPath, toRootRelative } from "../core/paths";
import { portFailureOf, type ClipboardContent } from "./port";

/** Go 侧写操作的结局：成功时 kind 为空，失败时 kind 是类别（见 localservice.Outcome）。 */
export interface DesktopOutcome {
  ok: boolean;
  kind: string;
  message: string;
  version: string;
}

/** Go 侧画板列表。 */
export interface DesktopBoardListing {
  boards: { name: string; path: string; archived: boolean; bytes: number | null }[];
  slots: { used: number; total: number };
  size_lines: { warn: number; alert: number };
}

/** Go 侧壳信息（Shell.Info）。 */
export interface DesktopInfo {
  version: string;
  user_data_root: string;
  board_root: string;
  features: { generation: boolean; usage: boolean; pack_export: boolean };
}

/** Go 侧本地能力（Local 服务）：方法名与 Go 侧绑定名一致。 */
export interface DesktopLocalBridge {
  readBoard(path: string): Promise<{ main: string | null; bak: string | null; version: string | null }>;
  writeBoard(path: string, text: string, options: { version?: string; create_only?: boolean }): Promise<DesktopOutcome>;
  listBoardNames(dir: string): Promise<string[]>;
  listBoards(): Promise<DesktopBoardListing>;
  renameBoard(from: string, to: string, version?: string): Promise<DesktopOutcome>;
  deleteBoard(path: string, version?: string): Promise<DesktopOutcome>;
  readFile(path: string): Promise<string>;
  writeNewFile(path: string, bytes: Uint8Array): Promise<DesktopOutcome>;
  /** 与 writeNewFile 相同，字节以 base64 传（Uint8Array 在 JSON 里解不进 Go 的 []byte）。 */
  writeNewFileBase64(path: string, data: string): Promise<DesktopOutcome>;
  isFile(path: string): Promise<boolean>;
  listDir(path: string): Promise<{ name: string; is_dir: boolean }[]>;
  fileSha256(path: string): Promise<string>;
  inspectImage(path: string): Promise<ImageInfo>;
  readSettings(): Promise<string>;
  writeSettings(text: string): Promise<DesktopOutcome>;
  readUiState(): Promise<string>;
  writeUiState(text: string): Promise<DesktopOutcome>;
  readModelsCache(): Promise<string>;
  writeModelsCache(text: string): Promise<DesktopOutcome>;
  readCapabilityOverride(): Promise<string>;
  boardsDir(): Promise<string>;
  userDataRoot(): Promise<string>;
}

/** Go 侧剪贴板快照（Clipboard.Read）：类别与 desktop/internal/clipboard 的 Kind 一致。 */
export interface DesktopClipboardSnapshot {
  kind: string;
  text: string;
  /** base64 的 PNG，按剪贴板里的顺序。 */
  images: string[];
  reason: string;
  formats: string[];
}

/** Go 侧剪贴板服务（Clipboard 服务）。 */
export interface DesktopClipboardBridge {
  read(): Promise<DesktopClipboardSnapshot>;
}

/** Go 侧导入进度（Pack.Snapshot 的 progress）。 */
export interface DesktopPackProgress {
  step: string;
  done: number;
  total: number;
  detail: string;
  bytes_done: number;
  bytes_total: number;
}

/** Go 侧一次导入的结局（Pack.Snapshot 的 outcome）。 */
export interface DesktopPackOutcome {
  ok: boolean;
  kind: string;
  step: string;
  message: string;
  report?: {
    outcomes: { path: string; outcome: string }[];
    bytes: number;
    boards: string[];
    imported: number;
    skipped: number;
    conflicts: string[];
    missing: string[];
    message: string;
  } | null;
}

/** Go 侧导入状态快照。 */
export interface DesktopPackSnapshot {
  running: boolean;
  progress: DesktopPackProgress;
  outcome: DesktopPackOutcome | null;
}

/** Go 侧画板包服务（Pack 服务，#131）：选包、开始导入、轮询状态、取消。 */
export interface DesktopPackBridge {
  pick(): Promise<string>;
  start(path: string): Promise<DesktopPackOutcome>;
  snapshot(): Promise<DesktopPackSnapshot>;
  cancel(): Promise<void>;
}

/** MyGo 桥：Go 侧绑定与测试替身都满足它。 */
export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  local: DesktopLocalBridge;
  /** 系统剪贴板（#129）；没有这一项的替身按读不到处理。 */
  clipboard?: DesktopClipboardBridge;
  /** 画板包导入（#131）；没有这一项的替身按「尚不可用」处理。 */
  pack?: DesktopPackBridge;
}

/** 能力的中文名，用来写「尚不可用」的提示。 */
const FEATURE_LABEL: Record<FeatureId, string> = {
  generation: "生成",
  usage: "用量统计",
  packExport: "画板包导出",
  packImport: "画板包导入",
  archive: "归档",
  tidy: "整理",
  relay: "结果中转",
  login: "登录",
};

/** 本切片还没有的能力：以 kind: "unavailable" 拒绝。 */
export function unavailable(feature: FeatureId): never {
  throw new PortError({
    kind: "unavailable",
    code: "unavailable",
    message: "桌面客户端：" + FEATURE_LABEL[feature] + "尚不可用",
    status: 0,
    feature,
  });
}

/** Go 侧的失败类别 → 端口失败类别；未列出的按 failed 处理（消息保持原文）。 */
const KIND_BY_GO: Record<string, "conflict" | "missing" | "alreadyExists" | "invalid" | "failed"> = {
  conflict: "conflict",
  missing: "missing",
  alreadyExists: "alreadyExists",
  invalid: "invalid",
};

/** Go 侧结局 → 端口结局：成功就返回，失败抛 PortError。 */
function checked(outcome: DesktopOutcome): void {
  if (outcome.ok) return;
  const kind = KIND_BY_GO[outcome.kind] ?? "failed";
  throw new PortError({ kind, code: outcome.kind || "failed", message: outcome.message, status: 0 });
}

/** 桌面壳的实现细节：端口与壳信息快照。 */
export interface DesktopShell {
  readonly port: ShellPort;
  readonly info: DesktopInfo;
}

/** 造桌面壳端口：读一次壳信息，之后都从这份快照回答。 */
export async function createDesktopPort(bridge: DesktopBridge): Promise<DesktopShell> {
  const info = await bridge.info();
  const local = bridge.local;
  const features: ShellFeatures = {
    generation: info.features.generation,
    usage: info.features.usage,
    packExport: info.features.pack_export,
    // 画板包导入（#131）在本机做：桥上有 Pack 服务就能导入（导入与导出是两项能力）。
    packImport: bridge.pack !== undefined,
    // 整理模式本切片还没实现（度量画板体量留给后续切片）。
    tidy: false,
    // 桌面壳直接读系统剪贴板（#129）：粘贴截图不必先存成文件。
    nativeClipboard: true,
  };

  /** 一次本地调用：Go 侧异常折成 failed（消息保持原文），结局失败折成类别化 PortError。 */
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PortError) throw e;
      throw new PortError({ kind: "failed", code: "local", message: e instanceof Error ? e.message : String(e), status: 0 });
    }
  };


  /** 导入参考图的目录（与 Web 服务端同一份布局，见 core/boardPack 的 IMPORTED_REFERENCES_DIR）。 */
  const refDir = joinPath(info.user_data_root, IMPORTED_REFERENCES_DIR);

  /**
   * 本机图片进 导入参考图/：文件名是内容的 sha256，扩展名按图片格式（剪贴板里一律 PNG）。
   * 同图重复上传时写新文件报 alreadyExists——那说明这个内容已经在盘上，按成功处理（去重）。
   */
  const uploadReference = async (file: File): Promise<{ path: string; sha256: string }> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha = await sha256Hex(bytes);
    // 端口约定：返回相对用户数据根的路径（与 Web 上传一致），绝对路径只在本函数里用。
    const abs = joinPath(refDir, sha + "." + extensionOf(file));
    const path = toRootRelative(info.user_data_root, abs);
    try {
      checked(await local.writeNewFileBase64(abs, base64Of(bytes)));
    } catch (e) {
      const failure = portFailureOf(e);
      if (failure.kind !== "alreadyExists") throw e;
    }
    return { path, sha256: sha };
  };

  /**
   * 读一次系统剪贴板（#129）：Go 侧给类型化快照，这里把 base64 的 PNG 还原成 File。
   * 桥里没有剪贴板（旧替身）时返回 null，调用方改用 paste 事件带的内容。
   */
  const readClipboardSnapshot = async (): Promise<ClipboardContent | null> => {
    if (!bridge.clipboard) return null;
    const snapshot = await run(() => bridge.clipboard!.read());
    return clipboardContentOf(snapshot);
  };

  const board = {
    read: (path: string): Promise<BoardTexts> =>
      run(async () => {
        const texts = await local.readBoard(path);
        return { main: texts.main, bak: texts.bak, version: texts.version };
      }),
    write: (path: string, text: string, options?: BoardWriteOptions): Promise<void> =>
      run(async () => checked(await local.writeBoard(path, text, { version: options?.version, create_only: options?.createOnly }))),
    rename: (from: string, to: string, version?: string): Promise<void> => run(async () => checked(await local.renameBoard(from, to, version))),
    remove: (path: string, version?: string): Promise<void> => run(async () => checked(await local.deleteBoard(path, version))),
    archive: async (): Promise<void> => unavailable("archive"),
    unarchive: async (): Promise<void> => unavailable("archive"),
    listNames: (dir: string): Promise<string[]> => run(() => local.listBoardNames(dir)),
    list: (): Promise<BoardListing> =>
      run(async () => {
        const listing = await local.listBoards();
        return {
          // Go 侧给的是相对用户数据根的路径；这里拼成绝对路径，
          // 与界面别处（画板目录、标签页会话路径）同一形状：列表 → 打开 → 保存 → 删除一路对得上。
          boards: listing.boards.map((b) => ({ name: b.name, path: joinPath(info.user_data_root, b.path), archived: b.archived, bytes: b.bytes })),
          slots: listing.slots,
          size_lines: listing.size_lines,
        };
      }),
    measure: async (): Promise<never> => unavailable("tidy"),
  };

  const files = {
    readFile: (absPath: string): Promise<Uint8Array> =>
      run(async () => base64ToBytes(await local.readFile(absPath))),
    writeNewFile: (absPath: string, bytes: Uint8Array): Promise<void> => run(async () => checked(await local.writeNewFile(absPath, bytes))),
    isFile: (absPath: string): Promise<boolean> => run(() => local.isFile(absPath)),
    listDir: (absDir: string): Promise<DirEntry[]> =>
      run(async () => (await local.listDir(absDir)).map((e) => ({ name: e.name, is_dir: e.is_dir }))),
    sha256: (absPath: string): Promise<string> => run(() => local.fileSha256(absPath)),
    inspectImage: (absPath: string): Promise<ImageInfo> => run(() => local.inspectImage(absPath)),
  };

  const meta = {
    readSettings: (): Promise<string | null> => run(async () => (await local.readSettings()) || null),
    writeSettings: (text: string): Promise<void> => run(async () => checked(await local.writeSettings(text))),
    readUiState: (): Promise<string | null> => run(async () => (await local.readUiState()) || null),
    writeUiState: (text: string): Promise<void> => run(async () => checked(await local.writeUiState(text))),
    readModelsCache: (): Promise<string | null> => run(async () => (await local.readModelsCache()) || null),
    writeModelsCache: (text: string): Promise<void> => run(async () => checked(await local.writeModelsCache(text))),
    readCapabilityOverride: (): Promise<string | null> => run(async () => (await local.readCapabilityOverride()) || null),
  };

  const media = {
    imageUrl: (absPath: string): string => fileUrl(absPath),
    thumbUrl: (absPath: string): string => fileUrl(absPath),
    pickImages: async (): Promise<never> => unavailable("generation"),
    // 选画板包：系统对话框给出本机路径，之后交给 Pack.Import（#131）。
    pickPackFile: async (): Promise<File | null> => {
      if (!bridge.pack) unavailable("packImport");
      const path = await run(() => bridge.pack!.pick());
      if (!path) return null;
      const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
      const file = new File([], name, { type: "application/zip" });
      pickedPacks.set(file, path);
      return file;
    },
    // 本机图片进 导入参考图/：文件名就是内容的 sha256，同图重复上传天然去重（写新文件只新建不覆盖）。
    uploadReference: (file: File): Promise<{ path: string; sha256: string }> => uploadReference(file),
    copyText: (text: string): Promise<void> => copyTextToClipboard(text),
    copyImage: async (): Promise<never> => unavailable("generation"),
    readClipboard: (): Promise<ClipboardContent | null> => readClipboardSnapshot(),
    saveCopyAs: async (): Promise<never> => unavailable("generation"),
    downloadImage: (): void => {
      unavailable("generation");
    },
    downloadBoardResults: (): void => {
      unavailable("generation");
    },
  };

  /**
   * 选中的包文件 → 本机绝对路径。选包走系统对话框（页面拿不到 File 的路径），
   * 路径记在这里而不是把整个包读进内存：大包不该被复制一遍。
   */
  const pickedPacks = new WeakMap<File, string>();

  /** 进度订阅者：进度对话框经 ui.onPackProgress 挂上来。 */
  const progressHandlers = new Set<(progress: { done: number; total: number }) => void>();

  /** 把一次快照的字节进度报给订阅者。 */
  const reportProgress = (progress: { bytes_done: number; bytes_total: number }): void => {
    for (const handler of progressHandlers) handler({ done: progress.bytes_done, total: progress.bytes_total });
  };

  /** 等一次导入跑完：每 100ms 取一次快照，直到 running 变 false（大包不会让界面卡住）。 */
  const awaitImport = async (options: ImportOptions): Promise<DesktopPackSnapshot> => {
    const phases: Record<string, ImportPhase> = { extract: "extract", restore: "restore", merge: "merge", boards: "boards" };
    let lastStep = "";
    for (;;) {
      const snapshot = await run(() => bridge.pack!.snapshot());
      reportProgress(snapshot.progress);
      const phase = phases[snapshot.progress.step];
      if (phase && snapshot.progress.step !== lastStep) {
        lastStep = snapshot.progress.step;
        options.onPhase?.(phase);
      }
      if (!snapshot.running) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  /** 把 Go 侧的结局折成 core 的 ImportResult（界面按 kind 分支的那一套）。 */
  const importResultOf = async (snapshot: DesktopPackSnapshot, options: ImportOptions): Promise<ImportResult> => {
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

  const pack = {
    // 去重上传协议是 Web 版的路子：桌面壳整包在本机合并，不走 io。
    // 只有取消是真的：进度对话框上的「取消」经 io.cancel 落到 Pack.Cancel（#131）。
    io: new Proxy({} as PackIo, {
      get: (_target, prop: string) =>
        prop === "cancel"
          ? async (cancelled: boolean): Promise<void> => {
              if (cancelled && bridge.pack) await run(() => bridge.pack!.cancel());
            }
          : async (): Promise<never> => unavailable("packExport"),
    }),
    /**
     * 导入画板包（#131）：本机解压合并，画板作为新画板提交。
     * 选包在 media.pickPackFile 里用系统对话框做；这里只认那次选中的路径。
     */
    import: async (file: File, options: ImportOptions): Promise<ImportResult> => {
      if (!bridge.pack) unavailable("packImport");
      const path = pickedPacks.get(file);
      if (!path) return { kind: "failed", error: "没有选中画板包" };
      options.onStage("progress");
      const started = await run(() => bridge.pack!.start(path));
      if (!started.ok) {
        // 开不了就按结局处理：不必再轮询（start 已把原因说清）。
        return importResultOf({ running: false, progress: { step: started.step, done: 0, total: 0, detail: "", bytes_done: 0, bytes_total: 0 }, outcome: started }, options);
      }
      return importResultOf(await awaitImport(options), options);
    },
    facts: async (): Promise<never> => unavailable("packExport"),
    exportPack: async (): Promise<never> => unavailable("packExport"),
  };

  const ui = {
    // 确认框与提示框用窗口自带的：桌面壳没有服务端，浏览器能力照样有。
    ask: (message: string, _options?: BrowserOptions): Promise<boolean> => Promise.resolve(window.confirm(message)),
    message: (text: string, _options?: BrowserOptions): Promise<void> => {
      window.alert(text);
      return Promise.resolve();
    },
    // 进度订阅：导入期间由 Pack.Snapshot 的字节进度推送（#131）。
    onPackProgress: async (handler: (progress: { done: number; total: number }) => void): Promise<() => void> => {
      progressHandlers.add(handler);
      return () => {
        progressHandlers.delete(handler);
      };
    },
    openExternal: (url: string): void => {
      window.open(url, "_blank", "noopener");
    },
    version: (): Promise<string> => Promise.resolve(info.version),
    log: (_kind: LogKind, _fields: Record<string, unknown>): void => {},
    isEditableTarget,
    installInputTakeover: installPageInputTakeover,
  };

  const usage: UsagePort = {
    usage: async (): Promise<never> => unavailable("usage"),
    cleanupUnreferenced: async (): Promise<never> => unavailable("usage"),
  };

  const session: SessionPort = {
    // 桌面壳没有服务端会话：不需要登录界面（Root 看到它就直接进工作台）。
    requiresLogin: false,
    login: async (): Promise<never> => unavailable("login"),
    current: (): Promise<{ fingerprint: string }> => Promise.resolve({ fingerprint: LOCAL_FINGERPRINT }),
    logout: (): Promise<void> => Promise.resolve(),
    config: (): Promise<{ version: string; gateway_url: string }> => Promise.resolve({ version: info.version, gateway_url: "" }),
    onExpired: (): (() => void) => () => {},
    readStoredKey: (): null => null,
    storeKey: (): void => {},
    clearStoredKey: (): void => {},
  };

  const port: ShellPort = {
    userRoot: info.user_data_root,
    features,
    board,
    files,
    meta,
    media,
    pack,
    ui,
    usage,
    session,
    core: {
      taskFs: { writeNewFile: files.writeNewFile, readFile: files.readFile },
      runDeps: {
        writeNewFile: files.writeNewFile,
        readFile: files.readFile,
        fetch: async (): Promise<never> => unavailable("generation"),
        now: () => new Date(),
        schedule: (ms: number, fn: () => void) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
      },
      relocateFs: { listDir: files.listDir, isFile: files.isFile, sha256: files.sha256 },
      packFs: { isFile: files.isFile, sha256: files.sha256 },
      imageProbe: { inspectImage: files.inspectImage },
      settingsPorts: {
        readSettings: meta.readSettings,
        defaultBaseUrl: (): Promise<string> => Promise.resolve(""),
        writeSettings: meta.writeSettings,
        readModelsCache: meta.readModelsCache,
        writeModelsCache: meta.writeModelsCache,
        readApiKey: (): Promise<string | null> => Promise.resolve(null),
        writeApiKey: (): Promise<void> => Promise.resolve(),
        deleteApiKey: (): Promise<void> => Promise.resolve(),
        fetch: async (): Promise<never> => unavailable("generation"),
        now: () => new Date(),
        log: (): void => {},
      },
    },
  };

  return { port, info };
}

/** 本机标识：固定值，不含密钥，也不随密钥变化。 */
export const LOCAL_FINGERPRINT = "local";

/** 本机文件地址：file:/// 加正斜杠路径。 */
function fileUrl(absPath: string): string {
  return "file:///" + absPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** base64 文本 → 字节。 */
function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

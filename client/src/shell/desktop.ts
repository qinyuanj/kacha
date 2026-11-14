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
import type { PackIo } from "../core/boardPack";
import type { LogKind } from "./log";

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
  renameBoard(from: string, to: string): Promise<DesktopOutcome>;
  deleteBoard(path: string): Promise<DesktopOutcome>;
  readFile(path: string): Promise<string>;
  writeNewFile(path: string, bytes: Uint8Array): Promise<DesktopOutcome>;
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

/** MyGo 桥：Go 侧绑定与测试替身都满足它。 */
export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  local: DesktopLocalBridge;
}

/** 能力的中文名，用来写「尚不可用」的提示。 */
const FEATURE_LABEL: Record<FeatureId, string> = {
  generation: "生成",
  usage: "用量统计",
  packExport: "画板包导出",
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

  const board = {
    read: (path: string): Promise<BoardTexts> =>
      run(async () => {
        const texts = await local.readBoard(path);
        return { main: texts.main, bak: texts.bak, version: texts.version };
      }),
    write: (path: string, text: string, options?: BoardWriteOptions): Promise<void> =>
      run(async () => checked(await local.writeBoard(path, text, { version: options?.version, create_only: options?.createOnly }))),
    rename: (from: string, to: string): Promise<void> => run(async () => checked(await local.renameBoard(from, to))),
    remove: (path: string): Promise<void> => run(async () => checked(await local.deleteBoard(path))),
    archive: async (): Promise<void> => unavailable("archive"),
    unarchive: async (): Promise<void> => unavailable("archive"),
    listNames: (dir: string): Promise<string[]> => run(() => local.listBoardNames(dir)),
    list: (): Promise<BoardListing> =>
      run(async () => {
        const listing = await local.listBoards();
        return {
          boards: listing.boards.map((b) => ({ name: b.name, path: b.path, archived: b.archived, bytes: b.bytes })),
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
    pickPackFile: async (): Promise<never> => unavailable("packExport"),
    uploadReference: async (): Promise<never> => unavailable("generation"),
    copyText: (text: string): Promise<void> => copyTextToClipboard(text),
    copyImage: async (): Promise<never> => unavailable("generation"),
    readClipboard: (): null => null,
    saveCopyAs: async (): Promise<never> => unavailable("generation"),
    downloadImage: (): void => {
      unavailable("generation");
    },
    downloadBoardResults: (): void => {
      unavailable("generation");
    },
  };

  const pack = {
    io: new Proxy({} as PackIo, {
      get: () => async (): Promise<never> => unavailable("packExport"),
    }),
    import: async (): Promise<never> => unavailable("packExport"),
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
    onPackProgress: async (): Promise<never> => unavailable("packExport"),
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

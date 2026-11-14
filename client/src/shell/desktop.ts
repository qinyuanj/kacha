// 桌面壳端口（#127）：壳端口（#126）的桌面实现。
//
// 界面只认 ShellPort（见 shell/port.ts）：Web 实现在 webPort.ts，本文件是同一接口的桌面版本。
// 画板、文件与元数据经 MyGo 绑定（Go 侧 internal/localstore 与 internal/localservice）落到本机用户数据根；
// 本切片还没有的能力（生成、用量、画板包导出、归档、整理、结果中转）按 features 关掉，
// 调用时以 kind: "unavailable" 拒绝：界面据此标「尚不可用」，不失败得更晚，也不伪装成功。
//
// 桥（DesktopBridge）是 Go 绑定在页面侧的形状；测试用假桥，不必起窗口。
// 各组实现（画板、文件、元数据、媒体、画板包、用量）在 shell/desktopStores.ts（#137），这里只做接线。
import { portFailureOf, type ClipboardContent, type ImageCopyFailure, type ImageCopyResult, type MediaStore, type ShellFeatures, type ShellPort } from "./port";
import { installPageInputTakeover, isEditableTarget } from "./pageInput";
import type { BrowserOptions, ImageInfo, SessionPort, UsagePort } from "./types";
import type { LogKind } from "./log";
import { base64Of } from "../core/base64";
import { clipboardContentOf, extensionOf } from "./desktopClipboard";
import { sha256Hex } from "../core/sha256";
import { IMPORTED_REFERENCES_DIR } from "../core/boardPack";
import { joinPath, toRootRelative } from "../core/paths";
import { checked, desktopBoardStore, desktopFileStore, desktopMediaStore, desktopMetaStore, desktopPackStore, desktopUsageStore, localRun, unavailable } from "./desktopStores";

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

/** Go 侧复制图片的结局（Clipboard.CopyImage）：类别与 desktop/internal/clipboard 的 Image* 常量一致。 */
export interface DesktopImageCopy {
  ok: boolean;
  /** unsupported / invalid / busy / failed；成功时为空。 */
  kind: string;
  message: string;
  bytes: number;
}

/** Go 侧剪贴板服务（Clipboard 服务）：读快照（#129）与把图片写进系统剪贴板（#130）。 */
export interface DesktopClipboardBridge {
  read(): Promise<DesktopClipboardSnapshot>;
  /** 字节由 Go 自己按路径读（用户数据根在那边），页面只给路径与格式提示。 */
  copyImage(path: string, format: string): Promise<DesktopImageCopy>;
}

/** MyGo 桥：Go 侧绑定与测试替身都满足它。 */
export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  local: DesktopLocalBridge;
  /** 系统剪贴板（#129）；没有这一项的替身按读不到处理。 */
  clipboard?: DesktopClipboardBridge;
}

/** 本切片还没有的能力：以 kind: "unavailable" 拒绝。 */
export { unavailable };

/** 桌面壳的实现细节：端口与壳信息快照。 */
export interface DesktopShell {
  readonly port: ShellPort;
  readonly info: DesktopInfo;
}

/**
 * 本机图片进 导入参考图/（#129）：文件名是内容的 sha256，扩展名按图片格式（剪贴板里一律 PNG）。
 * 同图重复上传时写新文件报 alreadyExists——那说明这个内容已经在盘上，按成功处理（去重）。
 */
async function uploadReference(local: DesktopLocalBridge, userRoot: string, file: File): Promise<{ path: string; sha256: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = await sha256Hex(bytes);
  // 端口约定：返回相对用户数据根的路径（与 Web 上传一致），绝对路径只在本函数里用。
  const abs = joinPath(joinPath(userRoot, IMPORTED_REFERENCES_DIR), sha + "." + extensionOf(file));
  const path = toRootRelative(userRoot, abs);
  try {
    checked(await local.writeNewFileBase64(abs, base64Of(bytes)));
  } catch (e) {
    if (portFailureOf(e).kind !== "alreadyExists") throw e;
  }
  return { path, sha256: sha };
}

/**
 * 读一次系统剪贴板（#129）：Go 侧给类型化快照，这里把 base64 的 PNG 还原成 File。
 * 桥里没有剪贴板（旧替身）时返回 null，调用方改用 paste 事件带的内容。
 */
async function readClipboardSnapshot(bridge: DesktopBridge): Promise<ClipboardContent | null> {
  if (!bridge.clipboard) return null;
  const snapshot = await localRun(() => bridge.clipboard!.read());
  return clipboardContentOf(snapshot);
}

/**
 * 复制图片到系统剪贴板（#130）：Go 侧按路径读字节、归一化成 PNG、写进系统剪贴板。
 *
 * 失败折成端口类别：Go 的 kind 与端口的 ImageCopyFailure 同名，认不出的按 failed。
 * 桥里没有剪贴板（旧替身）时按 unavailable 收：复制图片在桌面壳里不该伪装成功。
 */
async function copyImageToSystemClipboard(bridge: DesktopBridge, absPath: string, format: string): Promise<ImageCopyResult> {
  if (!bridge.clipboard) return { ok: false, reason: "unavailable" };
  const outcome = await localRun(() => bridge.clipboard!.copyImage(absPath, format));
  return outcome.ok ? { ok: true } : { ok: false, reason: copyFailureOf(outcome.kind) };
}

/** Go 侧的失败类别 → 端口的失败类别；认不出的按 failed（不伪装成可重试）。 */
const COPY_FAILURE_BY_GO: Record<string, ImageCopyFailure> = {
  unsupported: "unsupported",
  invalid: "invalid",
  busy: "busy",
  failed: "failed",
};

/** Go 侧的复制失败类别 → 端口的类别。 */
function copyFailureOf(kind: string): ImageCopyFailure {
  return COPY_FAILURE_BY_GO[kind] ?? "failed";
}

/** 造桌面壳端口：读一次壳信息，之后都从这份快照回答。 */
export async function createDesktopPort(bridge: DesktopBridge): Promise<DesktopShell> {
  const info = await bridge.info();
  const local = bridge.local;
  const features: ShellFeatures = {
    generation: info.features.generation,
    usage: info.features.usage,
    packExport: info.features.pack_export,
    // 整理模式本切片还没实现（度量画板体量留给后续切片）。
    tidy: false,
    // 桌面壳直接读系统剪贴板（#129）：粘贴截图不必先存成文件。
    nativeClipboard: true,
  };

  const board = desktopBoardStore(local, info.user_data_root);

  const files = desktopFileStore(local);

  const meta = desktopMetaStore(local);

  // 本机图片进 导入参考图/ 与系统剪贴板是本机独有的两样（#129 / #130）：其余浏览器能力来自 desktopStores。
  const media: MediaStore = {
    ...desktopMediaStore(),
    uploadReference: (file: File): Promise<{ path: string; sha256: string }> => uploadReference(local, info.user_data_root, file),
    readClipboard: (): Promise<ClipboardContent | null> => readClipboardSnapshot(bridge),
    copyImage: (absPath: string, format = ""): Promise<ImageCopyResult> => copyImageToSystemClipboard(bridge, absPath, format),
  };

  const pack = desktopPackStore();

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

  const usage: UsagePort = desktopUsageStore();

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

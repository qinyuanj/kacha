// 桌面壳端口（#127）：壳端口（#126）的桌面实现。
//
// 界面只认 ShellPort（见 shell/port.ts），本文件负责 MyGo 桌面实现。
// 画板、文件与元数据经 MyGo 绑定（Go 侧 internal/localstore 与 internal/localservice）落到本机数据根；
// 本切片还没有的能力（用量、画板包导出、归档、整理、结果中转）按 features 关掉，
// 调用时以 kind: "unavailable" 拒绝：界面据此标「尚不可用」，不失败得更晚，也不伪装成功。
//
// 桥（DesktopBridge）是 Go 绑定在页面侧的形状；测试用假桥，不必起窗口。
// 各组实现（画板、文件、元数据、媒体、画板包、用量）在 shell/desktopStores.ts（#137），这里只做接线。
import { PortError, portFailureOf, type ClipboardContent, type ImageCopyFailure, type ImageCopyResult, type MediaStore, type SaveCopyOutcome, type ShellFeatures, type ShellPort } from "./port";
import { installPageInputTakeover, isEditableTarget } from "./pageInput";
import type { BrowserOptions, ImageInfo, UsagePort } from "./types";
import type { LogKind } from "./log";
import { base64Of } from "../core/base64";
import { clipboardContentOf, extensionOf } from "./desktopClipboard";
import { sha256Hex } from "../core/sha256";
import { IMPORTED_REFERENCES_DIR } from "../core/boardPack";
import { joinPath, toRootRelative } from "../core/paths";
import { checked, desktopBoardStore, desktopFileStore, desktopMediaStore, desktopMetaStore, desktopUsageStore, localRun, unavailable } from "./desktopStores";
import { createDesktopPack } from "./desktopPack";
import { imageCodec } from "./imageCodec";
import { composeOverlay } from "./overlay";
import { createGatewayPorts } from "./desktopGateway";
import { DEFAULT_SETTINGS } from "../core/settings";

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
  /** 把数据根里的图片另存为用户选的位置（#130 的「另存为…」兜底）。 */
  saveCopyAs(path: string): Promise<DesktopOutcome>;
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
  /** 认出来的容器名（unsupported 时非空，如 tiff / heic）。 */
  container?: string;
  bytes: number;
}

/** Go 侧写文本的结局（Clipboard.WriteText）。MyGo 的 WriteText 不返回错误，Go 侧写后读回来核实。 */
export interface DesktopTextCopy {
  ok: boolean;
  /** failed；成功时为空。 */
  kind: string;
  message: string;
}

/** Go 侧剪贴板服务（Clipboard 服务）：读快照（#129）与把图片写进系统剪贴板（#130）。 */
export interface DesktopClipboardBridge {
  read(): Promise<DesktopClipboardSnapshot>;
  /** 字节由 Go 自己按路径读（数据根在那边），页面只给路径与格式提示。 */
  copyImage(path: string, format: string): Promise<DesktopImageCopy>;
  /** 把纯文本写进系统剪贴板（#124）：Go 原生 Clipboard.WriteText，不依赖浏览器权限。 */
  writeText(text: string): Promise<DesktopTextCopy>;
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

/**
 * Go 侧网关服务（Gateway 服务，#152）：真实 HTTP 请求与 Windows 系统保护的密钥。
 * 页面不直接发网关请求，也不把密钥写进普通设置。
 */
export interface DesktopGatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** 二进制响应（结果图）走 base64，避免 UTF-8 文本转换损坏字节。 */
  body_base64?: string;
}

export interface DesktopGatewayBridge {
  request(url: string, method: string, headers: Record<string, string>, body?: string): Promise<DesktopGatewayResponse>;
  readApiKey(): Promise<string | null>;
  writeApiKey(key: string): Promise<void>;
  deleteApiKey(): Promise<void>;
}

/** MyGo 桥：Go 侧绑定与测试替身都满足它。 */
export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  local: DesktopLocalBridge;
  /** 系统剪贴板（#129）；没有这一项的替身按读不到处理。 */
  clipboard?: DesktopClipboardBridge;
  /** 画板包导入（#131）；没有这一项的替身按「尚不可用」处理。 */
  pack?: DesktopPackBridge;
  /** 网关与密钥（#152）；没有这一项的替身按「尚不可用」处理。 */
  gateway?: DesktopGatewayBridge;
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
  // 端口约定：返回相对数据根的路径，绝对路径只在本函数里用。
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
 * 复制文本到系统剪贴板（#124）：桌面壳经 Go 原生 Clipboard.WriteText 写节点标记，不依赖浏览器剪贴板权限。
 * 桥里没有剪贴板（旧替身）时按 unavailable 收，不退回浏览器剪贴板。
 */
async function copyTextToSystemClipboard(bridge: DesktopBridge, text: string): Promise<void> {
  // 桌面壳不退回浏览器剪贴板：那条路依赖焦点与 Web Clipboard 权限，正是 #124 要摆脱的。
  if (!bridge.clipboard) return unavailable("copyText");
  // MyGo 的 WriteText 没有返回值（Windows 上失败是静默的），Go 侧写后读回剪贴板核实；
  // 核实失败时拒绝，调用点（useBoardKeyboard）会给「Ctrl+V 粘贴节点可能不生效」的提示。
  const outcome = await localRun(() => bridge.clipboard!.writeText(text));
  if (!outcome.ok) {
    throw new PortError({ kind: "failed", code: outcome.kind || "failed", message: outcome.message || "复制文本失败：系统剪贴板没有写进去", status: 0 });
  }
}

/**
 * 「另存为…」（#130 复制失败时的兜底）：经 Go 的 Local.SaveCopyAs 打开系统另存为对话框并写字节。
 * 用户取消（kind = cancelled）当作没发生，不弹失败提示。
 */
async function saveCopyAsThroughLocal(local: DesktopLocalBridge, absPath: string): Promise<SaveCopyOutcome> {
  const outcome = await localRun(() => local.saveCopyAs(absPath));
  // 用户取消不是保存：返回 cancelled，调用点不提示「已开始下载」。
  if (outcome.kind === "cancelled") return { kind: "cancelled" };
  if (!outcome.ok) checked(outcome);
  return { kind: "saved" };
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
  if (outcome.ok) return { ok: true };
  const reason = copyFailureOf(outcome.kind);
  // 容器名（tiff / heic）原样交给界面：失败提示要说清是哪种格式不行。
  return outcome.container ? { ok: false, reason, detail: outcome.container } : { ok: false, reason };
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
    // 画板包导入（#131）在本机做：桥上有 Pack 服务就能导入（导入与导出是两项能力）。
    packImport: bridge.pack !== undefined,
    // 整理模式本切片还没实现（度量画板体量留给后续切片）。
    tidy: false,
    // 整板结果下载属于画板包导出与结果保存（#160），本切片还没实现。
    downloadResults: false,
  };

  const board = desktopBoardStore(local, info.user_data_root);

  const files = desktopFileStore(local);

  const meta = desktopMetaStore(local);

  // 画板包导入（#131）是本机能力：选包、进度与结局都在 shell/desktopPack.ts。
  const desktopPack = createDesktopPack(bridge);

  // 本机图片进 导入参考图/ 与系统剪贴板是本机独有的两样（#129 / #130）：其余浏览器能力来自 desktopStores。
  const media: MediaStore = {
    ...desktopMediaStore(info.user_data_root),
    // 选画板包用系统对话框（页面拿不到 File 的路径），之后交给 Pack.Import。
    pickPackFile: () => desktopPack.pickPackFile(),
    uploadReference: (file: File): Promise<{ path: string; sha256: string }> => uploadReference(local, info.user_data_root, file),
    readClipboard: (): Promise<ClipboardContent | null> => readClipboardSnapshot(bridge),
    copyText: (text: string): Promise<void> => copyTextToSystemClipboard(bridge, text),
    copyImage: (absPath: string, format = ""): Promise<ImageCopyResult> => copyImageToSystemClipboard(bridge, absPath, format),
    saveCopyAs: (absPath: string): Promise<SaveCopyOutcome> => saveCopyAsThroughLocal(local, absPath),
  };

  const pack = desktopPack.store;

  const ui = {
    // 确认框与提示框由桌面窗口的 WebView 提供。
    ask: (message: string, _options?: BrowserOptions): Promise<boolean> => Promise.resolve(window.confirm(message)),
    message: (text: string, _options?: BrowserOptions): Promise<void> => {
      window.alert(text);
      return Promise.resolve();
    },
    // 进度订阅：导入期间由 Pack.Snapshot 的字节进度推送（#131）。
    onPackProgress: async (handler: (progress: { done: number; total: number }) => void): Promise<() => void> => desktopPack.onProgress(handler),
    openExternal: (url: string): void => {
      window.open(url, "_blank", "noopener");
    },
    version: (): Promise<string> => Promise.resolve(info.version),
    log: (_kind: LogKind, _fields: Record<string, unknown>): void => {},
    isEditableTarget,
    installInputTakeover: installPageInputTakeover,
  };

  const usage: UsagePort = desktopUsageStore();

  // 网关配置、系统保护的密钥与模型发现（#152）：经 Gateway 绑定走 Go 服务。
  const gatewayPorts = createGatewayPorts(bridge);

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
    core: {
      taskFs: { writeNewFile: files.writeNewFile, readFile: files.readFile },
      runDeps: {
        imageCodec,
        composeOverlay,
        writeNewFile: files.writeNewFile,
        readFile: files.readFile,
        // 生成请求与模型发现共用 #152 接通的 Gateway 绑定；没有绑定时由 gatewayPorts 明确报不可用。
        fetch: info.features.generation ? gatewayPorts.fetch : async (): Promise<never> => unavailable("generation"),
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
        ...gatewayPorts,
        readSettings: meta.readSettings,
        // 没有 settings.json 时用 core 的唯一默认地址，不让首次启动变成空网关。
        defaultBaseUrl: (): Promise<string> => Promise.resolve(DEFAULT_SETTINGS.base_url),
        writeSettings: meta.writeSettings,
        readModelsCache: meta.readModelsCache,
        writeModelsCache: meta.writeModelsCache,
        now: () => new Date(),
        log: (): void => {},
      },
    },
  };

  return { port, info };
}

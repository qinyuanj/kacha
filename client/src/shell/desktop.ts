// 桌面壳端口（#127）：壳端口（#126）的桌面实现。
//
// 界面只认 ShellPort（见 shell/port.ts）：Web 实现在 webPort.ts，本文件是同一接口的桌面版本。
// 画板、文件与元数据经 MyGo 绑定（Go 侧 internal/localstore 与 internal/localservice）落到本机用户数据根；
// 本切片还没有的能力（生成、用量、画板包导出、归档、整理、结果中转）按 features 关掉，
// 调用时以 kind: "unavailable" 拒绝：界面据此标「尚不可用」，不失败得更晚，也不伪装成功。
//
// 桥（DesktopBridge）是 Go 绑定在页面侧的形状；测试用假桥，不必起窗口。
import { type ShellFeatures, type ShellPort } from "./port";
import { installPageInputTakeover, isEditableTarget } from "./pageInput";
import type { BrowserOptions, ImageInfo, SessionPort, UsagePort } from "./types";
import type { LogKind } from "./log";
import { desktopBoardStore, desktopFileStore, desktopMediaStore, desktopMetaStore, desktopPackStore, desktopUsageStore, unavailable } from "./desktopStores";

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

/** 本切片还没有的能力：以 kind: "unavailable" 拒绝。 */
export { unavailable };

/** Go 侧结局 → 端口结局：成功就返回，失败抛 PortError。 */
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
    // 整理模式本切片还没实现（度量画板体量留给后续切片）。
    tidy: false,
  };

  const board = desktopBoardStore(local);

  const files = desktopFileStore(local);

  const meta = desktopMetaStore(local);

  const media = desktopMediaStore();

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

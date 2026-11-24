// 桌面壳端口（#127）：壳端口（#126）的桌面实现。
//
// 界面只认 ShellPort（见 shell/port.ts），本文件负责 MyGo 桌面实现。
// 画板、文件与元数据经 MyGo 绑定（Go 侧 internal/localstore 与 internal/localservice）落到本机数据根；
// 还没实现的能力（如结果中转）按 features 关掉，
// 调用时以 kind: "unavailable" 拒绝：界面据此标「尚不可用」，不失败得更晚，也不伪装成功。
//
// 桥（DesktopBridge）是 Go 绑定在页面侧的形状；测试用假桥，不必起窗口。
// 各组实现（画板、文件、元数据、媒体、画板包、用量）在 shell/desktopStores.ts（#137），这里只做接线。
import { FEEDBACK_UNAVAILABLE, PortError, portFailureOf, type ClipboardContent, type DataRootStore, type DiagnosticsOutcome, type DiagnosticsPackOutcome, type FeedbackAuthStart, type FeedbackAuthStatus, type FeedbackOutcome, type FeedbackPort, type FeedbackSpec, type ImageCopyFailure, type ImageCopyResult, type MediaStore, type SaveCopyOutcome, type ShellFeatures, type ShellPort, type UpdatePort } from "./port";
import type { PackEntryFact, PackExportSpec } from "../core/boardPack";
import type { ThemeChoice } from "../core/theme";
import { installPageInputTakeover, isEditableTarget } from "./pageInput";
import type { BrowserOptions, ImageInfo, RecycleEntry, UsageCandidate, UsagePort } from "./types";
import type { LogKind } from "./log";
import { base64Of, base64ToBytes } from "../core/base64";
import { bytesToFile, clipboardContentOf, extensionOf } from "./desktopClipboard";
import { sha256Hex } from "../core/sha256";
import { IMPORTED_REFERENCES_DIR } from "../core/boardPack";
import { sniffImage } from "../core/taskDir";
import { joinPath, toRootRelative } from "../core/paths";
import { checked, desktopBoardStore, desktopDataRootStore, desktopFileStore, desktopMediaStore, desktopMetaStore, desktopUpdateStore, desktopUsageStore, localRun, unavailable, unavailableUpdateStore, unavailableUsageStore } from "./desktopStores";
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
  features: { generation: boolean; usage: boolean; pack_export: boolean; archive?: boolean; update?: boolean; feedback?: boolean };
}

/** Go 侧本地能力（Local 服务）：方法名与 Go 侧绑定名一致。 */
export interface DesktopLocalBridge {
  readBoard(path: string): Promise<{ main: string | null; bak: string | null; version: string | null }>;
  writeBoard(path: string, text: string, options: { version?: string; create_only?: boolean }): Promise<DesktopOutcome>;
  listBoardNames(dir: string): Promise<string[]>;
  listBoards(): Promise<DesktopBoardListing>;
  renameBoard(from: string, to: string, version?: string): Promise<DesktopOutcome>;
  deleteBoard(path: string, version?: string): Promise<DesktopOutcome>;
  archiveBoard(from: string, to: string, version?: string): Promise<DesktopOutcome>;
  unarchiveBoard(from: string, to: string): Promise<DesktopOutcome>;
  readFile(path: string): Promise<string>;
  /** 本机选图（#154）：Go 弹系统对话框并按路径读成 base64——页面拿不到本机路径，也读不到数据根之外的文件。 */
  pickImages(multiple: boolean): Promise<DesktopPickedImage[]>;
  writeNewFile(path: string, bytes: Uint8Array): Promise<DesktopOutcome>;
  /** 与 writeNewFile 相同，字节以 base64 传（Uint8Array 在 JSON 里解不进 Go 的 []byte）。 */
  writeNewFileBase64(path: string, data: string): Promise<DesktopOutcome>;
  /** 把数据根里的图片另存为用户选的位置（#130 的「另存为…」兜底）。 */
  saveCopyAs(path: string): Promise<DesktopOutcome>;
  /** 单结果保存（带图层打 zip）；目标由 Go 弹系统对话框。 */
  saveResult(path: string): Promise<DesktopOutcome>;
  /** 整板结果保存；目标由 Go 弹系统对话框。 */
  saveBoardResults(path: string): Promise<DesktopOutcome>;
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

/** Go 侧选中的本机图片（Local.PickImages）：name 是文件名，data 是 base64 的原始字节。 */
export interface DesktopPickedImage {
  name: string;
  data: string;
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

/** Go 侧画板包导出的结局（Pack.ExportSnapshot.outcome）。 */
export interface DesktopExportOutcome {
  ok: boolean;
  kind: string;
  step: string;
  message: string;
  result?: { task_dirs: number; bytes: number } | null;
}

/** Go 侧导出状态快照。 */
export interface DesktopExportSnapshot {
  running: boolean;
  progress: DesktopPackProgress;
  outcome: DesktopExportOutcome | null;
}

/** Go 侧选导出目标的结局：path 为空表示取消；overwrite 表示用户已在确认框里同意覆盖已存在的目标。 */
export interface DesktopExportTarget {
  path: string;
  overwrite: boolean;
}

/** Go 侧画板包服务（Pack 服务）：导入 + 导出都在这里。 */
export interface DesktopPackBridge {
  pick(): Promise<string>;
  start(path: string): Promise<DesktopPackOutcome>;
  snapshot(): Promise<DesktopPackSnapshot>;
  cancel(): Promise<void>;
  /** 导出能力：目标选择、事实、打包、进度与取消；旧替身没有这些时按 unavailable 处理。 */
  pickExport?(name: string): Promise<DesktopExportTarget>;
  facts?(spec: Pick<PackExportSpec, "task_dirs" | "files">): Promise<PackEntryFact[]>;
  /** overwrite 只在用户确认过覆盖时为 true：已存在的目标由此才允许替换。 */
  exportPack?(target: string, spec: PackExportSpec, overwrite: boolean): Promise<DesktopExportOutcome>;
  exportSnapshot?(): Promise<DesktopExportSnapshot>;
  cancelExport?(): Promise<void>;
}

/** Go 侧用量快照（Usage.Usage）：字段与本机的真实文件统计一一对应。 */
export interface DesktopUsage {
  total_bytes: number;
  boards_bytes: number;
  meta_bytes: number;
  last_access: number;
  by_date: { date: string; bytes: number }[];
  unreferenced: UsageCandidate[] | null;
  unreadable_board: string | null;
  limit_bytes: number | null;
  limit_level: "" | "warn" | "alert" | null;
}

/** Usage 服务的写结局：Go 侧只有 ok / kind / message 三个字段。 */
export interface DesktopUsageOutcome {
  ok: boolean;
  kind: string;
  message: string;
}

/** Go 侧清理结局：部分跳过与失败逐项给出，成功也可能只处理其中一部分。 */
export interface DesktopCleanupResult extends DesktopUsageOutcome {
  moved: UsageCandidate[];
  skipped: string[];
  failed: string[];
}

/** Go 侧回收区一行：原位置、清理时间与到期状态。 */
export type DesktopRecycleEntry = RecycleEntry;

/** Go 侧 Usage 服务：四种能力都是本机绑定，不是前端计算。 */
export interface DesktopUsageBridge {
  usage(): Promise<DesktopUsage>;
  cleanup(dirs: string[]): Promise<DesktopCleanupResult>;
  setLimit(bytes: number): Promise<DesktopUsageOutcome>;
  recycle(): Promise<DesktopRecycleEntry[]>;
  restore(id: string): Promise<DesktopUsageOutcome>;
  purgeExpired(): Promise<DesktopUsageOutcome>;
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

/** Go 侧诊断结局（Diagnostics.Export）：页面按 ok / kind / message / bytes 折成类型化结局。 */
export interface DesktopDiagnosticsOutcome {
  ok: boolean;
  kind: string;
  message: string;
  bytes: number;
}

/**
 * Go 侧更新服务（Update 服务，#164）：检查、读快照、交给真实安装器。
 *
 * 页面不参与选版与验签：只发「检查」与「安装」两个动作，其余按快照显示。
 */
export interface DesktopUpdateBridge {
  status(): Promise<DesktopUpdateStatus>;
  check(): Promise<void>;
  install(): Promise<void>;
}

/** Go 侧快照的形状（与 updateservice.Snapshot 的 json tag 一致）。 */
export interface DesktopUpdateStatus {
  phase: string;
  current: string;
  version: string;
  notes: string;
  page_url: string;
  downloaded: number;
  total: number;
  verified: boolean;
  installable: boolean;
  error: string;
  checked_at: string;
}

/** Go 侧诊断服务（Diagnostics 服务，#162）：脱敏日志入有界缓冲，导出交给本机对话框。 */
export interface DesktopDiagnosticsBundle {
  ok: boolean;
  kind: string;
  message?: string;
  name: string;
  data: string;
  bytes: number;
}

export interface DesktopDiagnosticsBridge {
  log(kind: string, fields: Record<string, string>): void;
  export(): Promise<DesktopDiagnosticsOutcome>;
  pack(): Promise<DesktopDiagnosticsBundle>;
}

/** 数据位置（Storage 服务，Go 侧 internal/storage）：键名与 Go 的 json tag 对齐。 */
export interface DesktopDataRootStatus {
  root: string;
  moving: boolean;
  done: number;
  total: number;
}

export interface DesktopDataRootOutcome {
  ok: boolean;
  kind: string;
  message: string;
  root: string;
  files: number;
  bytes: number;
}

export interface DesktopDataRootBridge {
  status(): Promise<DesktopDataRootStatus>;
  pick(): Promise<string>;
  move(target: string): Promise<DesktopDataRootOutcome>;
}

/** Go 侧反馈服务（Feedback.Send）：把文字反馈交给配置的中继。 */
export interface DesktopFeedbackBridge {
  send(spec: FeedbackSpec): Promise<FeedbackOutcome>;
  authStatus(): Promise<FeedbackAuthStatus>;
  authStart(): Promise<FeedbackAuthStart>;
  authReset(): Promise<void>;
}

/** MyGo 桥：Go 侧绑定与测试替身都满足它。 */
export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  /** 原生主题同步（#221）：Go 侧 Shell.SetTheme；没有这一项的桥按「宿主不跟随」处理。 */
  setTheme?(choice: ThemeChoice): Promise<void>;
  local: DesktopLocalBridge;
  /** 系统剪贴板（#129）；没有这一项的替身按读不到处理。 */
  clipboard?: DesktopClipboardBridge;
  /** 画板包导入（#131）；没有这一项的替身按「尚不可用」处理。 */
  pack?: DesktopPackBridge;
  /** 网关与密钥（#152）；没有这一项的替身按「尚不可用」处理。 */
  gateway?: DesktopGatewayBridge;
  /** 脱敏诊断采集与导出（#162）；没有这一项时能力关闭、导出明确不可用。 */
  diagnostics?: DesktopDiagnosticsBridge;
  /** 本机用量与回收（#159）；没有这一项的替身按「尚不可用」处理。 */
  usage?: DesktopUsageBridge;
  /** 可信自动更新（#164）；没有这一项时能力关闭，入口明确不可用。 */
  update?: DesktopUpdateBridge;
  /** 本机数据位置迁移（#161）；没有这一项时能力关闭、入口不出现。 */
  dataRoot?: DesktopDataRootBridge;
  /** 反馈（#205）；没有这一项或 Go 没配中继时能力关闭。 */
  feedback?: DesktopFeedbackBridge;
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
  // 扩展名按字节认（本机选来的图可能是 JPEG / WebP），认不出才用 File 的类型提示。
  const abs = joinPath(joinPath(userRoot, IMPORTED_REFERENCES_DIR), sha + "." + (sniffImage(bytes)?.ext ?? extensionOf(file)));
  const path = toRootRelative(userRoot, abs);
  try {
    checked(await local.writeNewFileBase64(abs, base64Of(bytes)));
  } catch (e) {
    if (portFailureOf(e).kind !== "alreadyExists") throw e;
  }
  return { path, sha256: sha };
}

/**
 * 本机选图（#154）：系统对话框在 Go 侧弹，字节由 Go 按用户选中的路径读成 base64。
 * 这里还原成 File 交给既有导入链路（isImageFile → uploadReference），页面不碰本机路径，也不读数据根之外的文件。
 */
async function pickLocalImages(local: DesktopLocalBridge, multiple: boolean): Promise<File[]> {
  const picked = await localRun(() => local.pickImages(multiple));
  return picked.map((image) => {
    const bytes = base64ToBytes(image.data);
    return bytesToFile(bytes, image.name, sniffImage(bytes)?.mediaType ?? "");
  });
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
  return saveThroughLocal(() => local.saveCopyAs(absPath));
}

/** 保存结果 / 整板结果：目标由 Go 弹系统对话框，取消不报成功，缺图与写失败带原因。 */
async function saveThroughLocal(call: () => Promise<DesktopOutcome>): Promise<SaveCopyOutcome> {
  const outcome = await localRun(call);
  if (outcome.kind === "cancelled") return { kind: "cancelled" };
  if (!outcome.ok) {
    if (outcome.kind === "missing") throw new PortError({ kind: "missing", code: outcome.kind, message: outcome.message, status: 0 });
    checked(outcome);
  }
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


/** 把结构化日志字段折成 Go 能收的字符串；脱敏由 Go 侧统一做，页面不碰秘密。 */
function logFields(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    else if (value === null || value === undefined) out[key] = "";
    else out[key] = JSON.stringify(value);
  }
  return out;
}

/** Go 的诊断结局 → 端口结局：只有 ok 才是成功，取消与失败都不冒充成功。 */
function diagnosticsOutcomeOf(outcome: DesktopDiagnosticsOutcome): DiagnosticsOutcome {
  if (outcome.ok) return { kind: "saved", bytes: outcome.bytes };
  if (outcome.kind === "cancelled") return { kind: "cancelled" };
  return { kind: "failed", message: outcome.message || "导出诊断包失败" };
}

/**
 * 能力开关：每项只在「桥上有真实服务」时打开，没有实现就明确不可用（界面据此隐藏入口）。
 *
 * 单独成函数：这些判断随切片增长，留在 createDesktopPort 里会把它压成一张难读的开关表。
 */
export function desktopFeatures(bridge: DesktopBridge, info: DesktopInfo): ShellFeatures {
  return {
    generation: info.features.generation,
    usage: info.features.usage,
    packExport: info.features.pack_export,
    // 画板包导入（#131）在本机做：桥上有 Pack 服务就能导入（导入与导出是两项能力）。
    packImport: bridge.pack !== undefined,
    // 归档由 Go 本机存储执行（20 画板位与只读都落在服务端），已接通。
    archive: info.features.archive ?? false,
    // 诊断包导出（#162）：桥上有真实 Diagnostics 服务才开放。
    diagnostics: bridge.diagnostics !== undefined,
    // 自动更新（#164）：只有内置发布者公钥的构建才有 Update 服务；否则入口按「尚不可用」。
    update: bridge.update !== undefined && (info.features.update ?? false),
    // 数据位置迁移（#161）：桥上有真实 Storage 服务才开放，否则入口不出现。
    dataRoot: bridge.dataRoot !== undefined,
    // 反馈（#205）：桥上有服务还不够，Go 侧必须明确配置了中继地址。
    feedback: bridge.feedback !== undefined && (info.features.feedback ?? false),
  };
}

/** 造桌面壳端口：读一次壳信息，之后都从这份快照回答。 */
export async function createDesktopPort(bridge: DesktopBridge): Promise<DesktopShell> {
  const info = await bridge.info();
  const local = bridge.local;
  const features: ShellFeatures = desktopFeatures(bridge, info);

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
    // 选参考图同样走系统对话框：Go 读字节，页面只拿 File。
    pickImages: (multiple: boolean): Promise<File[]> => pickLocalImages(local, multiple),
    uploadReference: (file: File): Promise<{ path: string; sha256: string }> => uploadReference(local, info.user_data_root, file),
    readClipboard: (): Promise<ClipboardContent | null> => readClipboardSnapshot(bridge),
    copyText: (text: string): Promise<void> => copyTextToSystemClipboard(bridge, text),
    copyImage: (absPath: string, format = ""): Promise<ImageCopyResult> => copyImageToSystemClipboard(bridge, absPath, format),
    saveCopyAs: (absPath: string): Promise<SaveCopyOutcome> => saveCopyAsThroughLocal(local, absPath),
    downloadImage: (absPath: string): Promise<SaveCopyOutcome> => saveThroughLocal(() => local.saveResult(absPath)),
    downloadBoardResults: (boardPath: string): Promise<SaveCopyOutcome> => saveThroughLocal(() => local.saveBoardResults(boardPath)),
  };

  const pack = desktopPack.store;

  const ui = desktopUi(bridge, info, desktopPack);

  // 网关配置、系统保护的密钥与模型发现（#152）：经 Gateway 绑定走 Go 服务。
  const gatewayPorts = createGatewayPorts(bridge);

  const { usage, update, dataRoot, feedback } = desktopOptionalPorts(bridge, info, features);

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
    update,
    dataRoot,
    feedback,
    core: desktopCore(info, files, meta, gatewayPorts, bridge),
  };

  return { port, info };
}


/** 画板包导入端口（createDesktopPack 的返回）。 */
type DesktopPackPort = ReturnType<typeof createDesktopPack>;

/** 桌面窗口的 UI 能力：确认框、提示框、进度订阅、打开外链、版本与日志；诊断包导出另见 desktopDiagnosticsUi。 */
function desktopUi(bridge: DesktopBridge, info: DesktopInfo, desktopPack: DesktopPackPort): ShellPort["ui"] {
  return {
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
    log: (kind: LogKind, fields: Record<string, unknown>): void => {
      bridge.diagnostics?.log(kind, logFields(fields));
    },
    ...desktopDiagnosticsUi(bridge),
    isEditableTarget,
    installInputTakeover: installPageInputTakeover,
    // 原生主题（#221）：宿主不跟随也没有界面后果（本页已经按自己解析出的主题画好了）。
    setNativeTheme: async (choice: ThemeChoice): Promise<void> => {
      await bridge.setTheme?.(choice);
    },
  };
}

/** 诊断包（#162）：导出与随反馈上传两条出口；没有 Diagnostics 绑定时明确不可用。 */
function desktopDiagnosticsUi(bridge: DesktopBridge): Pick<ShellPort["ui"], "exportDiagnostics" | "diagnosticsPack"> {
  return {
    exportDiagnostics: (): Promise<DiagnosticsOutcome> => {
      if (!bridge.diagnostics) return Promise.reject(unavailable("diagnostics"));
      return bridge.diagnostics.export().then(diagnosticsOutcomeOf);
    },
    diagnosticsPack: async (): Promise<DiagnosticsPackOutcome> => {
      if (!bridge.diagnostics) return Promise.reject(unavailable("diagnostics"));
      const result = await bridge.diagnostics.pack();
      if (!result.ok || result.kind !== "saved" || !result.data) {
        return { kind: "failed", message: result.message || "诊断包生成失败，请重试" };
      }
      return { kind: "saved", name: result.name || "diagnostics.zip", contentType: "application/zip", data: result.data };
    },
  };
}

/** 用量、自动更新、数据位置迁移与反馈：没有绑定时都以同形 unavailable 结局关掉入口。 */
function desktopOptionalPorts(bridge: DesktopBridge, info: DesktopInfo, features: ShellFeatures): {
  usage: UsagePort; update: UpdatePort; dataRoot: DataRootStore; feedback: FeedbackPort;
} {
  const usage: UsagePort = info.features.usage && bridge.usage ? desktopUsageStore(bridge.usage) : unavailableUsageStore();
  // 自动更新（#164）：信任判定在 Go 侧，这里只做类型化转发；没有绑定时明确不可用。
  const update: UpdatePort = features.update && bridge.update ? desktopUpdateStore(bridge.update) : unavailableUpdateStore();
  // 数据位置迁移（#161）：没有 Storage 绑定时调用以 unavailable 拒绝，界面按能力开关不显示入口。
  const dataRoot: DataRootStore = bridge.dataRoot ? desktopDataRootStore(bridge.dataRoot) : {
    status: async (): Promise<never> => unavailable("dataRoot"),
    pick: async (): Promise<never> => unavailable("dataRoot"),
    move: async (): Promise<never> => unavailable("dataRoot"),
  };
  // 反馈（#205）：没有绑定就返回同形 unavailable 结局，界面按能力开关隐藏入口。
  const feedback: FeedbackPort = bridge.feedback
    ? {
        send: (spec) => bridge.feedback!.send(spec),
        authStatus: () => bridge.feedback!.authStatus(),
        authStart: () => bridge.feedback!.authStart(),
        authReset: () => bridge.feedback!.authReset(),
      }
    : {
        send: async () => FEEDBACK_UNAVAILABLE,
        authStatus: async (): Promise<FeedbackAuthStatus> => ({ authorized: false, pending: false, message: "" }),
        authStart: async (): Promise<FeedbackAuthStart> => ({ ok: false, url: "", message: "" }),
        authReset: async () => undefined,
      };
  return { usage, update, dataRoot, feedback };
}

/** 画板核心端口：任务文件、生成请求、重定位、画板包与设置经本机绑定接通。 */
function desktopCore(info: DesktopInfo, files: ReturnType<typeof desktopFileStore>, meta: ReturnType<typeof desktopMetaStore>, gatewayPorts: ReturnType<typeof createGatewayPorts>, bridge: DesktopBridge): ShellPort["core"] {
  return {
    taskFs: { writeNewFile: files.writeNewFile, readFile: files.readFile },
    runDeps: {
      imageCodec,
      composeOverlay,
      writeNewFile: files.writeNewFile,
      readFile: files.readFile,
      isFile: files.isFile,
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
      // 网关连接日志（#162）：走同一条脱敏采集通道，连接测试失败这类信息才能进诊断包。
      log: (kind, fields) => bridge.diagnostics?.log(kind, logFields(fields)),
    },
  };
}
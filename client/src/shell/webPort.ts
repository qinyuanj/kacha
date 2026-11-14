// 壳端口的 Web 实现（#126）：同源 HTTP（ipc.ts）+ 浏览器能力（剪贴板、文件选择、下载）。
// 换桌面壳时只换这份实现，界面不改；HTTP 错误在这里折成类型化 PortError，界面不再看状态码。
import { importPack } from "../core/boardPack";
import { imageProbe, packFs, packIo, relocateFs, runDeps, settingsPorts, taskFs } from "./adapters";
import { ApiError } from "./apiError";
import { copyTextToClipboard } from "./clipboard";
import { copyImageToClipboard } from "./imageClipboard";
import { browser, fileUrl, ipc, session, thumbUrl, transfer, usage } from "./ipc";
import { logEvent, type LogKind } from "./log";
import { installPageInputTakeover, isEditableTarget } from "./pageInput";
import { pickPackFile } from "./packFile";
import { PortError, type MediaStore, type PortFailureKind, type ShellPort } from "./port";

/** 服务端错误码 → 端口失败类别：界面只认类别，不认 HTTP 状态。 */
const KIND_BY_CODE: Record<string, PortFailureKind> = {
  board_conflict: "conflict",
  board_missing: "missing",
  already_exists: "alreadyExists",
  board_slots_full: "slotsFull",
  board_archived: "archived",
  cancelled: "cancelled",
  not_found: "notFound",
  forbidden: "forbidden",
  unauthenticated: "unauthenticated",
  invalid_key: "unauthenticated",
  network: "network",
  insufficient_storage: "storageFull",
  payload_too_large: "tooLarge",
  invalid_pack: "invalid",
  not_image: "invalid",
  upload_timeout: "timeout",
};

const KIND_BY_STATUS: Record<number, PortFailureKind> = {
  0: "network",
  401: "unauthenticated",
  403: "forbidden",
  404: "notFound",
  408: "timeout",
  409: "conflict",
  413: "tooLarge",
  422: "invalid",
  507: "storageFull",
};

/** 底层错误 → 端口失败：ApiError 按错误码 / 状态折类，其余原样抛出（文案不变）。 */
function asPortError(e: unknown): unknown {
  if (!(e instanceof ApiError)) return e;
  const kind = KIND_BY_CODE[e.code] ?? KIND_BY_STATUS[e.status] ?? "failed";
  return new PortError({ kind, code: e.code, message: e.message, status: e.status });
}

/** 一次端口调用：失败统一折成 PortError。 */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw asPortError(e);
  }
}

/** 把一组直白的 HTTP 调用包上错误映射。 */
function withPortErrors<T extends object>(group: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(group)) {
    out[key] = typeof value === "function" ? (...args: unknown[]) => mapped(() => (value as (...a: unknown[]) => Promise<unknown>)(...args)) : value;
  }
  return out as T;
}

const board: ShellPort["board"] = withPortErrors({
  read: (path: string) => ipc.readBoard(path),
  write: (path: string, text: string, options?: Parameters<typeof ipc.writeBoard>[2]) => ipc.writeBoard(path, text, options),
  rename: (from: string, to: string, version?: string) => ipc.renameBoard(from, to, version),
  remove: (path: string, version?: string) => ipc.deleteBoard(path, version),
  archive: (from: string, to: string, version?: string) => ipc.archiveBoard(from, to, version),
  unarchive: (from: string, to: string) => ipc.unarchiveBoard(from, to),
  listNames: (dir: string) => ipc.listBoardNames(dir),
  list: () => ipc.listBoards(),
  measure: (text: string) => ipc.measureBoard(text),
});

const files: ShellPort["files"] = withPortErrors({
  readFile: (absPath: string) => ipc.readFileBytes(absPath),
  writeNewFile: (absPath: string, bytes: Uint8Array) => ipc.writeNewFile(absPath, bytes),
  isFile: (absPath: string) => ipc.isFile(absPath),
  listDir: (absDir: string) => ipc.listDir(absDir),
  sha256: (absPath: string) => ipc.fileSha256(absPath),
  inspectImage: (absPath: string) => ipc.inspectImage(absPath),
});

const meta: ShellPort["meta"] = withPortErrors({
  readSettings: () => ipc.readSettings(),
  writeSettings: (text: string) => ipc.writeSettings(text),
  readUiState: () => ipc.readUiState(),
  writeUiState: (text: string) => ipc.writeUiState(text),
  readModelsCache: () => ipc.readModelsCache(),
  writeModelsCache: (text: string) => ipc.writeModelsCache(text),
  readCapabilityOverride: () => ipc.readCapabilityOverride(),
});

/** 浏览器里读不到系统剪贴板：返回 null，粘贴改由 paste 事件带内容（见 canvasPaste）。 */
const media: MediaStore = {
  imageUrl: fileUrl,
  thumbUrl,
  pickImages: (multiple) => transfer.pickLocalImages(multiple),
  pickPackFile,
  uploadReference: (file) => mapped(() => transfer.uploadReference(file)),
  copyText: (text) => copyTextToClipboard(text),
  copyImage: async (absPath) => {
    const failure = await copyImageToClipboard(fileUrl(absPath));
    return failure === null ? { ok: true } : { ok: false, reason: failure };
  },
  // Web 读不到系统剪贴板（内网 HTTP 不是安全上下文）：粘贴内容由 paste 事件带。
  readClipboard: async () => null,
  saveCopyAs: async (absPath) => {
    transfer.downloadImage(absPath);
    return { kind: "saved" as const };
  },
  downloadImage: (path, name) => transfer.downloadImage(path, name),
  downloadBoardResults: (boardPath) => transfer.downloadBoardResults(boardPath),
};

const pack: ShellPort["pack"] = {
  io: packIo,
  import: (file, options) => importPack(packIo, { ...options, file }),
  facts: (spec) => mapped(() => ipc.boardPackFacts(spec)),
  exportPack: (target, spec) => mapped(() => ipc.boardPackExport(target, spec)),
};

const ui: ShellPort["ui"] = {
  ask: (message, options) => browser.ask(message, options),
  message: (text, options) => browser.message(text, options),
  onPackProgress: (handler) => browser.onPackProgress(handler),
  openExternal: (url) => browser.openExternal(url),
  version: () => browser.version(),
  log: (kind: LogKind, fields: Record<string, unknown>) => logEvent(kind, fields),
  isEditableTarget,
  installInputTakeover: installPageInputTakeover,
};

/**
 * 造一份 Web 壳端口：用户数据根是虚拟根 /~，所有能力都在。
 * 桌面壳实现同一个 ShellPort（ADR 0023），只换这里的构造，不改任何调用点。
 */
export function createShellPort(): ShellPort {
  return {
    userRoot: "/~",
    features: { generation: true, usage: true, packExport: true },
  board,
  files,
  meta,
  media,
  pack,
  ui,
    usage,
    session,
    core: { taskFs, runDeps, relocateFs, packFs, imageProbe, settingsPorts },
  };
}

/** 生产用的 Web 壳端口（组合根注入一次，见 main.tsx）。 */
export const webPort: ShellPort = createShellPort();
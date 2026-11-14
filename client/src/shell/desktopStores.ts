// 桌面壳端口的各个分组（#137）：从 shell/desktop.ts 拆出，一组一个函数。
// 拆开之后每个函数的复杂度单独看得到，门禁也按函数计。
import { PortError, type BoardStore, type FeatureId, type FileStore, type MediaStore, type MetaStore, type PackStore } from "./port";
import type { BoardListing, BoardTexts, BoardWriteOptions, ImageInfo, UsagePort } from "./types";
import type { DirEntry } from "../core/relocate";
import type { PackIo } from "../core/boardPack";
import { copyTextToClipboard } from "./clipboard";
import type { DesktopLocalBridge, DesktopOutcome } from "./desktop";

/** Go 侧的失败类别 → 端口失败类别；未列出的按 failed 处理（消息保持原文）。 */
const KIND_BY_GO: Record<string, "conflict" | "missing" | "alreadyExists" | "invalid" | "failed"> = {
  conflict: "conflict",
  missing: "missing",
  alreadyExists: "alreadyExists",
  invalid: "invalid",
};

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

/** 一次本地调用：Go 侧异常折成 failed（消息保持原文），结局失败折成类别化 PortError。 */
export async function localRun<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PortError) throw e;
    throw new PortError({ kind: "failed", code: "local", message: e instanceof Error ? e.message : String(e), status: 0 });
  }
}

/** 结局失败折成类别化 PortError。 */
export function checked(outcome: DesktopOutcome): void {
  if (outcome.ok) return;
  const kind = KIND_BY_GO[outcome.kind] ?? "failed";
  throw new PortError({ kind, code: outcome.kind || "failed", message: outcome.message, status: 0 });
}

/** 画板那一组。 */
export function desktopBoardStore(local: DesktopLocalBridge): BoardStore {
  return {
    read: (path: string): Promise<BoardTexts> =>
      localRun(async () => {
        const texts = await local.readBoard(path);
        return { main: texts.main, bak: texts.bak, version: texts.version };
      }),
    write: (path: string, text: string, options?: BoardWriteOptions): Promise<void> =>
      localRun(async () => checked(await local.writeBoard(path, text, { version: options?.version, create_only: options?.createOnly }))),
    rename: (from: string, to: string): Promise<void> => localRun(async () => checked(await local.renameBoard(from, to))),
    remove: (path: string): Promise<void> => localRun(async () => checked(await local.deleteBoard(path))),
    archive: async (): Promise<void> => unavailable("archive"),
    unarchive: async (): Promise<void> => unavailable("archive"),
    listNames: (dir: string): Promise<string[]> => localRun(() => local.listBoardNames(dir)),
    list: (): Promise<BoardListing> =>
      localRun(async () => {
        const listing = await local.listBoards();
        return {
          boards: listing.boards.map((b) => ({ name: b.name, path: b.path, archived: b.archived, bytes: b.bytes })),
          slots: listing.slots,
          size_lines: listing.size_lines,
        };
      }),
    measure: async (): Promise<never> => unavailable("tidy"),
  };
}

/** base64 文本 → 字节。 */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 文件那一组。 */
export function desktopFileStore(local: DesktopLocalBridge): FileStore {
  return {
    readFile: (absPath: string): Promise<Uint8Array> => localRun(async () => base64ToBytes(await local.readFile(absPath))),
    writeNewFile: (absPath: string, bytes: Uint8Array): Promise<void> => localRun(async () => checked(await local.writeNewFile(absPath, bytes))),
    isFile: (absPath: string): Promise<boolean> => localRun(() => local.isFile(absPath)),
    listDir: (absDir: string): Promise<DirEntry[]> =>
      localRun(async () => (await local.listDir(absDir)).map((e) => ({ name: e.name, is_dir: e.is_dir }))),
    sha256: (absPath: string): Promise<string> => localRun(() => local.fileSha256(absPath)),
    inspectImage: (absPath: string): Promise<ImageInfo> => localRun(() => local.inspectImage(absPath)),
  };
}

/** 元数据那一组。 */
export function desktopMetaStore(local: DesktopLocalBridge): MetaStore {
  return {
    readSettings: (): Promise<string | null> => localRun(async () => (await local.readSettings()) || null),
    writeSettings: (text: string): Promise<void> => localRun(async () => checked(await local.writeSettings(text))),
    readUiState: (): Promise<string | null> => localRun(async () => (await local.readUiState()) || null),
    writeUiState: (text: string): Promise<void> => localRun(async () => checked(await local.writeUiState(text))),
    readModelsCache: (): Promise<string | null> => localRun(async () => (await local.readModelsCache()) || null),
    writeModelsCache: (text: string): Promise<void> => localRun(async () => checked(await local.writeModelsCache(text))),
    readCapabilityOverride: (): Promise<string | null> => localRun(async () => (await local.readCapabilityOverride()) || null),
  };
}

/** 本机文件地址：file:/// 加正斜杠路径。 */
export function fileUrl(absPath: string): string {
  return "file:///" + absPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** 浏览器能力那一组。 */
export function desktopMediaStore(): MediaStore {
  return {
    imageUrl: (absPath: string) => fileUrl(absPath),
    thumbUrl: (absPath: string) => fileUrl(absPath),
    pickImages: async (): Promise<never> => unavailable("generation"),
    pickPackFile: async (): Promise<never> => unavailable("packExport"),
    uploadReference: async (): Promise<never> => unavailable("generation"),
    copyText: (text: string): Promise<void> => copyTextToClipboard(text),
    copyImage: async (): Promise<never> => unavailable("generation"),
    readClipboard: (): null => null,
    saveCopyAs: async (): Promise<never> => unavailable("generation"),
    downloadImage: (): void => {
      void unavailable("generation");
    },
    downloadBoardResults: (): void => {
      void unavailable("generation");
    },
  };
}

/** 画板包那一组：桌面壳还没有画板包能力。 */
export function desktopPackStore(): PackStore {
  return {
    io: new Proxy({} as PackIo, {
      get: () => async (): Promise<never> => unavailable("packExport"),
    }),
    import: async (): Promise<never> => unavailable("packExport"),
    facts: async (): Promise<never> => unavailable("packExport"),
    exportPack: async (): Promise<never> => unavailable("packExport"),
  };
}

/** 用量统计那一组：桌面壳没有用量统计。 */
export function desktopUsageStore(): UsagePort {
  return {
    usage: async (): Promise<never> => unavailable("usage"),
    cleanupUnreferenced: async (): Promise<never> => unavailable("usage"),
  };
}
// 桌面壳端口的各个分组（#137）：从 shell/desktop.ts 拆出，一组一个函数。
// 拆开之后每个函数的复杂度单独看得到，门禁也按函数计。
import { PortError, type BoardStore, type FeatureId, type FileStore, type MediaStore, type MetaStore } from "./port";
import type { BoardListing, BoardTexts, BoardWriteOptions, ImageInfo, UsagePort } from "./types";
import { base64ToBytes } from "../core/base64";
import { joinPath } from "../core/paths";
import type { DirEntry } from "../core/relocate";
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
export function desktopBoardStore(local: DesktopLocalBridge, userRoot: string): BoardStore {
  return {
    read: (path: string): Promise<BoardTexts> =>
      localRun(async () => {
        const texts = await local.readBoard(path);
        return { main: texts.main, bak: texts.bak, version: texts.version };
      }),
    write: (path: string, text: string, options?: BoardWriteOptions): Promise<void> =>
      localRun(async () => checked(await local.writeBoard(path, text, { version: options?.version, create_only: options?.createOnly }))),
    rename: (from: string, to: string, version?: string): Promise<void> => localRun(async () => checked(await local.renameBoard(from, to, version))),
    remove: (path: string, version?: string): Promise<void> => localRun(async () => checked(await local.deleteBoard(path, version))),
    archive: async (): Promise<void> => unavailable("archive"),
    unarchive: async (): Promise<void> => unavailable("archive"),
    listNames: (dir: string): Promise<string[]> => localRun(() => local.listBoardNames(dir)),
    list: (): Promise<BoardListing> =>
      localRun(async () => {
        const listing = await local.listBoards();
        return {
          // Go 侧给的是相对用户数据根的路径；这里拼成绝对路径，
          // 与界面别处（画板目录、标签页会话路径）同一形状：列表 → 打开 → 保存 → 删除一路对得上。
          boards: listing.boards.map((b) => ({ name: b.name, path: joinPath(userRoot, b.path), archived: b.archived, bytes: b.bytes })),
          slots: listing.slots,
          size_lines: listing.size_lines,
        };
      }),
    measure: async (): Promise<never> => unavailable("tidy"),
  };
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

/** 读一个文本：空串当没有。 */
export function readText(read: () => Promise<string>): Promise<string | null> {
  return localRun(async () => (await read()) || null);
}

/** 写一个文本：结局失败折成类别化的错误。 */
export function writeText(write: () => Promise<DesktopOutcome>): Promise<void> {
  return localRun(async () => checked(await write()));
}

/** 元数据那一组。 */
export function desktopMetaStore(local: DesktopLocalBridge): MetaStore {
  return {
    readSettings: () => readText(() => local.readSettings()),
    writeSettings: (text: string) => writeText(() => local.writeSettings(text)),
    readUiState: () => readText(() => local.readUiState()),
    writeUiState: (text: string) => writeText(() => local.writeUiState(text)),
    readModelsCache: () => readText(() => local.readModelsCache()),
    writeModelsCache: (text: string) => writeText(() => local.writeModelsCache(text)),
    readCapabilityOverride: () => readText(() => local.readCapabilityOverride()),
  };
}

/**
 * 用户数据根下的文件在页面上可读的地址。
 *
 * WebView2 的页面来自 http://mygo.localhost，不允许这种 http 页面加载 file:// 子资源：用 file:// 时
 * 节点上的图片一律显示「图片缺失」。Go 侧把用户数据根注册成自定义协议 kacha（见 desktop/wiring.go
 * 的 registerAssetProtocol），页面通过 http://kacha.localhost/<相对路径> 取图。
 */
const ASSET_ORIGIN = "http://kacha.localhost/";

/** 相对用户数据根的路径（正斜杠）；不在根内返回 null。根比较不区分大小写（Windows）。 */
function rootRelative(root: string, absPath: string): string | null {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = absPath.replace(/\\/g, "/");
  if (abs.toLowerCase() === base.toLowerCase()) return "";
  const prefix = base.toLowerCase() + "/";
  return abs.toLowerCase().startsWith(prefix) ? abs.slice(base.length + 1) : null;
}

/** 本机文件地址：用户数据根内走 kacha 协议，根外退回 file:///（画板契约要求路径在根内）。 */
export function servedFileUrl(root: string, absPath: string): string {
  const rel = rootRelative(root, absPath);
  if (rel === null) return fileUrl(absPath);
  return ASSET_ORIGIN + rel.split("/").map(encodeURIComponent).join("/");
}

/** 本机文件地址：file:/// 加正斜杠路径（只作根外兜底；根内用 servedFileUrl）。 */
function fileUrl(absPath: string): string {
  return "file:///" + absPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** 浏览器能力那一组。 */
export function desktopMediaStore(root: string): MediaStore {
  return {
    imageUrl: (absPath: string) => servedFileUrl(root, absPath),
    thumbUrl: (absPath: string) => servedFileUrl(root, absPath),
    pickImages: async (): Promise<never> => unavailable("generation"),
    pickPackFile: async (): Promise<never> => unavailable("packExport"),
    uploadReference: async (): Promise<never> => unavailable("generation"),
    copyText: (text: string): Promise<void> => copyTextToClipboard(text),
    copyImage: async (): Promise<never> => unavailable("generation"),
    readClipboard: async (): Promise<null> => null,
    saveCopyAs: async (): Promise<never> => unavailable("generation"),
    downloadImage: (): void => {
      void unavailable("generation");
    },
    downloadBoardResults: (): void => {
      void unavailable("generation");
    },
  };
}

/** 用量统计那一组：桌面壳没有用量统计。 */
export function desktopUsageStore(): UsagePort {
  return {
    usage: async (): Promise<never> => unavailable("usage"),
    cleanupUnreferenced: async (): Promise<never> => unavailable("usage"),
  };
}
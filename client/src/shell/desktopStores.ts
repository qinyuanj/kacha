// 桌面壳端口的各个分组（#137）：从 shell/desktop.ts 拆出，一组一个函数。
// 拆开之后每个函数的复杂度单独看得到，门禁也按函数计。
import { FEATURE_LABELS, PortError, type BoardStore, type DataRootMoveResult, type DataRootStatus, type DataRootStore, type FeatureId, type FileStore, type MediaStore, type MetaStore } from "./port";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import type { BoardListing, BoardTexts, BoardWriteOptions, ImageInfo, RecycleEntry, UpdatePort, Usage, UsagePort } from "./types";
import { base64Of, base64ToBytes } from "../core/base64";
import { joinPath } from "../core/paths";
import type { DirEntry } from "../core/relocate";
import type { DesktopDataRootBridge, DesktopLocalBridge, DesktopOutcome, DesktopUpdateBridge, DesktopUsageBridge } from "./desktop";
import { emptySnapshot, type UpdatePhase, type UpdateSnapshot } from "../core/update";

/** Go 侧的失败类别 → 端口失败类别；未列出的按 failed 处理（消息保持原文）。 */
const KIND_BY_GO: Record<string, "conflict" | "missing" | "alreadyExists" | "slotsFull" | "archived" | "invalid" | "failed"> = {
  conflict: "conflict",
  missing: "missing",
  alreadyExists: "alreadyExists",
  slotsFull: "slotsFull",
  archived: "archived",
  invalid: "invalid",
};

/** 本切片还没有的能力：以 kind: "unavailable" 拒绝。能力名与界面共用 port.ts 的那一份（C1）。 */
export function unavailable(feature: FeatureId): never {
  throw new PortError({
    kind: "unavailable",
    code: "unavailable",
    message: "桌面客户端：" + FEATURE_LABELS[feature] + UNAVAILABLE_TEXT,
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
export function checked(outcome: { ok: boolean; kind: string; message: string; version?: string }): void {
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
    archive: (from: string, to: string, version?: string): Promise<void> =>
      localRun(async () => checked(await local.archiveBoard(from, to, version))),
    unarchive: (from: string, to: string): Promise<void> =>
      localRun(async () => checked(await local.unarchiveBoard(from, to))),
    listNames: (dir: string): Promise<string[]> => localRun(() => local.listBoardNames(dir)),
    list: (): Promise<BoardListing> =>
      localRun(async () => {
        const listing = await local.listBoards();
        return {
          // Go 侧给的是相对数据根的路径；这里拼成绝对路径，
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
    // 跨 MyGo/JSON 绑定的字节一律走 base64：Uint8Array 直传会变成对象，Go 的 []byte 解不出来。
    writeNewFile: (absPath: string, bytes: Uint8Array): Promise<void> => localRun(async () => checked(await local.writeNewFileBase64(absPath, base64Of(bytes)))),
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
 * 数据根下的文件在页面上可读的地址。
 *
 * WebView2 的页面来自 http://mygo.localhost，不允许这种 http 页面加载 file:// 子资源：用 file:// 时
 * 节点上的图片一律显示「图片缺失」。Go 侧把数据根注册成自定义协议 kacha（见 desktop/wiring.go
 * 的 registerAssetProtocol），页面通过 http://kacha.localhost/<相对路径> 取图。
 */
const ASSET_ORIGIN = "http://kacha.localhost/";

/** 相对数据根的路径（正斜杠）；不在根内返回 null。根比较不区分大小写（Windows）。 */
function rootRelative(root: string, absPath: string): string | null {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = absPath.replace(/\\/g, "/");
  if (abs.toLowerCase() === base.toLowerCase()) return "";
  const prefix = base.toLowerCase() + "/";
  return abs.toLowerCase().startsWith(prefix) ? abs.slice(base.length + 1) : null;
}

/** 本机文件地址：数据根内走 kacha 协议，根外退回 file:///（画板契约要求路径在根内）。 */
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
    copyText: async (): Promise<never> => unavailable("copyText"),
    // 各能力用自己的名字，别把「生成尚不可用」当成保存 / 下载的理由（C4）。
    copyImage: async (): Promise<never> => unavailable("copyImage"),
    readClipboard: async (): Promise<null> => null,
    saveCopyAs: async (): Promise<never> => unavailable("saveImage"),
    downloadImage: async (): Promise<never> => unavailable("downloadImage"),
    downloadBoardResults: async (): Promise<never> => unavailable("downloadResults"),
  };
}

/**
 * 能力未开时的分组：每个方法都以同一类别明确不可用，不返回空成功。
 *
 * 各能力用自己的名字拒绝（C4）：用量说「用量统计」，更新说「自动更新」，
 * 不把「生成尚不可用」当成别的能力没实现的理由。
 */
function unavailableStore<T>(feature: FeatureId, methods: readonly string[]): T {
  const store: Record<string, () => Promise<never>> = {};
  for (const method of methods) store[method] = async (): Promise<never> => unavailable(feature);
  return store as T;
}

/** 能力未开时用量统计明确不可用，不返回空成功。 */
export function unavailableUsageStore(): UsagePort {
  return unavailableStore<UsagePort>("usage", ["usage", "cleanupUnreferenced", "setLimit", "recycle", "restore", "purgeExpired"]);
}

/** 更新阶段的白名单：Go 侧给不认识的值时按 error 处理，不静默当成可安装。 */
const UPDATE_PHASES = new Set<UpdatePhase>([
  "disabled",
  "idle",
  "checking",
  "up_to_date",
  "available",
  "downloading",
  "ready",
  "installing",
  "error",
]);

/** Go 侧快照 → 页面快照：字段一一对应，阶段不认识就按 error 收。 */
export function updateSnapshotOf(raw: Awaited<ReturnType<DesktopUpdateBridge["status"]>>): UpdateSnapshot {
  const phase = UPDATE_PHASES.has(raw.phase as UpdatePhase) ? (raw.phase as UpdatePhase) : "error";
  return {
    ...emptySnapshot(),
    phase,
    current: raw.current ?? "",
    version: raw.version ?? "",
    notes: raw.notes ?? "",
    page_url: raw.page_url ?? "",
    downloaded: raw.downloaded ?? 0,
    total: raw.total ?? 0,
    // 验签与可安装只信 Go 侧的说法：界面不自己推断。
    verified: raw.verified === true,
    installable: raw.installable === true,
    error: raw.error ?? "",
    checked_at: raw.checked_at ?? "",
  };
}

/** 能力未开时更新入口明确不可用，不返回空成功。 */
export function unavailableUpdateStore(): UpdatePort {
  return unavailableStore<UpdatePort>("update", ["status", "check", "install"]);
}

/** 自动更新那一组：检查、读快照与安装都落到 Go 的 Update 服务。 */
export function desktopUpdateStore(update: DesktopUpdateBridge): UpdatePort {
  return {
    status: (): Promise<UpdateSnapshot> => localRun(async () => updateSnapshotOf(await update.status())),
    check: (): Promise<void> => localRun(() => update.check()),
    install: (): Promise<void> => localRun(() => update.install()),
  };
}

const USAGE_LEVELS = new Set(["warn", "alert"]);

/** Go 的提醒档位是空串表示不提醒；端口用 null 表达同一个意思。 */
function usageOf(raw: Awaited<ReturnType<DesktopUsageBridge["usage"]>>): Usage {
  return {
    ...raw,
    limit_level: USAGE_LEVELS.has(raw.limit_level ?? "") ? (raw.limit_level as Usage["limit_level"]) : null,
  };
}

/** 用量统计那一组：读、清理、阈值与回收恢复都落到 Go 的 Usage 服务。 */
export function desktopUsageStore(usage: DesktopUsageBridge): UsagePort {
  return {
    usage: (): Promise<Usage> => localRun(async () => usageOf(await usage.usage())),
    cleanupUnreferenced: (dirs: string[]) => localRun(async () => {
      const result = await usage.cleanup(dirs);
      checked(result);
      return result;
    }),
    setLimit: (bytes: number): Promise<void> => localRun(async () => checked(await usage.setLimit(bytes))),
    recycle: (): Promise<RecycleEntry[]> => localRun(() => usage.recycle()),
    restore: (id: string): Promise<void> => localRun(async () => checked(await usage.restore(id))),
    purgeExpired: (): Promise<void> => localRun(async () => checked(await usage.purgeExpired())),
  };
}

/** 迁移的 Go 类别 → 端口类别：目标冲突与路径越界都是「这个目标不行」，取消不算失败。 */
const DATA_ROOT_KINDS: Record<string, "conflict" | "invalid" | "cancelled" | "failed"> = {
	notEmpty: "conflict",
	sameRoot: "invalid",
	nested: "invalid",
	invalid: "invalid",
	busy: "conflict",
	cancelled: "cancelled",
};

/** 数据位置那一组（#161）：状态、选目标与迁移都落到 Go 的 Storage 服务。 */
export function desktopDataRootStore(bridge: DesktopDataRootBridge): DataRootStore {
	return {
		status: (): Promise<DataRootStatus> => localRun(async () => {
			const status = await bridge.status();
			return { root: status.root, moving: status.moving, done: status.done, total: status.total };
		}),
		pick: (): Promise<string> => localRun(() => bridge.pick()),
		move: (target: string): Promise<DataRootMoveResult> => localRun(async () => {
			const outcome = await bridge.move(target);
			if (!outcome.ok) {
				throw new PortError({
					kind: DATA_ROOT_KINDS[outcome.kind] ?? "failed",
					code: outcome.kind || "failed",
					message: outcome.message,
					status: 0,
				});
			}
			return { root: outcome.root, files: outcome.files, bytes: outcome.bytes };
		}),
	};
}
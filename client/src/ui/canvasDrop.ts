// HTML5 拖放与粘贴图片的纯逻辑：哪些文件是图片、松手处的落点挂到哪张任务卡片、逐张上传并读元信息、
// 粘贴的图片按「粘贴-年月日-时分」命名后落成参考图节点。监听与落盘接线见 useCanvasDrop / canvasPaste；
// 只接受图片（画板 .ugcboard.json 由画板包导入承担，不解析本机路径）。
import type { Board } from "../core/board";
import type { BoardChange, ImportedImage } from "../core/edit";
import { errorText } from "../core/errors";
import { MAX_PASTE_BYTES, pasteDisplayNames } from "../core/pageInput";
import { resolveFromRoot } from "../core/paths";
import { IMAGE_EXTENSIONS } from "../core/relocate";
import type { ImageInfo } from "../shell/ipc";
import { IMPORT_TEXT, PASTE_TEXT } from "./boardText";
import type { DropTarget } from "./canvasPoint";

/** 本机图片导入的 IO 端口：上传、读元信息、写画布的图片信息缓存（生产实现见 useCanvasDrop）。 */
export interface ImagePorts {
  upload: (file: File) => Promise<{ path: string }>;
  inspect: (absPath: string) => Promise<ImageInfo>;
  prime: (absPath: string, info: ImageInfo) => void;
}

/** 这个文件是图片吗：MIME 是 image/*，或后缀在 IMAGE_EXTENSIONS 里（大小写不敏感）。 */
export function isImageFile(f: { name: string; type: string }): boolean {
  return f.type.startsWith("image/") || IMAGE_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(`.${ext}`));
}

/** 一批文件里挑出图片。 */
export function imageFilesOf<T extends { name: string; type: string }>(files: Iterable<T>): T[] {
  return [...files].filter((f) => isImageFile(f));
}

/** 松手处的落点 → 参考图挂接目标：落在任务卡片上时挂到该任务左侧，其余位置按落点新建。 */
export function dropAttachOf(hit: DropTarget | null, board: Board): { taskId: string; place: "left" } | undefined {
  if (hit?.kind !== "node") return undefined;
  const card = board.nodes.find((n) => n.id === hit.nodeId);
  return card?.type === "task" ? { taskId: card.id, place: "left" } : undefined;
}

/**
 * 本机图片先上传到用户数据根的 导入参考图/，再按服务端给出的路径读元信息并写进缓存。单张失败只提示，不打断其余。
 * displayNames = 整批上传后统一合成显示名（粘贴的图按「粘贴-…」命名，扩展名取落盘路径而不是剪贴板里的类型声明）；缺省用本机文件名。
 */
export async function importImages(
  files: Iterable<File>,
  deps: {
    userRoot: string;
    toast: (message: string) => void;
    ports: ImagePorts;
    displayNames?: (uploadedPaths: string[]) => string[];
  },
): Promise<ImportedImage[]> {
  // 先收集成功的，再整批算显示名：同一分钟粘多张时，要等整批落盘路径都出来才排得开 -2、-3。
  const done: { file: File; path: string; sha256: string; width: number; height: number }[] = [];
  for (const file of files) {
    try {
      const uploaded = await deps.ports.upload(file);
      const abs = resolveFromRoot(deps.userRoot, uploaded.path);
      const info = await deps.ports.inspect(abs);
      deps.ports.prime(abs, info);
      done.push({ file, path: uploaded.path, sha256: info.sha256, width: info.width, height: info.height });
    } catch (e) {
      deps.toast(IMPORT_TEXT.failed(file.name, errorText(e)));
    }
  }
  const names = deps.displayNames?.(done.map((u) => u.path));
  return done.map((u, i) => ({ path: u.path, sha256: u.sha256, display_name: names?.[i] ?? u.file.name, width: u.width, height: u.height }));
}

/** 导入完成后落成参考图节点（attach = 同时接到任务卡片的空图片端口）；一张都没成功就不产生撤销步。 */
export function addImportedReferences(
  images: ImportedImage[],
  at: { x: number; y: number },
  attach: { taskId: string; place: "asIs" | "left" } | undefined,
  apply: (change: BoardChange) => void,
): void {
  if (!images.length) return;
  apply({ kind: "addReferences", images, at: [at.x, at.y], attach: attach ?? null });
}

/** 粘贴进来的图片：超限的当场提示、不发请求；其余与「添加参考图」同一条链路，一次粘多张仍算一个撤销步。 */
export async function importPastedImages(
  files: File[],
  at: { x: number; y: number },
  deps: {
    /** 当前画板：显示名要避开画板里已有的参考图名。 */
    board: Board;
    userRoot: string;
    toast: (message: string) => void;
    ports: ImagePorts;
    apply: (change: BoardChange) => void;
  },
): Promise<void> {
  const usable = files.filter((file) => {
    if (file.size <= MAX_PASTE_BYTES) return true;
    deps.toast(PASTE_TEXT.tooLarge);
    return false;
  });
  if (!usable.length) return;
  const now = new Date();
  // 显示名整批一起算：同一分钟的第二张自动 -2，与画板里已有的名字也不撞。
  const taken = new Set(deps.board.nodes.flatMap((n) => (n.type === "reference" ? [n.display_name] : [])));
  const images = await importImages(usable, { userRoot: deps.userRoot, toast: deps.toast, ports: deps.ports, displayNames: (paths) => pasteDisplayNames(now, paths, taken) });
  addImportedReferences(images, at, undefined, deps.apply);
}

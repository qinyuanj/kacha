// 页面输入接管（#96）的粘贴分派：这里只有判定——剪贴板快照 + 界面状态 → 一个可执行结果。
// 读 paste 事件、上传图片、往画板写节点都在界面层；判定与产物名放这里，才能不碰 DOM 地测。

/** 复制节点时写进系统剪贴板的标记前缀；计数接在后面（见 nodeMarker）。 */
export const NODE_MARKER_PREFIX = "kacha:clip:v1:";

/** 复制节点时写进系统剪贴板的标记文本：粘回本页时据此认出「这是节点，不是截图」。 */
export const nodeMarker = (count: number): string => `${NODE_MARKER_PREFIX}${count}`;

/** 标记全文的形状：前缀 + 从 1 起、不许多一位前导零的计数。前缀里没有正则元字符，直接拼进来。 */
const NODE_MARKER_RE = new RegExp(`^${NODE_MARKER_PREFIX}[1-9]\\d*$`);

/**
 * 剪贴板文本是不是本应用写的节点标记：先 trim（用户可能会一起粘上空白），计数从 1 起。
 * 0、别的前缀、空串都不算——宁可当成普通文本放行，也不误吞用户粘的东西。
 */
export function isNodeMarker(text: string | null): boolean {
  return text !== null && NODE_MARKER_RE.test(text.trim());
}

/**
 * 单次粘贴一张图片的上限（字节），与服务端单请求上限一致：超限在客户端就提示、不发请求。
 * 真源头是 server/src/lib.rs 的 `MAX_BODY_BYTES`；客户端另有一份画板包单份内容的副本
 * （core/boardPack 的 `MAX_CONTENT_BYTES`，同样指这个服务端上限），两者的一致性由
 * pageInput 的单测盯着——改一处忘了另一处会在测试里现形。
 */
export const MAX_PASTE_BYTES = 64 * 1024 * 1024;

/** 粘贴图片的显示名前缀。产物名只在这里定义，界面与 e2e 都 import 它。 */
export const PASTE_NAME_PREFIX = "粘贴";

/** 画布坐标。 */
export type PastePos = [number, number];

/** 剪贴板快照：由界面层从 paste 事件里读出来（这里不碰 ClipboardEvent）。 */
export interface PasteFacts {
  /** 剪贴板里的纯文本；没有为 null。 */
  text: string | null;
  /** 能读出内容的图片张数。 */
  images: number;
  /** 读不到内容的文件个数（例如资源管理器里复制的文件）。 */
  opaqueFiles: number;
}

/** 粘贴时的界面状态：判定只看这些，不看画板内容。 */
export interface PasteContext {
  /** 当前是否打开着一块画板（登录页 / 没有画板为 false）。 */
  board: boolean;
  /** 归档只读画板。 */
  readOnly: boolean;
  /** 有模态弹出。 */
  modal: boolean;
  /** 焦点在文本输入里。 */
  textFocus: boolean;
  /** 应用内剪贴板里有可粘的节点。 */
  hasNodeClip: boolean;
  /** 落点（画布坐标）。 */
  at: PastePos;
}

export type PasteRefusal = "readOnly" | "staleNodeClip" | "filesNotReadable";

/** 粘贴的分派结果：放行给浏览器 / 粘节点 / 把图片落成参考图 / 吞掉并提示。 */
export type PasteAction = { kind: "pass" } | { kind: "pasteNodes" } | { kind: "importImages"; at: PastePos } | { kind: "refuse"; reason: PasteRefusal };

/** 剪贴板里是本应用的节点标记：只读画板先拒绝；内存剪贴板空了就是刷新过页面或来自另一个标签页，只能提示重新复制。 */
function markerPaste(context: PasteContext): PasteAction {
  if (context.readOnly) return { kind: "refuse", reason: "readOnly" };
  return context.hasNodeClip ? { kind: "pasteNodes" } : { kind: "refuse", reason: "staleNodeClip" };
}

/**
 * 一个 Ctrl+V 落在哪条路上：先看有没有画板与模态，再看剪贴板里是什么。
 * 顺序照 ADR 0021：标记优先于图片，避免复制节点后立刻粘贴粘出几小时前的旧截图。
 */
export function dispatchPaste(facts: PasteFacts, context: PasteContext): PasteAction {
  if (!context.board) return { kind: "pass" };
  if (context.modal) return { kind: "pass" };
  if (isNodeMarker(facts.text)) return markerPaste(context);
  // 输入框里粘文本照旧：只有「没有文本」（纯图片或文件）时才轮到下面的分支。
  if (context.textFocus && facts.text !== null) return { kind: "pass" };
  if (facts.images > 0) {
    if (context.readOnly) return { kind: "refuse", reason: "readOnly" };
    return { kind: "importImages", at: context.at };
  }
  if (facts.opaqueFiles > 0) return { kind: "refuse", reason: "filesNotReadable" };
  return { kind: "pass" };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 产物名里的时间戳：本地时间 YYYYMMDD-HHmm——用户看的是自己电脑上的时间。 */
const pasteStamp = (now: Date): string => `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;

/** 扩展名取文件名最后一个点之后的部分（小写）；目录名里的点、末尾的点都不算扩展名。 */
function pasteExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * 粘贴出来的图片叫什么：`粘贴-年月日-时分[.扩展名]`，与画板里已有的名字（taken）或同批先到的那张重名时追加 -2、-3……
 * 名字是用户唯一能区分「这张是我刚粘的」的线索，所以同一分钟多张必须能分得开。
 */
export function pasteDisplayNames(now: Date, uploadedPaths: readonly string[], taken: ReadonlySet<string>): string[] {
  const stem = `${PASTE_NAME_PREFIX}-${pasteStamp(now)}`;
  // 批内已分配的名字也算占用，否则同一批两张会拿到同一个名字。
  const used = new Set(taken);
  return uploadedPaths.map((path) => {
    const ext = pasteExtension(path);
    const withExt = (name: string) => (ext === "" ? name : `${name}.${ext}`);
    let name = withExt(stem);
    for (let n = 2; used.has(name); n++) name = withExt(`${stem}-${n}`);
    used.add(name);
    return name;
  });
}

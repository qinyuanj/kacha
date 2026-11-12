// 页面输入接管：复制模式（#98）、粘贴分派（#96）、与画板冲突的浏览器默认行为判定（#97）。
// 这里只有纯逻辑，不碰 DOM；读事件与挂监听都在界面层：粘贴在 BoardCanvas 的 window paste，默认行为在 shell/pageInput。
import type { Board, ReferenceNode, ResultNode } from "./board";

// ---- 复制模式（#98） ----
export type CopyTarget = { mode: "image"; node: ReferenceNode | ResultNode } | { mode: "nodes" };

/** Ctrl+C 只看选区：恰好单选参考图 / 结果节点时返回待复制图片；其余选区保持节点复制。 */
export function copyTarget(board: Board, selectedIds: readonly string[]): CopyTarget {
  if (selectedIds.length !== 1) return { mode: "nodes" };
  const node = board.nodes.find((n) => n.id === selectedIds[0]);
  return node?.type === "reference" || node?.type === "result" ? { mode: "image", node } : { mode: "nodes" };
}

// ---- 粘贴分派（#96） ----
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

/** 剪贴板内容的样子：决定「没有受支持图片」时给用户哪一句可操作的原因。 */
export type PasteContent = "file" | "uri" | "html" | "text" | "none";

/** 内嵌 data URL 解码失败的分类（#114）：每一类对应一句用户可见原因。 */
export interface PasteFailures {
  /** 载荷解不出来，或不是一个完整的图片 data URL。 */
  invalid: number;
  /** 媒体类型不在既有格式清单里（例如 svg）。 */
  unsupported: number;
  /** 单张超过粘贴上限。 */
  tooLarge: number;
}

/**
 * 有没有失败项：invalid + unsupported + tooLarge 的求和只在这里做一次。
 * 分派与界面层都问它，别各写一遍求和。
 */
export const hasFailures = (failures: PasteFailures): boolean => failures.invalid + failures.unsupported + failures.tooLarge > 0;

/** 剪贴板快照：由界面层从 paste 事件里读出来（这里不碰 ClipboardEvent）。 */
export interface PasteFacts {
  /** 剪贴板里的纯文本；没有为 null。 */
  text: string | null;
  /** 能读出内容的图片张数。 */
  images: number;
  /** 读不到内容的文件个数（例如资源管理器里复制的文件）。 */
  opaqueFiles: number;
  /** 剪贴板内容的样子：文件 / URI / HTML / 纯文本 / 空。 */
  content: PasteContent;
  /** 远程图片地址的个数：应用不抓，只用来给一个可操作的原因。 */
  remote: number;
  /** 解码失败的内嵌图片分类计数。 */
  failures: PasteFailures;
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

export type PasteRefusal = "readOnly" | "staleNodeClip" | "filesNotReadable" | "noSupportedImage" | "remoteImage" | "imageFailed";

/** 粘贴的分派结果：放行给浏览器 / 粘节点 / 把图片落成参考图 / 吞掉并提示。 */
export type PasteAction = { kind: "pass" } | { kind: "pasteNodes" } | { kind: "importImages"; at: PastePos } | { kind: "refuse"; reason: PasteRefusal };

/** 剪贴板里是本应用的节点标记：只读画板先拒绝；内存剪贴板空了就是刷新过页面或来自另一个标签页，只能提示重新复制。 */
function markerPaste(context: PasteContext): PasteAction {
  if (context.readOnly) return { kind: "refuse", reason: "readOnly" };
  return context.hasNodeClip ? { kind: "pasteNodes" } : { kind: "refuse", reason: "staleNodeClip" };
}

/** 输入框里粘非空文本：任何非空文本（包括一串图片 data URL）都交给输入框自己，不改判成粘图片（#98）。 */
function textInputPaste(facts: PasteFacts, context: PasteContext): PasteAction | null {
  return context.textFocus && facts.text !== null ? { kind: "pass" } : null;
}

/** 剪贴板里有受支持图片：落成参考图节点；只读画板拒绝。 */
function imagePaste(facts: PasteFacts, context: PasteContext): PasteAction | null {
  if (facts.images <= 0) return null;
  if (context.readOnly) return { kind: "refuse", reason: "readOnly" };
  return { kind: "importImages", at: context.at };
}

/** 内容看似是文件 / 图片 / HTML / URI 却拿不到受支持图片：给一条可操作的原因，不静默。 */
function noImagePaste(facts: PasteFacts): PasteAction | null {
  // 远程地址：应用不去抓，也不把地址写进提示，只给用户一条可操作的原因。
  if (facts.remote > 0) return { kind: "refuse", reason: "remoteImage" };
  // 读不到内容的文件：浏览器不给页面读文件本身，只能提示用户拖进来。
  if (facts.opaqueFiles > 0) return { kind: "refuse", reason: "filesNotReadable" };
  // 内嵌图片解不开：按失败分类给原因。
  if (hasFailures(facts.failures)) return { kind: "refuse", reason: "imageFailed" };
  // 文件 / HTML / URI 类内容里没有受支持图片：提示改用文件。
  if (facts.content === "file" || facts.content === "html" || facts.content === "uri") return { kind: "refuse", reason: "noSupportedImage" };
  return null;
}

/**
 * 一个 Ctrl+V 落在哪条路上：先看有没有画板与模态，再看剪贴板里是什么。
 * 顺序照 ADR 0021：标记优先于图片，避免复制节点后立刻粘贴粘出几小时前的旧截图。
 *
 * #114 补：内嵌 data URL 解出来的图片与文件、图片条目同路；有受支持图片就导入，
 * 只剩远程地址或没有受支持图片时给一个可操作的原因，空剪贴板与普通纯文本照旧放行。
 */
export function dispatchPaste(facts: PasteFacts, context: PasteContext): PasteAction {
  if (!context.board || context.modal) return { kind: "pass" };
  if (isNodeMarker(facts.text)) return markerPaste(context);
  return textInputPaste(facts, context) ?? imagePaste(facts, context) ?? noImagePaste(facts) ?? { kind: "pass" };
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

// ---- 默认行为判定（#97） ----
/** 页面级吞掉的 Ctrl / Cmd + 字母：保存网页、打印、页内查找、打开文件。 */
export const BLOCKED_MOD_KEYS: readonly string[] = ["s", "p", "f", "o"];

const ARROW_KEYS: readonly string[] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

/** 键盘事件的形状：KeyboardEvent 里用得上的字段，加上焦点是否在输入区。 */
export interface KeyShape {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** 焦点在输入框 / 文本域 / 内容可编辑里：方向键与编辑快捷键的原生行为留给它们。 */
  editable: boolean;
}

/**
 * 键盘是否吞掉浏览器默认行为：
 * - Alt + ← / →：吞，避免后退 / 前进丢掉当前画板；
 * - Ctrl / Cmd + S / P / F / O：一律吞，不看焦点（这些组合在文本编辑里没有原生意义）；
 * - 方向键：非输入区一律吞，页面不滚动、与「选中时微移」共存；输入区放行（移动光标）；
 * - 其余放行：Ctrl+G / U、编辑类组合，以及浏览器自己处理的 Ctrl+W / T / N（见 README 已知限制）。
 */
export function blocksKey(e: KeyShape): boolean {
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return true;
  const letter = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) return BLOCKED_MOD_KEYS.includes(letter);
  return !e.editable && ARROW_KEYS.includes(e.key);
}

/**
 * 拖放：只要拖拽里带着文件就拦——浏览器会直接打开那个文件、把应用顶掉（本票唯一现存缺陷级条目）。
 * 纯文本 / 链接的拖拽放行，输入框里拖字照旧。画布上的落图由 BoardCanvas 在捕获阶段先行处理。
 * transfer 为 null 是合成事件的情形，当作不带文件。
 */
export function blocksFileDrag(transfer: { types: readonly string[] } | null): boolean {
  return !!transfer?.types.includes("Files");
}

/** 鼠标事件的形状：按下还是松开，加键位。 */
export type MousePhase = "down" | "up";

/**
 * 鼠标是否吞掉默认行为：
 * - 中键按下会启动自动滚动，只在 down 上拦（画布的中键平移由画布自己处理，配置不变）；
 * - 侧键后退 / 前进：Chromium 会把侧键事件交给页面，默认动作在 up 事件之后才执行，
 *   所以只在 up 上拦有效——在 down 或 auxclick 上 preventDefault 拦不住（票 #97 实测）。
 *   鼠标厂商软件把侧键映射成系统 APPCOMMAND 时页面完全收不到事件，那种情况拦不住，见 README 已知限制。
 */
export function blocksMouseButton(phase: MousePhase, button: number): boolean {
  if (phase === "down") return button === 1;
  return button === 3 || button === 4;
}

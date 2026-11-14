// 系统剪贴板的分派（#129）：桌面壳从系统剪贴板读到的快照，决定一个 Ctrl+V 落在哪条路上。
// 纯逻辑：不碰 DOM、不起 MyGo runtime、不发请求——读取由壳端口的 media.readClipboard 负责，
// 这里只按快照的类别与界面状态给出意图（与 #96 的 dispatchPaste 同一套语义，只是输入更具体）。
import { isNodeMarker, markerPaste, type PasteContext, type PasteRefusal } from "./pageInput";

/**
 * 剪贴板快照的类别：与 Go 侧 desktop/internal/clipboard 的 Kind 一一对应。
 * mark = 本应用写的节点标记；images = 一张或多张 PNG；text = 其它纯文本；
 * empty = 空的；unsupported = 有内容但用不了（文件、别的图片格式、超限）；busy = 读的当下拿不到。
 */
export type ClipboardKind = "mark" | "images" | "text" | "empty" | "unsupported" | "busy";

/** 用不了 / 拿不到的原因：决定给用户哪句话。 */
export type ClipboardReason = "files" | "format" | "tooLarge" | "busy" | "changed" | "failed";

/** 桌面壳读到的系统剪贴板快照（读不到时调用方改用 paste 事件带的内容）。 */
export interface ClipboardContent {
  kind: ClipboardKind;
  /** 剪贴板里的纯文本；没有为 null。 */
  text: string | null;
  /** 能读出内容的图片，顺序与剪贴板里一致。 */
  images: File[];
  /** kind = unsupported / busy 时的原因。 */
  reason: ClipboardReason | null;
  /** 读不到内容的文件个数（资源管理器里复制的文件只有名字没有内容）。 */
  readFailureCount: number;
}

/** 读不出东西时给用户的提示：空、格式不支持、超限、剪贴板被占用（可重试）。 */
export type ClipboardNotice = "empty" | "unsupported" | "tooLarge" | "busy";

/** 一次粘贴的意图：放行 / 粘节点 / 落成参考图 / 拒绝 / 吞掉并提示。 */
export type ClipboardPasteAction =
  | { kind: "pass" }
  | { kind: "pasteNodes" }
  | { kind: "importImages"; at: [number, number] }
  | { kind: "refuse"; reason: PasteRefusal }
  | { kind: "notice"; notice: ClipboardNotice };

/**
 * 标记是否真的在剪贴板里：以文本形状为准（Go 侧与 #96 用同一个前缀），类别只是提示。
 * 这样即便快照的 kind 与 text 不一致，也不会误把普通文本当成节点、或反过来把标记当文本放行。
 */
function hasMark(content: ClipboardContent): boolean {
  return content.kind === "mark" && isNodeMarker(content.text);
}

/** 用不了的东西怎么说：文件只能拖入，其余是格式 / 超限 / 剪贴板占用。 */
function noticeOf(content: ClipboardContent): ClipboardPasteAction {
  // 超限先于 busy：超过 64 MiB 单张上限的图不是「稍后重试」能好的，不能被 busy 掩盖（A3）。
  if (content.reason === "tooLarge") return { kind: "notice", notice: "tooLarge" };
  if (content.kind === "busy") return { kind: "notice", notice: "busy" };
  if (content.reason === "files" || content.readFailureCount > 0) return { kind: "refuse", reason: "filesNotReadable" };
  if (content.kind === "unsupported") return { kind: "notice", notice: "unsupported" };
  return { kind: "notice", notice: "empty" };
}

/**
 * 一个 Ctrl+V 落在哪条路上：先看有没有画板与模态，再看剪贴板里是什么。
 * 顺序照 ADR 0021：标记优先于图片——复制节点后立刻粘贴不会粘出旧截图，
 * 截图后粘贴也不会粘出旧节点（那时剪贴板里只有图片，没有标记）。
 * 读不出东西时一律给提示（notice / refuse），不静默丢弃。
 */
export function dispatchClipboardPaste(content: ClipboardContent, context: PasteContext): ClipboardPasteAction {
  if (!context.board || context.modal) return { kind: "pass" };
  // 标记那条路与 #96 的事件分派是同一份判定（只读拒绝 / 内存剪贴板空了按失效处理）。
  if (hasMark(content)) return markerPaste(context);
  // 输入框里粘文本照旧：只有「没有文本」（纯图片或文件）时才轮到下面的分支。
  if (context.textFocus && content.text !== null) return { kind: "pass" };
  if (content.images.length > 0) return imagePaste(context);
  // 普通文本放行（画布上的文字仍能自己粘）。
  return content.kind === "text" ? { kind: "pass" } : noticeOf(content);
}

/** 剪贴板里是图片：只读拒绝，否则落成参考图。 */
function imagePaste(context: PasteContext): ClipboardPasteAction {
  return context.readOnly ? { kind: "refuse", reason: "readOnly" } : { kind: "importImages", at: context.at };
}

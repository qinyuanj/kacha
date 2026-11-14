// 粘贴落地的分派（#137）：从 ui/canvasPaste.ts 拆出的纯逻辑——一个分派结局该做什么，与事件、DOM 无关。
// 组件只按这里给出的指令接线（弹提示、落图、写画板）。
import type { ClipboardNotice, ClipboardPasteAction } from "../core/clipboardDispatch";
import type { Clip } from "../core/iterate";
import type { PasteAction, PasteRefusal } from "../core/pageInput";

/** 一个粘贴结局落到界面上的动作：吞掉 / 放行，以及要做的具体那一件事。 */
export type PasteEffect =
  | { kind: "pass" }
  | { kind: "toast"; text: string }
  | { kind: "importImages"; files: File[]; at: [number, number] }
  | { kind: "pasteNodes"; clip: Clip }
  // 分派判为粘节点、读剪贴板时却空了（防御分支）：吞掉但什么都不做。
  | { kind: "swallow" };

/**
 * 分派结局 → 落地动作：吞不吞、提示哪句话、落哪些图、粘哪份剪贴板。
 * 读剪贴板与文案都注入，便于单测；这里不碰 DOM。
 */
export function pasteEffect(
  action: PasteAction | ClipboardPasteAction,
  deps: {
    /** 落成参考图的文件：按分派结局的来源给出（快照或事件）。 */
    images: () => File[];
    /** 应用内剪贴板（节点标记那条路）。 */
    readClipboard: () => Clip | null;
    /** 拒绝原因 / 提示的文案。 */
    refuseText: (reason: PasteRefusal) => string;
    noticeText: (notice: ClipboardNotice) => string;
  },
): PasteEffect {
  if (action.kind === "pass") return { kind: "pass" };
  if (action.kind === "refuse") return { kind: "toast", text: deps.refuseText(action.reason) };
  if (action.kind === "notice") return { kind: "toast", text: deps.noticeText(action.notice) };
  if (action.kind === "importImages") {
    const files = deps.images();
    return files.length ? { kind: "importImages", files, at: action.at } : { kind: "swallow" };
  }
  // 含节点标记却内存剪贴板为空的分支已被分派拦下，这里必有内容。
  const clip = deps.readClipboard();
  return clip?.nodes.length ? { kind: "pasteNodes", clip } : { kind: "swallow" };
}

/** 落地动作的接线：界面把这几件事接上（弹提示、落图、写画板、错开剪贴板）。 */
export interface PasteSinks {
  toast: (message: string) => void;
  importPastedImages: (files: File[], at: { x: number; y: number }) => void;
  apply: (change: { kind: "paste"; clip: Clip }) => void;
  writeClipboard: (clip: Clip) => void;
}

/**
 * 把落地动作接到界面上：返回是否吞掉这次粘贴（放行时 false）。
 * 分支只在这里出现一次，组件那边只剩调用。
 */
export function applyPasteEffect(effect: PasteEffect, sinks: PasteSinks): boolean {
  if (effect.kind === "pass") return false;
  if (effect.kind === "toast") sinks.toast(effect.text);
  else if (effect.kind === "importImages") sinks.importPastedImages(effect.files, { x: effect.at[0], y: effect.at[1] });
  else if (effect.kind === "pasteNodes") {
    sinks.apply({ kind: "paste", clip: effect.clip });
    // 连续粘贴逐次错开。
    sinks.writeClipboard(effect.clip);
  }
  return true;
}

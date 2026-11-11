// 画板快捷键的挂载点：判定在 canvasKeyboard（纯逻辑），这里把 window 的 keydown 接上撤销 / 重做 / 复制。
// 粘贴不在这里：键盘事件里拦默认行为会连 paste 事件一起压掉，粘贴改由 canvasPaste 的页面级 paste 接管（#96）。
import { useEffect, type RefObject } from "react";
import type { Board } from "../core/board";
import { errorText } from "../core/errors";
import { copySelection } from "../core/iterate";
import { copyTarget, nodeMarker } from "../core/pageInput";
import { resolveFromRoot } from "../core/paths";
import { copyTextToClipboard } from "../shell/clipboard";
import { copyImageToClipboard } from "../shell/imageClipboard";
import { fileUrl, userRoot } from "../shell/ipc";
import { isEditableTarget } from "../shell/pageInput";
import { PASTE_TEXT } from "./boardText";
import { COPY_TEXT } from "./copyText";
import { shortcutCommand, writeClipboard, type ShortcutCommand } from "./canvasKeyboard";

interface Options {
  /** 画布根元素：还没挂上 / 已卸载时快捷键不作用（画板正在换掉的那一刻）。 */
  wrapper: RefObject<HTMLDivElement | null>;
  /** 当前画板：复制的来源。 */
  boardRef: RefObject<Board>;
  /** 选区的同步视图：Ctrl / ⌘+C 复制它。 */
  selectedRef: RefObject<ReadonlySet<string>>;
  /** 弹窗（预览、上下文菜单）开着时快捷键不作用于背后的画板。 */
  dialogOpen: RefObject<boolean>;
  onUndo: () => void;
  onRedo: () => void;
  toast: (message: string) => void;
}

/** 键盘事件 → 判定输入：preventDefault 交给判定按原时机调用。 */
function keyInputOf(e: KeyboardEvent) {
  return {
    key: e.key,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    preventDefault: () => e.preventDefault(),
  };
}

/** 判定上下文：焦点在不在输入区、画布是否还挂着、弹窗、选区大小。 */
function shortcutContextOf(e: KeyboardEvent, opts: Options) {
  const connected = !!opts.wrapper.current?.isConnected;
  return {
    editable: isEditableTarget(e.target),
    connected,
    dialogOpen: opts.dialogOpen.current,
    selectedCount: opts.selectedRef.current.size,
  };
}

/** 复制：Ctrl+C 的语义只看选区（#98）；单选图片写图，其它选区保持节点复制与标记（#96）。 */
function copyShortcut(e: KeyboardEvent, opts: Options): void {
  const board = opts.boardRef.current;
  const selected = [...opts.selectedRef.current];
  const target = copyTarget(board, selected);
  if (target.mode === "image") {
    // 立即拦掉原生复制，避免默认动作在异步解码完成后覆盖图片；不改画板，也不写节点标记或内存剪贴板。
    e.preventDefault();
    const src = fileUrl(resolveFromRoot(userRoot, target.node.path));
    void copyImageToClipboard(src)
      .then((failure) => {
        if (failure) opts.toast(COPY_TEXT.imageFailed(COPY_TEXT.imageReason[failure]));
      })
      .catch((error) => opts.toast(COPY_TEXT.imageFailed(errorText(error))));
    return;
  }
  const clip = copySelection(board, selected);
  writeClipboard(clip);
  if (!clip.nodes.length) return;
  // 先拦掉浏览器的原生复制：默认复制动作在本处理器之后才写剪贴板，会把刚写好的标记冲掉。
  e.preventDefault();
  // 同时向系统剪贴板写一段节点标记（#96）：Ctrl+V 靠它分辨该粘节点还是该落一张剪贴板里的图。
  // 写不进去时粘贴节点会失效，所以给一句话和一条可用的替代动作，而不是静默失败。
  void copyTextToClipboard(nodeMarker(clip.nodes.length)).catch(() => opts.toast(PASTE_TEXT.markerUnwritable));
}

/** 执行一条命令：撤销 / 重做交给画板会话；复制按目标写图片，或写应用内节点剪贴板与系统标记。 */
function runShortcut(cmd: ShortcutCommand, e: KeyboardEvent, opts: Options): void {
  if (cmd.kind === "undo") return opts.onUndo();
  if (cmd.kind === "redo") return opts.onRedo();
  copyShortcut(e, opts);
}

/**
 * 画布的键盘快捷键：Ctrl / ⌘+C 按选区复制图片，或记录节点到应用内剪贴板并写系统标记。
 * Ctrl / ⌘+Z 撤销，Ctrl / ⌘+Shift+Z、Ctrl / ⌘+Y 重做；文本框聚焦时交给原生撤销。
 * Ctrl / ⌘+V 不在这里处理：粘贴由页面级 paste 接管（见 canvasPaste）。
 */
export function useBoardKeyboard({ wrapper, boardRef, selectedRef, dialogOpen, onUndo, onRedo, toast }: Options): void {
  useEffect(() => {
    const opts: Options = { wrapper, boardRef, selectedRef, dialogOpen, onUndo, onRedo, toast };
    const onKey = (e: KeyboardEvent) => {
      const cmd = shortcutCommand(keyInputOf(e), shortcutContextOf(e, opts));
      if (cmd === null) return;
      runShortcut(cmd, e, opts);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onUndo, onRedo, toast, wrapper, boardRef, selectedRef, dialogOpen]);
}

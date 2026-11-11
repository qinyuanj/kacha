// 画板快捷键的挂载点：判定在 canvasKeyboard（纯逻辑），这里把 window 的 keydown 接上撤销 / 重做 / 复制。
// 粘贴不在这里：键盘事件里拦默认行为会连 paste 事件一起压掉，粘贴改由 canvasPaste 的页面级 paste 接管（#96）。
import { useEffect, type RefObject } from "react";
import type { Board } from "../core/board";
import { copySelection } from "../core/iterate";
import { nodeMarker } from "../core/pageInput";
import { copyTextToClipboard } from "../shell/clipboard";
import { isEditableTarget } from "../shell/pageInput";
import { PASTE_TEXT } from "./boardText";
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
  return {
    editable: isEditableTarget(e.target),
    connected: !!opts.wrapper.current?.isConnected,
    dialogOpen: opts.dialogOpen.current,
    selectedCount: opts.selectedRef.current.size,
  };
}

/** 复制选中节点：先存应用内剪贴板，再给系统剪贴板写节点标记（#96），拦不拦原生复制由实际结果决定。 */
function copyShortcut(e: KeyboardEvent, opts: Options): void {
  const clip = copySelection(opts.boardRef.current, [...opts.selectedRef.current]);
  writeClipboard(clip);
  if (!clip.nodes.length) return;
  // 先拦掉浏览器的原生复制：默认复制动作在本处理器之后才写剪贴板，会把刚写好的标记冲掉。
  e.preventDefault();
  // 同时向系统剪贴板写一段节点标记（#96）：Ctrl+V 靠它分辨该粘节点还是该落一张剪贴板里的图。
  // 写不进去时粘贴节点会失效，所以给一句话和一条可用的替代动作，而不是静默失败。
  void copyTextToClipboard(nodeMarker(clip.nodes.length)).catch(() => opts.toast(PASTE_TEXT.markerUnwritable));
}

/** 执行一条命令：撤销 / 重做交给画板会话，复制走应用内剪贴板与系统剪贴板标记。 */
function runShortcut(cmd: ShortcutCommand, e: KeyboardEvent, opts: Options): void {
  if (cmd.kind === "undo") return opts.onUndo();
  if (cmd.kind === "redo") return opts.onRedo();
  copyShortcut(e, opts);
}

/**
 * 画布的键盘快捷键：Ctrl / ⌘+C 复制选中节点（记录到应用内剪贴板，并给系统剪贴板写节点标记）。
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

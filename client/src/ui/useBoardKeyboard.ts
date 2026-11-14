// 画板快捷键的挂载点：判定在 canvasKeyboard（纯逻辑），这里把 window 的 keydown 接上撤销 / 重做 / 复制。
// 粘贴不在这里：键盘事件里拦默认行为会连 paste 事件一起压掉，粘贴改由 canvasPaste 的页面级 paste 接管（#96）。
import { useEffect, type RefObject } from "react";
import type { Board } from "../core/board";
import { errorText } from "../core/errors";
import { copySelection } from "../core/iterate";
import { nodeMarker } from "../core/pageInput";
import { resolveFromRoot } from "../core/paths";
import type { ShellPort } from "../shell/port";
import { PASTE_TEXT } from "./boardText";
import { copyOutcome } from "./copySelection";
import { imageCopyFailureText } from "./copyText";
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
  /** 壳端口：系统剪贴板读写与图片地址。 */
  port: ShellPort;
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
    editable: opts.port.ui.isEditableTarget(e.target),
    connected,
    dialogOpen: opts.dialogOpen.current,
    selectedCount: opts.selectedRef.current.size,
  };
}

/**
 * 复制图片（#130）：把这张图写进系统剪贴板。
 *
 * 立即拦掉原生复制，避免默认动作在异步写入完成后再覆盖一遍；失败只说一句话并指向「另存为…」，
 * 不改画板、不新增节点、不构成撤销步，也不碰应用内的节点剪贴板（ADR 0021 / 0023）。
 */
function copyImageShortcut(e: KeyboardEvent, path: string, format: string, opts: Options): void {
  e.preventDefault();
  const absPath = resolveFromRoot(opts.port.userRoot, path);
  void opts.port.media
    .copyImage(absPath, format)
    .then((result) => {
      if (!result.ok) opts.toast(imageCopyFailureText(result.reason));
    })
    .catch((error) => opts.toast(imageCopyFailureText(errorText(error))));
}

/** 复制节点：写应用内剪贴板与系统剪贴板里的节点标记（#96）。 */
function copyNodesShortcut(e: KeyboardEvent, opts: Options): void {
  const clip = copySelection(opts.boardRef.current, [...opts.selectedRef.current]);
  writeClipboard(clip);
  if (!clip.nodes.length) return;
  // 先拦掉浏览器的原生复制：默认复制动作在本处理器之后才写剪贴板，会把刚写好的标记冲掉。
  e.preventDefault();
  // 同时向系统剪贴板写一段节点标记（#96）：Ctrl+V 靠它分辨该粘节点还是该落一张剪贴板里的图。
  // 写不进去时粘贴节点会失效，所以给一句话和一条可用的替代动作，而不是静默失败。
  void opts.port.media.copyText(nodeMarker(clip.nodes.length)).catch(() => opts.toast(PASTE_TEXT.markerUnwritable));
}

/**
 * 复制：Ctrl+C 的语义只看选区（#98 / #130），判定在 copySelection（纯逻辑），这里只执行。
 *
 * 单选一张参考图或结果图 → 复制图片；其余选区 → 复制节点标记。两条路各写各的：
 * 复制图片不写标记，复制节点不写图片，粘贴时不会互相误判（ADR 0021）。
 */
function copyShortcut(e: KeyboardEvent, opts: Options): void {
  const outcome = copyOutcome(opts.boardRef.current, [...opts.selectedRef.current]);
  if (outcome.kind === "nothing") return;
  if (outcome.kind === "image") return copyImageShortcut(e, outcome.path, outcome.format, opts);
  copyNodesShortcut(e, opts);
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
export function useBoardKeyboard({ wrapper, boardRef, selectedRef, dialogOpen, onUndo, onRedo, toast, port }: Options): void {
  useEffect(() => {
    const opts: Options = { wrapper, boardRef, selectedRef, dialogOpen, onUndo, onRedo, toast, port };
    const onKey = (e: KeyboardEvent) => {
      const cmd = shortcutCommand(keyInputOf(e), shortcutContextOf(e, opts));
      if (cmd === null) return;
      runShortcut(cmd, e, opts);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onUndo, onRedo, toast, wrapper, boardRef, selectedRef, dialogOpen, port]);
}

// 页面级粘贴接管（#96 / #129）：分派是纯逻辑（core/clipboardDispatch 与 core/pageInput），
// 这里只做事件读数、粘贴落点与画板写入。
// 监听挂在 window 上而不是画布元素：焦点在工具栏、标签栏时粘贴也落图；没有画板时画布不挂载，登录页粘贴不受影响。
// 判定与落点在 ui/canvasPasteFacts.ts，落地动作在 ui/canvasPasteApply.ts（#137），这里只留事件读数与接线。
import { useEffect, useRef, type RefObject } from "react";
import type { BoardChange } from "../core/edit";
import type { ClipboardContent } from "../core/clipboardDispatch";
import type { PasteContext } from "../core/pageInput";
import { clipboardNoticeText, pasteRefusalText, PASTE_TEXT } from "./boardText";
import { nextPasteClip, readClipboard, writeClipboard } from "./canvasKeyboard";
import { applyPasteEffect, pasteEffect, type PasteSinks } from "./canvasPasteApply";
import { decideClipboardPaste, pastePosition } from "./canvasPasteFacts";

interface Options {
  /** 画布根元素：粘贴落点跟着它上面的指针位置。 */
  wrapper: RefObject<HTMLDivElement | null>;
  /** 预览 / 上下文菜单开着时粘贴不作用于背后的画板（与键盘快捷键同一份判定）。 */
  dialogOpen: RefObject<boolean>;
  /** 别的模态（对话框、设置面板等）开着。 */
  modalOpen: boolean;
  /** 归档只读画板：粘图只提示、粘节点只拒绝。 */
  readOnly: boolean;
  /** 窗口坐标 → 画布坐标（React Flow 的 screenToFlowPosition）。 */
  screenToFlowPosition: (client: { x: number; y: number }) => { x: number; y: number };
  /** 视口中央的画布坐标：指针从没进过画布时粘贴落在这里。 */
  centerPosition: () => { x: number; y: number };
  /** 画板写入的唯一入口（见 core/edit）。 */
  apply: (change: BoardChange) => void;
  toast: (message: string) => void;
  /** 粘贴进来的图片落成参考图节点（超限过滤、显示名与落盘见 canvasDrop.importPastedImages）。 */
  importPastedImages: (files: File[], at: { x: number; y: number }) => void;
  /** 焦点 / 点击是否落在可编辑控件里（端口：桌面壳按自己的 DOM 判定）。 */
  isEditableTarget: (target: EventTarget | null) => boolean;
  /** 读系统剪贴板（端口）：桌面壳直接读取原生快照，读不到时明确提示。 */
  readClipboard: () => Promise<ClipboardContent | null>;
}

/** 页面级粘贴：剪贴板里是本应用的节点标记就粘节点，是图片就落成参考图，其余（文本、读不到的文件）放行或提示。 */
export function useCanvasPaste({
  wrapper,
  dialogOpen,
  modalOpen,
  readOnly,
  screenToFlowPosition,
  centerPosition,
  apply,
  toast,
  importPastedImages,
  isEditableTarget,
  readClipboard: readClipboardPort,
}: Options): void {
  // 粘贴落点跟着鼠标：记下最后在画布内的位置（没有则取视口中心）。
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  // 坐标换算只在粘贴那一刻用（不必随它重挂监听）：调用方常写成箭头包装，每次渲染都是新函数，经 ref 取最新一版。
  const positionOf = useRef(screenToFlowPosition);
  positionOf.current = screenToFlowPosition;
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const move = (e: PointerEvent) => {
      lastPointer.current = { x: e.clientX, y: e.clientY };
    };
    el.addEventListener("pointermove", move);
    return () => el.removeEventListener("pointermove", move);
  }, [wrapper]);

  useEffect(() => {
    /** 落地动作接到的界面能力：提示、落图、写画板、错开剪贴板。 */
    const sinks: PasteSinks = {
      toast,
      importPastedImages,
      apply,
      writeClipboard: (clip) => writeClipboard(nextPasteClip(clip)),
    };
    /** 分派时要看的界面状态（与 #96 同一份）。 */
    const context = (at: [number, number]): PasteContext => ({
      // board 恒为 true：画布只在有画板时挂载，「没有画板就放行」由登录页 / 空工作台不挂载兑现。
      board: true,
      readOnly,
      modal: modalOpen || dialogOpen.current,
      textFocus: isEditableTarget(document.activeElement),
      hasNodeClip: (readClipboard()?.nodes.length ?? 0) > 0,
      at,
    });
    /** 落点：最后一次指针位置换算成画布坐标，没进过画布就取视口中央。 */
    const landing = () =>
      pastePosition({
        pointer: lastPointer.current,
        center: centerPosition,
        toFlow: (client) => positionOf.current(client),
      });
    /** 分派结局 → 落地动作 → 接上界面；返回是否吞掉这次粘贴。 */
    const run = (action: Parameters<typeof pasteEffect>[0], images: () => File[]): boolean =>
      applyPasteEffect(pasteEffect(action, { images, readClipboard, refuseText: pasteRefusalText, noticeText: clipboardNoticeText }), sinks);

    /** 桌面壳的路：系统剪贴板要经 Go 读，是异步的（等主线程）。 */
    const pasteFromNative = () => {
      const at = landing();
      void (async () => {
        const snapshot = await readClipboardPort().catch(() => null);
        if (!snapshot) { toast(PASTE_TEXT.unavailable); return; }
        const action = decideClipboardPaste(snapshot, context(at));
        run(action, () => snapshot.images);
      })();
    };

    const onPaste = (event: ClipboardEvent) => {
      if (modalOpen || dialogOpen.current) return;
      // 输入框里的文本粘贴完全交给浏览器：不读快照、不吞，文本照旧落进输入框。
      // （剪贴板里没有文本时仍走下面的原生读法：粘截图进画板与焦点在不在输入框无关。）
      if (isEditableTarget(document.activeElement) && (event.clipboardData?.getData("text/plain") ?? "") !== "") return;
      // 原生读取是异步的，必须在事件返回前阻止 WebView 的默认粘贴。
      event.preventDefault();
      pasteFromNative();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [apply, centerPosition, dialogOpen, importPastedImages, isEditableTarget, modalOpen, readClipboardPort, readOnly, toast]);
}

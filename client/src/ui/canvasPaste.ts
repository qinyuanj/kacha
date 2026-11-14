// 页面级粘贴接管（#96）：分派是纯逻辑（core/pageInput 的 dispatchPaste），这里只做事件读数、粘贴落点与画板写入。
// 监听挂在 window 上而不是画布元素：焦点在工具栏、标签栏时粘贴也落图；没有画板时画布不挂载，登录页粘贴不受影响。
// 判定与落点在 ui/canvasPasteFacts.ts（#137），这里只留事件读数与接线。
import { useEffect, useRef, type RefObject } from "react";
import type { BoardChange } from "../core/edit";
import type { ClipboardSnapshot } from "../shell/port";
import { pasteRefusalText } from "./boardText";
import { isImageFile } from "./canvasDrop";
import { nextPasteClip, readClipboard, writeClipboard } from "./canvasKeyboard";
import { decidePaste, pastePosition, pastedFacts } from "./canvasPasteFacts";

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
  /** 读系统剪贴板（端口）：桌面壳能直接读，Web 返回 null，改用 paste 事件带的内容。 */
  readClipboard: () => ClipboardSnapshot | null;
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
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      // 桌面壳直接读系统剪贴板（Web 读不到，返回 null）：有快照就以它为准，没有再用 paste 事件带的内容。
      const snapshot = readClipboardPort();
      const files = snapshot ? snapshot.images : [...(data?.files ?? [])];
      const facts = pastedFacts(snapshot, files, data?.getData("text/plain") || null, isImageFile);
      const at = pastePosition({
        pointer: lastPointer.current,
        center: centerPosition,
        toFlow: (client) => positionOf.current(client),
      });
      const action = decidePaste(facts, {
        readOnly,
        modal: modalOpen || dialogOpen.current,
        textFocus: isEditableTarget(document.activeElement),
        hasNodeClip: (readClipboard()?.nodes.length ?? 0) > 0,
        at,
      });
      if (action.kind === "pass") return;
      // 落到这一步都是本应用要处理 / 要拒绝的粘贴：吞掉，免得浏览器再往别处塞一份。
      event.preventDefault();
      if (action.kind === "refuse") return toast(pasteRefusalText(action.reason));
      if (action.kind === "importImages") {
        const images = files.filter((f) => isImageFile(f) && f.size > 0);
        return void importPastedImages(images, { x: action.at[0], y: action.at[1] });
      }
      // 含节点标记却内存剪贴板为空的分支已被分派拦下，这里必有内容。
      const clip = readClipboard();
      if (!clip?.nodes.length) return;
      apply({ kind: "paste", clip });
      // 连续粘贴逐次错开。
      writeClipboard(nextPasteClip(clip));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [apply, centerPosition, dialogOpen, importPastedImages, isEditableTarget, modalOpen, readClipboardPort, readOnly, toast]);
}

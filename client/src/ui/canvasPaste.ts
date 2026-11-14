// 页面级粘贴接管（#96 / #129）：分派是纯逻辑（core/clipboardDispatch 与 core/pageInput），
// 这里只做事件读数、粘贴落点与画板写入。
// 监听挂在 window 上而不是画布元素：焦点在工具栏、标签栏时粘贴也落图；没有画板时画布不挂载，登录页粘贴不受影响。
import { useEffect, useRef, type RefObject } from "react";
import type { BoardChange } from "../core/edit";
import { dispatchClipboardPaste, type ClipboardContent } from "../core/clipboardDispatch";
import { dispatchPaste, type PasteContext, type PasteFacts } from "../core/pageInput";
import { clipboardNoticeText, pasteRefusalText } from "./boardText";
import { isImageFile } from "./canvasDrop";
import { nextPasteClip, readClipboard, writeClipboard } from "./canvasKeyboard";
import { posOf } from "./canvasPoint";

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
  /** 读系统剪贴板（端口）：桌面壳直接读，Web 返回 null，改用 paste 事件带的内容。 */
  readClipboard: () => Promise<ClipboardContent | null>;
  /**
   * 这一端能不能直接读系统剪贴板（端口的 features.nativeClipboard）。
   * 能读就先吞掉默认行为再等快照；不能读（Web）仍按 paste 事件同步分派，行为与 #96 完全一致。
   */
  nativeClipboard: boolean;
}

/** paste 事件里带的剪贴板内容（Web 的路：页面读不到系统剪贴板，只能看事件）。 */
function factsOfEvent(data: DataTransfer | null): { facts: PasteFacts; images: File[] } {
  const files = [...(data?.files ?? [])];
  // 读得到内容才算图片；资源管理器里复制的文件只有名字没有内容，归到 opaqueFiles 里提示改为拖入。
  const images = files.filter((f) => isImageFile(f) && f.size > 0);
  return { facts: { text: data?.getData("text/plain") || null, images: images.length, opaqueFiles: files.length - images.length }, images };
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
  nativeClipboard,
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
    const landing = () => posOf(lastPointer.current ? positionOf.current(lastPointer.current) : centerPosition());
    /** 落到这一步都是本应用要处理 / 要拒绝的粘贴：吞掉，免得浏览器再往别处塞一份。 */
    const handle = (action: ReturnType<typeof dispatchPaste> | ReturnType<typeof dispatchClipboardPaste>, images: () => File[]) => {
      if (action.kind === "pass") return false;
      if (action.kind === "refuse") toast(pasteRefusalText(action.reason));
      else if (action.kind === "notice") toast(clipboardNoticeText(action.notice));
      else if (action.kind === "importImages") {
        const files = images();
        if (!files.length) return true;
        void importPastedImages(files, { x: action.at[0], y: action.at[1] });
      } else {
        // 含节点标记却内存剪贴板为空的分支已被分派拦下，这里必有内容。
        const clip = readClipboard();
        if (!clip?.nodes.length) return true;
        apply({ kind: "paste", clip });
        // 连续粘贴逐次错开。
        writeClipboard(nextPasteClip(clip));
      }
      return true;
    };

    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      const at = landing();
      if (!nativeClipboard) {
        // Web：内容只能从 paste 事件里读，同步分派，放行时一点都不拦（输入框、页面文字照旧）。
        const { facts, images } = factsOfEvent(data);
        const action = dispatchPaste(facts, context(at));
        if (action.kind !== "pass") event.preventDefault();
        handle(action, () => images);
        return;
      }
      // 桌面壳：系统剪贴板要经 Go 读，是异步的（等主线程）。先吞掉默认行为再等快照，
      // 否则同一个 Ctrl+V 会既落一份到页面、又落一份到画板。
      event.preventDefault();
      void (async () => {
        const snapshot = await readClipboardPort().catch(() => null);
        // 读不到快照（桥里没有剪贴板）就退回 paste 事件带的内容，与 Web 同一套语义。
        if (!snapshot) {
          const { facts, images } = factsOfEvent(data);
          handle(dispatchPaste(facts, context(at)), () => images);
          return;
        }
        handle(dispatchClipboardPaste(snapshot, context(at)), () => snapshot.images);
      })();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [apply, centerPosition, dialogOpen, importPastedImages, isEditableTarget, modalOpen, nativeClipboard, readClipboardPort, readOnly, toast]);
}

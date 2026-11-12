// 页面级粘贴接管（#96）：分派是纯逻辑（core/pageInput 的 dispatchPaste），这里只做事件读数、粘贴落点与画板写入。
// 监听挂在 window 上而不是画布元素：焦点在工具栏、标签栏时粘贴也落图；没有画板时画布不挂载，登录页粘贴不受影响。
// #114：文件列表、图片条目与内嵌图片 data URL 都汇成同一份图片集合，远程地址只用来给原因、绝不主动去抓。
import { useEffect, useRef, type RefObject } from "react";
import type { BoardChange } from "../core/edit";
import { dispatchPaste, hasFailures, type PasteAction, type PasteContext, type PasteFacts, type PasteFailures } from "../core/pageInput";
import { isEditableTarget } from "../shell/pageInput";
import { pasteImageFailureText, pasteRefusalText } from "./boardText";
import { clipboardImageFiles, decodeClipboardDataUrls, normalizeClipboardImages, uniqueClipboardImages, type ClipboardImage } from "./clipboardImages";
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
}

/** 一次粘贴读出来的东西：分派要的事实，以及执行「落图」还要用的原始图片。 */
interface PasteRead {
  facts: PasteFacts;
  /** 解码后带真实字节的图片（还没按内容去重）。 */
  decoded: readonly ClipboardImage[];
  failures: PasteFailures;
}

/** 执行一次粘贴需要的界面能力：分派之外的动作都在这里。 */
interface PasteDeps {
  apply: (change: BoardChange) => void;
  toast: (message: string) => void;
  importPastedImages: Options["importPastedImages"];
}

/** 读剪贴板：文件列表、图片条目与内嵌 data URL 汇成一份图片集合，data URL 就地解成真实字节。 */
function readPaste(data: DataTransfer | null): PasteRead {
  const text = data?.getData("text/plain") || null;
  const normalized = normalizeClipboardImages({
    files: data?.files ?? null,
    items: data?.items ?? null,
    text,
    html: data?.getData("text/html") || null,
    uri: data?.getData("text/uri-list") || null,
  });
  // 内嵌 data URL 在这一步解成真实字节：解不开的分类计数，同批其它图片照旧能进链路。
  const decoded = decodeClipboardDataUrls(normalized.images);
  const files = clipboardImageFiles(decoded.images);
  return {
    facts: { text, images: files.length, opaqueFiles: normalized.opaqueFiles, content: normalized.content, remote: normalized.remote, failures: decoded.failures },
    decoded: decoded.images,
    failures: decoded.failures,
  };
}

/**
 * 落图：先把同一张图经两条途径暴露的那份去掉，再交给既有的导入链路。
 * 去重要读字节比较内容，只能在同步拦下默认行为之后做；只有一张图时没有可比的候选，不必为它引入异步等待。
 */
async function importReadImages(read: PasteRead, action: Extract<PasteAction, { kind: "importImages" }>, deps: PasteDeps): Promise<void> {
  // 混合内容里只要有可读图片就导入：解不开的那几张单独说明，不影响其余图片落盘。
  if (hasFailures(read.failures)) deps.toast(pasteImageFailureText(read.failures));
  const unique = read.facts.images > 1 ? await uniqueClipboardImages(read.decoded) : read.decoded;
  const files = clipboardImageFiles(unique);
  if (files.length) deps.importPastedImages(files, { x: action.at[0], y: action.at[1] });
}

/** 粘节点：应用内剪贴板里的快照落到画板上，再把剪贴板逐次错开（连续粘贴不会叠在同一处）。 */
function pasteNodes(deps: PasteDeps): void {
  // 含节点标记却内存剪贴板为空的分支已被分派拦下，这里必有内容。
  const clip = readClipboard();
  if (!clip?.nodes.length) return;
  deps.apply({ kind: "paste", clip });
  writeClipboard(nextPasteClip(clip));
}

/** 分派结果的执行：拒绝时给原因，落图时导入，粘节点时还原节点。 */
function runAction(action: PasteAction, read: PasteRead, deps: PasteDeps): void | Promise<void> {
  if (action.kind === "refuse") {
    // 解码失败的原因逐类说明（不带任何来源地址）；其它拒绝原因各有固定文案。
    return deps.toast(action.reason === "imageFailed" ? pasteImageFailureText(read.failures) : pasteRefusalText(action.reason));
  }
  if (action.kind === "importImages") return importReadImages(read, action, deps);
  return pasteNodes(deps);
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
}: Options): void {
  // 粘贴落点跟着鼠标：记下最后在画布内的位置（没有则取视口中央）。
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
    /** 分派上下文：落点跟着最后一次指针位置，没进过画布就取视口中央。 */
    const contextOf = (at: PasteContext["at"]): PasteContext => ({
      // board 恒为 true：画布只在有画板时挂载，「没有画板就放行」由登录页 / 空工作台不挂载兑现。
      board: true,
      readOnly,
      modal: modalOpen || dialogOpen.current,
      textFocus: isEditableTarget(document.activeElement),
      hasNodeClip: (readClipboard()?.nodes.length ?? 0) > 0,
      at,
    });
    const onPaste = async (event: ClipboardEvent) => {
      const read = readPaste(event.clipboardData);
      const at = posOf(lastPointer.current ? positionOf.current(lastPointer.current) : centerPosition());
      const action = dispatchPaste(read.facts, contextOf(at));
      if (action.kind === "pass") return;
      // 落到这一步都是本应用要处理 / 要拒绝的粘贴：吞掉，免得浏览器再往别处塞一份。
      // 必须在这个同步阶段拦：后面的去重要读字节，是异步的，拦晚了浏览器已经按默认行为处理了。
      event.preventDefault();
      await runAction(action, read, { apply, toast, importPastedImages });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [apply, centerPosition, dialogOpen, importPastedImages, modalOpen, readOnly, toast]);
}

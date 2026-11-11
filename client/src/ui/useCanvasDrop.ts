// 画布上的 HTML5 拖放挂载点：dragover 拦下浏览器默认接管，drop 在捕获阶段先接（#97 的承重行为）。
// 只认图片：按松手处的落点挂到任务卡片左侧或就地新建参考图节点；过滤、导入与落盘在 canvasDrop。
import { useEffect, useRef, type RefObject } from "react";
import type { Board } from "../core/board";
import type { BoardChange } from "../core/edit";
import { blocksFileDrag } from "../core/pageInput";
import { ipc, transfer } from "../shell/ipc";
import { ARCHIVE_TEXT, IMPORT_TEXT } from "./boardText";
import { addImportedReferences, dropAttachOf, imageFilesOf, importImages, type ImagePorts } from "./canvasDrop";
import { dropTargetAt } from "./canvasPoint";
import { primeImageInfo } from "./context";

/** 生产用的图片导入端口：壳层的上传与元信息读取，加上画布的图片信息缓存。 */
export const imageImportPorts: ImagePorts = {
  upload: (file) => transfer.uploadReference(file),
  inspect: (absPath) => ipc.inspectImage(absPath),
  prime: primeImageInfo,
};

interface Options {
  /** 画布根元素：拖放监听挂在它上面。 */
  wrapper: RefObject<HTMLDivElement | null>;
  /** 当前画板：落点命中任务卡片时取节点类型。 */
  boardRef: RefObject<Board>;
  /** 窗口坐标 → 画布坐标（React Flow 的 screenToFlowPosition）。 */
  screenToFlowPosition: (client: { x: number; y: number }) => { x: number; y: number };
  /** 画板写入的唯一入口（见 core/edit）：只读画板由它拒绝，这里先给只读提示。 */
  apply: (change: BoardChange) => void;
  toast: (message: string) => void;
  /** 用户数据根：本机图片上传后按它拼绝对路径。 */
  userRoot: string;
  /** 归档画板：拖进来的图片不导入，只提示只读。 */
  readOnly: boolean;
}

/** 画布上的拖放：dragover 让浏览器别接管文件拖拽，drop 在捕获阶段接并阻断冒泡。 */
export function useCanvasDrop({ wrapper, boardRef, screenToFlowPosition, apply, toast, userRoot, readOnly }: Options): void {
  // 坐标换算只在松手那一刻用（不必随它重挂监听）：调用方常写成箭头包装，每次渲染都是新函数，经 ref 取最新一版。
  const positionOf = useRef(screenToFlowPosition);
  positionOf.current = screenToFlowPosition;
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const over = (e: DragEvent) => {
      if (blocksFileDrag(e.dataTransfer)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      if (readOnly) return toast(ARCHIVE_TEXT.readOnly);
      const at = positionOf.current({ x: e.clientX, y: e.clientY });
      const files = imageFilesOf(e.dataTransfer.files);
      if (!files.length) return toast(IMPORT_TEXT.imageOnly);
      // 落点按松手这一刻算（elementFromPoint 随 DOM 变化），上传是异步的。
      const attach = dropAttachOf(dropTargetAt({ x: e.clientX, y: e.clientY }), boardRef.current);
      void importImages(files, { userRoot, toast, ports: imageImportPorts }).then((images) => addImportedReferences(images, at, attach, apply));
    };
    el.addEventListener("dragover", over);
    // 捕获阶段接 drop：先于页面级接管（shell/pageInput）跑并阻断冒泡，拖进画板的图片仍落成参考图节点。
    el.addEventListener("drop", drop, true);
    return () => {
      el.removeEventListener("dragover", over);
      el.removeEventListener("drop", drop, true);
    };
  }, [apply, boardRef, readOnly, toast, userRoot, wrapper]);
}

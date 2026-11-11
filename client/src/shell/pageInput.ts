// 页面输入接管（#97）的唯一挂载点：判定在 core/pageInput（纯逻辑），这里只接线——
// 命中的事件调 preventDefault 吞掉浏览器默认行为，不弹提示、不改画板内容，与画板是否只读无关。
import { blocksFileDrag, blocksKey, blocksMouseButton } from "../core/pageInput";

/** 可编辑控件：输入框、文本域、下拉、内容可编辑（点在其子孙节点上也算）。 */
const EDITABLE = "input, textarea, select, [contenteditable='true']";

/** 焦点或点击是否落在可编辑控件里：方向键与编辑类快捷键的原生语义留给它们自己。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE) !== null;
}

/**
 * 装上页面级输入接管，返回卸载函数。监听挂在 window 上：登录页、各类弹窗、归档画板一并生效。
 *
 * 拖文件到画布以外时浏览器会打开那个文件、把应用顶掉，所以这里一律拦下；画布上的落图由 BoardCanvas
 * 在捕获阶段先行处理并阻断冒泡，仍落成参考图节点。滚轮与捏合一概不碰：画布以外的 Ctrl+滚轮是页面
 * 唯一剩下的缩放途径，当作无障碍逃生口留着。
 */
export function installPageInputTakeover(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (blocksKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, editable: isEditableTarget(e.target) })) {
      e.preventDefault();
    }
  };
  // dragover 与 drop 都要拦：只拦 drop 的话浏览器仍然接管这次拖拽。
  const blockFileDrag = (e: DragEvent) => {
    if (blocksFileDrag(e.dataTransfer)) e.preventDefault();
  };
  const onMouseDown = (e: MouseEvent) => {
    if (blocksMouseButton("down", e.button)) e.preventDefault();
  };
  // 侧键后退 / 前进只有拦 up 才有效（见 core/pageInput）。
  const onMouseUp = (e: MouseEvent) => {
    if (blocksMouseButton("up", e.button)) e.preventDefault();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("dragover", blockFileDrag);
  window.addEventListener("drop", blockFileDrag);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("dragover", blockFileDrag);
    window.removeEventListener("drop", blockFileDrag);
    window.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mouseup", onMouseUp);
  };
}

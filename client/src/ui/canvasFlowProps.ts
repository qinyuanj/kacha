// 画布交给 <ReactFlow> 的固定配置与视图切换动画时长：框选 / 平移 / 缩放 / 删除键全在这里，
// BoardCanvas 只把它展开到 <ReactFlow> 上（画布键位语义见 useCanvasInteraction）。
import { SelectionMode, type ReactFlowProps } from "@xyflow/react";

/** 视图切换的动画时长（ms）：适应画布、实际大小、缩放快捷键共用。 */
export const ZOOM_DURATION_MS = 200;

/** React Flow 的固定配置：取值与注释逐字照搬拆分前的 flowProps。 */
export const canvasFlowProps: Partial<ReactFlowProps> = {
  selectionOnDrag: true,
  selectionMode: SelectionMode.Partial,
  // Shift 用于加选；框选靠左键拖空白，不另设框选键（按住框选键时 React Flow 在节点上也起框，Shift + 点节点会变成框选）。
  selectionKeyCode: null,
  multiSelectionKeyCode: "Shift",
  // 右键 / 中键拖平移。右键没拖动时 React Flow 在松手时才触发空白处上下文菜单，拖动过则不弹。
  panOnDrag: [1, 2],
  panActivationKeyCode: "Space",
  zoomOnScroll: true,
  zoomOnPinch: true,
  zoomOnDoubleClick: false,
  deleteKeyCode: ["Delete", "Backspace"],
  // 方向键微移由 useCanvasInteraction 处理（1 / 10px）；关掉 React Flow 自带的键盘移动（5px）。
  disableKeyboardA11y: true,
};

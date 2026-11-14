// 预览弹窗的拖拽接线（#137）：从 ui/PreviewDialog.tsx 拆出的模块级函数，便于单测。
import type { Point01, Rect01 } from "./rects";
import { beginDrag, endDrag, pointInStage, startEditState, type PreviewEditState } from "./previewState";
import type { Drag } from "./previewRegion";
import type { RegionTarget } from "./PreviewDialog";

/** 舞台上的坐标换算。 */
export function pointAt(stage: { current: HTMLImageElement | null }, e: { clientX: number; clientY: number }): Point01 {
  const box = stage.current!.getBoundingClientRect();
  return pointInStage(box, e);
}

/** 按下：开始画框或拖动已有框。 */
export function startDragAt(state: PreviewEditState, target: EventTarget | null, at: Point01): { selected: number | null; drag: Drag } {
  return beginDrag(state, target, at);
}

/** 拖动时的当前点。 */
export function dragPoint(drag: Drag, at: Point01): Drag {
  return { ...drag, current: at };
}

/** 松手：把拖动结果落到矩形上。 */
export function rectsAfter(drag: Drag, rects: Rect01[], at: Point01): Rect01[] {
  let next = rects;
  endDrag({ editing: null, regionMode: "overlay", rects, selected: null, drag }, at, (r) => {
    next = r;
  });
  return next;
}

/** 进入编辑另一个目标：区域、表达方式与选中态都换过去。 */
export function editStateOf(target: RegionTarget): { editing: RegionTarget | null; regionMode: PreviewEditState["regionMode"]; rects: Rect01[]; selected: number | null } {
  const next = startEditState(target);
  return { editing: next.editing, regionMode: next.regionMode, rects: next.rects, selected: next.selected };
}
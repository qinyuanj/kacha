// 放大预览弹窗的区域编辑判定（#137）：从 ui/PreviewDialog.tsx 拆出的纯逻辑，便于单测。
import type { Point01, Rect01 } from "./rects";
import { dragRect, isMeaningful, moveRect, resizeRect, type Corner } from "./rects";
import { MAX_REGIONS } from "../core/overlay";

/** 拖拽的种类：画新框、移动已有框、拖角柄缩放。 */
export type Drag =
  | { kind: "draw"; start: Point01; current: Point01 }
  | { kind: "move"; index: number; start: Point01; origin: Rect01; current: Point01 }
  | { kind: "resize"; index: number; corner: Corner; origin: Rect01; current: Point01 };

/** 按下时命中了哪个手柄：矩形编号与角柄；都没命中为 null（画新框）。 */
export interface DragHandle {
  index: number;
  corner?: Corner;
}

/** 起点按在哪儿：已有矩形的角柄、已有矩形本身、还是空白。 */
export function dragHandleOf(target: EventTarget | null): DragHandle | null {
  const handle = target instanceof Element ? target.closest<HTMLElement>("[data-rect-index]") : null;
  if (!handle) return null;
  const index = Number(handle.dataset.rectIndex);
  const corner = handle.dataset.corner as Corner | undefined;
  return corner ? { index, corner } : { index };
}

/** 按下之后开始哪种拖拽。 */
export function startDrag(handle: DragHandle | null, rects: readonly Rect01[], at: Point01): Drag {
  if (handle && handle.corner) return { kind: "resize", index: handle.index, corner: handle.corner, origin: rects[handle.index], current: at };
  if (handle) return { kind: "move", index: handle.index, start: at, origin: rects[handle.index], current: at };
  return { kind: "draw", start: at, current: at };
}

/** 松手之后区域列表变成什么样：画新框、移动、缩放。 */
export function rectsAfterDrag(drag: Drag, rects: readonly Rect01[], at: Point01): Rect01[] {
  if (drag.kind === "draw") {
    const drawn = dragRect(drag.start, at);
    return isMeaningful(drawn) ? [...rects, drawn] : [...rects];
  }
  if (drag.kind === "move") {
    const moved = moveRect(drag.origin, at.x - drag.start.x, at.y - drag.start.y);
    return rects.map((r, i) => (i === drag.index ? moved : r));
  }
  const resized = resizeRect(drag.origin, drag.corner, at);
  return rects.map((r, i) => (i === drag.index ? resized : r));
}

/** 拖拽中显示的区域：正在动的那个跟着指针走，其余不动。 */
export function shownRects(drag: Drag | null, rects: readonly Rect01[]): Rect01[] {
  const shown = rects.map((r, i) => {
    if (drag?.kind === "move" && drag.index === i) return moveRect(drag.origin, drag.current.x - drag.start.x, drag.current.y - drag.start.y);
    if (drag?.kind === "resize" && drag.index === i) return resizeRect(drag.origin, drag.corner, drag.current);
    return r;
  });
  if (drag?.kind === "draw") shown.push(dragRect(drag.start, drag.current));
  return shown;
}

/** 区域表达方式：overlay（高亮叠加）、bbox（坐标框）、point（坐标点）。 */
export type RegionMode = "overlay" | "bbox" | "point";

/** 打开即编辑某个目标时，区域表达方式是什么。 */
export function regionModeOf(target: { render: string; coordinateKind?: "point" | "bbox" }): RegionMode {
  return target.render === "bbox_tag" ? target.coordinateKind ?? "bbox" : "overlay";
}

/** 保存到画板的区域设置：没有区域为 null（清空这条连线的区域）。 */
export function regionSetting(rects: readonly Rect01[], mode: RegionMode): { rects: Rect01[]; render: "highlight_overlay" | "bbox_tag"; coordinate_kind?: "point" | "bbox" } | null {
  if (!rects.length) return null;
  return mode === "overlay" ? { rects: [...rects], render: "highlight_overlay" } : { rects: [...rects], render: "bbox_tag", coordinate_kind: mode };
}

/** 区域数量超限：提示里标出来（任务最多 MAX_REGIONS 个区域）。 */
export function overRegionLimit(count: number): boolean {
  return count > MAX_REGIONS;
}

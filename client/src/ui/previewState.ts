// 放大预览弹窗的状态（#137）：从 ui/PreviewDialog.tsx 拆出的模块级函数，便于单测。
import { toggled } from "../core/collections";
import type { Point01, Rect01 } from "./rects";
import { dragHandleOf, rectsAfterDrag, regionSetting, startDrag, type Drag } from "./previewRegion";
import type { RegionTarget } from "./PreviewDialog";

/** 预览弹窗的编辑状态。 */
export interface PreviewEditState {
  editing: RegionTarget | null;
  regionMode: "overlay" | "bbox" | "point";
  rects: Rect01[];
  selected: number | null;
  drag: Drag | null;
}

/** 打开即进入某个目标的编辑：区域、表达方式与选中态。 */
export function startEditState(target: RegionTarget): PreviewEditState {
  return {
    editing: target,
    regionMode: target.render === "bbox_tag" ? target.coordinateKind ?? "bbox" : "overlay",
    rects: target.rects.map((r) => [...r] as Rect01),
    selected: null,
    drag: null,
  };
}

/** 按下时开始拖拽：命中手柄就动那个矩形，否则画新框。 */
export function beginDrag(state: PreviewEditState, target: EventTarget | null, at: Point01): { selected: number | null; drag: Drag } {
  const handle = dragHandleOf(target);
  const selected = handle ? handle.index : null;
  return { selected, drag: startDrag(handle, state.rects, at) };
}

/** 松手之后区域列表变成什么样。 */
export function endDrag(state: PreviewEditState, at: Point01, apply: (next: Rect01[]) => void): void {
  const drag = state.drag;
  if (!drag) return;
  apply(rectsAfterDrag(drag, state.rects, at));
}



/** 指针位置：相对底图的归一化坐标（钳在 0–1）。 */
export function pointInStage(box: { left: number; top: number; width: number; height: number }, client: { clientX: number; clientY: number }): Point01 {
  return {
    x: Math.min(1, Math.max(0, (client.clientX - box.left) / box.width)),
    y: Math.min(1, Math.max(0, (client.clientY - box.top) / box.height)),
  };
}

/** 勾选的图层集合：点一下加上，再点一下去掉。 */
export const toggleChecked = (checked: ReadonlySet<number>, index: number): Set<number> => toggled(checked, index);

/** 单层显示：点同一张再点取消。 */
export const toggleSolo = (solo: number | null, index: number): number | null => (solo === index ? null : index);

/** 删除选中的区域。 */
export function removeSelected(rects: Rect01[], selected: number | null): Rect01[] {
  if (selected === null) return rects;
  return rects.filter((_, i) => i !== selected);
}

/** 清空区域。 */
export const clearRects = (): Rect01[] => [];

/** 保存区域时要写进画板的形状。 */
export function regionChange(edge: RegionTarget["edgeRef"], rects: Rect01[], mode: "overlay" | "bbox" | "point"): { kind: "setRegion"; edge: RegionTarget["edgeRef"]; region: { rects: Rect01[]; render: "highlight_overlay" | "bbox_tag"; coordinate_kind?: "point" | "bbox" } | null } {
  return { kind: "setRegion", edge, region: regionSetting(rects, mode) };
}

/** 可编辑目标的入口文字：有区域时带上个数。 */
export function targetLabel(target: RegionTarget): string {
  return target.rects.length > 0 ? `${target.label}（${target.rects.length} 区域）` : target.label;
}

/** 图层侧栏的名字：没有名字时按序号写「图层N」。 */
// 预览弹窗的接线判定（#137）：从 ui/PreviewDialog.tsx 拆出的模块级函数，便于单测。
import type { LayerRecord } from "../core/taskDir";
import { regionModeOf } from "./previewRegion";
import type { RegionTarget } from "./PreviewDialog";
import type { RegionMode } from "./previewRegion";

/** 编辑区域时的初始状态。 */
export interface EditTarget {
  editing: RegionTarget | null;
  regionMode: RegionMode;
  rects: [number, number, number, number][];
}

/** 打开即编辑的目标；没有就是纯预览。 */
export function initialEditTarget(req: { edit?: RegionTarget }): EditTarget {
  if (!req.edit) return { editing: null, regionMode: "overlay", rects: [] };
  return { editing: req.edit, regionMode: regionModeOf(req.edit), rects: req.edit.rects.map((r) => [...r] as [number, number, number, number]) };
}

/** 图层侧栏的「加为参考图 / 以此继续编辑」用哪一层：0 = 底图。 */
export function pickedLayerIndex(pickSource: number, layerCount: number): number | null {
  if (pickSource <= 0) return null;
  const index = pickSource - 1;
  return index < layerCount ? index : null;
}

/** 预览弹窗要渲染的图层（没有就是没有）。 */
export function previewLayers(layers: { record: LayerRecord; absPath: string }[] | undefined): { record: LayerRecord; absPath: string }[] {
  return layers ?? [];
}

/** 预览弹窗的可编辑目标。 */
export function previewTargets(targets: RegionTarget[] | undefined): RegionTarget[] {
  return targets ?? [];
}

/** 预览弹窗的区域轮廓。 */
export function previewOutlines(outlines: [number, number, number, number][] | undefined): [number, number, number, number][] {
  return outlines ?? [];
}

/** 导出单层时的按钮文字。 */
export const exportOneLabel = "保存";

/** 图层侧栏的透明标记。 */
export const alphaBadgeText = "透明";
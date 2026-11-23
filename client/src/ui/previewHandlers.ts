// 预览弹窗的接线判定（#137）：从 ui/PreviewDialog.tsx 拆出的模块级函数，便于单测。
import type { LayerRecord } from "../core/taskDir";
import { startEditState } from "./previewState";
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
  const state = startEditState(req.edit);
  return { editing: state.editing, regionMode: state.regionMode, rects: state.rects };
}

/**
 * 图层侧栏的「加为参考图 / 以此继续编辑」用哪一层：null = 底图（合成结果）。
 *
 * 图层编号从 1 起（core/edit.ts 的 sourceLayer 也是 1 起）：选中的下拉项就是层号，
 * 0 是底图。层号越界（理论上不会发生）按底图处理。
 */
export function pickedLayerIndex(pickSource: number, layerCount: number): number | null {
  if (pickSource <= 0 || pickSource > layerCount) return null;
  return pickSource;
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
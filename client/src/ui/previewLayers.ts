// 放大预览弹窗的图层判定（#137）：从 ui/PreviewDialog.tsx 拆出的纯逻辑，便于单测。
import type { LayerRecord } from "../core/taskDir";
import type { ImageInfo } from "../shell/port";

/** 图层在预览里的位置（相对底图的百分比）。 */
export interface LayerStyle {
  visibility?: "hidden";
  inset?: string;
  left?: string;
  top?: string;
  width?: string;
  height?: string;
  zIndex?: number;
}

/**
 * 图层的位置样式：按底图尺寸换算成百分比。
 * 历史结果的 bounding_box 是数组（不是矩形），照旧渲染，不给位置；
 * 底图尺寸还没读到时先藏起来，免得位置算错。
 */
export function layerStyleOf(layer: LayerRecord, baseInfo: ImageInfo | null | undefined): LayerStyle | undefined {
  const box = layer.bounding_box;
  if (Array.isArray(box)) return undefined;
  if (!baseInfo) return { visibility: "hidden" };
  const [left, top, right, bottom] = box.absolute;
  return {
    inset: "auto",
    left: `${left / baseInfo.width * 100}%`,
    top: `${top / baseInfo.height * 100}%`,
    width: `${(right - left) / baseInfo.width * 100}%`,
    height: `${(bottom - top) / baseInfo.height * 100}%`,
    zIndex: layer.z_index,
  };
}

/** 图层的名字：没有名字时按序号写「图层N」（N 从 1 起）。 */
export function layerName(layer: LayerRecord, index: number): string {
  return layer.name ?? `图层${index + 1}`;
}

/** 弹窗的底图：单层模式下显示那一层，否则显示底图。 */
export function baseImagePath(req: { absPath: string }, layers: readonly { absPath: string }[], solo: number | null): string {
  return solo === null ? req.absPath : layers[solo].absPath;
}

/** 单层模式下底图 alt 用图层文件名，否则用弹窗标题。 */
export function baseImageAlt(req: { title: string }, layers: readonly { record: LayerRecord }[], solo: number | null): string {
  return solo === null ? req.title : layers[solo].record.file;
}

/** 选来源：底图是 0，图层从 1 起；越界当 null（没有图层）。 */
export function layerIndexOf(pickSource: number, layerCount: number): number | null {
  return pickSource > 0 && pickSource <= layerCount ? pickSource : null;
}

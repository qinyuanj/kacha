// 放大预览弹窗的图层判定（#137）：从 ui/PreviewDialog.tsx 拆出的纯逻辑，便于单测。
import type { LayerRecord } from "../core/taskDir";
import type { TextRunStyle } from "../core/gateway";
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

/**
 * 图层的 OCR 文本（#178）：没有、空串或全空白都算没拿到 —— 非文字层、艺术字、手写体本来就不返回，
 * 界面不显示空结果。
 */
export function layerOcrText(layer: LayerRecord): string | null {
  const text = layer.text_recognition?.text.trim();
  return text ? text : null;
}

const OCR_STYLE_LABELS: [keyof TextRunStyle, string][] = [
  ["bold", "粗体"],
  ["italic", "斜体"],
  ["underline", "下划线"],
  ["strikethrough", "删除线"],
  ["shadow", "阴影"],
  ["translucent", "半透明"],
];

/** 该图层的近似样式：只要有一段文字带这个样式就列出来，按固定顺序去重；没给样式时为空。 */
export function layerOcrStyles(layer: LayerRecord): string[] {
  const runs = layer.text_recognition?.lines.flatMap((line) => line.runs) ?? [];
  return OCR_STYLE_LABELS.filter(([key]) => runs.some((run) => run.style?.[key] === true)).map(([, label]) => label);
}

/** 弹窗的底图：单层模式下显示那一层，否则显示底图。 */
export function baseImagePath(req: { absPath: string }, layers: readonly { absPath: string }[], solo: number | null): string {
  return solo === null ? req.absPath : layers[solo].absPath;
}

/** 单层模式下底图 alt 用图层文件名，否则用弹窗标题。 */
export function baseImageAlt(req: { title: string }, layers: readonly { record: LayerRecord }[], solo: number | null): string {
  return solo === null ? req.title : layers[solo].record.file;
}


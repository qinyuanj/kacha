// 参考图规则的判定：格式、字节、总像素、短边与宽高比，只此一处实现。
// 界面标黄（ui/canvasNodes）、拖线拦截（core/graph）、请求体（core/gateway）与提交前快照（core/run）共用同一套说法，
// 新增规则键时四处自动跟上，不会出现某处静默忽略。
import type { InputImageRule } from "./capabilities";

export interface ImageFacts {
  /** 小写格式名：png / jpeg / webp …；未知为空串。 */
  format: string;
  bytes: number;
  width: number;
  height: number;
}

export const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 路径里的格式名（小写；jpg 归一到 jpeg）；没有扩展名或点开头返回空串。 */
export function imageFormatOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return ext === "jpg" ? "jpeg" : ext;
}

/** 按 input_image_rule 预校验参考图，逐项给出说明；违反时参考图节点标黄、拖线与派发也据此拦下。 */
export function imageRuleViolations(image: ImageFacts, rule: InputImageRule): string[] {
  const out: string[] = [];
  if (!rule.formats.includes(image.format)) {
    out.push(`格式 ${image.format.toUpperCase() || "未知"} 不受支持（支持 ${rule.formats.map((f) => f.toUpperCase()).join(" / ")}）`);
  }
  if (rule.max_bytes !== null && image.bytes > rule.max_bytes) out.push(`文件 ${mb(image.bytes)} 超过上限 ${mb(rule.max_bytes)}`);
  if (image.width > 0 && image.height > 0) out.push(...imagePixelViolations(image, rule), ...imageAspectViolations(image, rule));
  return out;
}

function imagePixelViolations(image: ImageFacts, rule: InputImageRule): string[] {
  const out: string[] = [];
  const total = image.width * image.height;
  if (rule.min_total_pixels !== null && total < rule.min_total_pixels) out.push(`总像素 ${total} 低于下限 ${rule.min_total_pixels}`);
  if (rule.max_total_pixels !== null && total > rule.max_total_pixels) out.push(`总像素 ${total} 超过上限 ${rule.max_total_pixels}`);
  const short = Math.min(image.width, image.height);
  if (rule.min_short_edge !== null && short < rule.min_short_edge) out.push(`最短边 ${short} px 小于 ${rule.min_short_edge} px`);
  return out;
}

function imageAspectViolations(image: ImageFacts, rule: InputImageRule): string[] {
  const out: string[] = [];
  const ratio = image.width / image.height;
  const lo = rule.min_aspect_ratio;
  const hi = rule.max_aspect_ratio;
  if ((lo !== null && ratio < lo) || (hi !== null && ratio > hi)) {
    out.push(`宽高比 ${ratio.toFixed(2)} 超出 ${lo === null ? "0" : lo.toFixed(2)}～${hi === null ? "∞" : hi.toFixed(2)}`);
  }
  return out;
}

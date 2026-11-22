// 预览舞台的各层（#137）：从 ui/PreviewDialog.tsx 拆出的子组件，让舞台本体只留接线。
import type { ImageInfo } from "../shell/port";
import { regionCss } from "../core/overlay";
import type { Rect01 } from "./rects";
import type { RegionMode } from "./previewRegion";
import { baseImageAlt, baseImagePath, layerStyleOf } from "./previewLayers";

/** 舞台的角柄位置。 */
export const CORNERS = ["nw", "ne", "sw", "se"] as const;

/** 一层预览图：勾选叠加显示时才画。 */
export function PreviewLayers(props: {
  layers: { record: { file: string }; absPath: string }[];
  checked: ReadonlySet<number>;
  baseInfo: ImageInfo | null | undefined;
  imageUrl(path: string): string;
}) {
  const { layers, checked, baseInfo, imageUrl } = props;
  return (
    <>
      {layers.map((layer, i) =>
        checked.has(i) ? <img key={layer.record.file} className="preview-layer" style={layerStyleOf(layer.record as never, baseInfo)} src={imageUrl(layer.absPath)} alt={layer.record.file} draggable={false} /> : null,
      )}
    </>
  );
}

/** 区域轮廓（只读描边）。 */
export function PreviewOutlines(props: { outlines: Rect01[] }) {
  return (
    <>
      {props.outlines.map((r, i) => (
        <div
          key={`outline-${i}`}
          className="preview-outline"
          style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${(r[2] - r[0]) * 100}%`, height: `${(r[3] - r[1]) * 100}%` }}
        />
      ))}
    </>
  );
}

/** 一个区域框：选中的那个带角柄。 */
export function PreviewRect(props: {
  rect: Rect01;
  index: number;
  selected: boolean;
  editing: boolean;
  regionMode: RegionMode;
  first: number;
}) {
  const { rect: r, index: i, selected, editing, regionMode, first } = props;
  return (
    <div
      className={`preview-rect ${editing && selected ? "preview-rect-selected" : ""}`}
      data-rect-index={editing ? i : undefined}
      style={{
        left: `${r[0] * 100}%`,
        top: `${r[1] * 100}%`,
        width: `${(r[2] - r[0]) * 100}%`,
        height: `${(r[3] - r[1]) * 100}%`,
        background: regionMode === "overlay" ? regionCss(first + i, 0.5) : "transparent",
        borderColor: regionCss(first + i, 0.9),
      }}
    >
      <span className="preview-rect-label" style={{ background: regionCss(first + i, 0.9) }}>
        区域{first + i + 1}
      </span>
      {editing && selected && CORNERS.map((c) => <span key={c} className={`preview-handle preview-handle-${c}`} data-rect-index={i} data-corner={c} />)}
    </div>
  );
}

/** 预览舞台：底图、叠加图层、区域轮廓与可拖动的区域框。 */
export function PreviewStage(props: {
  stageRef: React.RefObject<HTMLImageElement | null>;
  absPath: string;
  title: string;
  layers: { record: { file: string }; absPath: string }[];
  baseInfo: ImageInfo | null | undefined;
  checked: ReadonlySet<number>;
  solo: number | null;
  showOutlines: boolean;
  outlines: Rect01[];
  editing: unknown;
  selected: number | null;
  shown: Rect01[];
  regionMode: RegionMode;
  first: number;
  imageUrl(path: string): string;
  onPointerDown(e: React.PointerEvent): void;
}) {
  const { layers, checked, solo, showOutlines, outlines, editing, selected, shown, regionMode, first } = props;
  const isEditing = editing !== null;
  return (
    <div className="preview-stage nodrag" onPointerDown={props.onPointerDown}>
      <div className="preview-canvas">
        <img ref={props.stageRef} className="preview-base-image" src={props.imageUrl(baseImagePath({ absPath: props.absPath }, layers as never, solo))} alt={baseImageAlt({ title: props.title }, layers as never, solo)} draggable={false} />
        {solo === null && <PreviewLayers layers={layers} checked={checked} baseInfo={props.baseInfo} imageUrl={props.imageUrl} />}
        {solo === null && showOutlines && <PreviewOutlines outlines={outlines} />}
        {solo === null &&
          shown.map((r, i) => <PreviewRect key={i} rect={r} index={i} selected={selected === i} editing={isEditing} regionMode={regionMode} first={first} />)}
      </div>
    </div>
  );
}

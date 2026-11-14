// 放大预览弹窗：纯预览、编辑图片连线的指示区域（拖拽画矩形）、结果节点的图层侧栏与导出。
// 弹窗必须挂在画布根（BoardCanvas），不能挂进 React Flow 节点内：变换容器里 position:fixed 会失效。
// 区域编辑与图层判定在 ui/previewRegion.ts、ui/previewLayers.ts、ui/previewState.ts（#137），这里只留接线与 DOM 摆放。
import { useEffect, useRef, useState } from "react";
import type { PortRef, RegionRender } from "../core/board";
import { useBoardActions, useImageInfos } from "./context";
import { useShell } from "./shell";
import type { Rect01 } from "./rects";
import { regionSetting, shownRects, type Drag, type RegionMode } from "./previewRegion";

import { removeSelected, toggleChecked, toggleSolo } from "./previewState";
import { PreviewFooter, PreviewHeader } from "./previewViews";
import { PreviewStage } from "./previewStage";
import { LayerSidebar, type PreviewLayer } from "./previewSidebar";
import { exportAllImages, exportOneImage } from "./previewExport";
import { dragPoint, editStateOf, pointAt, rectsAfter, startDragAt } from "./previewDrag";
import { initialEditTarget, previewLayers, previewOutlines, previewTargets } from "./previewHandlers";

/** 弹窗里可编辑区域的一条目标连线（任务端口行单条，或参考图 / 结果扇出的多条）。 */
export interface RegionTarget {
  label: string;
  edgeRef: { from: PortRef; to: PortRef };
  rects: Rect01[];
  render: RegionRender;
  coordinateKind?: "point" | "bbox";
  coordinateAvailable?: boolean;
  /** 这条线第一个区域的区域编号（0 起）；区域N 的颜色由它推导。 */
  firstRegion: number;
}

export interface PreviewRequest {
  title: string;
  /** 主图（底图）绝对路径。 */
  absPath: string;
  /** 结果节点的图层（z 升序）；有则露出图层侧栏。 */
  layers?: PreviewLayer[];
  /** 结果节点 id：图层侧栏露出「加为参考图 / 以此继续编辑」。 */
  resultId?: string;
  /** 可编辑区域的连线目标；空 = 纯预览。 */
  regionTargets?: RegionTarget[];
  /** 打开即进入该连线的区域编辑（任务端口行入口）。 */
  edit?: RegionTarget;
  /** 本次编辑用到的区域轮廓（结果节点：产出任务提交快照里的 region，只读描边回显）；空 = 不露出开关。 */
  regionOutlines?: Rect01[];
}

interface Props {
  req: PreviewRequest;
  toast: (message: string) => void;
  onClose: () => void;
}

export function PreviewDialog({ req, toast, onClose }: Props) {
  const port = useShell();
  const { apply, addAsReference, continueEditing } = useBoardActions();
  const stage = useRef<HTMLImageElement>(null);
  const initial = initialEditTarget(req);
  const [editing, setEditing] = useState<RegionTarget | null>(initial.editing);
  const [regionMode, setRegionMode] = useState<RegionMode>(initial.regionMode);
  const [rects, setRects] = useState<Rect01[]>(initial.rects);
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [solo, setSolo] = useState<number | null>(null);
  const [showOutlines, setShowOutlines] = useState(false);
  const [pickSource, setPickSource] = useState(0);
  const [busy, setBusy] = useState(false);
  const layers = previewLayers(req.layers);
  const baseInfo = useImageInfos([req.absPath]).get(req.absPath);
  const targets = previewTargets(req.regionTargets);
  const outlines = previewOutlines(req.regionOutlines);
  const first = editing?.firstRegion ?? 0;
  const layerInfos = useImageInfos(layers.map((l) => l.absPath));

  const startEdit = (target: RegionTarget) => {
    const next = editStateOf(target);
    setEditing(next.editing);
    setRegionMode(next.regionMode);
    setRects(next.rects);
    setSelected(next.selected);
    setSolo(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!editing || e.button !== 0 || !stage.current) return;
    const p = pointAt(stage, e);
    const next = startDragAt({ editing, regionMode, rects, selected, drag }, e.target, p);
    e.preventDefault();
    setSelected(next.selected);
    setDrag(next.drag);
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag((d) => (d ? dragPoint(d, pointAt(stage, e)) : d));
    const up = (e: PointerEvent) => {
      const p = pointAt(stage, e);
      setRects((rs) => rectsAfter(drag, rs, p));
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [drag]);

  const shown = shownRects(drag, rects);
  const removeOne = () => {
    setRects((rs) => removeSelected(rs, selected));
    setSelected(null);
  };
  const saveRegion = () => {
    if (!editing) return;
    apply({ kind: "setRegion", edge: editing.edgeRef, region: regionSetting(rects, regionMode) });
    onClose();
  };

  const exportOne = (absPath: string) => void exportOneImage(port.media, toast, setBusy, absPath);
  const exportAll = () => void exportAllImages(port.media, toast, setBusy, req.absPath);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal modal-preview ${layers.length ? "modal-preview-wide" : ""}`} role="dialog" aria-label={req.title}>
        <PreviewHeader
          title={req.title}
          editing={editing}
          regionMode={regionMode}
          onRegionMode={setRegionMode}
          solo={solo}
          showOutlines={showOutlines}
          onShowOutlines={setShowOutlines}
          outlineCount={outlines.length}
          onClose={onClose}
        />
        <div className="preview-body">
          <PreviewStage
            stageRef={stage}
            absPath={req.absPath}
            title={req.title}
            layers={layers}
            baseInfo={baseInfo}
            checked={checked}
            solo={solo}
            showOutlines={showOutlines}
            outlines={outlines}
            editing={editing}
            selected={selected}
            shown={shown}
            regionMode={regionMode}
            first={first}
            imageUrl={(p) => port.media.imageUrl(p)}
            onPointerDown={onPointerDown}
          />
          {layers.length > 0 && (
            <LayerSidebar
              layers={layers}
              checked={checked}
              solo={solo}
              pickSource={pickSource}
              busy={busy}
              resultId={req.resultId}
              layerInfos={layerInfos}
              onToggle={(i) => setChecked((s) => toggleChecked(s, i))}
              onSolo={(i) => setSolo((s) => toggleSolo(s, i))}
              onPickSource={setPickSource}
              onExportOne={(path) => void exportOne(path)}
              onExportBase={() => void exportOne(req.absPath)}
              onExportAll={() => void exportAll()}
              onContinueEditing={(id, index) => continueEditing(id, index)}
              onAddAsReference={(id, index) => addAsReference(id, index)}
            />
          )}
        </div>
        <PreviewFooter
          editing={editing}
          targets={targets}
          rects={rects}
          selected={selected}
          regionMode={regionMode}
          first={first}
          onRemove={removeOne}
          onClear={() => {
            setRects([]);
            setSelected(null);
          }}
          onSave={saveRegion}
          onClose={onClose}
          onStartEdit={startEdit}
        />
      </div>
    </div>
  );
}
// 放大预览弹窗：纯预览、编辑图片连线的指示区域（拖拽画矩形）、结果节点的图层侧栏与导出。
// 弹窗必须挂在画布根（BoardCanvas），不能挂进 React Flow 节点内：变换容器里 position:fixed 会失效。
// 区域编辑与图层判定在 ui/previewRegion.ts、ui/previewLayers.ts、ui/previewState.ts（#137），这里只留接线与 DOM 摆放。
import { useEffect, useRef, useState } from "react";
import type { PortRef, RegionRender } from "../core/board";
import { type LayerRecord } from "../core/taskDir";
import { useBoardActions, useImageInfos } from "./context";
import { useShell } from "./shell";
import type { Rect01 } from "./rects";
import { regionModeOf, regionSetting, shownRects, type Drag, type RegionMode } from "./previewRegion";
import { layerIndexOf, layerName } from "./previewLayers";
import { removeSelected, startEditState, toggleChecked, toggleSolo } from "./previewState";
import { PreviewFooter, PreviewHeader } from "./previewViews";
import { PreviewStage } from "./previewStage";
import { exportAllImages, exportOneImage } from "./previewExport";
import { dragPoint, editStateOf, pointAt, rectsAfter, startDragAt } from "./previewDrag";

export interface PreviewLayer {
  record: LayerRecord;
  absPath: string;
}

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

/** 图层侧栏：勾选叠加显示、点缩略图看单层、导出与继续编辑的入口。 */
function LayerSidebar(props: {
  layers: PreviewLayer[];
  checked: ReadonlySet<number>;
  solo: number | null;
  pickSource: number;
  busy: boolean;
  resultId: string | undefined;
  layerInfos: ReadonlyMap<string, { has_alpha: boolean } | null>;
  onToggle(index: number): void;
  onSolo(index: number): void;
  onPickSource(value: number): void;
  onExportOne(absPath: string): void;
  onExportBase(): void;
  onExportAll(): void;
  onContinueEditing(resultId: string, layerIndex: number | null): void;
  onAddAsReference(resultId: string, layerIndex: number | null): void;
}) {
  const { layers, checked, solo, pickSource, busy, resultId, layerInfos } = props;
  const layerIndex = layerIndexOf(pickSource, layers.length);
  return (
    <div className="preview-side">
      <div className="muted small">图层（点缩略图看单层，勾选叠加显示）</div>
      <ul className="layer-list">
        {layers.map((layer, i) => (
          <li key={layer.record.file}>
            <label>
              <input type="checkbox" checked={checked.has(i)} onChange={() => props.onToggle(i)} />
              <img
                src={layer.absPath}
                alt={layer.record.file}
                draggable={false}
                className={solo === i ? "layer-solo" : ""}
                title="点选只显示该层（再点取消）"
                onClick={(e) => {
                  e.preventDefault();
                  props.onSolo(i);
                }}
              />
              <span title={layer.record.description}>
                {layerName(layer.record, i)}
                {layerInfos.get(layer.absPath)?.has_alpha && <span className="badge">透明</span>}
              </span>
            </label>
            <button className="link small" disabled={busy} onClick={() => props.onExportOne(layer.absPath)}>
              保存
            </button>
          </li>
        ))}
      </ul>
      {resultId && (
        <div className="preview-pick">
          <select value={pickSource} onChange={(e) => props.onPickSource(Number(e.target.value))}>
            <option value={0}>底图（合成结果）</option>
            {layers.map((layer, i) => (
              <option key={layer.record.file} value={i + 1}>
                图层{i + 1}
              </option>
            ))}
          </select>
          <button disabled={busy} onClick={() => props.onContinueEditing(resultId, layerIndex)}>
            以此继续编辑
          </button>
          <button disabled={busy} onClick={() => props.onAddAsReference(resultId, layerIndex)}>
            加为参考图
          </button>
        </div>
      )}
      <div className="preview-export">
        <button disabled={busy} onClick={props.onExportBase}>
          保存底图
        </button>
        <button disabled={busy} onClick={props.onExportAll} title="选一个目录，写入底图、全部图层文件与 layers.json（重名自动加序号）">
          保存全部图层 + layers.json
        </button>
      </div>
    </div>
  );
}

export function PreviewDialog({ req, toast, onClose }: Props) {
  const port = useShell();
  const { apply, addAsReference, continueEditing } = useBoardActions();
  const stage = useRef<HTMLImageElement>(null);
  const initial = startEditState(req.edit ?? { label: "", edgeRef: { from: ["", ""], to: ["", ""] }, rects: [], render: "highlight_overlay", firstRegion: 0 });
  const [editing, setEditing] = useState<RegionTarget | null>(req.edit ?? null);
  const [regionMode, setRegionMode] = useState<RegionMode>(req.edit ? regionModeOf(req.edit) : "overlay");
  const [rects, setRects] = useState<Rect01[]>(initial.rects);
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [solo, setSolo] = useState<number | null>(null);
  const [showOutlines, setShowOutlines] = useState(false);
  const [pickSource, setPickSource] = useState(0);
  const [busy, setBusy] = useState(false);
  const layers = req.layers ?? [];
  const baseInfo = useImageInfos([req.absPath]).get(req.absPath);
  const targets = req.regionTargets ?? [];
  const outlines = req.regionOutlines ?? [];
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
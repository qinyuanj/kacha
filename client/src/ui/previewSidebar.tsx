// 预览弹窗的图层侧栏（#137）：从 ui/PreviewDialog.tsx 拆出的子组件，让弹窗本体只留接线。
import type { LayerRecord } from "../core/taskDir";
import { layerName } from "./previewLayers";
import { pickedLayerIndex } from "./previewHandlers";

/** 一层预览图。 */
export interface PreviewLayer {
  record: LayerRecord;
  absPath: string;
}

/** 图层侧栏：勾选叠加显示、点缩略图看单层、导出与继续编辑的入口。 */
export function LayerSidebar(props: {
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
  const layerIndex = pickedLayerIndex(pickSource, layers.length);
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

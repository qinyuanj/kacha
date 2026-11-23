// 放大预览弹窗的头与尾（#137）：从 ui/PreviewDialog.tsx 拆出的子组件，让弹窗本体只留接线。
import { MAX_REGIONS } from "../core/overlay";
import { overRegionLimit } from "./previewRegion";
import { targetLabel } from "./previewState";
import type { Rect01 } from "./rects";
import type { RegionMode } from "./previewRegion";
import type { RegionTarget } from "./PreviewDialog";

/** 弹窗头：标题、编辑状态、区域表达、单层标记与区域轮廓开关。 */
export function PreviewHeader(props: {
  title: string;
  /** 正在编辑的目标（没有为 null）。 */
  editing: RegionTarget | null;
  regionMode: RegionMode;
  onRegionMode(mode: RegionMode): void;
  /** 单层显示的图层序号（没有为 null）。 */
  solo: number | null;
  showOutlines: boolean;
  onShowOutlines(show: boolean): void;
  /** 区域轮廓的条数。 */
  outlineCount: number;
  onClose(): void;
}) {
  const { editing, regionMode, solo, showOutlines, outlineCount } = props;
  return (
    <div className="modal-head">
      <h2>{props.title}</h2>
      {editing && <span className="badge">编辑区域：{editing.label}</span>}
      {editing?.coordinateAvailable && (
        <label className="small">区域表达
          <select aria-label="区域表达" value={regionMode} onChange={(e) => props.onRegionMode(e.target.value as RegionMode)}>
            <option value="overlay">高亮叠加</option>
            <option value="bbox">坐标框</option>
            <option value="point">坐标点（框中心）</option>
          </select>
        </label>
      )}
      {solo !== null && <span className="badge">单层：图层{solo + 1}</span>}
      {outlineCount > 0 && !editing && (
        <label className="small" title="本次编辑框选的修改区域（只读描边，来自产出任务的提交快照）">
          <input type="checkbox" checked={showOutlines} onChange={(e) => props.onShowOutlines(e.target.checked)} />
          区域轮廓
        </label>
      )}
      <button className="link" onClick={props.onClose}>
        关闭
      </button>
    </div>
  );
}

/** 弹窗尾：编辑时给区域操作，纯预览时给可编辑目标的入口。 */
export function PreviewFooter(props: {
  /** 正在编辑的目标（没有为 null）。 */
  editing: RegionTarget | null;
  /** 可编辑的目标（纯预览时用）。 */
  targets: RegionTarget[];
  rects: Rect01[];
  selected: number | null;
  regionMode: RegionMode;
  first: number;
  onRemove(): void;
  onClear(): void;
  onSave(): void;
  onClose(): void;
  onStartEdit(target: RegionTarget): void;
}) {
  const { editing, targets, rects, selected, regionMode, first } = props;
  return (
    <div className="modal-foot">
      {editing ? (
        <>
          <span className={"modal-foot-note " + (overRegionLimit(first + rects.length) ? "region-limit-exceeded" : "muted")}>
            拖拽空白处画新矩形；拖动矩形移动，拖动角柄缩放。提示词里写「区域N」指代对应区域，每个任务最多 {MAX_REGIONS} 个。{regionMode === "point" && "坐标点取每个框的中心，影响范围由模型判断。"}
          </span>
          <button disabled={selected === null} onClick={props.onRemove}>
            删除选中
          </button>
          <button disabled={rects.length === 0} onClick={props.onClear}>
            清空
          </button>
          <button onClick={props.onClose}>取消</button>
          <button className="primary" onClick={props.onSave}>
            保存区域
          </button>
        </>
      ) : (
        <>
          <span className="muted modal-foot-note">
            {targets.length > 0 && (
              <>
                框选修改区域：
                {targets.map((t) => (
                  <button key={`${t.edgeRef.from.join(":")}->${t.edgeRef.to.join(":")}`} className="link" onClick={() => props.onStartEdit(t)}>
                    {targetLabel(t)}
                  </button>
                ))}
              </>
            )}
          </span>
          <button onClick={props.onClose}>关闭</button>
        </>
      )}
    </div>
  );
}
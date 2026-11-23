// 画板包（ADR 0013）的模态：导出前确认（含完整提示词、预估大小、缺图清单）、可取消的进度、导入后的冲突清单。
// 可见判定在 ui/boardPackView.ts（#137），这里只留接线与 DOM 摆放。
import { useEffect, useState } from "react";
import { useShell } from "./shell";
import type { ExportPlan, PackContents } from "../core/boardPack";
import { dismissible, estimateText, exportButtonLabel, exportSummary, progressMax, progressText } from "./boardPackView";

export type PackDialogState =
  | { stage: "confirmExport"; boardFile: string; plan: ExportPlan; contents: PackContents }
  /** detail：进度阶段内正在做的一步（导入时按 ImportPhase 换）。 */
  | { stage: "progress"; title: string; detail?: string }
  /** 有冲突、本机存储导入请求失败或打开画板失败时才弹：message 是结局，notice 是完整的补充说明（文案见 boardText）。 */
  | { stage: "importDone"; message: string; conflicts: string[]; notice: string | null };

export interface BoardPackDialogProps {
  state: PackDialogState;
  onExport: () => void;
  onCancelProgress: () => void;
  onClose: () => void;
}

/** 进度阶段：听本机存储的进度回报，可取消。 */
function Progress({ title, detail, onCancel }: { title: string; detail?: string; onCancel: () => void }) {
  const port = useShell();
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    const unlisten = port.ui.onPackProgress(setProgress);
    return () => void unlisten.then((fn) => fn());
  }, []);
  return (
    <>
      <div className="modal-head">
        <h2>{title}</h2>
      </div>
      {detail && <div className="muted small pack-phase">{detail}</div>}
      <progress className="pack-progress" value={progress.done} max={progressMax(progress)} />
      <div className="muted small">{progressText(progress)}</div>
      <div className="modal-foot">
        <button
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            onCancel();
          }}
        >
          {cancelling ? "正在取消…" : "取消"}
        </button>
      </div>
    </>
  );
}

/** 导出前确认：打包内容、预估大小、缺图清单。 */
function ConfirmExport({ state, onExport, onClose }: { state: Extract<PackDialogState, { stage: "confirmExport" }>; onExport: () => void; onClose: () => void }) {
  return (
    <>
      <div className="modal-head">
        <h2>导出画板包：{state.boardFile}</h2>
      </div>
      <div>{exportSummary(state.plan.taskDirs.length, state.plan.files.length)}</div>
      <div className="pack-estimate">{estimateText(state.contents.bytes, state.contents.totalBytes)}</div>
      <div className="badge-warn pack-warning">包含完整提示词与任务记录，不脱敏；请只发给可信的人。</div>
      {state.plan.missing.length > 0 && (
        <>
          <div>以下 {state.plan.missing.length} 张图片缺失，导出后在导入端仍为缺图占位：</div>
          <ul className="error-list">
            {state.plan.missing.map((m) => (
              <li key={m.nodeId} className="mono">
                {m.path}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="modal-foot">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={onExport}>
          {exportButtonLabel(state.plan.missing.length)}
        </button>
      </div>
    </>
  );
}

/** 导入后的结局：冲突清单与补充说明。 */
function ImportDone({ state, onClose }: { state: Extract<PackDialogState, { stage: "importDone" }>; onClose: () => void }) {
  return (
    <>
      <div className="modal-head">
        <h2>{state.message}</h2>
      </div>
      {state.notice && <div className="badge-warn pack-warning">{state.notice}</div>}
      {state.conflicts.length > 0 && (
        <>
          <div>以下内容与本机已有的不一致，已跳过、未覆盖：</div>
          <ul className="error-list">
            {state.conflicts.map((c) => (
              <li key={c} className="mono">
                {c}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="modal-foot">
        <button className="primary" onClick={onClose}>
          知道了
        </button>
      </div>
    </>
  );
}

export function BoardPackDialog({ state, onExport, onCancelProgress, onClose }: BoardPackDialogProps) {
  // 进度中不响应点背景关闭：只能点「取消」。
  const dismiss = dismissible(state) ? onClose : undefined;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dismiss?.()}>
      <div className="modal" role="dialog" aria-label="画板包">
        {state.stage === "progress" && <Progress title={state.title} detail={state.detail} onCancel={onCancelProgress} />}
        {state.stage === "confirmExport" && <ConfirmExport state={state} onExport={onExport} onClose={onClose} />}
        {state.stage === "importDone" && <ImportDone state={state} onClose={onClose} />}
      </div>
    </div>
  );
}

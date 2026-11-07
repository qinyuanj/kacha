// 画板包（ADR 0013）的模态：导出前确认（含完整提示词、预估大小、缺图清单）、可取消的进度、导入后的冲突清单。
import { browser } from "../shell/ipc";
import { useEffect, useState } from "react";
import type { ExportPlan, PackContents } from "../core/boardPack";

export type PackDialogState =
  | { stage: "confirmExport"; boardFile: string; plan: ExportPlan; contents: PackContents }
  /** detail：进度阶段内正在做的一步（导入时按 ImportPhase 换）。 */
  | { stage: "progress"; title: string; detail?: string }
  /** 有冲突、服务端导入请求失败或打开画板失败时才弹：message 是结局，notice 是完整的补充说明（文案见 boardText）。 */
  | { stage: "importDone"; message: string; conflicts: string[]; notice: string | null };

export interface BoardPackDialogProps {
  state: PackDialogState;
  onExport: () => void;
  onCancelProgress: () => void;
  onClose: () => void;
}

const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function Progress({ title, detail, onCancel }: { title: string; detail?: string; onCancel: () => void }) {
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    const unlisten = browser.onPackProgress(setProgress);
    return () => void unlisten.then((fn) => fn());
  }, []);
  return (
    <>
      <div className="modal-head">
        <strong>{title}</strong>
      </div>
      {detail && <div className="muted small pack-phase">{detail}</div>}
      <progress className="pack-progress" value={progress.done} max={progress.total || 1} />
      <div className="muted small">{progress.total ? `${formatSize(progress.done)} / ${formatSize(progress.total)}` : "准备中…"}</div>
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

export function BoardPackDialog({ state, onExport, onCancelProgress, onClose }: BoardPackDialogProps) {
  // 进度中不响应点背景关闭：只能点「取消」。
  const dismiss = state.stage === "progress" ? undefined : onClose;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dismiss?.()}>
      <div className="modal" role="dialog" aria-label="画板包">
        {state.stage === "progress" && <Progress title={state.title} detail={state.detail} onCancel={onCancelProgress} />}
        {state.stage === "confirmExport" && (
          <>
            <div className="modal-head">
              <strong>导出画板包：{state.boardFile}</strong>
            </div>
            <div>
              将打包画板与它引用的 {state.plan.taskDirs.length} 个任务目录
              {state.plan.files.length > 0 && `、${state.plan.files.length} 张参考图`}。
            </div>
            <div className="pack-estimate">
              预估大小：{formatSize(state.contents.bytes)}
              {state.contents.bytes < state.contents.totalBytes &&
                `（重复内容只存一份，省去 ${formatSize(state.contents.totalBytes - state.contents.bytes)}）`}
            </div>
            <div className="badge-warn">包含完整提示词与任务记录，不脱敏；请只发给可信的人。</div>
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
                {state.plan.missing.length ? "仍然导出…" : "导出并下载…"}
              </button>
            </div>
          </>
        )}
        {state.stage === "importDone" && (
          <>
            <div className="modal-head">
              <strong>{state.message}</strong>
            </div>
            {state.notice && <div className="badge-warn">{state.notice}</div>}
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
        )}
      </div>
    </div>
  );
}

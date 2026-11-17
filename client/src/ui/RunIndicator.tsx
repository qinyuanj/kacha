// 顶栏运行指示「执行 n · 排队 m」：点开小列表，可跳到对应画板与节点、取消其中一份，或取消全部排队。不是任务中心。
// 计数取运行器的忙闲判断（activity）：读参考图、排队、执行与退避都算未完成的份（#155）。
import { useState } from "react";
import type { ActiveTask, TaskActivity } from "../core/runner";

interface Props {
  active: readonly ActiveTask[];
  /** 未完成份的阶段分布：读图阶段的份还没有任务编号，只能在这里露面。 */
  activity: TaskActivity;
  titleOf: (boardKey: string) => string;
  onJump: (task: ActiveTask) => void;
  onCancelCopy: (taskId: string) => void;
  onCancelWaiting: () => void;
}

export function RunIndicator({ active, activity, titleOf, onJump, onCancelCopy, onCancelWaiting }: Props) {
  const [open, setOpen] = useState(false);
  if (activity.pending === 0) return null;
  // 取消全部排队 = 所有还没执行的份（读图中、排队、退避）；执行中的不受影响。
  const cancellable = activity.pending - activity.running;
  const extras = [
    activity.backoff > 0 ? `退避 ${activity.backoff}` : "",
    activity.reading > 0 ? `读图 ${activity.reading}` : "",
  ].filter((text) => text !== "");
  return (
    <div className="run-indicator">
      <button onClick={() => setOpen((v) => !v)}>
        {[`执行 ${activity.running} · 排队 ${activity.waiting}`, ...extras].join(" · ")}
      </button>
      {open && (
        <div className="run-list">
          <ul>
            {active.map((t) => (
              <li key={t.taskId}>
                <button
                  className="link"
                  onClick={() => {
                    setOpen(false);
                    onJump(t);
                  }}
                >
                  <span className={t.state === "running" ? "status status-running" : "status status-queued"}>{t.state === "running" ? "执行中" : "排队中"}</span>
                  {titleOf(t.boardKey)}
                  <span className="mono muted"> {t.taskId}</span>
                </button>
                <button className="link small" aria-label={`取消任务 ${t.taskId}`} onClick={() => onCancelCopy(t.taskId)}>
                  取消
                </button>
              </li>
            ))}
          </ul>
          <button disabled={cancellable === 0} onClick={onCancelWaiting}>
            取消全部排队
          </button>
        </div>
      )}
    </div>
  );
}

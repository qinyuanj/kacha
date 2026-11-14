// 用量与自助清理（Web 版，ADR 0018）：高级设置里的一块；清单来自服务端，服务端逐条重算候选资格。
// 可见判定在 ui/usageView.ts（#137），这里只留接线与 DOM 摆放。
import { useCallback, useEffect, useState } from "react";
import type { Usage } from "../shell/types";
import { errorText } from "../core/errors";
import { useShell } from "./shell";
import { formatBytes, IDLE_USER_RULE_TEXT } from "./boardText";
import { canClean, cleanupNote, unreadableNotice, unreferencedSummary, usageBreakdown, usageByDate } from "./usageView";

export function UsageSection() {
  const port = useShell();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsage(await port.usage.usage());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const clean = async () => {
    if (!usage?.unreferenced) return;
    setBusy(true);
    setError(null);
    try {
      const result = await port.usage.cleanupUnreferenced(usage.unreferenced.map((d) => d.dir));
      setNote(cleanupNote(result));
      setConfirm(false);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const dirs = usage?.unreferenced ?? [];
  return (
    <div className="usage-section">
      <div className="form-row">
        <span>用量</span>
        {usage ? (
          <span data-testid="usage-total" className="mono">
            {formatBytes(usage.total_bytes)}
            {usage.limit_bytes !== null && ` / 上限 ${formatBytes(usage.limit_bytes)}`}
          </span>
        ) : (
          <span className="muted small">正在统计…</span>
        )}
      </div>
      {usage && (
        <>
          <div className="muted small form-hint">{usageBreakdown(usage)}</div>
          <div className="muted small form-hint" data-testid="usage-note">
            用量按文件长度累加：导入画板包时内容相同的文件共用一份磁盘空间，这里会重复计入，实际占用可能更小；清理也不一定释放显示的全部字节。
          </div>
          <div className="muted small form-hint" data-testid="usage-dates">{usageByDate(usage)}</div>
          <div className="form-row">
            <span>未引用任务目录</span>
            <span className="muted small" data-testid="usage-unreferenced-summary">{unreferencedSummary(dirs)}</span>
            <button onClick={() => setConfirm(true)} disabled={!canClean(usage, busy)}>
              清理未引用任务目录…
            </button>
          </div>
          {usage.unreadable_board && (
            <div className="notice notice-warn" data-testid="usage-unreadable">{unreadableNotice(usage.unreadable_board)}</div>
          )}
          <div className="muted small form-hint" data-testid="usage-idle-rule">{IDLE_USER_RULE_TEXT}</div>
          <div className="muted small form-hint">没有画板引用、建立超过 30 天的任务目录可以清理；清掉的先进回收区，14 天内可找管理员恢复。</div>
        </>
      )}
      {note && <div className="muted small form-hint">{note}</div>}
      {error && <div className="form-error">{error}</div>}
      {confirm && usage && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-label="清理未引用任务目录">
            <div className="modal-head"><strong>清理未引用任务目录</strong></div>
            <p className="muted small">以下 {dirs.length} 个任务目录没有任何画板引用，将移入回收区（保留 14 天，只能由管理员恢复）。被引用的结果不在清单里。</p>
            <ul className="usage-candidates">
              {dirs.map((d) => (
                <li key={d.dir}>
                  <span className="mono">{d.dir}</span> — {formatBytes(d.bytes)}，最后修改 {new Date(d.last_write * 1000).toLocaleString()}
                </li>
              ))}
            </ul>
            <div className="modal-foot">
              <button onClick={() => setConfirm(false)} disabled={busy}>取消</button>
              <button className="primary" onClick={() => void clean()} disabled={busy}>{busy ? "正在清理…" : "移入回收区"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 用量与自助清理（Web 版，ADR 0018）：高级设置里的一块；清单来自服务端，服务端逐条重算候选资格。
// 可见判定在 ui/usageView.ts（#137），这里只留接线与 DOM 摆放。
import { useCallback, useEffect, useState } from "react";
import type { Usage } from "../shell/types";
import { errorText } from "../core/errors";
import { useShell } from "./shell";
import { formatBytes, IDLE_USER_RULE_TEXT } from "./boardText";
import { canClean, unreadableNotice, unreferencedSummary, usageBreakdown, usageByDate } from "./usageView";
import { cleanUnreferenced } from "./usageClean";

/** 用量汇总那几行：总数、分项、按日期与说明。 */
function UsageSummary({ usage }: { usage: Usage }) {
  return (
    <>
      <div className="muted small form-hint">{usageBreakdown(usage)}</div>
      <div className="muted small form-hint" data-testid="usage-note">
        用量按文件长度累加：导入画板包时内容相同的文件共用一份磁盘空间，这里会重复计入，实际占用可能更小；清理也不一定释放显示的全部字节。
      </div>
      <div className="muted small form-hint" data-testid="usage-dates">
        {usageByDate(usage)}
      </div>
    </>
  );
}

/** 未引用任务目录：摘要与清理入口。 */
function UnreferencedRow({ usage, busy, onClean }: { usage: Usage; busy: boolean; onClean(): void }) {
  const dirs = usage.unreferenced ?? [];
  return (
    <>
      <div className="form-row">
        <span>未引用任务目录</span>
        <span className="muted small" data-testid="usage-unreferenced-summary">
          {unreferencedSummary(dirs)}
        </span>
        <button onClick={onClean} disabled={!canClean(usage, busy)}>
          清理未引用任务目录…
        </button>
      </div>
      {usage.unreadable_board && (
        <div className="notice notice-warn" data-testid="usage-unreadable">
          {unreadableNotice(usage.unreadable_board)}
        </div>
      )}
      <div className="muted small form-hint" data-testid="usage-idle-rule">{IDLE_USER_RULE_TEXT}</div>
      <div className="muted small form-hint">没有画板引用、建立超过 30 天的任务目录可以清理；清掉的先进回收区，14 天内可找管理员恢复。</div>
    </>
  );
}

/** 清理前的确认框：列出将被移入回收区的目录。 */
function CleanConfirm({ usage, busy, onConfirm, onCancel }: { usage: Usage; busy: boolean; onConfirm(): void; onCancel(): void }) {
  const dirs = usage.unreferenced ?? [];
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label="清理未引用任务目录">
        <div className="modal-head">
          <strong>清理未引用任务目录</strong>
        </div>
        <p className="muted small">以下 {dirs.length} 个任务目录没有任何画板引用，将移入回收区（保留 14 天，只能由管理员恢复）。被引用的结果不在清单里。</p>
        <ul className="usage-candidates">
          {dirs.map((d) => (
            <li key={d.dir}>
              <span className="mono">{d.dir}</span> — {formatBytes(d.bytes)}，最后修改 {new Date(d.last_write * 1000).toLocaleString()}
            </li>
          ))}
        </ul>
        <div className="modal-foot">
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={onConfirm} disabled={busy}>
            {busy ? "正在清理…" : "移入回收区"}
          </button>
        </div>
      </div>
    </div>
  );
}

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
    setBusy(true);
    setError(null);
    const result = await cleanUnreferenced(port, usage);
    if (result.kind === "failed") {
      setError(result.error);
    } else {
      setNote(result.note);
      setConfirm(false);
      await load();
    }
    setBusy(false);
  };

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
          <UsageSummary usage={usage} />
          <UnreferencedRow usage={usage} busy={busy} onClean={() => setConfirm(true)} />
        </>
      )}
      {note && <div className="muted small form-hint">{note}</div>}
      {error && <div className="form-error">{error}</div>}
      {confirm && usage && <CleanConfirm usage={usage} busy={busy} onConfirm={() => void clean()} onCancel={() => setConfirm(false)} />}
    </div>
  );
}
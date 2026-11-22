// 用量与自助清理区块：真实字节统计、未引用预览、阈值与回收恢复均由壳端口提供。
// 可见判定在 ui/usageView.ts（#137），这里只留接线与 DOM 摆放。
import { useCallback, useEffect, useState } from "react";
import type { Usage } from "../shell/types";
import { errorText } from "../core/errors";
import { useShell } from "./shell";
import { formatBytes } from "./boardText";
import { canClean, unreadableNotice, unreferencedSummary, usageBreakdown, usageByDate } from "./usageView";
import { cleanUnreferenced } from "./usageClean";
import { UsageLimitRow } from "./UsageLimitRow";
import { UsageRecycle } from "./UsageRecycle";

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
        <span className="form-row-label">未引用任务目录</span>
        <span className="form-row-hint" data-testid="usage-unreferenced-summary">
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
      <div className="muted small form-hint">这里只清理没有任何画板引用的任务目录；操作前请先备份数据根。</div>
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
        <p className="muted small">以下 {dirs.length} 个任务目录没有任何画板引用，将移入回收区。被引用的结果不在清单里。</p>
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

/** 用量的读取与刷新。 */
function useUsageRead() {
  const port = useShell();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  return { port, usage, setUsage, error, setError, load };
}

export function UsageSection() {
  const { port, usage, error, setError, load } = useUsageRead();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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
      <UsageTotal usage={usage} />
      <UsageLimitRow limitBytes={usage?.limit_bytes ?? null} onSaved={() => void load()} />
      {usage && (
        <>
          <UsageSummary usage={usage} />
          <UnreferencedRow usage={usage} busy={busy} onClean={() => setConfirm(true)} />
          <UsageRecycle onChanged={() => void load()} />
        </>
      )}
      {note && <div className="muted small form-hint">{note}</div>}
      {error && <div className="form-error">{error}</div>}
      {confirm && usage && <CleanConfirm usage={usage} busy={busy} onConfirm={() => void clean()} onCancel={() => setConfirm(false)} />}
    </div>
  );
}

/** 用量总数那一行。 */
function UsageTotal({ usage }: { usage: Usage | null }) {
  return (
    <div className="form-row">
      <span className="form-row-label">用量</span>
      {usage ? (
        <span data-testid="usage-total" className="mono">
          {formatBytes(usage.total_bytes)}
          {usage.limit_bytes !== null && ` / 上限 ${formatBytes(usage.limit_bytes)}`}
        </span>
      ) : (
        <span className="muted small">正在统计…</span>
      )}
    </div>
  );
}

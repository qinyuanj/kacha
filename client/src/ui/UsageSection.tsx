// 用量与自助清理（Web 版，ADR 0018）：高级设置里的一块；清单来自服务端，服务端逐条重算候选资格。
import { useCallback, useEffect, useState } from "react";
import { usage as usagePort } from "../shell/ipc";
import type { Usage } from "../shell/types";
import { errorText } from "../core/errors";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function UsageSection() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsage(await usagePort!.usage());
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
      const result = await usagePort!.cleanupUnreferenced(usage.unreferenced.map((d) => d.dir));
      setNote(`已把 ${result.moved.length} 个任务目录移入回收区${result.skipped.length ? `；${result.skipped.length} 个已不符合条件，未动` : ""}`);
      setConfirm(false);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const dirs = usage?.unreferenced ?? [];
  const unreferencedBytes = dirs.reduce((n, d) => n + d.bytes, 0);
  return (
    <div className="usage-section">
      <div className="form-row">
        <span>用量</span>
        {usage ? <span data-testid="usage-total" className="mono">{formatBytes(usage.total_bytes)}</span> : <span className="muted small">正在统计…</span>}
      </div>
      {usage && (
        <>
          <div className="muted small form-hint">
            画板 {formatBytes(usage.boards_bytes)}；设置与缓存 {formatBytes(usage.meta_bytes)}；最后访问 {new Date(usage.last_access * 1000).toLocaleString()}
          </div>
          <div className="muted small form-hint" data-testid="usage-note">
            用量按文件长度累加：导入画板包时内容相同的文件共用一份磁盘空间，这里会重复计入，实际占用可能更小；清理也不一定释放显示的全部字节。
          </div>
          <div className="muted small form-hint" data-testid="usage-dates">
            {usage.by_date.length === 0 ? "还没有任务目录" : usage.by_date.map((d) => `${d.date}：${formatBytes(d.bytes)}`).join("；")}
          </div>
          <div className="form-row">
            <span>未引用任务目录</span>
            <span className="muted small" data-testid="usage-unreferenced-summary">
              {dirs.length === 0 ? "没有未引用任务目录" : `${dirs.length} 个未引用任务目录，共 ${formatBytes(unreferencedBytes)}`}
            </span>
            <button onClick={() => setConfirm(true)} disabled={!dirs.length || !!usage.unreadable_board || busy}>
              清理未引用任务目录…
            </button>
          </div>
          {usage.unreadable_board && (
            <div className="notice notice-warn" data-testid="usage-unreadable">
              画板读不懂（{usage.unreadable_board}），为避免误删暂不清理；仍被画板引用的结果不会按时间清理。
            </div>
          )}
          <div className="muted small form-hint">只有所有画板都不再引用、且建立超过 30 天的任务目录才会被清理；删除后先进入回收区，14 天内可由管理员恢复。</div>
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

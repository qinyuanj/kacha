// 回收区：用户自己查看、恢复与清理期满项；原位置与清理时间来自 Go（#159）。
import { useCallback, useEffect, useState } from "react";
import { errorText } from "../core/errors";
import type { RecycleEntry } from "../shell/types";
import { formatBytes } from "./boardText";
import { useShell } from "./shell";

interface Props {
  onChanged(): void;
}

/** 回收区的读与写：每步都经壳端口，失败给文字说明，不静默成功。 */
function useRecycle() {
  const port = useShell();
  const [entries, setEntries] = useState<RecycleEntry[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await port.usage.recycle());
    } catch (e) {
      setNote(errorText(e));
    }
  }, [port]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await action();
      await load();
    } catch (e) {
      setNote(errorText(e));
    }
    setBusy(false);
  };

  return { port, entries, note, busy, load, run };
}

/** 回收区的一行：期内可恢复，期满只等用户确认清理，不提前删除。 */
function RecycleRow({ entry, busy, onRestore }: { entry: RecycleEntry; busy: boolean; onRestore(entry: RecycleEntry): void }) {
  return (
    <div className="form-row" key={entry.id} data-testid="recycle-entry">
      <span className="mono">{entry.dir}</span>
      <span className="muted small">{formatBytes(entry.bytes)}，清理于 {new Date(entry.cleaned_at * 1000).toLocaleString()}</span>
      <span className={entry.expired ? "form-error" : "muted small"}>{entry.expired ? "已期满" : "保留中"}</span>
      <button data-testid="recycle-restore" onClick={() => onRestore(entry)} disabled={entry.expired || busy}>恢复</button>
    </div>
  );
}

export function UsageRecycle({ onChanged }: Props) {
  const { port, entries, note, busy, run } = useRecycle();
  const hasExpired = entries.some((e) => e.expired);

  const restore = (entry: RecycleEntry) => run(async () => {
    await port.usage.restore(entry.id);
    onChanged();
  });
  const purge = () => run(async () => {
    await port.usage.purgeExpired();
    onChanged();
  });

  return (
    <div className="usage-recycle" data-testid="usage-recycle">
      <div className="form-row">
        <span>回收区</span>
        <span className="muted small">清理内容保留 14 天；期内不提前删除，归档画板不按时间清理。</span>
        <button data-testid="recycle-purge" onClick={() => void purge()} disabled={!hasExpired || busy}>清理期满项</button>
      </div>
      {entries.length === 0 && <div className="muted small form-hint" data-testid="recycle-empty">回收区为空</div>}
      {entries.map((entry) => <RecycleRow key={entry.id} entry={entry} busy={busy} onRestore={restore} />)}
      {note && <div className="form-error">{note}</div>}
    </div>
  );
}
// 容量提醒阈值：经壳端口写到本机元数据，只提醒、不阻止生成（#159）。
import { useEffect, useState } from "react";
import { errorText } from "../core/errors";
import { useShell } from "./shell";
import { limitDraftOf, parseLimitDraft } from "./usageLimitInput";

interface Props {
  limitBytes: number | null;
  onSaved(): void;
}

export function UsageLimitRow({ limitBytes, onSaved }: Props) {
  const port = useShell();
  const [draft, setDraft] = useState(() => limitDraftOf(limitBytes));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(limitDraftOf(limitBytes)), [limitBytes]);

  const save = async () => {
    const parsed = parseLimitDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await port.usage.setLimit(parsed.bytes);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  return (
    <>
      <label className="form-row">
        <span>容量提醒阈值（MiB）</span>
        <input data-testid="usage-limit-input" type="number" min="0" step="0.1" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        <button data-testid="usage-limit-save" onClick={() => void save()} disabled={busy}>保存阈值</button>
      </label>
      <div className="muted small form-hint">只提醒，不阻止生成；留空保存即清除提醒。这里是本机文件占用，不是 token 或金额配额。</div>
      {error && <div className="form-error">{error}</div>}
    </>
  );
}

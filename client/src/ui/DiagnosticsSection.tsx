// 排障信息（诊断包导出，#162）：入口与结局提示都在这一段，SettingsPanel 只负责摆放。
//
// 取消不是成功：只给中性说明；失败显示 Go 给的具体原因。导出只读本机数据根，
// 不改画板、不写创作数据。
import { useState } from "react";
import { useShell } from "./shell";
import { portFailureOf } from "../shell/port";

/** 导出的结局文案：成功给字节数，取消中性说明，失败给原因。 */
export function diagnosticsMessageOf(outcome: { kind: "saved"; bytes: number } | { kind: "cancelled" } | { kind: "failed"; message: string }): string {
  if (outcome.kind === "saved") return `诊断包已保存（${outcome.bytes} 字节）`;
  if (outcome.kind === "cancelled") return "已取消导出诊断包";
  return outcome.message;
}

/** 排障信息那一行：有诊断能力才显示导出入口。 */
export function DiagnosticsSection() {
  const port = useShell();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!port.features.diagnostics) return null;

  const exportDiagnostics = async () => {
    setBusy(true);
    try {
      setMessage(diagnosticsMessageOf(await port.ui.exportDiagnostics()));
    } catch (e) {
      setMessage(portFailureOf(e).message || "导出诊断包失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="form-row">
        <span className="form-row-label">排障信息</span>
        <button onClick={() => void exportDiagnostics()} disabled={busy}>{busy ? "导出中…" : "导出诊断包"}</button>
        <span className="form-row-hint">只含版本、平台、运行状态与脱敏日志；不含密钥、鉴权头或画板内容。</span>
      </div>
      {message && <div className="muted small form-hint">{message}</div>}
    </>
  );
}

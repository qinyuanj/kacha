// 容量提醒阈值的输入换算：界面以 MiB 呈现，本机按字节持久化（#159）。
const MIB = 1024 * 1024;

/** 已保存的字节 → 输入框草稿；null 表示没有阈值。 */
export function limitDraftOf(bytes: number | null): string {
  if (bytes === null) return "";
  return String(Math.round((bytes / MIB) * 100) / 100);
}

export type ParsedLimit = { ok: true; bytes: number } | { ok: false; error: string };

/** 草稿 → 字节；留空是清除阈值（0），非法值明确拒绝。 */
export function parseLimitDraft(draft: string): ParsedLimit {
  const text = draft.trim();
  if (!text) return { ok: true, bytes: 0 };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return { ok: false, error: "容量提醒阈值要填非负数字（MiB）" };
  const bytes = Math.round(value * MIB);
  if (!Number.isSafeInteger(bytes)) return { ok: false, error: "容量提醒阈值太大" };
  return { ok: true, bytes };
}

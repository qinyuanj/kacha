// 用量区块的清理接线（#137）：从 ui/UsageSection.tsx 拆出的模块级函数，便于单测。
import { errorText } from "../core/errors";
import type { Usage } from "../shell/types";
import { cleanupNote } from "./usageView";

/** 清理用的端口。 */
export interface CleanPort {
  usage: {
    cleanupUnreferenced(dirs: string[]): Promise<{ moved: { dir: string; bytes: number; last_write: number }[]; skipped: string[] }>;
  };
}

/** 清理的结果。 */
export type CleanResult =
  /** 清理成功：给一句说明。 */
  | { kind: "done"; note: string }
  /** 清理失败：给错误说明。 */
  | { kind: "failed"; error: string };

/** 清掉未被引用的结果目录；失败时给错误说明。 */
export async function cleanUnreferenced(port: CleanPort, usage: Usage | null): Promise<CleanResult> {
  if (!usage?.unreferenced) return { kind: "done", note: "" };
  try {
    const result = await port.usage.cleanupUnreferenced(usage.unreferenced.map((d) => d.dir));
    return { kind: "done", note: cleanupNote(result) };
  } catch (e) {
    return { kind: "failed", error: errorText(e) };
  }
}

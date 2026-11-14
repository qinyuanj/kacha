// 画板包导入的接线（#137）：从 ui/useBoardPack.ts 拆出的模块级函数，便于单测。
import type { ImportOptions, ImportPhase } from "../core/boardPack";
import { errorText } from "../core/errors";
import { slotsRefusal } from "./boardText";
import { importOutcome } from "./boardPackImport";
import type { PackDialogState } from "./BoardPackDialog";
import type { LogKind } from "../shell/log";

/** 导入的结局。 */
export type PackImportResult =
  /** 一句话提示。 */
  | { kind: "toast"; text: string }
  /** 导入失败（抛错）。 */
  | { kind: "failed"; text: string }
  /** 弹窗说明结局。 */
  | { kind: "dialog"; state: PackDialogState };

/** 导入的依赖。 */
export interface PackImportDeps {
  pickPackFile(): Promise<File | null>;
  import(file: File, options: ImportOptions): Promise<{ kind: string } & Record<string, unknown>>;
  listSlots(): Promise<{ used: number; total: number } | null>;
  /** 打开导入的画板（导入成功后逐个打开）。 */
  openBoard(path: string): Promise<void>;
  log(kind: LogKind, fields: Record<string, unknown>): void;
}

/** 导入的接线：从端口取文件、预检画板位、跑导入、给结局。 */
export async function packImportOutcome(
  deps: PackImportDeps,
  progress: (title: string) => () => void,
  onPhase: (phase: ImportPhase) => void,
): Promise<PackImportResult> {
  let file: File | null;
  try {
    file = await deps.pickPackFile();
  } catch (e) {
    return { kind: "failed", text: `导入画板包失败：${errorText(e)}` };
  }
  if (!file) return { kind: "failed", text: "" };
  try {
    const result = await deps.import(file, {
      file,
      openBoard: (path) => deps.openBoard(path),
      // 画板位预检（#89）：读不到列表时不拦，服务端合并前仍会检查。
      slotsRefusal: async (adding) => {
        const slots = await deps.listSlots();
        return slots ? slotsRefusal(slots, adding) : null;
      },
      onStage: progress(`正在导入画板包：${file.name}`),
      onPhase,
      log: (kind, fields) => deps.log(kind, fields),
    });
    const outcome = importOutcome(result as never);
    if (outcome.kind === "toast") return { kind: "toast", text: outcome.text };
    return { kind: "dialog", state: outcome.state };
  } catch (e) {
    return { kind: "failed", text: `导入画板包失败：${errorText(e)}` };
  }
}

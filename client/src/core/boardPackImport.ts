// 画板包命令的取消编排；桌面导入由 Go packimport 执行。
import { errorText } from "./errors";
import { PACK_CANCELLED, type PackIo, type Outcome } from "./boardPackTypes";

/** 先复位取消标记，复位之后才进入进度阶段（调用方在此弹进度），再跑命令：进度弹出后立刻点的取消才不会丢。 */
export async function runCancellable<T>(io: PackIo, onStage: (stage: "progress") => void, run: () => Promise<T>): Promise<Outcome<T>> {
  await io.cancel(false);
  onStage("progress");
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    const error = errorText(e);
    return { ok: false, result: error === PACK_CANCELLED ? "cancelled" : "failed", error };
  }
}

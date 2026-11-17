// 迁移本机数据位置的一步（#161）：拦下 → 选目标 → 确认 → 准备 → 迁移 → 重映射界面状态 → 收尾。
// 搬字节与校验在 Go 侧（internal/storage + internal/moveroot）；这里只管顺序与页面状态。
import { moveBlockedReason, moveMessageOf, remapUiState, type MoveGuard } from "../core/dataRoot";
import { parseUiState, serializeUiState } from "../core/uiState";
import { portFailureOf, type ShellPort } from "../shell/port";

/** 迁移前后的准备与收尾由工作台给：落盘、拦新提交、重新载入。 */
export interface DataRootActions {
	/** 迁移前：把未落盘的画板全部写完，并阻止新的冲突操作。 */
	prepare(): Promise<void>;
	/** 迁移结束（成败都调）：解除准备期的阻止；moved 时重新载入页面，让数据根地址重新读一次。 */
	finish(moved: boolean): void;
	/** 现在能不能开始迁移。 */
	guard(): MoveGuard;
}

const CANCELLED = moveMessageOf({ kind: "cancelled" });

export function confirmTextOf(target: string): string {
	return `把本机数据迁到 ${target}？\n\n内容会整份复制并逐字节校验，成功后才切换；旧位置保留不动。`;
}

/** 界面状态里存的是绝对路径：换根之后它们要跟着搬到新位置，否则重启恢复会找不到画板。 */
async function rebaseUiState(port: ShellPort, from: string, to: string): Promise<void> {
	const text = await port.meta.readUiState();
	if (text === null) return;
	await port.meta.writeUiState(serializeUiState(remapUiState(parseUiState(text), from, to)));
}

/** 迁移并报告结局；失败时抛出去，由调用方决定怎么说。 */
async function moveAndRebase(port: ShellPort, target: string, from: string): Promise<string> {
	const result = await port.dataRoot.move(target);
	await rebaseUiState(port, from, result.root);
	return moveMessageOf({ kind: "moved", root: result.root, files: result.files });
}

/** 已经拦过、选过、确认过：先落盘再迁移，成败都解除准备期阻止。 */
async function runPrepared(port: ShellPort, actions: DataRootActions, target: string, from: string, report: (message: string) => void): Promise<void> {
	await actions.prepare();
	try {
		report(await moveAndRebase(port, target, from));
		actions.finish(true);
	} catch (e) {
		// 失败时数据根没动：解除准备期的阻止，让用户接着干活。
		report(moveMessageOf({ kind: "failed", message: portFailureOf(e).message || "迁移失败" }));
		actions.finish(false);
	}
}

/** 走完一步迁移；每一步的结局都用 report 说出来，不吞成成功。 */
export async function performMove(port: ShellPort, actions: DataRootActions, report: (message: string) => void): Promise<void> {
	const blocked = moveBlockedReason(actions.guard());
	if (blocked) return report(blocked);
	const target = await port.dataRoot.pick();
	if (target === "") return report(CANCELLED);
	const from = (await port.dataRoot.status()).root;
	if (!(await port.ui.ask(confirmTextOf(target)))) return report(CANCELLED);
	await runPrepared(port, actions, target, from, report);
}

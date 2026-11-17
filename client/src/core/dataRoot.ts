// 数据位置迁移的纯逻辑（#161）：迁移前的拦截判定、界面状态里的路径重映射、结局文案。
// 这里不碰端口、不碰 DOM，单测直接覆盖；组件只负责摆放与调用。
import type { UiState } from "./uiState";

/** 迁移前要问的三件事：有没有在途任务、打包是否在跑、是不是已经在迁移。 */
export interface MoveGuard {
	/** 在途生成任务数（读图中、排队、执行、退避）。 */
	pending: number;
	/** 画板包导入 / 导出是否在跑。 */
	packBusy: boolean;
	/** 这一次点击是否已经在迁移中（按钮防重入）。 */
	moving: boolean;
}

/** 不能开始迁移的原因；能开始返回 null。 */
export function moveBlockedReason(guard: MoveGuard): string | null {
	if (guard.moving) return "正在迁移数据位置";
	if (guard.pending > 0) return `还有 ${guard.pending} 个任务没结束；等它们跑完或取消后再迁移`;
	if (guard.packBusy) return "正在导入或导出画板包；等它结束再迁移";
	return null;
}

const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();

/** 把数据根内的绝对路径从旧位置换到新位置；根外的路径原样保留。 */
export function remapPath(path: string, fromRoot: string, toRoot: string): string {
	const from = norm(fromRoot);
	const target = norm(path);
	if (target === from) return toRoot;
	if (!target.startsWith(`${from}/`)) return path;
	const rest = path.replace(/[\\/]+/g, "/").slice(from.length + 1);
	const sep = /^[a-zA-Z]:[\\/]/.test(toRoot) ? "\\" : "/";
	return [toRoot.replace(/[\\/]+$/, ""), ...rest.split("/")].join(sep);
}

/** 迁移后界面状态里的路径跟着换位置：打开的画板与体量提示都不指向旧位置。 */
export function remapUiState(state: UiState, fromRoot: string, toRoot: string): UiState {
	const notices = state.size_notices
		? Object.fromEntries(Object.entries(state.size_notices).map(([p, tier]) => [remapPath(p, fromRoot, toRoot), tier]))
		: undefined;
	const next: UiState = {
		open_boards: state.open_boards.map((p) => remapPath(p, fromRoot, toRoot)),
		active_board: state.active_board ? remapPath(state.active_board, fromRoot, toRoot) : null,
	};
	if (state.last_seen_version !== undefined) next.last_seen_version = state.last_seen_version;
	if (notices) next.size_notices = notices;
	return next;
}

/** 迁移结局的说法：成功说清新位置与文件数，取消是中性说明，失败给 Go 的原因。 */
export function moveMessageOf(outcome: { kind: "moved"; root: string; files: number } | { kind: "cancelled" } | { kind: "failed"; message: string }): string {
	if (outcome.kind === "moved") return `已迁移 ${outcome.files} 个文件到 ${outcome.root}`;
	if (outcome.kind === "cancelled") return "已取消迁移；数据仍在原来的位置";
	return outcome.message;
}

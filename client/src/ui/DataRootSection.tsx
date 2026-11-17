// 本机数据位置（#161）：显示当前数据根，选一个新位置并把整份数据迁过去。
//
// 迁移由 Go 完成（复制 → 校验 → 原子切换记录），旧位置一直可用；本段只负责摆放与调用，
// 顺序与结局见 ui/dataRootMove.ts。
import { useEffect, useState } from "react";
import { useShell } from "./shell";
import { performMove, type DataRootActions } from "./dataRootMove";

export type { DataRootActions } from "./dataRootMove";

/** 当前数据根那一行：地址读不到时只说「读取中」，不挡住迁移入口。 */
function RootRow({ root, busy, onMove }: { root: string | null; busy: boolean; onMove(): void }) {
	return (
		<div className="form-row">
			<span>数据位置</span>
			<button onClick={onMove} disabled={busy}>{busy ? "迁移中…" : "迁移到其他位置…"}</button>
			<span className="muted small">{root ?? "读取中…"}</span>
		</div>
	);
}

export function DataRootSection({ actions }: { actions: DataRootActions }) {
	const port = useShell();
	const [message, setMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [root, setRoot] = useState<string | null>(null);
	const enabled = port.features.dataRoot;
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		void port.dataRoot.status().then((s) => { if (live) setRoot(s.root); }).catch(() => { if (live) setRoot(""); });
		return () => { live = false; };
	}, [enabled, port]);
	if (!enabled) return null;

	const move = (): void => {
		setBusy(true);
		setMessage(null);
		void performMove(port, actions, setMessage).finally(() => setBusy(false));
	};

	return (
		<>
			<RootRow root={root} busy={busy} onMove={move} />
			<div className="muted small form-hint">
				画板、任务目录、导入参考图与设置会整份复制到新位置并逐字节校验，成功后才切换；
				失败或中途取消时数据仍在原位置。API 密钥随同一份数据搬迁，换位置不改变本机画板身份。
			</div>
			{message !== null && <div className="muted small form-hint" data-testid="data-root-message">{message}</div>}
		</>
	);
}

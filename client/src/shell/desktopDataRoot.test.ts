// 本机数据位置（#161）：桌面端口把状态、选目标与迁移接到真实的 Storage 绑定上，
// 并用类型化失败说清「这个目标不行」的几种情况。
import { describe, expect, it } from "vitest";

import { createDesktopPort, type DesktopBridge, type DesktopDataRootBridge, type DesktopDataRootOutcome, type DesktopInfo, type DesktopLocalBridge } from "./desktop";
import { portFailureOf } from "./port";

const INFO: DesktopInfo = {
	version: "1.6.0",
	user_data_root: "C:/data",
	board_root: "C:/data/画板",
	features: { generation: false, usage: false, pack_export: false },
};

function local(): DesktopLocalBridge {
	return new Proxy({} as DesktopLocalBridge, { get: () => () => Promise.reject(new Error("没实现的本地调用")) });
}

function bridgeWith(dataRoot?: DesktopDataRootBridge): DesktopBridge {
	return { info: () => Promise.resolve(INFO), local: local(), ...(dataRoot ? { dataRoot } : {}) };
}

function ready(overrides: Partial<DesktopDataRootBridge> = {}): DesktopDataRootBridge {
	return {
		status: () => Promise.resolve({ root: "C:/data", moving: false, done: 0, total: 0 }),
		pick: () => Promise.resolve("D:/新位置"),
		move: () => Promise.resolve<DesktopDataRootOutcome>({ ok: true, kind: "", message: "", root: "D:/新位置", files: 7, bytes: 1024 }),
		...overrides,
	};
}

async function failureOf(run: () => Promise<unknown>) {
	try {
		await run();
	} catch (e) {
		return portFailureOf(e);
	}
	throw new Error("本应拒绝");
}

describe("数据位置（#161）", () => {
	it("桥上有 Storage 才开放；状态与选目标直通 Go", async () => {
		const { port } = await createDesktopPort(bridgeWith(ready()));
		expect(port.features.dataRoot).toBe(true);
		expect(await port.dataRoot.status()).toEqual({ root: "C:/data", moving: false, done: 0, total: 0 });
		expect(await port.dataRoot.pick()).toBe("D:/新位置");
	});

	it("没有 Storage 绑定时明确不可用，不以空成功冒充", async () => {
		const { port } = await createDesktopPort(bridgeWith());
		expect(port.features.dataRoot).toBe(false);
		const failure = await failureOf(() => port.dataRoot.move("D:/新位置"));
		expect(failure.kind).toBe("unavailable");
		expect(failure.feature).toBe("dataRoot");
	});

	it("成功迁移返回新数据根与文件数", async () => {
		const { port } = await createDesktopPort(bridgeWith(ready()));
		await expect(port.dataRoot.move("D:/新位置")).resolves.toEqual({ root: "D:/新位置", files: 7, bytes: 1024 });
	});

	it("目标已有内容 / 路径越界 / 取消各有各的类别，消息照抄 Go", async () => {
		const cases: [string, string, string][] = [
			["notEmpty", "conflict", "目标位置里已有内容"],
			["nested", "invalid", "目标在数据根里面"],
			["sameRoot", "invalid", "就是当前位置"],
			["cancelled", "cancelled", "已取消迁移"],
			["failed", "failed", "复制失败"],
		];
		for (const [kind, expected, message] of cases) {
			const { port } = await createDesktopPort(bridgeWith(ready({ move: () => Promise.resolve<DesktopDataRootOutcome>({ ok: false, kind, message, root: "", files: 0, bytes: 0 }) })));
			const failure = await failureOf(() => port.dataRoot.move("D:/x"));
			expect([failure.kind, failure.message]).toEqual([expected, message]);
		}
	});
});

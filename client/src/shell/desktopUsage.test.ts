// #159：用量、清理与回收经桌面桥接到 Go 的 Usage 服务，不能用替身冒充。
import { describe, expect, it, vi } from "vitest";

import { createDesktopPort, type DesktopBridge, type DesktopCleanupResult, type DesktopInfo, type DesktopLocalBridge, type DesktopRecycleEntry, type DesktopUsage, type DesktopUsageBridge } from "./desktop";
import { portFailureOf } from "./port";

const INFO: DesktopInfo = {
	version: "1.5.0",
	user_data_root: "C:/data",
	board_root: "C:/data/画板",
	features: { generation: false, usage: true, pack_export: false },
};

const USAGE: DesktopUsage = {
	total_bytes: 2048,
	boards_bytes: 1024,
	meta_bytes: 1024,
	last_access: 123,
	by_date: [{ date: "2026-11-01", bytes: 512 }],
	unreferenced: [{ dir: "2026-11-01/x", bytes: 512, last_write: 120 }],
	unreadable_board: null,
	limit_bytes: 4096,
	limit_level: "warn",
};

const CLEAN_OK: DesktopCleanupResult = {
	ok: true, kind: "", message: "",
	moved: [{ dir: "2026-11-01/x", bytes: 512, last_write: 120 }],
	skipped: [], failed: [],
};

const RECYCLED: DesktopRecycleEntry[] = [
	{ id: "r000001", dir: "2026-11-01/x", bytes: 512, cleaned_at: 100, location: "回收区/任务目录/r000001", expired: false },
];

function makeBridge(usage: DesktopUsageBridge, info: DesktopInfo = INFO): DesktopBridge {
	const local = new Proxy({} as DesktopLocalBridge, {
		get: () => () => Promise.reject(new Error("没实现的本地调用")),
	});
	return { info: () => Promise.resolve(info), local, usage };
}

describe("桌面用量端口", () => {
	it("读到 Go 的真实用量与提醒档位", async () => {
		const usage = vi.fn(async () => USAGE);
		const { port } = await createDesktopPort(makeBridge({ usage } as unknown as DesktopUsageBridge));
		expect(port.features.usage).toBe(true);
		expect(await port.usage.usage()).toEqual(USAGE);
		expect(usage).toHaveBeenCalledOnce();
	});

	it("Go 的未引用结局原样给出，失败按类别折成 PortError", async () => {
		const usage = {
			usage: async () => USAGE,
			cleanup: vi.fn(async () => CLEAN_OK),
		} as unknown as DesktopUsageBridge;
		const { port } = await createDesktopPort(makeBridge(usage));
		expect(await port.usage.cleanupUnreferenced(["2026-11-01/x"])).toEqual(CLEAN_OK);
		expect(usage.cleanup).toHaveBeenCalledWith(["2026-11-01/x"]);

		(usage.cleanup as unknown as { mockImplementation: (fn: () => Promise<DesktopCleanupResult>) => void }).mockImplementation(async () => ({
			ok: false, kind: "invalid", message: "画板读不懂", moved: [], skipped: [], failed: [],
		}));
		try {
			await port.usage.cleanupUnreferenced(["2026-11-01/x"]);
			throw new Error("应当拒绝");
		} catch (e) {
			expect(portFailureOf(e).kind).toBe("invalid");
		}
	});

	it("阈值、回收列表、恢复与期满清理都走各自绑定", async () => {
		const setLimit = vi.fn(async () => ({ ok: true, kind: "", message: "" }));
		const recycle = vi.fn(async () => RECYCLED);
		const restore = vi.fn(async () => ({ ok: false, kind: "alreadyExists", message: "原位置已有内容，未覆盖" }));
		const purgeExpired = vi.fn(async () => ({ ok: true, kind: "", message: "已清理 0 个期满项" }));
		const { port } = await createDesktopPort(makeBridge({ usage: async () => USAGE, cleanup: async () => CLEAN_OK, setLimit, recycle, restore, purgeExpired } as unknown as DesktopUsageBridge));

		await port.usage.setLimit(1024);
		expect(setLimit).toHaveBeenCalledWith(1024);
		expect(await port.usage.recycle()).toEqual(RECYCLED);
		expect(recycle).toHaveBeenCalledOnce();
		try {
			await port.usage.restore("r000001");
			throw new Error("应当拒绝");
		} catch (e) {
			expect(portFailureOf(e).kind).toBe("alreadyExists");
		}
		expect(restore).toHaveBeenCalledWith("r000001");
		await port.usage.purgeExpired();
		expect(purgeExpired).toHaveBeenCalledOnce();
	});

	it("能力关着或桥缺失时仍明确不可用，不假装成功", async () => {
		const off = { ...INFO, features: { ...INFO.features, usage: false } };
		const { port } = await createDesktopPort(makeBridge({} as DesktopUsageBridge, off));
		await expect(port.usage.usage()).rejects.toMatchObject({ kind: "unavailable", feature: "usage" });

		const missing = makeBridge({} as DesktopUsageBridge);
		delete (missing as { usage?: DesktopUsageBridge }).usage;
		const { port: missingPort } = await createDesktopPort(missing);
		await expect(missingPort.usage.usage()).rejects.toMatchObject({ kind: "unavailable", feature: "usage" });
	});

	it("绑定抛错折成 failed，不静默当成功", async () => {
		const bridge = makeBridge({ usage: async () => { throw new Error("boom"); } } as unknown as DesktopUsageBridge);
		const { port } = await createDesktopPort(bridge);
		try {
			await port.usage.usage();
			throw new Error("应当失败");
		} catch (e) {
			expect(portFailureOf(e).kind).toBe("failed");
		}
	});
});

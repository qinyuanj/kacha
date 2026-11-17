import { describe, expect, it } from "vitest";
import { moveBlockedReason, moveMessageOf, remapPath, remapUiState } from "./dataRoot";

describe("迁移前的拦截（#161）", () => {
	it("没有在途任务、打包空闲时放行", () => {
		expect(moveBlockedReason({ pending: 0, packBusy: false, moving: false })).toBeNull();
	});

	it("有在途生成任务时说清还有几个，等它们结束", () => {
		const reason = moveBlockedReason({ pending: 3, packBusy: false, moving: false });
		expect(reason).toContain("3");
		expect(reason).toContain("任务");
	});

	it("打包在跑时不让开始", () => {
		expect(moveBlockedReason({ pending: 0, packBusy: true, moving: false })).toContain("画板包");
	});

	it("已经在迁移时按钮防重入", () => {
		expect(moveBlockedReason({ pending: 0, packBusy: false, moving: true })).toContain("正在迁移");
	});
});

describe("路径重映射", () => {
	it("数据根内的路径换成新根，其余不动", () => {
		expect(remapPath("C:\\data\\画板\\a.json", "C:\\data", "D:\\新位置")).toBe("D:\\新位置\\画板\\a.json");
		expect(remapPath("C:\\other\\a.json", "C:\\data", "D:\\新位置")).toBe("C:\\other\\a.json");
	});

	it("大小写与斜杠方向不影响判定", () => {
		expect(remapPath("c:/DATA/画板/a.json", "C:\\data", "D:\\新位置")).toBe("D:\\新位置\\画板\\a.json");
	});

	it("界面状态里打开的画板与体量提示都跟着换位置", () => {
		const state = {
			open_boards: ["C:\\data\\画板\\a.json", "C:\\out\\b.json"],
			active_board: "C:\\data\\画板\\a.json",
			last_seen_version: "1.2.0",
			size_notices: { "C:\\data\\画板\\a.json": "warn" as const },
		};
		const next = remapUiState(state, "C:\\data", "D:\\新位置");
		expect(next.open_boards).toEqual(["D:\\新位置\\画板\\a.json", "C:\\out\\b.json"]);
		expect(next.active_board).toBe("D:\\新位置\\画板\\a.json");
		expect(next.last_seen_version).toBe("1.2.0");
		expect(next.size_notices).toEqual({ "D:\\新位置\\画板\\a.json": "warn" });
	});
});

describe("结局文案", () => {
	it("成功说清文件数与新位置", () => {
		expect(moveMessageOf({ kind: "moved", root: "D:\\新位置", files: 7 })).toContain("7");
		expect(moveMessageOf({ kind: "moved", root: "D:\\新位置", files: 7 })).toContain("D:\\新位置");
	});

	it("取消不是成功", () => {
		expect(moveMessageOf({ kind: "cancelled" })).toContain("取消");
	});

	it("失败照抄原因", () => {
		expect(moveMessageOf({ kind: "failed", message: "目标位置里已有内容" })).toBe("目标位置里已有内容");
	});
});

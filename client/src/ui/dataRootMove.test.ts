// 迁移一步的接线（#161）：确认文案、界面状态缺席时的行为、失败时的收尾。
import { describe, expect, it, vi } from "vitest";
import { createFakePort } from "../shell/testing/fakePort";
import { confirmTextOf, performMove, type DataRootActions } from "./dataRootMove";

function actions(): DataRootActions {
	return { prepare: vi.fn(async () => undefined), finish: vi.fn(), guard: () => ({ pending: 0, packBusy: false, moving: false }) };
}

describe("迁移一步", () => {
	it("确认文案说清目标、校验与旧位置保留", () => {
		const text = confirmTextOf("D:\\新位置");
		expect(text).toContain("D:\\新位置");
		expect(text).toContain("校验");
		expect(text).toContain("旧位置保留");
	});

	it("没有界面状态可写时照样迁移完成，不因重映射失败而中断", async () => {
		const port = createFakePort({ userRoot: "C:\\data", pickTargets: ["D:\\新位置"], moveFiles: 2 });
		port.meta.readUiState = async () => null;
		const a = actions();
		const report = vi.fn();
		await performMove(port, a, report);
		expect(port.calls.moveTargets).toEqual(["D:\\新位置"]);
		expect(report).toHaveBeenCalledWith(expect.stringContaining("2"));
		expect(a.finish).toHaveBeenCalledWith(true);
		expect(port.calls.uiStateWrites).toEqual([]);
	});

	it("用户否认确认时不落盘也不迁移", async () => {
		const port = createFakePort({ pickTargets: ["D:\\新位置"] });
		port.ui.ask = async () => false;
		const a = actions();
		const report = vi.fn();
		await performMove(port, a, report);
		expect(a.prepare).not.toHaveBeenCalled();
		expect(port.calls.moveTargets ?? []).toEqual([]);
		expect(report).toHaveBeenCalledWith(expect.stringContaining("取消"));
	});
});

// @vitest-environment jsdom
// 数据位置迁移的界面行为（#161）：入口只在能力打开时出现；有在途任务时拦下；
// 成功迁移后界面状态里的路径换到新根并重新载入；失败照抄 Go 的原因。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePort, type FakePort, type FakePortOptions } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { DataRootSection } from "./DataRootSection";
import type { DataRootActions } from "./dataRootMove";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let dom: ReactRoot;

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	dom = createRoot(container);
});

afterEach(async () => {
	await act(async () => dom.unmount());
	container.remove();
});

function actions(guard: () => { pending: number; packBusy: boolean; moving: boolean } = () => ({ pending: 0, packBusy: false, moving: false })) {
	return { prepare: vi.fn(async () => undefined), finish: vi.fn(), guard };
}

async function show(port: FakePort, a: DataRootActions): Promise<void> {
	await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(DataRootSection, { actions: a }) })));
	await act(async () => undefined);
}

function button(): HTMLButtonElement | null {
	return [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("迁移")) ?? null;
}

function message(): string {
	return container.querySelector("[data-testid=data-root-message]")?.textContent ?? "";
}

describe("数据位置入口", () => {
	it("没有 Storage 绑定时入口不出现", async () => {
		await show(createFakePort({ missing: ["dataRoot"] }), actions());
		expect(button()).toBeNull();
	});

	it("能力打开时显示当前数据根", async () => {
		await show(createFakePort({ userRoot: "C:\\data" }), actions());
		expect(button()).not.toBeNull();
		expect(container.textContent).toContain("C:\\data");
	});
});

describe("迁移的拦截与结局", () => {
	it.each([
		{ label: "有在途生成任务", guard: () => ({ pending: 2, packBusy: false, moving: false }), reason: "2" },
		{ label: "打包在跑", guard: () => ({ pending: 0, packBusy: true, moving: false }), reason: "画板包" },
	])("$label：不发起迁移，只说清原因", async ({ guard, reason }) => {
		const options: FakePortOptions = { pickTargets: ["D:\\新位置"] };
		const port = createFakePort(options);
		const a = actions(guard);
		await show(port, a);
		await act(async () => button()!.click());
		expect(a.prepare).not.toHaveBeenCalled();
		expect(port.calls.moveTargets ?? []).toEqual([]);
		expect(message()).toContain(reason);
	});

	it("用户取消选目录时不迁移，也不是成功", async () => {
		const port = createFakePort({ pickTargets: [] });
		const a = actions();
		await show(port, a);
		await act(async () => button()!.click());
		expect(a.prepare).not.toHaveBeenCalled();
		expect(message()).toContain("取消");
	});

	it("确认后先落盘再迁移，成功后把界面状态换到新根并重新载入", async () => {
		const port = createFakePort({ userRoot: "C:\\data", pickTargets: ["D:\\新位置"], moveFiles: 7 });
		const moveSpy = vi.spyOn(port.dataRoot, "move");
		port.meta.readUiState = async () => JSON.stringify({ open_boards: ["C:\\data\\画板\\a.ugcboard.json"], active_board: "C:\\data\\画板\\a.ugcboard.json" });
		const a = actions();
		await show(port, a);
		await act(async () => button()!.click());
		expect(a.prepare).toHaveBeenCalledTimes(1);
		expect(a.prepare.mock.invocationCallOrder[0]).toBeLessThan(moveSpy.mock.invocationCallOrder[0]);
		expect(port.calls.moveTargets).toEqual(["D:\\新位置"]);
		expect(a.finish).toHaveBeenCalledWith(true);
		expect(message()).toContain("7");
		const written = JSON.parse(port.calls.uiStateWrites.at(-1)!);
		expect(written.open_boards).toEqual(["D:\\新位置\\画板\\a.ugcboard.json"]);
	});

	it("迁移失败照抄 Go 的原因，不重新载入", async () => {
		const port = createFakePort({ pickTargets: ["D:\\新位置"], moveFailure: "conflict" });
		const a = actions();
		await show(port, a);
		await act(async () => button()!.click());
		expect(a.finish).toHaveBeenCalledWith(false);
		expect(message()).toContain("迁移失败");
		expect(message()).toContain("conflict");
	});
});
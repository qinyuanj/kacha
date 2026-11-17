// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecycleEntry } from "../shell/types";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { UsageRecycle } from "./UsageRecycle";

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

const entry = (patch: Partial<RecycleEntry> = {}): RecycleEntry => ({
	id: "r000001", dir: "2026-11-01/x", bytes: 1024, cleaned_at: 100, location: "回收区/任务目录/r000001", expired: false, ...patch,
});

async function show(port: FakePort): Promise<void> {
	await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(UsageRecycle, { onChanged: () => undefined }) })));
}

describe("回收区列表", () => {
	it("列出回收项，恢复入口走壳端口", async () => {
		const port = createFakePort();
		port.usage.recycle = async () => [entry()];
		let restored = "";
		port.usage.restore = async (id) => { restored = id; };
		await show(port);
		expect(container.querySelector("[data-testid='recycle-entry']")?.textContent).toContain("2026-11-01/x");
		const button = container.querySelector("[data-testid='recycle-restore']") as HTMLButtonElement;
		await act(async () => button.click());
		expect(restored).toBe("r000001");
	});

	it("未到期不提前清理：期满清理按钮保持禁用", async () => {
		const port = createFakePort();
		port.usage.recycle = async () => [entry()];
		await show(port);
		expect((container.querySelector("[data-testid='recycle-purge']") as HTMLButtonElement).disabled).toBe(true);
	});

	it("期满项不能恢复，可由用户确认清理期满项", async () => {
		const port = createFakePort();
		port.usage.recycle = async () => [entry({ expired: true })];
		let purged = false;
		port.usage.purgeExpired = async () => { purged = true; };
		await show(port);
		expect((container.querySelector("[data-testid='recycle-restore']") as HTMLButtonElement).disabled).toBe(true);
		expect(container.textContent).toContain("已期满");
		await act(async () => (container.querySelector("[data-testid='recycle-purge']") as HTMLButtonElement).click());
		expect(purged).toBe(true);
	});
});

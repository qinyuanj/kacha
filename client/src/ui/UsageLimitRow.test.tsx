// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { UsageLimitRow } from "./UsageLimitRow";

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

async function show(port: FakePort, limitBytes: number | null = null): Promise<void> {
	await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(UsageLimitRow, { limitBytes, onSaved: () => undefined }) })));
}

function input(): HTMLInputElement {
	return container.querySelector("[data-testid='usage-limit-input']") as HTMLInputElement;
}

function type(value: string): void {
	const el = input();
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	if (!setter) throw new Error("没有原生 value setter");
	setter.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function save(): HTMLButtonElement {
	return container.querySelector("[data-testid='usage-limit-save']") as HTMLButtonElement;
}

describe("容量提醒阈值行", () => {
	it("保存阈值走壳端口，不是前端假装记住", async () => {
		const port = createFakePort();
		let saved = -1;
		port.usage.setLimit = async (bytes) => { saved = bytes; };
		await show(port);
		await act(async () => type("2"));
		await act(async () => save().click());
		expect(saved).toBe(2 * 1024 * 1024);
		expect(container.textContent).toContain("只提醒");
	});

	it("留空保存就是清除阈值", async () => {
		const port = createFakePort();
		let saved = -1;
		port.usage.setLimit = async (bytes) => { saved = bytes; };
		await show(port, 1024);
		await act(async () => type(""));
		await act(async () => save().click());
		expect(saved).toBe(0);
	});

	it("非法草稿不调用端口，给出错误", async () => {
		const port = createFakePort();
		let called = false;
		port.usage.setLimit = async () => { called = true; };
		await show(port);
		await act(async () => type("-1"));
		await act(async () => save().click());
		expect(called).toBe(false);
		expect(container.textContent).toContain("非负");
	});
});
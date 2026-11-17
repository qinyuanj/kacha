import { describe, expect, it } from "vitest";
import { limitDraftOf, parseLimitDraft } from "./usageLimitInput";

describe("容量提醒阈值输入", () => {
	it("已保存的字节数显示为 MiB 草稿，留空表示没有阈值", () => {
		expect(limitDraftOf(null)).toBe("");
		expect(limitDraftOf(2 * 1024 * 1024)).toBe("2");
		expect(limitDraftOf(1536 * 1024)).toBe("1.5");
	});

	it("草稿换算成字节；留空清除阈值", () => {
		expect(parseLimitDraft("2")).toEqual({ ok: true, bytes: 2 * 1024 * 1024 });
		expect(parseLimitDraft(" 1.5 ")).toEqual({ ok: true, bytes: 1536 * 1024 });
		expect(parseLimitDraft("")).toEqual({ ok: true, bytes: 0 });
	});

	it("负数与非数字明确拦下，不写进本机设置", () => {
		expect(parseLimitDraft("-1").ok).toBe(false);
		expect(parseLimitDraft("abc").ok).toBe(false);
	});
});

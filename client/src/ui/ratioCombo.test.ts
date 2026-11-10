import { describe, expect, it } from "vitest";
import type { SizeRule } from "../core/capabilities";
import type { SizeSpec } from "../core/size";
import { AUTO_RATIO, commitRatioDraft, ratioComboClass, ratioComboText, ratioFocusText, ratioPickChanges, ratioPresetLabel, ratioPresetSelected } from "./ratioCombo";

/** 两个档、三种预设；允许任意宽高比（custom 非空），范围 1:2–2:1。 */
const rule: SizeRule = {
  tiers: { "1K": { "1:1": [1024, 1024], "16:9": [1424, 800], "2:1": [1448, 724] }, "2K": { "1:1": [2048, 2048] } },
  custom: { min_total_pixels: null, max_total_pixels: null, min_aspect_ratio: 0.5, max_aspect_ratio: 2 },
};

const manual = (ratio: string | null): SizeSpec => ({ tier: "1K", ratio, width: null, height: null });
const auto = (ratio: string, image: number | null, source: [number, number] | null): SizeSpec => ({
  tier: "1K",
  ratio,
  width: null,
  height: null,
  auto_ratio: { ratio, image, source },
});

describe("ratioComboText", () => {
  it("自动时显示推测标签（没有参考图为 1:1）", () => {
    expect(ratioComboText(rule, auto("16:9", null, null), false)).toBe("自动（16:9）");
  });

  it("自动且跟随的图片被模型范围限制时标「已限制」", () => {
    expect(ratioComboText(rule, auto("1:2", 1, [1000, 100]), false)).toBe("自动（1:2 · 图1，已限制）");
  });

  it("手动发不出去时带上「（不支持）」，值不动", () => {
    expect(ratioComboText(rule, manual("3:2"), true)).toBe("3:2（不支持）");
  });

  it("手动可发时原样显示；没有宽高比为空白", () => {
    expect(ratioComboText(rule, manual("16:9"), false)).toBe("16:9");
    expect(ratioComboText(rule, manual(null), false)).toBe("");
  });
});

describe("ratioFocusText", () => {
  it("自动从空开始（手填即转手动），手动填当前值", () => {
    expect(ratioFocusText(auto("16:9", null, null))).toBe("");
    expect(ratioFocusText(manual("16:9"))).toBe("16:9");
    expect(ratioFocusText(manual(null))).toBe("");
  });
});

describe("commitRatioDraft", () => {
  it("没手填、没改过、或已放弃时不提交", () => {
    expect(commitRatioDraft(rule, manual("16:9"), null, "16:9", false)).toBeNull();
    expect(commitRatioDraft(rule, manual("16:9"), "16:9", "16:9", false)).toBeNull();
    expect(commitRatioDraft(rule, manual("16:9"), "9:16", "16:9", true)).toBeNull();
  });

  it("读不出的文本不提交，恢复原值", () => {
    expect(commitRatioDraft(rule, manual("16:9"), "abc", "16:9", false)).toBeNull();
    expect(commitRatioDraft(rule, manual("16:9"), "16:0", "16:9", false)).toBeNull();
  });

  it("模型不允许任意宽高比时也不提交", () => {
    expect(commitRatioDraft({ ...rule, custom: null }, manual("1:1"), "16:9", "1:1", false)).toBeNull();
  });

  it("合法的手填文本约分后提交，没有范围提示", () => {
    expect(commitRatioDraft(rule, manual("1:1"), "32:18", "1:1", false)).toEqual({ ratio: "16:9", hint: null });
  });

  it("越界的手填钳制到模型边界，并给范围提示", () => {
    expect(commitRatioDraft(rule, manual("1:1"), "8:1", "1:1", false)).toEqual({ ratio: "2:1", hint: "该模型宽高比范围 1:2–2:1" });
  });

  it("钳制后与当前值相同时只提示、不重选", () => {
    expect(commitRatioDraft(rule, manual("2:1"), "8:1", "2:1", false)).toEqual({ ratio: null, hint: "该模型宽高比范围 1:2–2:1" });
  });

  it("自动状态下填出当前值也要提交（转手动）", () => {
    expect(commitRatioDraft(rule, auto("16:9", null, null), "16:9", "", false)).toEqual({ ratio: "16:9", hint: null });
  });
});

describe("ratioPickChanges", () => {
  it("选当前状态（已自动 / 同一个宽高比）不动", () => {
    expect(ratioPickChanges(AUTO_RATIO, auto("16:9", null, null))).toBe(false);
    expect(ratioPickChanges("16:9", manual("16:9"))).toBe(false);
  });

  it("换成自动或换一个宽高比要提交", () => {
    expect(ratioPickChanges(AUTO_RATIO, manual("16:9"))).toBe(true);
    expect(ratioPickChanges("9:16", manual("16:9"))).toBe(true);
    expect(ratioPickChanges("9:16", auto("16:9", null, null))).toBe(true);
  });
});

describe("ratioPresetLabel", () => {
  it("具体宽高比原样；自动项在自动状态下显示推测标签", () => {
    expect(ratioPresetLabel("16:9", manual("16:9"), "自动（16:9）")).toBe("16:9");
    expect(ratioPresetLabel(AUTO_RATIO, auto("16:9", null, null), "自动（16:9）")).toBe("自动（16:9）");
    expect(ratioPresetLabel(AUTO_RATIO, manual("16:9"), "自动（16:9）")).toBe("自动");
  });
});

describe("ratioPresetSelected", () => {
  it("自动项只在自动状态下选中", () => {
    expect(ratioPresetSelected(AUTO_RATIO, auto("16:9", null, null))).toBe(true);
    expect(ratioPresetSelected(AUTO_RATIO, manual("16:9"))).toBe(false);
  });

  it("具体宽高比只在手动且相同时选中", () => {
    expect(ratioPresetSelected("16:9", manual("16:9"))).toBe(true);
    expect(ratioPresetSelected("16:9", manual("9:16"))).toBe(false);
    expect(ratioPresetSelected("16:9", auto("16:9", null, null))).toBe(false);
  });
});

describe("ratioComboClass", () => {
  it("发不出去的宽高比多一个「不支持」类名", () => {
    expect(ratioComboClass(true)).toBe("ratio-combo ratio-unsupported");
    expect(ratioComboClass(false)).toBe("ratio-combo ");
  });
});

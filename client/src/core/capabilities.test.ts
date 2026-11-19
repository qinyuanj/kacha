import { describe, expect, it } from "vitest";
import { imageRuleViolations } from "./graph";
import {
  BUILTIN_TABLE,
  isSupported,
  mergeOverride,
  modelsByTier,
  parseCapabilityTable,
  untestedCapabilities,
} from "./capabilities";

const qwenPro = () => BUILTIN_TABLE.models.find((m) => m.model_id === "qwen-image-3.0-pro")!;

describe("Flash 输入政策", () => {
  const rule = BUILTIN_TABLE.models.find((m) => m.model_id === "doubao-seedream-5-0-flash-260915")!.input_image_rule;
  it("八种官方格式及保守字节/像素上下界，不继承 Lite 14 图", () => {
    for (const format of ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"]) expect(imageRuleViolations({ format, bytes: 30000000, width: 6000, height: 6000 }, rule)).toEqual([]);
    expect(imageRuleViolations({ format: "png", bytes: 30000001, width: 6000, height: 6000 }, rule).join()).toContain("文件");
    expect(imageRuleViolations({ format: "png", bytes: 1, width: 6001, height: 6000 }, rule).join()).toContain("总像素");
    expect(imageRuleViolations({ format: "png", bytes: 1, width: 14, height: 14 }, rule).join()).toContain("最短边");
    expect(imageRuleViolations({ format: "png", bytes: 1, width: 13, height: 15 }, rule).join()).toContain("总像素");
    expect(imageRuleViolations({ format: "avif", bytes: 1, width: 15, height: 15 }, rule).join()).toContain("格式");
  });
});

describe("内置能力表", () => {
  it("Lite 不再提供运行能力或模型选择入口", () => {
    expect(BUILTIN_TABLE.models.some((m) => m.model_id === "doubao-seedream-5-0-lite-260128")).toBe(false);
  });
  it("Seedream 5.5 归旗舰档，其余档位与顺序不动", () => {
    const groups = modelsByTier(BUILTIN_TABLE);
    expect(groups.map((g) => [g.tier, g.models.map((m) => m.model_id)])).toEqual([
      ["flagship", ["qwen-image-3.0-pro", "doubao-seedream-5-0-pro-260628", "doubao-seedream-5-5-261028"]],
      ["economy", ["qwen-image-3.0", "doubao-seedream-5-0-flash-260915"]],
    ]);
  });
});

describe("Seedream 5.5 上架条目", () => {
  const five = () => BUILTIN_TABLE.models.find((m) => m.model_id === "doubao-seedream-5-5-261028")!;
  const flash = () => BUILTIN_TABLE.models.find((m) => m.model_id === "doubao-seedream-5-0-flash-260915")!;

  it("旗舰档、复用 Flash 请求形态、帮助页指官方 5.5 文档", () => {
    expect(five().display_name).toBe("Seedream 5.5");
    expect(five().tier).toBe("flagship");
    expect(five().request_shape).toBe(flash().request_shape);
    expect(five().help_url).toBe("https://ark.volcengine.com/region:cn-beijing/docs/seedream-5-5");
  });

  it("生成场景输入政策：八种格式、30MB、总像素 196–36000000、短边 15、宽高比 1/16–16", () => {
    const rule = five().input_image_rule;
    for (const format of ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"]) expect(imageRuleViolations({ format, bytes: 30000000, width: 6000, height: 6000 }, rule)).toEqual([]);
    expect(imageRuleViolations({ format: "png", bytes: 30000001, width: 6000, height: 6000 }, rule).join()).toContain("文件");
    expect(imageRuleViolations({ format: "png", bytes: 1, width: 6001, height: 6000 }, rule).join()).toContain("总像素");
    expect(imageRuleViolations({ format: "png", bytes: 1, width: 14, height: 14 }, rule).join()).toContain("最短边");
    expect(imageRuleViolations({ format: "png", bytes: 1, width: 13, height: 15 }, rule).join()).toContain("总像素");
    expect(imageRuleViolations({ format: "avif", bytes: 1, width: 15, height: 15 }, rule).join()).toContain("格式");
  });

  it("透明背景与区域指示三项支持、原生蒙版不支持、英文序号措辞已验证", () => {
    expect(five().transparent_background).toBe("supported");
    expect(five().region_hint).toEqual({ highlight_overlay: "supported", marked_image: "supported", bbox_tag: "supported" });
    expect(five().native_mask).toBe("unsupported");
    expect(five().reference_phrasing.en_verified).toBe(flash().reference_phrasing.en_verified);
  });

  it("拆分图层标待测：真机没验过拆分，不谎报支持", () => {
    expect(five().workflows.text_to_image.layer_decomposition).toBe("untested");
    expect(five().workflows.image_edit.layer_decomposition).toBe("untested");
    expect(untestedCapabilities(five())).toEqual(["拆分图层（文生图）", "拆分图层（图片编辑）"]);
    expect(untestedCapabilities(flash())).toEqual([]);
  });

  it("参考图 0–10 / 1–10，size_rule 与 Flash 逐值相同（custom 上限是输出 4624220）", () => {
    expect([five().workflows.text_to_image.min_references, five().workflows.text_to_image.max_references]).toEqual([0, 10]);
    expect([five().workflows.image_edit.min_references, five().workflows.image_edit.max_references]).toEqual([1, 10]);
    for (const wf of ["text_to_image", "image_edit"] as const) expect(five().workflows[wf].size_rule).toEqual(flash().workflows[wf].size_rule);
    expect(five().workflows.text_to_image.size_rule.custom).toEqual({ min_total_pixels: 921600, max_total_pixels: 4624220, min_aspect_ratio: 0.0625, max_aspect_ratio: 16 });
  });

  it("通过现有 schema 校验；本票不加 #175 的 layer_decomposition_rule 与拆分场景 input_image_rule", () => {
    expect(parseCapabilityTable(structuredClone(BUILTIN_TABLE)).ok).toBe(true);
    expect(five()).not.toHaveProperty("layer_decomposition_rule");
    for (const wf of ["text_to_image", "image_edit"] as const) expect(five().workflows[wf]).not.toHaveProperty("layer_decomposition_rule");
  });
});

describe("三态", () => {
  it("待测在 UI 上等同不支持", () => {
    expect(isSupported("supported")).toBe(true);
    expect(isSupported("untested")).toBe(false);
    expect(isSupported("unsupported")).toBe(false);
  });

  it("列出模型的待测能力供模型说明浮层展示", () => {
    const pro = BUILTIN_TABLE.models.find((m) => m.model_id.startsWith("doubao-seedream-5-0-pro"))!;
    expect(untestedCapabilities(pro)).toEqual([
      "拆分图层（文生图）",
      "拆分图层（图片编辑）",
    ]);
    expect(untestedCapabilities(qwenPro())).toEqual([]);
  });
});

describe("解析与校验", () => {
  it("拒绝非整数 format_version", () => {
    const result = parseCapabilityTable({ format_version: "1", models: [] });
    expect(result.ok).toBe(false);
  });

  it("拒绝非法三态取值并指出字段", () => {
    const bad = structuredClone(BUILTIN_TABLE) as unknown as { models: Record<string, unknown>[] };
    bad.models[0].native_mask = "maybe";
    const result = parseCapabilityTable(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("native_mask");
  });

  it("拒绝更新版本的表", () => {
    const result = parseCapabilityTable({ format_version: 2, models: [] });
    expect(result.ok).toBe(false);
  });
});

describe("覆盖文件按模型合并", () => {
  it("覆盖文件不能重新引入停用 Lite，即使声明全套有效能力", () => {
    const retired = { ...structuredClone(qwenPro()), model_id: "doubao-seedream-5-0-lite-260128" };
    const merged = mergeOverride(BUILTIN_TABLE, { format_version: 1, models: [retired] });
    expect(merged.models.some((m) => m.model_id === retired.model_id)).toBe(false);
  });
  it("同 model_id 整条替换内置，新模型追加，其余不动", () => {
    const override = structuredClone(qwenPro());
    override.workflows.image_edit.max_references = 5;
    const added = { ...structuredClone(qwenPro()), model_id: "new-model", tier: null };
    const merged = mergeOverride(BUILTIN_TABLE, { format_version: 1, models: [override, added] });
    expect(merged.models.length).toBe(BUILTIN_TABLE.models.length + 1);
    expect(merged.models.find((m) => m.model_id === "qwen-image-3.0-pro")!.workflows.image_edit.max_references).toBe(5);
    expect(merged.models.find((m) => m.model_id === "qwen-image-3.0")!.workflows.image_edit.max_references).toBe(3);
    expect(merged.models.at(-1)!.model_id).toBe("new-model");
    expect(BUILTIN_TABLE.models[0].workflows.image_edit.max_references).toBe(3);
  });
});

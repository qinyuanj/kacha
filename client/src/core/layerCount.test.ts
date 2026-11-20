import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE, findModel, layerMaxImagesRuleOf, parseCapabilityTable, type ModelCapability } from "./capabilities";
import { buildGenerationRequest, type GenerationInput } from "./gateway";
import { editBoard } from "./edit";
import { taskView, type TaskFacts } from "./taskView";
import { board } from "./testing/runnerHarness";
import type { TaskNode } from "./board";

const modelOf = (id: string): ModelCapability => findModel(BUILTIN_TABLE, id)!;
const PNG = new Uint8Array([137, 80, 78, 71]);
const oneRef = [{ mediaType: "image/png", bytes: PNG, hasAlpha: true }];

function layerInput(id: string, over: Partial<GenerationInput> = {}): GenerationInput {
  return { model: modelOf(id), text: "", nativeNegativePrompt: null, size: { width: 1024, height: 1024 }, references: oneRef, layerDecomposition: true, layerSize: "auto", ...over };
}

const maxImages = (id: string, over: Partial<GenerationInput> = {}): unknown => (buildGenerationRequest(layerInput(id, over)).body as Record<string, unknown>).max_images;

const facts = (over: Partial<TaskFacts> = {}): TaskFacts => ({ missingNodes: new Set<string>(), alphaByNode: new Map<string, boolean>(), discovery: { source: "none" }, concurrency: 4, ...over });

function layerBoard(cap?: number) {
  const b = board(["t1"], true);
  const t = b.nodes.find((n) => n.type === "task") as TaskNode;
  t.model = "doubao-seedream-5-5-261028";
  t.layer_decomposition = true;
  if (cap !== undefined) t.layer_max_images = cap;
  return b;
}

describe("拆分图层的张数按能力表声明下发（#175）", () => {
  it("5.5 拆层未设值时按 default 发 30", () => {
    expect(maxImages("doubao-seedream-5-5-261028")).toBe(30);
  });

  it("边界 2 与 100 放行，原样下发", () => {
    expect(maxImages("doubao-seedream-5-5-261028", { layerMaxImages: 2 })).toBe(2);
    expect(maxImages("doubao-seedream-5-5-261028", { layerMaxImages: 100 })).toBe(100);
  });

  it("1 与 101 越界，拦下并说明范围", () => {
    expect(() => maxImages("doubao-seedream-5-5-261028", { layerMaxImages: 1 })).toThrow(/图层输出数量必须在 2–100 之间/);
    expect(() => maxImages("doubao-seedream-5-5-261028", { layerMaxImages: 101 })).toThrow(/图层输出数量必须在 2–100 之间/);
  });

  it("没开拆分就不发这个字段", () => {
    expect(maxImages("doubao-seedream-5-5-261028", { layerDecomposition: false })).toBeUndefined();
  });

  it("没声明范围的工作流一个字段都不多发：5.0 Flash、5.0 Pro", () => {
    expect(maxImages("doubao-seedream-5-0-flash-260915", { layerMaxImages: 30 })).toBeUndefined();
    expect(maxImages("doubao-seedream-5-0-pro-260628", { layerMaxImages: 30 })).toBeUndefined();
  });
});

describe("能力表声明本身", () => {
  it("只有 5.5 的 image_edit 声明了 2–100、缺省 30", () => {
    expect(layerMaxImagesRuleOf(modelOf("doubao-seedream-5-5-261028"), "image_edit")).toEqual({ min: 2, max: 100, default: 30 });
    expect(layerMaxImagesRuleOf(modelOf("doubao-seedream-5-5-261028"), "text_to_image")).toBeNull();
    expect(layerMaxImagesRuleOf(modelOf("doubao-seedream-5-0-flash-260915"), "image_edit")).toBeNull();
  });

  it("min 大于 max 视为损坏", () => {
    const bad = structuredClone(BUILTIN_TABLE);
    bad.models.find((m) => m.model_id === "doubao-seedream-5-5-261028")!.workflows.image_edit.layer_max_images = { min: 10, max: 2, default: 5 };
    expect(parseCapabilityTable(bad).ok).toBe(false);
  });

  it("default 落在范围外视为损坏", () => {
    const bad = structuredClone(BUILTIN_TABLE);
    bad.models.find((m) => m.model_id === "doubao-seedream-5-5-261028")!.workflows.image_edit.layer_max_images = { min: 2, max: 100, default: 1 };
    expect(parseCapabilityTable(bad).ok).toBe(false);
  });
});

describe("画板记录与任务视图", () => {
  const apply = (b: ReturnType<typeof board>, count: number) => editBoard(b, { kind: "setLayerMaxImages", taskId: "t1", count }, { table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set<string>(), imageSize: () => undefined, newId: () => "r" }).board;
  const taskOf = (b: ReturnType<typeof board>) => b.nodes.find((n) => n.type === "task") as TaskNode;

  it("改张数记进画板，非正整数不落盘", () => {
    expect(taskOf(apply(layerBoard(), 50)).layer_max_images).toBe(50);
    expect(taskOf(apply(layerBoard(), 0)).layer_max_images).toBeUndefined();
  });

  it("默认与边界内不标红，越界标红", () => {
    const kinds = (b: ReturnType<typeof board>) => taskView(b, BUILTIN_TABLE, "t1", facts())!.reasons.map((r) => r.kind);
    expect(kinds(layerBoard())).not.toContain("layerMaxImagesRange");
    expect(kinds(layerBoard(100))).not.toContain("layerMaxImagesRange");
    expect(kinds(layerBoard(101))).toContain("layerMaxImagesRange");
  });
});
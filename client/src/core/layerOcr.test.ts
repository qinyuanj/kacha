import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE, findModel, parseCapabilityTable, textRecognitionSupported, type ModelCapability } from "./capabilities";
import { buildGenerationRequest, generate, type FetchLike, type GenerationInput } from "./gateway";
import { editBoard } from "./edit";
import { taskView, type TaskFacts } from "./taskView";
import { board } from "./testing/runnerHarness";
import { PNG_1X1 as PNG } from "./testing/png";
import { memoryTaskFs } from "./testing/memoryTaskFs";
import { LocalError, parseLayersFile, readLayers, saveLayers } from "./taskDir";
import type { TaskNode } from "./board";

const modelOf = (id: string): ModelCapability => findModel(BUILTIN_TABLE, id)!;
const oneRef = [{ mediaType: "image/png", bytes: PNG }];
const BOX = { absolute: [10, 20, 110, 220], normalized: [10, 20, 110, 220] };
const OCR = {
  text: "SUMMER\nSALE",
  lines: [
    { bounding_box: BOX, runs: [{ text: "SUMMER", style: { similar_font_family: "Arial", foreground_color: "#FFFFFF", bold: true, italic: false } }] },
    { runs: [{ text: "SALE", style: { strikethrough: true } }] },
  ],
};

function layerInput(id: string, over: Partial<GenerationInput> = {}): GenerationInput {
  return { model: modelOf(id), text: "", nativeNegativePrompt: null, size: { width: 1024, height: 1024 }, references: oneRef, layerDecomposition: true, layerSize: "auto", ...over };
}

const bodyOf = (id: string, over: Partial<GenerationInput> = {}) => buildGenerationRequest(layerInput(id, over)).body as Record<string, unknown>;
const optionsOf = (id: string, over: Partial<GenerationInput> = {}) => bodyOf(id, over).layer_decomposition_options;

function fetchLayers(data: unknown[]): FetchLike {
  return async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data }), arrayBuffer: async () => new ArrayBuffer(0) });
}

const facts = (): TaskFacts => ({ missingNodes: new Set<string>(), alphaByNode: new Map<string, boolean>(), discovery: { source: "none" }, concurrency: 4 });

describe("拆分时的文字识别按能力表声明下发（#178）", () => {
  it("5.5 打开开关时只多发 layer_decomposition_options.text_recognition", () => {
    expect(optionsOf("doubao-seedream-5-5-261028", { textRecognition: true })).toEqual({ text_recognition: true });
  });

  it("关掉开关时请求体里没有这个键", () => {
    expect(Object.keys(bodyOf("doubao-seedream-5-5-261028"))).not.toContain("layer_decomposition_options");
    expect(Object.keys(bodyOf("doubao-seedream-5-5-261028", { textRecognition: false }))).not.toContain("layer_decomposition_options");
  });

  it("没开拆分时不发：开关只在拆分里有意义", () => {
    expect(Object.keys(bodyOf("doubao-seedream-5-5-261028", { layerDecomposition: false, textRecognition: true }))).not.toContain("layer_decomposition_options");
  });

  it("没声明 OCR 的工作流打开了就拦下，不静默丢掉开关", () => {
    expect(() => buildGenerationRequest(layerInput("doubao-seedream-5-0-flash-260915", { textRecognition: true }))).toThrow(/不支持文字识别/);
  });
});

describe("能力表声明本身", () => {
  it("只有 5.5 的 image_edit 声明了文字识别", () => {
    expect(textRecognitionSupported(modelOf("doubao-seedream-5-5-261028"), "image_edit")).toBe(true);
    expect(textRecognitionSupported(modelOf("doubao-seedream-5-5-261028"), "text_to_image")).toBe(false);
    expect(textRecognitionSupported(modelOf("doubao-seedream-5-0-flash-260915"), "image_edit")).toBe(false);
    expect(textRecognitionSupported(modelOf("doubao-seedream-5-0-pro-260628"), "image_edit")).toBe(false);
  });

  it("非法三态取值视为损坏", () => {
    const bad = structuredClone(BUILTIN_TABLE);
    (bad.models.find((m) => m.model_id === "doubao-seedream-5-5-261028")!.workflows.image_edit as unknown as Record<string, unknown>).text_recognition = "maybe";
    expect(parseCapabilityTable(bad).ok).toBe(false);
  });
});

describe("返回解析：文字内容、行位置与近似样式", () => {
  const parse = async (data: unknown[]) => (await generate({ baseUrl: "https://gateway.test", apiKey: "test", fetch: fetchLayers(data) }, layerInput("doubao-seedream-5-5-261028", { textRecognition: true }))).images;

  it("文字图层带回整段文字、逐行位置与样式分段", async () => {
    const images = await parse([
      { url: "https://result.test/base", z_index: 0 },
      { url: "https://result.test/t", z_index: 1, bounding_box: BOX, text_recognition: OCR },
    ]);
    expect(images[1].layer?.text_recognition).toEqual(OCR);
  });

  it("非文字层没这个字段，就不臆造", async () => {
    const images = await parse([{ url: "https://result.test/base", z_index: 0 }, { url: "https://result.test/p", z_index: 1, bounding_box: BOX }]);
    expect(images[1].layer).not.toHaveProperty("text_recognition");
  });

  it("形状不完整或空结果都按没拿到处理，图照常返回", async () => {
    const broken = { text: "SUMMER", lines: [{ runs: [{ text: 1 }] }] };
    const images = await parse([
      { url: "https://result.test/base", z_index: 0 },
      { url: "https://result.test/t", z_index: 1, bounding_box: BOX, text_recognition: broken },
    ]);
    expect(images[1].layer).not.toHaveProperty("text_recognition");
    expect(images[1]).toMatchObject({ kind: "url", url: "https://result.test/t" });
    const blank = await parse([
      { url: "https://result.test/base", z_index: 0 },
      { url: "https://result.test/t", z_index: 1, bounding_box: BOX, text_recognition: { text: "   ", lines: [] } },
    ]);
    expect(blank[1].layer).not.toHaveProperty("text_recognition");
  });
});

describe("落盘：图层元数据里的 OCR", () => {
  const taskId = "20261120T091500Z-abcd1234";
  const fs = () => memoryTaskFs();

  it("layers.json 写入并读回 text_recognition", async () => {
    const store = fs();
    await saveLayers(store, "/data", `2026-11-20/${taskId}`, [{ bytes: PNG, zIndex: 1, boundingBox: BOX, textRecognition: OCR }]);
    expect((await readLayers(store, "/data", taskId))?.[0].text_recognition).toEqual(OCR);
  });

  it("没有 OCR 的图层不写这个键", async () => {
    const store = fs();
    const layers = await saveLayers(store, "/data", `2026-11-20/${taskId}`, [{ bytes: PNG, zIndex: 1, boundingBox: BOX }]);
    expect(layers[0]).not.toHaveProperty("text_recognition");
  });

  it("形状不完整的 text_recognition 视为图层元数据损坏", () => {
    const bad = new TextEncoder().encode(JSON.stringify({ layers: [{ file: "layers/01.png", z_index: 1, bounding_box: BOX, text_recognition: { text: "X" } }] }));
    expect(() => parseLayersFile(bad)).toThrow(LocalError);
  });
});

describe("画板开关与任务视图", () => {
  const env = { table: BUILTIN_TABLE, discovery: { source: "none" as const }, locked: new Set<string>(), imageSize: () => undefined, newId: () => "r" };
  const taskNode = (b: ReturnType<typeof board>) => b.nodes.find((n) => n.type === "task") as TaskNode;
  const layerBoard = () => {
    const b = board(["t1"], true);
    const t = taskNode(b);
    t.model = "doubao-seedream-5-5-261028";
    t.layer_decomposition = true;
    return b;
  };

  it("切换开关记进画板，撤销步写明改了什么", () => {
    const result = editBoard(layerBoard(), { kind: "setTaskFlag", taskId: "t1", flag: "layer_text_recognition", value: true }, env);
    expect(taskNode(result.board).layer_text_recognition).toBe(true);
    expect(result.step).toEqual({ label: "切换文字识别" });
  });

  it("声明支持的模型不标红，换到没声明的模型标红", () => {
    const b = layerBoard();
    taskNode(b).layer_text_recognition = true;
    expect(taskView(b, BUILTIN_TABLE, "t1", facts())!.reasons.map((r) => r.kind)).not.toContain("layerTextRecognitionUnsupported");
    taskNode(b).model = "doubao-seedream-5-0-flash-260915";
    expect(taskView(b, BUILTIN_TABLE, "t1", facts())!.reasons.map((r) => r.kind)).toContain("layerTextRecognitionUnsupported");
  });

  it("开关关着时换模型不误报", () => {
    const b = layerBoard();
    taskNode(b).model = "doubao-seedream-5-0-flash-260915";
    expect(taskView(b, BUILTIN_TABLE, "t1", facts())!.reasons.map((r) => r.kind)).not.toContain("layerTextRecognitionUnsupported");
  });
});

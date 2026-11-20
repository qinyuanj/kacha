import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE, findModel, parseCapabilityTable, textRecognitionSupported, untestedCapabilities, type CapabilityTable, type ModelCapability } from "./capabilities";
import { buildGenerationRequest, generate, type FetchLike, type GenerationInput } from "./gateway";
import { editBoard } from "./edit";
import { taskView, type TaskFacts } from "./taskView";
import { prepareJob, writeJob, type RunDeps } from "./run";
import { board } from "./testing/runnerHarness";
import { PNG_1X1 as PNG } from "./testing/png";
import { memoryTaskFs } from "./testing/memoryTaskFs";
import { LocalError, parseLayersFile, readLayers, saveLayers } from "./taskDir";
import type { TaskNode } from "./board";

const FIVE = "doubao-seedream-5-5-261028";
const FLASH = "doubao-seedream-5-0-flash-260915";

/**
 * 测试用能力表：把 5.5 的拆分场景按真机验证后的形状声明出来。内置表在 #179 验收后
 * 已把 layer_decomposition 与 text_recognition 放开为 supported；这里额外补上
 * layer_split，用来覆盖「声明了拆分场景规则」的分支。
 * 拆分场景的参考图规则直接取 Flash 已声明的那条，不另编数值。
 */
function splitOcrTable(over: { textRecognition?: "untested" } = {}): CapabilityTable {
  const table = structuredClone(BUILTIN_TABLE);
  const workflow = table.models.find((m) => m.model_id === FIVE)!.workflows.image_edit;
  workflow.layer_decomposition = "supported";
  workflow.layer_split = structuredClone(findModel(BUILTIN_TABLE, FLASH)!.workflows.image_edit.layer_split!);
  // 内置表#179 后已是 supported；要覆盖「待测时拦下」的分支，得显式写成 untested。
  workflow.text_recognition = over.textRecognition === "untested" ? "untested" : "supported";
  return table;
}

const OCR_TABLE = splitOcrTable();
const modelOf = (id: string, table: CapabilityTable = OCR_TABLE): ModelCapability => findModel(table, id)!;
const oneRef = [{ mediaType: "image/png", bytes: PNG }];
const BOX = { absolute: [10, 20, 110, 220], normalized: [100, 200, 900, 950] };
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

describe("能力表：验证之前不谎报支持（#178）", () => {
  it("内置表里 5.5 的文字识别已随 #179 放开为 supported（2026-11-20 owner 确认）", () => {
    const five = findModel(BUILTIN_TABLE, FIVE)!;
    expect(five.workflows.image_edit.text_recognition).toBe("supported");
    expect(textRecognitionSupported(five, "image_edit")).toBe(true);
    expect(untestedCapabilities(five)).not.toContain("文字识别（图片编辑）");
  });

  it("没声明 OCR 的模型不列进待测", () => {
    expect(untestedCapabilities(findModel(BUILTIN_TABLE, FLASH)!)).not.toContain("文字识别（图片编辑）");
  });

  it("声明 supported 的工作流判定为支持；同一模型别的工作流不受影响", () => {
    expect(textRecognitionSupported(modelOf(FIVE), "image_edit")).toBe(true);
    expect(textRecognitionSupported(modelOf(FIVE), "text_to_image")).toBe(false);
    expect(textRecognitionSupported(modelOf(FLASH), "image_edit")).toBe(false);
  });

  it("非法三态取值视为损坏", () => {
    const bad = structuredClone(OCR_TABLE);
    (bad.models.find((m) => m.model_id === FIVE)!.workflows.image_edit as unknown as Record<string, unknown>).text_recognition = "maybe";
    expect(parseCapabilityTable(bad).ok).toBe(false);
  });
});

describe("请求体：开关两态", () => {
  it("打开开关时只多发 layer_decomposition_options.text_recognition", () => {
    expect(optionsOf(FIVE, { textRecognition: true })).toEqual({ text_recognition: true });
  });

  it("关掉开关时请求体里没有这个键", () => {
    expect(Object.keys(bodyOf(FIVE))).not.toContain("layer_decomposition_options");
    expect(Object.keys(bodyOf(FIVE, { textRecognition: false }))).not.toContain("layer_decomposition_options");
  });

  it("没开拆分时不发：开关只在拆分里有意义", () => {
    expect(Object.keys(bodyOf(FIVE, { layerDecomposition: false, textRecognition: true }))).not.toContain("layer_decomposition_options");
  });

  it("没声明 OCR 的工作流打开了就拦下，不静默丢掉开关", () => {
    expect(() => buildGenerationRequest(layerInput(FLASH, { textRecognition: true }))).toThrow(/不支持文字识别/);
  });

  it("声明存在但不支持（待测）时同样拦下", () => {
    const pending = splitOcrTable({ textRecognition: "untested" });
    const input = { ...layerInput(FIVE), model: findModel(pending, FIVE)!, textRecognition: true };
    expect(() => buildGenerationRequest(input)).toThrow(/不支持文字识别/);
  });
});

describe("返回解析：文字内容、行位置与近似样式", () => {
  const parse = async (data: unknown[], id = FIVE) => (await generate({ baseUrl: "https://gateway.test", apiKey: "test", fetch: fetchLayers(data) }, layerInput(id, { textRecognition: true }))).images;
  const withOcr = (textRecognition: unknown) => [{ url: "https://result.test/base", z_index: 0 }, { url: "https://result.test/t", z_index: 1, bounding_box: BOX, text_recognition: textRecognition }];

  it("文字图层带回整段文字、逐行位置与样式分段", async () => {
    const images = await parse(withOcr(OCR));
    expect(images[1].layer?.text_recognition).toEqual(OCR);
  });

  it("行框按原样收下，不把 normalized 当成 absolute（夹具两者取不同值）", async () => {
    const images = await parse(withOcr(OCR));
    expect(images[1].layer?.text_recognition?.lines[0].bounding_box).toEqual(BOX);
  });

  it("行框是四元数组时照收，不丢这一行", async () => {
    const quad = { text: "SUMMER", lines: [{ bounding_box: [1, 2, 3, 4], runs: [{ text: "SUMMER" }] }] };
    const images = await parse(withOcr(quad));
    expect(images[1].layer?.text_recognition?.lines).toEqual([{ bounding_box: [1, 2, 3, 4], runs: [{ text: "SUMMER" }] }]);
  });

  it("行框只给 absolute 时按四元数组收下，不丢这一行", async () => {
    const onlyAbsolute = { text: "SUMMER", lines: [{ bounding_box: { absolute: [5, 6, 7, 8] }, runs: [{ text: "SUMMER" }] }] };
    const images = await parse(withOcr(onlyAbsolute));
    expect(images[1].layer?.text_recognition?.lines).toEqual([{ bounding_box: [5, 6, 7, 8], runs: [{ text: "SUMMER" }] }]);
  });

  it("没有 lines 时保留文字本身", async () => {
    const images = await parse(withOcr({ text: "SUMMER" }));
    expect(images[1].layer?.text_recognition).toEqual({ text: "SUMMER", lines: [] });
  });

  it("某一行或某一段认不出来时只丢那一行，整段 OCR 不陪葬", async () => {
    const mixed = { text: "SUMMER\nSALE", lines: [OCR.lines[0], { runs: [{ text: 1 }] }, { bounding_box: "坏", runs: [{ text: "SALE" }] }] };
    const images = await parse(withOcr(mixed));
    expect(images[1].layer?.text_recognition).toEqual({ text: "SUMMER\nSALE", lines: [OCR.lines[0]] });
  });

  it("非文字层没这个字段，就不臆造", async () => {
    const images = await parse([{ url: "https://result.test/base", z_index: 0 }, { url: "https://result.test/p", z_index: 1, bounding_box: BOX }]);
    expect(images[1].layer).not.toHaveProperty("text_recognition");
    expect(images[1]).toMatchObject({ kind: "url", url: "https://result.test/p" });
  });

  it("文字为空且没有行时按没拿到处理", async () => {
    const images = await parse(withOcr({ text: "   ", lines: [] }));
    expect(images[1].layer).not.toHaveProperty("text_recognition");
  });
});

describe("落盘：图层元数据里的 OCR", () => {
  const taskId = "20261120T091500Z-abcd1234";

  it("layers.json 写入并读回 text_recognition", async () => {
    const store = memoryTaskFs();
    await saveLayers(store, "/data", `2026-11-20/${taskId}`, [{ bytes: PNG, zIndex: 1, boundingBox: BOX, textRecognition: OCR }]);
    expect((await readLayers(store, "/data", taskId))?.[0].text_recognition).toEqual(OCR);
  });

  it("没有 OCR 的图层不写这个键", async () => {
    const store = memoryTaskFs();
    const layers = await saveLayers(store, "/data", `2026-11-20/${taskId}`, [{ bytes: PNG, zIndex: 1, boundingBox: BOX }]);
    expect(layers[0]).not.toHaveProperty("text_recognition");
  });

  it("形状不完整的 text_recognition 视为图层元数据损坏", () => {
    const bad = new TextEncoder().encode(JSON.stringify({ layers: [{ file: "layers/01.png", z_index: 1, bounding_box: BOX, text_recognition: { text: 42 } }] }));
    expect(() => parseLayersFile(bad)).toThrow(LocalError);
  });
});

describe("端到端：从提交计划到请求体与 task.json", () => {
  const passThroughCodec: RunDeps["imageCodec"] = { decode: async () => ({ width: 1024, height: 1024, hasAlpha: () => true, encode: async () => PNG, close: () => undefined }) };

  function prepareDeps() {
    const fs = memoryTaskFs();
    const deps: RunDeps = {
      imageCodec: passThroughCodec,
      readFile: async (path) => (path === "/root/refs/cat.png" ? PNG : fs.readFile(path)),
      writeNewFile: fs.writeNewFile,
      fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => "{}", arrayBuffer: async () => new ArrayBuffer(0) }),
      now: () => new Date("2026-11-20T09:15:00Z"),
      schedule: () => () => undefined,
    };
    return { deps, files: fs.files };
  }

  function splitBoard(ocr: boolean) {
    const b = board(["t1"], true);
    const task = b.nodes.find((n) => n.type === "task") as TaskNode;
    task.model = FIVE;
    task.layer_decomposition = true;
    if (ocr) task.layer_text_recognition = true;
    return b;
  }

  const prepare = (deps: RunDeps, b: ReturnType<typeof splitBoard>, table: CapabilityTable) =>
    prepareJob(deps, { board: b, table, tableSha256: "x", userRoot: "/root", taskNodeId: "t1" });

  it("开关进提交计划、进请求体、进 task.json", async () => {
    const { deps, files } = prepareDeps();
    const prepared = await prepare(deps, splitBoard(true), OCR_TABLE);
    expect(prepared.job.input.textRecognition).toBe(true);
    const written = await writeJob(deps, "/root", prepared.job);
    expect(buildGenerationRequest(written.input).body).toMatchObject({ layer_decomposition: true, layer_decomposition_options: { text_recognition: true } });
    const record = JSON.parse(new TextDecoder().decode(files.get(`/root/${written.relDir}/task.json`)));
    expect(record.layer_text_recognition).toBe(true);
  });

  it("开关关着时请求体与 task.json 都不带它", async () => {
    const { deps, files } = prepareDeps();
    const prepared = await prepare(deps, splitBoard(false), OCR_TABLE);
    const written = await writeJob(deps, "/root", prepared.job);
    expect(buildGenerationRequest(written.input).body).not.toHaveProperty("layer_decomposition_options");
    const record = JSON.parse(new TextDecoder().decode(files.get(`/root/${written.relDir}/task.json`)));
    expect(record).not.toHaveProperty("layer_text_recognition");
  });

  it("没声明 OCR 的工作流：拼请求时拦下（与张数越界同一道闸）", async () => {
    const { deps } = prepareDeps();
    const prepared = await prepare(deps, splitBoard(true), splitOcrTable({ textRecognition: "untested" }));
    const written = await writeJob(deps, "/root", prepared.job);
    expect(() => buildGenerationRequest(written.input)).toThrow(/不支持文字识别/);
  });
});

describe("画板开关与任务视图", () => {
  const env = { table: OCR_TABLE, discovery: { source: "none" as const }, locked: new Set<string>(), imageSize: () => undefined, newId: () => "r" };
  const taskNode = (b: ReturnType<typeof board>) => b.nodes.find((n) => n.type === "task") as TaskNode;
  const layerBoard = () => {
    const b = board(["t1"], true);
    const task = taskNode(b);
    task.model = FIVE;
    task.layer_decomposition = true;
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
    expect(taskView(b, OCR_TABLE, "t1", facts())!.reasons.map((r) => r.kind)).not.toContain("layerTextRecognitionUnsupported");
    taskNode(b).model = FLASH;
    expect(taskView(b, OCR_TABLE, "t1", facts())!.reasons.map((r) => r.kind)).toContain("layerTextRecognitionUnsupported");
  });

  it("开关关着时换模型不误报", () => {
    const b = layerBoard();
    taskNode(b).model = FLASH;
    expect(taskView(b, OCR_TABLE, "t1", facts())!.reasons.map((r) => r.kind)).not.toContain("layerTextRecognitionUnsupported");
  });
});

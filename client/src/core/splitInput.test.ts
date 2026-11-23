// 拆分场景的输入约束（#176）：参考图只能一张、只接受 PNG/JPEG、总像素不低于 262144，
// 规则全部声明在能力表（模型级 → 工作流级 → 拆分场景级逐级覆盖），拦截发生在选完图的那一刻。
import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, ReferenceNode, TaskNode } from "./board";
import { BUILTIN_TABLE, findModel, inputImageRuleOf, maxReferencesOf, parseCapabilityTable, type CapabilityTable, type ModelCapability } from "./capabilities";
import { editBoard, type EditEnv, type ImportedImage } from "./edit";
import { buildGenerationRequest, type GenerationInput } from "./gateway";
import { canConnect, imageRuleViolations, inputRulesFor, referencePolicy, splitReferenceRefusal, taskPorts } from "./graph";
import { withinPixelRange } from "./size";

const FLASH = "doubao-seedream-5-0-flash-260915";
const PRO = "doubao-seedream-5-0-pro-260628";
const QWEN = "qwen-image-3.0-pro";
const modelOf = (id: string, table: CapabilityTable = BUILTIN_TABLE): ModelCapability => findModel(table, id)!;
const env: EditEnv = { table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set<string>(), imageSize: () => undefined, newId: () => "new-ref" };

function reference(id: string, path = id + ".png"): ReferenceNode {
  return { id, type: "reference", pos: [0, 0], size: [100, 100], extra: {}, path, sha256: "0".repeat(64), display_name: path };
}

function splitTask(patch: Partial<TaskNode> = {}): TaskNode {
  return { id: "t1", type: "task", pos: [300, 0], size: [280, 260], extra: {}, model: FLASH, size_spec: { tier: null, ratio: null, width: null, height: null }, image_ports: 1, layer_decomposition: true, transparent_background: false, last_submitted: null, ...patch };
}

/** 开了图层拆分的任务；attached 时已经接上 r1（拆分的典型现场），r2 留在画板上当第 2 张。 */
function splitBoard(attached = false): Board {
  const nodes: BoardNode[] = [reference("r1"), reference("r2"), splitTask()];
  const edges: BoardEdge[] = attached ? [{ from: ["r1", "out"], to: ["t1", "image:0"], source_layer: null, region: null, system: false, extra: {} }] : [];
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

const imported = (path: string, width = 1024, height = 1024, bytes?: number): ImportedImage => ({ path, sha256: "0".repeat(64), display_name: path, width, height, bytes });
const facts = (format: string, width: number, height: number, bytes = 1024) => ({ format, bytes, width, height });

describe("#176 拆分场景：参考图只能一张", () => {
  it("拆分任务只给一个参考图名额，第 2 张连不上", () => {
    expect(taskPorts(splitBoard(true), BUILTIN_TABLE, "t1").maxReferences).toBe(1);
    const verdict = canConnect(splitBoard(true), BUILTIN_TABLE, { source: "r2", sourceHandle: "out", target: "t1", targetHandle: "image:1" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toContain("1 张");
  });

  it("选第 2 张就地拦下：不落节点、只说明原因", () => {
    const before = splitBoard(true);
    const r = editBoard(before, { kind: "addReferences", images: [imported("r2.png")], at: [0, 0], attach: { taskId: "t1", place: "asIs" } }, env);
    expect(r.step).toBeNull();
    expect(r.hint).toContain("1 张");
    expect(r.board.nodes).toHaveLength(before.nodes.length);
  });
});

describe("#176 拆分场景：格式与像素下限按声明", () => {
  it("只接受 PNG / JPEG，webp 被拦", () => {
    expect(splitReferenceRefusal(splitBoard(), BUILTIN_TABLE, "t1", [imported("a.webp")])).toContain("WEBP");
    expect(splitReferenceRefusal(splitBoard(), BUILTIN_TABLE, "t1", [imported("a.png")])).toBeNull();
    expect(splitReferenceRefusal(splitBoard(), BUILTIN_TABLE, "t1", [imported("a.jpeg")])).toBeNull();
  });

  it("选完 webp 就地报错，画板不动", () => {
    const before = splitBoard();
    const r = editBoard(before, { kind: "addReferences", images: [imported("b.webp")], at: [0, 0], attach: { taskId: "t1", place: "asIs" } }, env);
    expect(r.step).toBeNull();
    expect(r.hint).toContain("WEBP");
    expect(r.board.nodes).toHaveLength(before.nodes.length);
  });

  it("总像素下限 262144：511×512 被拦，512×512 恰好放行", () => {
    expect(splitReferenceRefusal(splitBoard(), BUILTIN_TABLE, "t1", [imported("small.png", 511, 512)])).toContain("262144");
    expect(splitReferenceRefusal(splitBoard(), BUILTIN_TABLE, "t1", [imported("exact.png", 512, 512)])).toBeNull();
  });

  it("规则来自能力表声明，不在代码里写死", () => {
    const flash = modelOf(FLASH);
    const declared = flash.workflows.image_edit.layer_split!;
    expect(declared.max_references).toBe(1);
    expect(declared.input_image_rule.formats).toEqual(["png", "jpeg"]);
    expect(declared.input_image_rule.min_total_pixels).toBe(262144);
    expect(referencePolicy(splitBoard(true), BUILTIN_TABLE, "t1")).toEqual({ scene: "layer_split", maxReferences: 1, rule: declared.input_image_rule, layerDeclared: true });
  });
});

describe("#176 生成场景不受影响", () => {
  it("生成场景仍按模型级规则与模型上限", () => {
    const flash = modelOf(FLASH);
    expect(inputImageRuleOf(flash, "image_edit", "generate")).toBe(flash.input_image_rule);
    expect(maxReferencesOf(flash, "image_edit", "generate")).toBe(10);
    const ordinary = { ...splitBoard(), nodes: splitBoard().nodes.map((n) => (n.type === "task" ? { ...n, layer_decomposition: false } : n)) };
    expect(splitReferenceRefusal(ordinary, BUILTIN_TABLE, "t1", [imported("a.webp")])).toBeNull();
  });
});

describe("#176 工作流级规则覆盖模型级，缺这项回落", () => {
  const withWorkflowRule = (): ModelCapability => {
    const table = structuredClone(BUILTIN_TABLE);
    const model = findModel(table, FLASH)!;
    model.workflows.text_to_image.input_image_rule = { ...model.input_image_rule, formats: ["png"], min_total_pixels: 400000 };
    return model;
  };

  it("声明了就整条覆盖该工作流，没声明回落模型级", () => {
    const model = withWorkflowRule();
    expect(inputImageRuleOf(model, "text_to_image").formats).toEqual(["png"]);
    expect(inputImageRuleOf(model, "text_to_image").min_total_pixels).toBe(400000);
    expect(inputImageRuleOf(model, "image_edit")).toBe(model.input_image_rule);
  });

  it("老模型完全没这项时仍是模型级规则", () => {
    const qwen = modelOf(QWEN);
    expect(inputImageRuleOf(qwen, "text_to_image", "layer_split")).toBe(qwen.input_image_rule);
    expect(maxReferencesOf(qwen, "image_edit", "layer_split")).toBe(qwen.workflows.image_edit.max_references);
  });

  it("没声明拆分场景的模型沿用工作流规则（5.0 Pro）", () => {
    const pro = modelOf(PRO);
    expect(pro.workflows.image_edit.layer_split).toBeUndefined();
    expect(inputImageRuleOf(pro, "image_edit", "layer_split")).toBe(pro.input_image_rule);
    expect(maxReferencesOf(pro, "image_edit", "layer_split")).toBe(10);
  });
});

describe("#176 三层 512×512", () => {
  const flash = modelOf(FLASH);
  it("拆分场景合法（恰等于 262144 下限）", () => {
    expect(imageRuleViolations(facts("png", 512, 512), flash.workflows.image_edit.layer_split!.input_image_rule)).toEqual([]);
  });
  it("尺寸自定义区间非法（低于 921600）", () => {
    const custom = flash.workflows.text_to_image.size_rule.custom!;
    expect(custom.min_total_pixels).toBe(921600);
    expect(withinPixelRange(custom, 512, 512)).toBe(false);
  });
});

describe("#176 请求层不再写死拆分约束", () => {
  const PNG = new Uint8Array([137, 80, 78, 71]);
  const generation = (mediaType: string, count: number): GenerationInput => ({
    model: modelOf(FLASH), text: "", nativeNegativePrompt: null, size: { width: 1024, height: 1024 },
    references: Array.from({ length: count }, () => ({ mediaType, bytes: PNG, hasAlpha: true })),
    layerDecomposition: true, layerSize: "auto",
  });

  it("两张参考图在请求层也被拦（兜底）", () => {
    expect(() => buildGenerationRequest(generation("image/png", 2))).toThrow(/1 张/);
  });
  it("webp 在请求层也被拦", () => {
    expect(() => buildGenerationRequest(generation("image/webp", 1))).toThrow(/PNG \/ JPEG/);
  });
  it("生成场景照旧放行 webp", () => {
    expect(() => buildGenerationRequest({ ...generation("image/webp", 1), layerDecomposition: false })).not.toThrow();
  });
});

describe("#176 拖线时就地拦格式（复审第 1 条）", () => {
  /** 把 r2 的路径换成指定图片，再试着连到拆分任务上。 */
  const connect = (path: string) => {
    const board = splitBoard();
    const nodes = board.nodes.map((n) => (n.id === "r2" && n.type === "reference" ? { ...n, path } : n));
    return canConnect({ ...board, nodes }, BUILTIN_TABLE, { source: "r2", sourceHandle: "out", target: "t1", targetHandle: "image:0" });
  };

  it("webp 参考图连不上拆分任务，png / jpeg 连得上", () => {
    expect(connect("r2.webp")).toEqual({ ok: false, reason: "图层拆分参考图只接受 PNG / JPEG" });
    expect(connect("r2.png")).toEqual({ ok: true });
    expect(connect("r2.JPG")).toEqual({ ok: true });
  });

  it("生成场景的同一张 webp 照旧连得上", () => {
    const board = splitBoard();
    const nodes = board.nodes.map((n) => (n.type === "task" ? { ...n, layer_decomposition: false } : n.id === "r2" && n.type === "reference" ? { ...n, path: "r2.webp" } : n));
    expect(canConnect({ ...board, nodes }, BUILTIN_TABLE, { source: "r2", sourceHandle: "out", target: "t1", targetHandle: "image:0" })).toEqual({ ok: true });
  });
});

describe("#176 标黄按场景规则算（复审第 1 条的另一半）", () => {
  const splitRule = modelOf(FLASH).workflows.image_edit.layer_split!.input_image_rule;

  it("接了拆分任务就按拆分声明提示，接了生成任务按模型级", () => {
    expect(inputRulesFor(splitBoard(true), BUILTIN_TABLE, "r1", null)).toEqual([splitRule]);
    const board = splitBoard(true);
    const nodes = board.nodes.map((n) => (n.type === "task" ? { ...n, layer_decomposition: false } : n));
    expect(inputRulesFor({ ...board, nodes }, BUILTIN_TABLE, "r1", null)).toEqual([modelOf(FLASH).input_image_rule]);
  });

  it("未接线的参考图按回退模型", () => {
    expect(inputRulesFor({ ...splitBoard(), edges: [] }, BUILTIN_TABLE, "r2", FLASH)).toEqual([modelOf(FLASH).input_image_rule]);
  });
});

describe("#176 拆分场景的字节上限也当场判（复审「顺带」）", () => {
  it("30.0 MB 以内放行，超一个字节当场拦下", () => {
    expect(splitReferenceRefusal(splitBoard(), BUILTIN_TABLE, "t1", [imported("a.png", 512, 512, 30000000)])).toBeNull();
    expect(splitReferenceRefusal(splitBoard(), BUILTIN_TABLE, "t1", [imported("a.png", 512, 512, 30000001)])).toContain("超过上限");
  });

  it("没带字节数（未知）时放行，留给派发前按快照验", () => {
    expect(splitReferenceRefusal(splitBoard(), BUILTIN_TABLE, "t1", [imported("a.png", 512, 512)])).toBeNull();
  });
});

describe("#176 两级同时声明时的优先级（复审第 5 条）", () => {
  /** 工作流级说只收 png 且下限 400000；拆分场景另说一套。 */
  const both = (): ModelCapability => {
    const table = structuredClone(BUILTIN_TABLE);
    const model = findModel(table, FLASH)!;
    model.workflows.image_edit.input_image_rule = { ...model.input_image_rule, formats: ["png"], min_total_pixels: 400000 };
    model.workflows.image_edit.layer_split = { max_references: 1, input_image_rule: { ...model.input_image_rule, formats: ["jpeg"], min_total_pixels: 100000 } };
    return model;
  };

  it("拆分场景用拆分声明，生成场景用工作流级，两者互不覆盖", () => {
    const model = both();
    expect(inputImageRuleOf(model, "image_edit", "layer_split").formats).toEqual(["jpeg"]);
    expect(inputImageRuleOf(model, "image_edit", "generate").formats).toEqual(["png"]);
    expect(maxReferencesOf(model, "image_edit", "layer_split")).toBe(1);
  });

  it("兜底没有第三处实现：请求层用的就是拆分声明", () => {
    const table = structuredClone(BUILTIN_TABLE);
    findModel(table, FLASH)!.workflows.image_edit.layer_split!.input_image_rule.max_bytes = 3;
    const model = findModel(table, FLASH)!;
    const input: GenerationInput = {
      model, text: "", nativeNegativePrompt: null, size: { width: 1024, height: 1024 },
      references: [{ mediaType: "image/png", bytes: new Uint8Array([1, 2, 3, 4]), hasAlpha: true }],
      layerDecomposition: true, layerSize: "auto",
    };
    expect(() => buildGenerationRequest(input)).toThrow(/不合规/);
  });
});

describe("#176 能力表 schema", () => {
  it("拆分声明张数非法或缺规则视为损坏", () => {
    const broken = structuredClone(BUILTIN_TABLE);
    (findModel(broken, FLASH)!.workflows.image_edit.layer_split as unknown as { max_references: number }).max_references = 0;
    expect(parseCapabilityTable(broken).ok).toBe(false);
    const missing = structuredClone(BUILTIN_TABLE);
    delete (findModel(missing, FLASH)!.workflows.image_edit.layer_split as unknown as { input_image_rule?: unknown }).input_image_rule;
    expect(parseCapabilityTable(missing).ok).toBe(false);
  });
});

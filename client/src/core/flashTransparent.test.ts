import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE, findModel } from "./capabilities";
import { buildGenerationRequest } from "./gateway";
import { taskView } from "./taskView";
import { board } from "./testing/runnerHarness";
import type { TaskNode } from "./board";
import { createRunner } from "./runner";
import { memoryTaskFs } from "./testing/memoryTaskFs";
import { settle } from "./testing/runnerHarness";
import { png as makePng } from "./testing/png";
import type { RunDeps } from "./run";
import { editBoard } from "./edit";

function runnerSetup(alpha: boolean | undefined = true) {
  const bytes = Uint8Array.from(Buffer.from(makePng(32, 32, { alpha: true }), "base64"));
  const fs = memoryTaskFs([["/root/refs/cat.png", bytes]]);
  const bodies: Record<string, any>[] = [];
  let b = board(["t1"], true);
  const t = b.nodes.find(n => n.type === "task") as TaskNode;
  t.model = "doubao-seedream-5-0-flash-260915";
  t.transparent_background = true;
  let tick = 0;
  let badOutput = false;
  const opaqueBytes = Uint8Array.from(Buffer.from(makePng(32, 32), "base64"));
  const deps: RunDeps = { ...fs, now: () => new Date(Date.UTC(2026, 9, 10, 0, 0, tick++)), schedule: () => () => {},
    composeOverlay: async () => bytes,
    imageCodec: { decode: async data => ({ width: 32, height: 32, hasAlpha: () => data[25] === 2 ? false : alpha as boolean, encode: async () => bytes, close: () => {} }) },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body!));
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from(badOutput ? opaqueBytes : bytes).toString("base64") }] }), arrayBuffer: async () => bytes.slice().buffer };
    } };
  const runner = createRunner({ deps, apply: (_key, change) => { b = editBoard(b, change, { table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set(), imageSize: () => undefined, newId: () => "result" }).board; }, log: () => {}, concurrency: 1 });
  const target = { boardKey: "A", boardFile: "A", table: BUILTIN_TABLE, userRoot: "/root", baseUrl: "http://gw", apiKey: "k" };
  return { fs, bytes, bodies, runner, target, board: () => b, unknownAlpha: () => { alpha = undefined; }, opaqueOutput: () => { badOutput = true; } };
}

it("公开运行器提交保存透明参数与快照，重新生成沿用历史 PNG/透明而非节点当前 JPEG/关闭状态", async () => {
  const h = runnerSetup();
  expect(await h.runner.submit(h.target, h.board(), ["t1"])).toEqual([]);
  await settle();
  expect(h.bodies).toHaveLength(1);
  expect(h.bodies[0]).toMatchObject({ background: "transparent", output_format: "png" });
  const records = [...h.fs.files.entries()].filter(([path]) => path.endsWith("/task.json"));
  expect(JSON.parse(new TextDecoder().decode(records[0][1]))).toMatchObject({ transparent_background: true, references: [{ source: { kind: "reference" } }] });
  const task = h.board().nodes.find(n => n.type === "task") as TaskNode;
  task.transparent_background = false;
  task.output_options = { output_format: "jpeg", response_format: "url", watermark: false };
  h.fs.files.delete("/root/refs/cat.png");
  await h.runner.regenerate(h.target, h.board(), "t1");
  await settle();
  expect(h.bodies).toHaveLength(2);
  expect(h.bodies[1]).toMatchObject({ background: "transparent", output_format: "png", image: h.bodies[0].image });
  expect([...h.fs.files.keys()].filter(p => p.endsWith("/result.png"))).toHaveLength(2);
});

it("区域指示把唯一 alpha 输入展开成原图+叠加图后，运行前以同一理由阻断：零请求零写入", async () => {
  // 组合验收（区域 × 透明）：叠加展开发生在发送计划，透明要求恰好一张实际参考图，
  // 阻断理由必须与节点控件展示的 transparentNeedsOneImage 一致。
  const h = runnerSetup();
  const b = h.board();
  b.edges[1].region = { rects: [[0, 0, 0.5, 0.5]], render: "highlight_overlay" };
  expect(await h.runner.submit(h.target, b, ["t1"])).toContain("透明背景需要恰好一张实际参考图");
  await settle();
  expect(h.bodies).toEqual([]);
  expect([...h.fs.files.keys()].some(p => p.endsWith("/task.json"))).toBe(false);
});

const model = findModel(BUILTIN_TABLE, "doubao-seedream-5-0-flash-260915")!;
const model55 = findModel(BUILTIN_TABLE, "doubao-seedream-5-5-261028")!;
const t2iInput = { model: model55, text: "一只橘猫贴纸", nativeNegativePrompt: null, size: { width: 1024, height: 1024 }, references: [], transparentBackground: true };
const jpegOptions = { output_format: "jpeg" as const, response_format: "url" as const, watermark: false };

/** 5.5 文生图没有连线（工作流由参考图张数推导，0 张 = text_to_image）。 */
function textToImageBoard(modelId: string) {
  const b = board(["t1"], true);
  const t = b.nodes.find(n => n.type === "task") as TaskNode;
  t.model = modelId;
  t.transparent_background = true;
  b.edges = [];
  b.nodes = b.nodes.filter(n => n.type === "task");
  return b;
}

const t2iFacts = { discovery: { source: "none" as const }, missingNodes: new Set<string>(), alphaByNode: new Map<string, boolean>(), concurrency: 4 };

describe("透明背景按工作流的能力声明判定（#182）", () => {
  it("5.5 文生图 + 透明提交：background=transparent、output_format=png，不需要参考图", () => {
    expect(buildGenerationRequest(t2iInput).body).toMatchObject({ background: "transparent", output_format: "png" });
    expect(buildGenerationRequest(t2iInput).body).not.toHaveProperty("image");
  });

  it("5.5 文生图 + 透明 + jpeg 输出仍被拦：官方该组合非法", () => {
    expect(() => buildGenerationRequest({ ...t2iInput, outputOptions: jpegOptions })).toThrow("透明背景输出必须为 PNG");
  });

  it("5.0 Flash 行为不变：文生图（零参考图）+ 透明仍被拦", () => {
    expect(() => buildGenerationRequest({ ...t2iInput, model })).toThrow("透明背景需要恰好一张实际参考图");
  });

  it("界面开关与运行规则同步：5.5 文生图可开，5.0 Flash 不可开", () => {
    expect(taskView(textToImageBoard(model55.model_id), BUILTIN_TABLE, "t1", t2iFacts)!.toggles.transparentBackground.canEnable).toBe(true);
    const flashView = taskView(textToImageBoard(model.model_id), BUILTIN_TABLE, "t1", t2iFacts)!;
    expect(flashView.toggles.transparentBackground.canEnable).toBe(false);
    expect(flashView.reasons.map(r => r.kind)).toContain("transparentNeedsOneImage");
  });

  it("5.5 文生图开启透明后没有阻断原因；改成 jpeg 才出现 transparentNeedsPng", () => {
    const b = textToImageBoard(model55.model_id);
    // 只锁透明相关的阻断；其他原因（如未测能力提示）不属于本票范围。
    expect(taskView(b, BUILTIN_TABLE, "t1", t2iFacts)!.reasons.map(r => r.kind).filter(k => k.startsWith("transparent"))).toEqual([]);
    (b.nodes.find(n => n.type === "task") as TaskNode).output_options = jpegOptions;
    expect(taskView(b, BUILTIN_TABLE, "t1", t2iFacts)!.reasons.map(r => r.kind)).toContain("transparentNeedsPng");
  });
});

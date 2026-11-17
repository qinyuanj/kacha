// 生成任务视图：一个生成任务按当前画板、能力表与界面采集的事实，能不能运行、为什么、节点上显示什么。
// 生成任务节点与二次确认（buildConfirmItems）消费同一份，「节点标红 ≡ 运行被拦」由构造保证。
// 换模型绝不自动删线或改设置，只报告原因。
import { findTask, runCopies, type Board, type BoardEdge, type TaskNode } from "./board";
import { findModel, isRetiredModel, isSupported, LITE_RETIRED_HINT, type CapabilityTable, type ModelCapability, type SizeRule } from "./capabilities";
import { isFlashShape, isLayerSize, isRequestShapeImplemented, LAYER_SIZES_TEXT } from "./gateway";
import { imageEdges, imageKey, imagePortSlots, imageSources, promptText, workflowOf } from "./graph";
import { MAX_REGIONS } from "./overlay";
import { effectiveRegionRender, expandImageEdges } from "./region";
import { planSend, promptLanguage, referenceProblemsOf, type ReferenceProblems, type SendPlan } from "./sendPlan";
import { availableModels, modelAvailabilityIssue, type Discovery } from "./settings";
import { isAutoRatio, ratioRangeText, ratioValue, resolveSize, sizeTiersOf, withinRatioRange, type SizeSpec } from "./size";

/** 不可运行原因的种类（封闭）。 */
export type ReasonKind =
  | "positiveMissing"
  | "positiveEmpty"
  | "modelUnknown"
  | "modelRetired"
  | "modelUnshelved"
  | "modelNotFromGateway"
  | "requestShapeMissing"
  | "imageEditUnsupported"
  | "tooManyReferences"
  | "regionUnsupported"
  | "tooManyRegions"
  | "negativeUnsupported"
  | "sizeUnsupported"
  | "layerNeedsOneImage"
  | "layerUnsupported"
  | "transparentUnsupported"
  | "transparentNeedsOneImage"
  | "transparentNoAlpha"
  | "transparentNeedsPng"
  | "referenceOutOfRange"
  | "sourceLayerInvalid"
  | "imageMissing";

/** 未就绪 = 还没填完（节点不标红）；错误 = 其余（节点标红）。两类都阻止提交。 */
export type ReasonCategory = "notReady" | "error";

export interface UnrunnableReason {
  kind: ReasonKind;
  category: ReasonCategory;
  text: string;
}

/** 界面采集的事实；透明背景必须明确确认 alpha，其余未知按各项规则处理。 */
export interface TaskFacts {
  /** 图片文件缺失的参考图 / 结果节点 id。 */
  missingNodes: ReadonlySet<string>;
  /** 节点 id → 是否带透明通道；不在 Map 里 = 未知。 */
  alphaByNode: ReadonlyMap<string, boolean>;
  discovery: Discovery;
  /** 页面当前的并发上限：实际份数不超过它。 */
  concurrency: number;
}

/** 任务开关能不能打开；hint 为不能打开的简短说明，能打开时为空串。已打开的开关不受它约束（条件变坏保留 + 标红，绝不自动关）。 */
export interface ToggleAvailability {
  canEnable: boolean;
  hint: string;
}

/** 模型标签 4 态：正常 / 能力表里没有 / 已发现模型列表但网关没有 / 不在上架清单。 */
export type ModelLabelState = "ok" | "unknown" | "notFromGateway" | "unshelved";

export interface TaskView {
  /** 不可运行原因；空 = 可运行。节点标红只看 category 为 error 的。 */
  reasons: UnrunnableReason[];
  /** 黄色提示，不阻断。 */
  warnings: string[];
  /** 有线但提示词没引用的用户序号（从 1 起）。 */
  unreferenced: number[];
  model: { state: ModelLabelState; label: string };
  /** 最终发送的像素（与提交时同一换算）；发不出去或模型缺失时为 null。 */
  size: { width: number; height: number } | null;
  /** 手动的宽高比在当前模型 / 分辨率档下发不出去（档位本身在尺寸表内）。 */
  ratioUnsupported: boolean;
  toggles: { transparentBackground: ToggleAvailability; layerDecomposition: ToggleAvailability };
}

const NOT_READY: ReadonlySet<ReasonKind> = new Set(["positiveMissing", "positiveEmpty"]);

const reason = (kind: ReasonKind, text: string): UnrunnableReason => ({ kind, category: NOT_READY.has(kind) ? "notReady" : "error", text });

export function taskView(board: Board, table: CapabilityTable, taskId: string, facts: TaskFacts): TaskView | null {
  const task = findTask(board, taskId);
  if (!task) return null;
  const model = findModel(table, task.model);
  const refs = imageRefProblems(board, table, taskId);
  const transparent = transparentBlock(board, model, taskId, facts);
  const layer = layerBlock(board, model, taskId);
  return {
    reasons: dedupe([
      ...inputReasons(board, table, task, model),
      ...taskModelReasons(board, table, task, model, facts.discovery),
      ...enabledToggleReasons(task, layer, transparent),
      ...refs.issues.map((text) => reason("referenceOutOfRange", text)),
      ...imageSourceReasons(board, taskId, facts),
    ]),
    warnings: [...refs.warnings, ...taskWarnings(board, task, model, facts.concurrency)],
    unreferenced: refs.unreferenced,
    model: modelLabel(table, facts.discovery, task.model),
    ...taskSizeView(board, task, model),
    toggles: {
      transparentBackground: { canEnable: transparent === null, hint: transparent?.hint ?? "" },
      layerDecomposition: { canEnable: model !== undefined && layer === null, hint: layer ?? "" },
    },
  };
}

/** Flash 拆层不要求提示词，改按实际参考图数与图层尺寸校验。 */
function inputReasons(board: Board, table: CapabilityTable, task: TaskNode, model: ModelCapability | undefined): UnrunnableReason[] {
  const taskId = task.id;
  const flashLayers = isFlashShape(model) && task.layer_decomposition;
  return [
    ...(flashLayers ? [] : promptReasons(board, taskId)),
    ...(flashLayers && imagePortSlots(board, table, taskId).length !== 1 ? [reason("layerNeedsOneImage", "图层拆分需要恰好一张 PNG/JPEG 参考图，不支持区域派生图")] : []),
    ...(flashLayers && !isLayerSize(task.layer_size ?? "auto") ? [reason("sizeUnsupported", `图层尺寸只支持 ${LAYER_SIZES_TEXT}`)] : []),
  ];
}

function taskModelReasons(board: Board, table: CapabilityTable, task: TaskNode, model: ModelCapability | undefined, discovery: Discovery): UnrunnableReason[] {
  if (isRetiredModel(task.model)) return [reason("modelRetired", LITE_RETIRED_HINT)];
  if (!model) return [reason("modelUnknown", `模型 ${task.model} 不在能力表内`)];
  return [...availabilityReasons(table, discovery, model), ...modelReasons(board, model, task)];
}

function layerBlock(board: Board, model: ModelCapability | undefined, taskId: string): string | null {
  return model && !isSupported(model.workflows[workflowOf(board, taskId)].layer_decomposition) ? "模型不支持拆分图层" : null;
}

function enabledToggleReasons(task: TaskNode, layer: string | null, transparent: ReturnType<typeof transparentBlock>): UnrunnableReason[] {
  return [
    ...(task.layer_decomposition && layer ? [reason("layerUnsupported", layer)] : []),
    ...(task.transparent_background && transparent ? [reason(transparent.kind, transparent.text)] : []),
  ];
}

function imageSourceReasons(board: Board, taskId: string, facts: TaskFacts): UnrunnableReason[] {
  return imageSources(board, taskId, "").flatMap((src, i) => {
    if (src.absPath === null) return [reason("sourceLayerInvalid", `图${i + 1} 来源图层无效：${src.label}`)];
    // 缺图按来源分键：图层线只看自己那层，底图线只看底图，互不株连。
    const key = imageKey(src.nodeId, src.sourceLayer);
    return facts.missingNodes.has(key) ? [reason("imageMissing", `图${i + 1} 图片缺失：${src.label}`)] : [];
  });
}

function taskWarnings(board: Board, task: TaskNode, model: ModelCapability | undefined, concurrency: number): string[] {
  const taskId = task.id;
  const edgeCount = imageEdges(board, taskId).length;
  const englishUnverified = !!model && edgeCount > 0 && promptLanguage(promptText(board, taskId, "positive")) === "en" && model.reference_phrasing.en_verified === "untested";
  const copies = runCopies(task, concurrency);
  return [...(englishUnverified ? ["该模型英文序号未验证"] : []), ...(copies.actual < copies.set ? [`份数 ${copies.set}，本次按 ${copies.actual}`] : [])];
}

function taskSizeView(board: Board, task: TaskNode, model: ModelCapability | undefined): Pick<TaskView, "size" | "ratioUnsupported"> {
  const taskId = task.id;
  const flashLayers = isFlashShape(model) && task.layer_decomposition;
  const rule = model?.workflows[workflowOf(board, taskId)].size_rule;
  const size = !flashLayers && rule ? resolveSize(rule, task.size_spec) : null;
  return { size, ratioUnsupported: manualRatioUnsupported(rule, task.size_spec, size) };
}

function manualRatioUnsupported(rule: SizeRule | undefined, spec: SizeSpec, size: TaskView["size"]): boolean {
  const { tier, ratio } = spec;
  return !!rule && !isAutoRatio(spec) && tier !== null && sizeTiersOf(rule).includes(tier) && ratio !== null && size === null;
}

function modelLabel(table: CapabilityTable, discovery: Discovery, modelId: string): TaskView["model"] {
  if (isRetiredModel(modelId)) return { state: "unknown", label: "Lite（已停用，请切换到 Flash）" };
  const model = findModel(table, modelId);
  if (!model) return { state: "unknown", label: `${modelId}（未知模型）` };
  if (availableModels(table, discovery).some((m) => m.model_id === modelId)) return { state: "ok", label: model.display_name };
  return model.tier !== null ? { state: "notFromGateway", label: `${model.display_name}（网关未提供）` } : { state: "unshelved", label: `${model.display_name}（未上架）` };
}

/**
 * 透明背景按展开后的实际参考图数、所选文件的 alpha 与输出格式校验，开关和不可运行原因共用规则。
 * 透明通道未知时阻止启用；模型缺失时由「不在能力表内」拦。
 */
function transparentBlock(board: Board, model: ModelCapability | undefined, taskId: string, facts: TaskFacts): { kind: ReasonKind; text: string; hint: string } | null {
  if (!model) return null;
  if (!isSupported(model.transparent_background)) return { kind: "transparentUnsupported", text: "模型不支持透明背景", hint: "模型不支持透明背景" };
  const edges = imageEdges(board, taskId);
  if (expandImageEdges(edges, model).length !== 1) {
    const text = isFlashShape(model) ? "需要恰好一张实际参考图" : "需要恰好一条图片线";
    return { kind: "transparentNeedsOneImage", text: `透明背景${text}`, hint: text };
  }
  const task = findTask(board, taskId)!;
  if (isFlashShape(model) && task.output_options?.output_format === "jpeg") return { kind: "transparentNeedsPng", text: "透明背景输出必须为 PNG", hint: "输出必须为 PNG" };
  const edge = edges[0];
  const alpha = facts.alphaByNode.get(imageKey(edge.from[0], edge.source_layer));
  return alpha === true ? null : { kind: "transparentNoAlpha", text: alpha === false ? "该图不带透明通道" : "参考图透明通道尚未确认", hint: alpha === false ? "该图不带透明通道" : "透明通道尚未确认" };
}

/** 按画板当前内容的发送计划；模型不在能力表内时没有发送计划。 */
export function sendPlanOf(board: Board, table: CapabilityTable, taskId: string): SendPlan | null {
  const task = findTask(board, taskId);
  const model = task && findModel(table, task.model);
  if (!model) return null;
  const plan = planSend(model, imagePortSlots(board, table, taskId), promptText(board, taskId, "positive"), promptText(board, taskId, "negative"));
  return isFlashShape(model) && task.layer_decomposition && !promptText(board, taskId, "positive").trim() && !promptText(board, taskId, "negative").trim() ? { ...plan, text: "" } : plan;
}

/** 「图N」「区域N」的引用越界与未引用，取自发送计划；没有发送计划（模型缺失）时按无固定句算。 */
function imageRefProblems(board: Board, table: CapabilityTable, taskId: string): ReferenceProblems {
  const plan = sendPlanOf(board, table, taskId);
  return plan ? plan.referenceProblems : referenceProblemsOf(undefined, imagePortSlots(board, table, taskId), promptText(board, taskId, "positive"));
}

/** 同一种类、同一文案只留一条。 */
function dedupe(reasons: UnrunnableReason[]): UnrunnableReason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const key = `${r.kind}\u0000${r.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasEdge(board: Board, taskId: string, port: string): boolean {
  return board.edges.some((e) => e.to[0] === taskId && e.to[1] === port);
}

function promptReasons(board: Board, taskId: string): UnrunnableReason[] {
  if (!hasEdge(board, taskId, "positive")) return [reason("positiveMissing", "正向提示词未连接")];
  return promptText(board, taskId, "positive").trim() ? [] : [reason("positiveEmpty", "正向提示词为空")];
}

/** 模型能不能用：上架、网关是否提供（已发现模型列表时）、请求形态是否已接入。 */
function availabilityReasons(table: CapabilityTable, discovery: Discovery, model: ModelCapability): UnrunnableReason[] {
  const out: UnrunnableReason[] = [];
  if (model.tier === null) out.push(reason("modelUnshelved", `模型 ${model.display_name} 未上架`));
  const unavailable = modelAvailabilityIssue(table, discovery, model.model_id);
  if (unavailable) out.push(reason("modelNotFromGateway", unavailable));
  if (!isRequestShapeImplemented(model)) out.push(reason("requestShapeMissing", `模型 ${model.display_name} 的请求形态尚未接入`));
  return out;
}

/** 按能力表判断的原因：参考图名额、区域、负向、尺寸。 */
function modelReasons(board: Board, model: ModelCapability, task: TaskNode): UnrunnableReason[] {
  const edges = imageEdges(board, task.id);
  const wf = model.workflows[workflowOf(board, task.id)];
  return [
    ...referenceCountReasons(edges, model),
    ...regionReasons(edges, model),
    ...(hasEdge(board, task.id, "negative") && !isSupported(wf.supports_negative_prompt) ? [reason("negativeUnsupported", "模型不支持负向提示词")] : []),
    ...generationSizeReasons(model, task, wf.size_rule),
  ];
}

function referenceCountReasons(edges: BoardEdge[], model: ModelCapability): UnrunnableReason[] {
  const max = model.workflows.image_edit.max_references;
  const expanded = expandImageEdges(edges, model).length;
  if (edges.length > 0 && max === 0) return [reason("imageEditUnsupported", "模型不支持图片编辑")];
  return expanded > max ? [reason("tooManyReferences", `参考图 ${expanded} 张超出模型上限 ${max} 张`)] : [];
}

function regionReasons(edges: BoardEdge[], model: ModelCapability): UnrunnableReason[] {
  const out: UnrunnableReason[] = [];
  const render = effectiveRegionRender(model);
  const regions = edges.reduce((n, e) => n + (e.region?.rects.length ?? 0), 0);
  if (render === null && regions > 0) out.push(reason("regionUnsupported", "模型不支持框选修改区域"));
  if (render !== null && regions > MAX_REGIONS) out.push(reason("tooManyRegions", `框选了 ${regions} 个区域，最多 ${MAX_REGIONS} 个`));
  return out;
}

function generationSizeReasons(model: ModelCapability, task: TaskNode, rule: SizeRule): UnrunnableReason[] {
  if (!(isFlashShape(model) && task.layer_decomposition) && resolveSize(rule, task.size_spec) === null) {
    return [reason("sizeUnsupported", unsupportedSizeText(rule, task.size_spec))];
  }
  return [];
}

function unsupportedSizeText(rule: SizeRule, s: SizeSpec): string {
  const range = unsupportedRatioRange(rule, s);
  return s.tier === null ? `自定义尺寸 ${s.width}×${s.height} 超出模型范围` : range !== null ? `宽高比 ${s.ratio} 超出模型范围 ${range}` : `生成尺寸 ${s.tier} · ${s.ratio} 不在模型尺寸表内`;
}

function unsupportedRatioRange(rule: SizeRule, s: SizeSpec): string | null {
  const value = ratioValue(s.ratio);
  // 只有宽高比本身越界才报范围；分辨率档不认识、或没有 custom 范围的模型仍按「不在尺寸表内」。
  return s.tier !== null && s.tier in rule.tiers && value !== null && !withinRatioRange(rule, value) ? ratioRangeText(rule) : null;
}

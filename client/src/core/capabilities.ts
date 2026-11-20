// 模型能力表：模型决定能力，能力决定生成任务节点上露出的端口、开关与分辨率档。
// 内置 JSON + 同 schema 覆盖文件，按 model_id 整条合并；不按模型名猜能力。
import type { RegionRender } from "./board";
import builtinJson from "./capabilities.builtin.json";

export const CAPABILITY_FORMAT_VERSION = 1;

export const RETIRED_LITE_MODEL = "doubao-seedream-5-0-lite-260128";
export const LITE_RETIRED_HINT = "Lite 已停用，请切换到 Flash";
export const isRetiredModel = (modelId: string): boolean => modelId === RETIRED_LITE_MODEL;

/** 三态：待测在 UI 上等同不支持，仅在模型说明浮层列出。 */
export type TriState = "supported" | "unsupported" | "untested";
export type Tier = "flagship" | "economy";
export type WorkflowName = "text_to_image" | "image_edit";

/**
 * 透明背景怎么落地（#182）：按**工作流**声明，不再写死在请求构造里。
 * - native：模型原生出 RGBA，不需要参考图（Seedream 5.5 文生图）
 * - alpha_reference：必须恰好一张已确认带透明通道的参考图（Seedream 5.0 Flash 的全部工作流）
 * 未声明时按 alpha_reference 处理——那是既有行为，也是更严格的一侧。
 */
export type TransparentRule = "native" | "alpha_reference";

export const TIER_LABELS: Record<Tier, string> = { flagship: "旗舰", economy: "经济" };

export interface InputImageRule {
  formats: string[];
  max_bytes: number | null;
  min_total_pixels: number | null;
  max_total_pixels: number | null;
  min_short_edge: number | null;
  min_aspect_ratio: number | null;
  max_aspect_ratio: number | null;
}

export interface PixelRange {
  min_total_pixels: number | null;
  max_total_pixels: number | null;
  min_aspect_ratio: number | null;
  max_aspect_ratio: number | null;
}

export interface SizeRule {
  /** 分辨率档 → 宽高比 → [宽, 高]；对象键顺序即下拉顺序。 */
  tiers: Record<string, Record<string, [number, number]>>;
  custom: PixelRange | null;
}

/**
 * 图层拆分的输出张数约束（#175）：只有声明了这条的工作流才在请求里发 max_images。
 * 没声明 = 该工作流不接受张数配置 —— 5.0 Flash / Pro 保持原样，请求体里不出现这个字段。
 */
export interface LayerMaxImagesRule {
  min: number;
  max: number;
  default: number;
}

/**
 * 拆分场景的输入规则（#176）：拆分只接受声明里的张数、格式与像素范围，
 * 声明在工作流上，整条覆盖模型级 input_image_rule（解析见 inputImageRuleOf）。
 */
export interface LayerSplitRule {
  /** 拆分场景的参考图张数上限：拆分的底图只有一张。 */
  max_references: number;
  /** 拆分场景的参考图规则；整条替换模型级，不做逐字段合并（null 的含义不会被继承搞混）。 */
  input_image_rule: InputImageRule;
}

export interface WorkflowCapability {
  supports_negative_prompt: TriState;
  min_references: number;
  max_references: number;
  size_rule: SizeRule;
  layer_decomposition: TriState;
  /** 透明背景怎么落地；缺省 alpha_reference（见 TransparentRule）。只在模型支持透明背景时有意义。 */
  transparent_rule?: TransparentRule;
  /** 拆分图层的输出张数约束；缺省 = 该工作流不发 max_images（见 LayerMaxImagesRule）。 */
  layer_max_images?: LayerMaxImagesRule | null;
  /**
   * 本工作流的参考图规则（生成场景）：声明了整条覆盖模型级，缺省回落模型级（#176）。
   * 键名按工作流而不是场景 —— 拆分场景见下面的 layer_split，两者并列、互不覆盖。
   */
  input_image_rule?: InputImageRule | null;
  /** 拆分场景的参考图规则与张数；缺省回落本工作流、再回落模型级（#176）。 */
  layer_split?: LayerSplitRule | null;
}

export interface ModelCapability {
  model_id: string;
  display_name: string;
  tier: Tier | null;
  help_url: string | null;
  request_shape: string;
  fixed_params: Record<string, unknown>;
  input_image_rule: InputImageRule;
  reference_phrasing: { en_verified: TriState };
  region_hint: Record<RegionRender, TriState>;
  region_hint_phrasing: Partial<Record<RegionRender, { zh: string; en: string }>>;
  native_mask: TriState;
  transparent_background: TriState;
  workflows: Record<WorkflowName, WorkflowCapability>;
}

export interface CapabilityTable {
  format_version: number;
  models: ModelCapability[];
}

export type ParseResult = { ok: true; table: CapabilityTable } | { ok: false; errors: string[] };

export function isSupported(value: TriState): boolean {
  return value === "supported";
}

/** 工作流由参考图张数决定：0 张 = 文生图，≥1 张 = 图片编辑。 */
export function workflowFor(referenceCount: number): WorkflowName {
  return referenceCount > 0 ? "image_edit" : "text_to_image";
}

/** 输入场景：普通生成，或图层拆分（#176）。规则按场景取，不看模型名。 */
export type InputScene = "generate" | "layer_split";

/**
 * 参考图规则按层级解析（#176）：拆分场景 > 工作流级 > 模型级。
 * 老模型两条都没声明时逐级回落到模型级，行为与改动前一致。
 */
export function inputImageRuleOf(model: ModelCapability, workflow: WorkflowName, scene: InputScene = "generate"): InputImageRule {
  const declared = model.workflows[workflow];
  if (scene === "layer_split" && declared.layer_split) return declared.layer_split.input_image_rule;
  return declared.input_image_rule ?? model.input_image_rule;
}

/** 与规则同层级的参考图张数上限：拆分场景用拆分声明，缺省回落该工作流的 max_references。 */
export function maxReferencesOf(model: ModelCapability, workflow: WorkflowName, scene: InputScene = "generate"): number {
  const declared = model.workflows[workflow];
  if (scene === "layer_split" && declared.layer_split) return declared.layer_split.max_references;
  return declared.max_references;
}


/** 该工作流下拆分图层的张数约束；未声明返回 null（请求里不发 max_images）。 */
export function layerMaxImagesRuleOf(model: ModelCapability, workflow: WorkflowName): LayerMaxImagesRule | null {
  return model.workflows[workflow].layer_max_images ?? null;
}

/** 该工作流下透明背景怎么落地；未声明按 alpha_reference（既有行为）。 */
export function transparentRuleOf(model: ModelCapability, workflow: WorkflowName): TransparentRule {
  return model.workflows[workflow].transparent_rule ?? "alpha_reference";
}

export function findModel(table: CapabilityTable, modelId: string): ModelCapability | undefined {
  return table.models.find((m) => m.model_id === modelId);
}

/** 模型选择器：只按模型档位分组展示上架模型（有模型档位 = 上架，ADR 0005）。 */
export function modelsByTier(table: CapabilityTable): { tier: Tier; models: ModelCapability[] }[] {
  return (["flagship", "economy"] as const)
    .map((tier) => ({ tier, models: table.models.filter((m) => m.tier === tier) }))
    .filter((group) => group.models.length > 0);
}

const REGION_LABELS: Record<RegionRender, string> = {
  highlight_overlay: "区域指示：高亮叠加参考图",
  marked_image: "区域指示：图上标记",
  bbox_tag: "区域指示：坐标标签",
};
const WORKFLOW_LABELS: Record<WorkflowName, string> = { text_to_image: "文生图", image_edit: "图片编辑" };

/** 模型说明浮层列出的「待测」能力。 */
export function untestedCapabilities(model: ModelCapability): string[] {
  const out: string[] = [];
  if (model.reference_phrasing.en_verified === "untested") out.push("英文序号措辞");
  for (const kind of Object.keys(REGION_LABELS) as RegionRender[]) {
    if (model.region_hint[kind] === "untested") out.push(REGION_LABELS[kind]);
  }
  if (model.native_mask === "untested") out.push("原生蒙版");
  if (model.transparent_background === "untested") out.push("透明背景");
  for (const wf of Object.keys(WORKFLOW_LABELS) as WorkflowName[]) {
    if (model.workflows[wf].supports_negative_prompt === "untested") out.push(`负向提示词（${WORKFLOW_LABELS[wf]}）`);
  }
  for (const wf of Object.keys(WORKFLOW_LABELS) as WorkflowName[]) {
    if (model.workflows[wf].layer_decomposition === "untested") out.push(`拆分图层（${WORKFLOW_LABELS[wf]}）`);
  }
  return out;
}

/** 覆盖文件按模型合并：同 model_id 整条替换内置，新模型追加。 */
export function mergeOverride(builtin: CapabilityTable, override: CapabilityTable): CapabilityTable {
  const byId = new Map(override.models.map((m) => [m.model_id, m]));
  const models = builtin.models.map((m) => byId.get(m.model_id) ?? m);
  const known = new Set(builtin.models.map((m) => m.model_id));
  models.push(...override.models.filter((m) => !known.has(m.model_id)));
  return { format_version: builtin.format_version, models: models.filter((m) => !isRetiredModel(m.model_id)) };
}

// ---- schema 校验 ----

const TRI_STATES = new Set(["supported", "unsupported", "untested"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkTri(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !TRI_STATES.has(value)) errors.push(`${path} 必须是 supported / unsupported / untested`);
}

function checkNullableNumber(value: unknown, path: string, errors: string[]): void {
  if (value !== null && (typeof value !== "number" || !(value > 0))) errors.push(`${path} 必须是正数或 null`);
}

function checkPixelRange(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) return void errors.push(`${path} 必须是对象`);
  for (const key of ["min_total_pixels", "max_total_pixels", "min_aspect_ratio", "max_aspect_ratio"]) {
    checkNullableNumber(value[key] ?? null, `${path}.${key}`, errors);
  }
}

/** 透明背景的落地方式只能取 native / alpha_reference；缺省表示沿用 alpha_reference。 */
function checkTransparentRule(value: unknown, path: string, errors: string[]): void {
  if (value !== undefined && value !== "native" && value !== "alpha_reference") errors.push(`${path} 必须是 native 或 alpha_reference`);
}

function checkPositiveInt(value: unknown, path: string, errors: string[]): void {
  if (!Number.isInteger(value) || (value as number) < 1) errors.push(`${path} 必须是正整数`);
}

const isInt = (value: unknown): value is number => Number.isInteger(value);

/** default 是否没落在 min–max 之间；三者不全是整数时不算越界（由 checkPositiveInt 报）。 */
function defaultOutOfRange(value: Record<string, unknown>): boolean {
  const { min, max, default: fallback } = value;
  if (!isInt(min) || !isInt(max) || !isInt(fallback)) return false;
  return fallback < min || fallback > max;
}

function checkLayerMaxImagesRange(value: Record<string, unknown>, path: string, errors: string[]): void {
  checkPositiveInt(value.min, `${path}.min`, errors);
  checkPositiveInt(value.max, `${path}.max`, errors);
  checkPositiveInt(value.default, `${path}.default`, errors);
  if (isInt(value.min) && isInt(value.max) && value.min > value.max) errors.push(`${path}.min 不能大于 max`);
  if (defaultOutOfRange(value)) errors.push(`${path}.default 必须落在 min–max 之间`);
}

function checkLayerMaxImages(value: unknown, path: string, errors: string[]): void {
  if (value === undefined || value === null) return;
  if (!isObject(value)) return void errors.push(`${path} 必须是对象或 null`);
  checkLayerMaxImagesRange(value, path, errors);
}

/** 拆分场景的声明：张数上限与整条输入规则都必填（拆分的限制不靠缺省值猜）。 */
function checkLayerSplit(value: unknown, path: string, errors: string[]): void {
  if (value === undefined || value === null) return;
  if (!isObject(value)) return void errors.push(`${path} 必须是对象或 null`);
  checkPositiveInt(value.max_references, `${path}.max_references`, errors);
  checkInputImageRule(value.input_image_rule, `${path}.input_image_rule`, errors);
}

function checkReferenceRange(value: Record<string, unknown>, path: string, errors: string[]): void {
  const min = value.min_references;
  const max = value.max_references;
  if (!Number.isInteger(min) || (min as number) < 0) errors.push(`${path}.min_references 必须是非负整数`);
  if (!Number.isInteger(max) || (max as number) < (min as number)) errors.push(`${path}.max_references 必须是不小于 min 的整数`);
}

function checkRatioTable(ratios: Record<string, unknown>, path: string, errors: string[]): void {
  for (const [ratio, px] of Object.entries(ratios)) {
    if (!Array.isArray(px) || px.length !== 2 || !px.every((n) => Number.isInteger(n) && n > 0)) errors.push(`${path}.${ratio} 必须是两个正整数`);
  }
}

function checkSizeRule(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value) || !isObject(value.tiers)) return void errors.push(`${path}.size_rule.tiers 必须是对象`);
  for (const [tier, ratios] of Object.entries(value.tiers)) {
    if (isObject(ratios)) checkRatioTable(ratios, `${path}.size_rule.tiers.${tier}`, errors);
    else errors.push(`${path}.size_rule.tiers.${tier} 必须是对象`);
  }
  if (value.custom != null) checkPixelRange(value.custom, `${path}.size_rule.custom`, errors);
}

function checkWorkflow(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) return void errors.push(`${path} 必须是对象`);
  checkTri(value.supports_negative_prompt, `${path}.supports_negative_prompt`, errors);
  checkTri(value.layer_decomposition, `${path}.layer_decomposition`, errors);
  checkTransparentRule(value.transparent_rule, `${path}.transparent_rule`, errors);
  checkLayerMaxImages(value.layer_max_images, `${path}.layer_max_images`, errors);
  if (value.input_image_rule != null) checkInputImageRule(value.input_image_rule, `${path}.input_image_rule`, errors);
  checkLayerSplit(value.layer_split, `${path}.layer_split`, errors);
  checkReferenceRange(value, path, errors);
  checkSizeRule(value.size_rule, path, errors);
}

/** 身份与展示字段。 */
function checkModelIdentity(value: Record<string, unknown>, path: string, errors: string[]): void {
  if (typeof value.model_id !== "string" || !value.model_id) errors.push(`${path}.model_id 必须是非空字符串`);
  if (typeof value.display_name !== "string") errors.push(`${path}.display_name 必须是字符串`);
  if (value.tier !== null && value.tier !== "flagship" && value.tier !== "economy") errors.push(`${path}.tier 必须是 flagship / economy / null`);
  if (value.help_url !== null && typeof value.help_url !== "string") errors.push(`${path}.help_url 必须是字符串或 null`);
}

/** 请求形态与固定参数。 */
function checkModelShape(value: Record<string, unknown>, path: string, errors: string[]): void {
  if (typeof value.request_shape !== "string") errors.push(`${path}.request_shape 必须是字符串`);
  if (!isObject(value.fixed_params)) errors.push(`${path}.fixed_params 必须是对象`);
}

/** 参考图输入约束。 */
function checkInputImageRule(rule: unknown, path: string, errors: string[]): void {
  if (!isObject(rule) || !Array.isArray(rule.formats)) return void errors.push(`${path}.formats 必须是数组`);
  for (const key of ["max_bytes", "min_total_pixels", "max_total_pixels", "min_short_edge", "min_aspect_ratio", "max_aspect_ratio"]) {
    checkNullableNumber(rule[key] ?? null, `${path}.${key}`, errors);
  }
}

/** 区域渲染提示、原生蒙版与透明背景三项能力声明。 */
function checkModelHints(value: Record<string, unknown>, path: string, errors: string[]): void {
  checkTri(isObject(value.reference_phrasing) ? value.reference_phrasing.en_verified : undefined, `${path}.reference_phrasing.en_verified`, errors);
  const hint = isObject(value.region_hint) ? value.region_hint : {};
  for (const kind of ["highlight_overlay", "marked_image", "bbox_tag"]) checkTri(hint[kind], `${path}.region_hint.${kind}`, errors);
  if (!isObject(value.region_hint_phrasing)) errors.push(`${path}.region_hint_phrasing 必须是对象`);
  checkTri(value.native_mask, `${path}.native_mask`, errors);
  checkTri(value.transparent_background, `${path}.transparent_background`, errors);
}

/** 两个工作流各自的约束。 */
function checkModelWorkflows(value: unknown, path: string, errors: string[]): void {
  const workflows = isObject(value) ? value : {};
  checkWorkflow(workflows.text_to_image, `${path}.workflows.text_to_image`, errors);
  checkWorkflow(workflows.image_edit, `${path}.workflows.image_edit`, errors);
}

function checkModel(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) return void errors.push(`${path} 必须是对象`);
  checkModelIdentity(value, path, errors);
  checkModelShape(value, path, errors);
  checkInputImageRule(value.input_image_rule, `${path}.input_image_rule`, errors);
  checkModelHints(value, path, errors);
  checkModelWorkflows(value.workflows, path, errors);
}

export function parseCapabilityTable(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, errors: ["能力表必须是 JSON 对象"] };
  const version = raw.format_version;
  if (!Number.isInteger(version) || (version as number) < 1) return { ok: false, errors: ["format_version 必须是正整数"] };
  if ((version as number) > CAPABILITY_FORMAT_VERSION) {
    return { ok: false, errors: [`能力表 format_version ${version} 高于本应用支持的 ${CAPABILITY_FORMAT_VERSION}，请升级应用`] };
  }
  if (!Array.isArray(raw.models)) return { ok: false, errors: ["models 必须是数组"] };
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.models.forEach((model, index) => {
    checkModel(model, `models[${index}]`, errors);
    const id = isObject(model) ? model.model_id : undefined;
    if (typeof id === "string") {
      if (seen.has(id)) errors.push(`models[${index}].model_id 重复：${id}`);
      seen.add(id);
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, table: raw as unknown as CapabilityTable };
}

function loadBuiltin(): CapabilityTable {
  const result = parseCapabilityTable(builtinJson);
  if (!result.ok) throw new Error(`内置能力表无效：${result.errors.join("；")}`);
  // 本票仅新增可手动选择的 Flash，保持既有上架顺序与默认模型（默认切换由停用票处理）。
  // 明确按 model_id 找到 Flash 挪到末尾，不依赖它在 JSON 里的位置。
  const models = result.table.models;
  const flash = models.find((m) => m.model_id === "doubao-seedream-5-0-flash-260915");
  if (!flash) throw new Error("内置能力表缺少 Flash 模型");
  return { ...result.table, models: [...models.filter((m) => m !== flash), flash] };
}

export const BUILTIN_TABLE: CapabilityTable = loadBuiltin();

/** 读入覆盖文件文本并与内置表合并；覆盖文件无效时整份忽略并返回错误。 */
export function effectiveTable(overrideText: string | null): { table: CapabilityTable; error: string | null } {
  if (overrideText === null) return { table: BUILTIN_TABLE, error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(overrideText);
  } catch {
    return { table: BUILTIN_TABLE, error: "能力表覆盖文件不是有效 JSON，已忽略" };
  }
  const result = parseCapabilityTable(raw);
  if (!result.ok) return { table: BUILTIN_TABLE, error: `能力表覆盖文件已忽略：${result.errors.join("；")}` };
  return { table: mergeOverride(BUILTIN_TABLE, result.table), error: null };
}

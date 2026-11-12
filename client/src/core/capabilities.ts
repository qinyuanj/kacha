// 模型能力表：模型决定能力，能力决定生成任务节点上露出的端口、开关与分辨率档。
// 内置 JSON + 同 schema 覆盖文件，按 model_id 整条合并；不按模型名猜能力。
import type { RegionRender } from "./board";
import builtinJson from "./capabilities.builtin.json" with { type: "json" };

export const CAPABILITY_FORMAT_VERSION = 1;

export const RETIRED_LITE_MODEL = "doubao-seedream-5-0-lite-260128";
export const LITE_RETIRED_HINT = "Lite 已停用，请切换到 Flash";
export const isRetiredModel = (modelId: string): boolean => modelId === RETIRED_LITE_MODEL;

/** 三态：待测在 UI 上等同不支持，仅在模型说明浮层列出。 */
export type TriState = "supported" | "unsupported" | "untested";
export type Tier = "flagship" | "economy";
export type WorkflowName = "text_to_image" | "image_edit";

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

export interface WorkflowCapability {
  supports_negative_prompt: TriState;
  min_references: number;
  max_references: number;
  size_rule: SizeRule;
  layer_decomposition: TriState;
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

/** 某个工作流能力待测时的那一行文案：按工作流名逐个列出。 */
function workflowUntested(model: ModelCapability, isUntested: (capability: WorkflowCapability) => boolean, label: string): string[] {
  return (Object.keys(WORKFLOW_LABELS) as WorkflowName[]).filter((wf) => isUntested(model.workflows[wf])).map((wf) => `${label}（${WORKFLOW_LABELS[wf]}）`);
}

/** 模型说明浮层列出的「待测」能力。 */
export function untestedCapabilities(model: ModelCapability): string[] {
  const out: string[] = [];
  if (model.reference_phrasing.en_verified === "untested") out.push("英文序号措辞");
  for (const kind of Object.keys(REGION_LABELS) as RegionRender[]) {
    if (model.region_hint[kind] === "untested") out.push(REGION_LABELS[kind]);
  }
  if (model.native_mask === "untested") out.push("原生蒙版");
  if (model.transparent_background === "untested") out.push("透明背景");
  // 顺序：先把两个工作流的负向提示词列完，再列拆分图层——与既有输出顺序一致。
  out.push(...workflowUntested(model, (c) => c.supports_negative_prompt === "untested", "负向提示词"));
  out.push(...workflowUntested(model, (c) => c.layer_decomposition === "untested", "拆分图层"));
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

/** 工作流的三态开关与参考图张数区间。 */
function checkWorkflowCounts(value: Record<string, unknown>, path: string, errors: string[]): void {
  checkTri(value.supports_negative_prompt, `${path}.supports_negative_prompt`, errors);
  checkTri(value.layer_decomposition, `${path}.layer_decomposition`, errors);
  const min = value.min_references;
  const max = value.max_references;
  if (!Number.isInteger(min) || (min as number) < 0) errors.push(`${path}.min_references 必须是非负整数`);
  if (!Number.isInteger(max) || (max as number) < (min as number)) errors.push(`${path}.max_references 必须是不小于 min 的整数`);
}

/** 一个分辨率档的宽高比表：宽高比 → [宽, 高]。 */
function isPixelPair(px: unknown): boolean {
  return Array.isArray(px) && px.length === 2 && px.every((n) => Number.isInteger(n) && n > 0);
}

/** 分辨率档：档 → 宽高比 → [宽, 高]。 */
function checkSizeTiers(tiers: Record<string, unknown>, path: string, errors: string[]): void {
  for (const [tier, ratios] of Object.entries(tiers)) {
    if (!isObject(ratios)) {
      errors.push(`${path}.size_rule.tiers.${tier} 必须是对象`);
      continue;
    }
    for (const [ratio, px] of Object.entries(ratios)) {
      if (!isPixelPair(px)) errors.push(`${path}.size_rule.tiers.${tier}.${ratio} 必须是两个正整数`);
    }
  }
}

function checkWorkflow(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) return void errors.push(`${path} 必须是对象`);
  checkWorkflowCounts(value, path, errors);
  const size = value.size_rule;
  if (!isObject(size) || !isObject(size.tiers)) return void errors.push(`${path}.size_rule.tiers 必须是对象`);
  checkSizeTiers(size.tiers, path, errors);
  if (size.custom != null) checkPixelRange(size.custom, `${path}.size_rule.custom`, errors);
}

const INPUT_RULE_NUMBERS = ["max_bytes", "min_total_pixels", "max_total_pixels", "min_short_edge", "min_aspect_ratio", "max_aspect_ratio"];
const REGION_RENDERS: RegionRender[] = ["highlight_overlay", "marked_image", "bbox_tag"];
const WORKFLOW_NAMES: WorkflowName[] = ["text_to_image", "image_edit"];

/** 模型的名字与档位：id、显示名、档位、说明链接。 */
function checkModelNaming(value: Record<string, unknown>, path: string, errors: string[]): void {
  if (typeof value.model_id !== "string" || !value.model_id) errors.push(`${path}.model_id 必须是非空字符串`);
  if (typeof value.display_name !== "string") errors.push(`${path}.display_name 必须是字符串`);
  if (value.tier !== null && value.tier !== "flagship" && value.tier !== "economy") errors.push(`${path}.tier 必须是 flagship / economy / null`);
  if (value.help_url !== null && typeof value.help_url !== "string") errors.push(`${path}.help_url 必须是字符串或 null`);
}

/** 模型的请求形状与固定参数。 */
function checkModelRequest(value: Record<string, unknown>, path: string, errors: string[]): void {
  if (typeof value.request_shape !== "string") errors.push(`${path}.request_shape 必须是字符串`);
  if (!isObject(value.fixed_params)) errors.push(`${path}.fixed_params 必须是对象`);
}

/** 模型的身份字段：名字档位 + 请求形状与固定参数。 */
function checkModelIdentity(value: Record<string, unknown>, path: string, errors: string[]): void {
  checkModelNaming(value, path, errors);
  checkModelRequest(value, path, errors);
}

/** 输入图片规则：格式数组 + 各个数值上下界。 */
function checkInputImageRule(rule: unknown, path: string, errors: string[]): void {
  if (!isObject(rule) || !Array.isArray(rule.formats)) return void errors.push(`${path}.input_image_rule.formats 必须是数组`);
  for (const key of INPUT_RULE_NUMBERS) checkNullableNumber(rule[key] ?? null, `${path}.input_image_rule.${key}`, errors);
}

/** 三态类能力：英文措辞、三种区域指示、原生蒙版、透明背景。 */
function checkModelTriStates(value: Record<string, unknown>, path: string, errors: string[]): void {
  checkTri(isObject(value.reference_phrasing) ? value.reference_phrasing.en_verified : undefined, `${path}.reference_phrasing.en_verified`, errors);
  const hint = isObject(value.region_hint) ? value.region_hint : {};
  for (const kind of REGION_RENDERS) checkTri(hint[kind], `${path}.region_hint.${kind}`, errors);
  if (!isObject(value.region_hint_phrasing)) errors.push(`${path}.region_hint_phrasing 必须是对象`);
  checkTri(value.native_mask, `${path}.native_mask`, errors);
  checkTri(value.transparent_background, `${path}.transparent_background`, errors);
}

/** 两个工作流各校验一遍。 */
function checkModelWorkflows(value: Record<string, unknown>, path: string, errors: string[]): void {
  const workflows = isObject(value.workflows) ? value.workflows : {};
  for (const name of WORKFLOW_NAMES) checkWorkflow(workflows[name], `${path}.workflows.${name}`, errors);
}

function checkModel(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) return void errors.push(`${path} 必须是对象`);
  checkModelIdentity(value, path, errors);
  checkInputImageRule(value.input_image_rule, path, errors);
  checkModelTriStates(value, path, errors);
  checkModelWorkflows(value, path, errors);
}

/** 表头的版本与 models 形状：不合法时直接给出错误，合法时什么也不做。 */
function checkTableHeader(raw: Record<string, unknown>): string[] | null {
  const version = raw.format_version;
  if (!Number.isInteger(version) || (version as number) < 1) return ["format_version 必须是正整数"];
  if ((version as number) > CAPABILITY_FORMAT_VERSION) return [`能力表 format_version ${version} 高于本应用支持的 ${CAPABILITY_FORMAT_VERSION}，请升级应用`];
  if (!Array.isArray(raw.models)) return ["models 必须是数组"];
  return null;
}

/** 逐条校验模型，同时收集重复的 model_id。 */
function checkModels(models: unknown[], errors: string[]): void {
  const seen = new Set<string>();
  models.forEach((model, index) => {
    checkModel(model, `models[${index}]`, errors);
    const id = isObject(model) ? model.model_id : undefined;
    if (typeof id !== "string") return;
    if (seen.has(id)) errors.push(`models[${index}].model_id 重复：${id}`);
    seen.add(id);
  });
}

export function parseCapabilityTable(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, errors: ["能力表必须是 JSON 对象"] };
  const headerErrors = checkTableHeader(raw);
  if (headerErrors) return { ok: false, errors: headerErrors };
  const errors: string[] = [];
  checkModels(raw.models as unknown[], errors);
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

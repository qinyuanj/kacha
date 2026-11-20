// 团队网关适配器（契约 docs/contracts/team-gateway-contract.md）。
// 路径、载荷与出图解析全部来自 contracts/fixtures 实测夹具；生成请求只发一次，不重发、不用幂等键、不查任务。
// HTTP 由调用方注入（壳里是浏览器原生 fetch，测试里是夹具回放）。
// 发什么由发送计划（sendPlan.ts）决定；这里只把发送文本与原生负向放进请求体。
import { withinPixelRange } from "./size";
import { inputImageRuleOf, isSupported, layerMaxImagesRuleOf, maxReferencesOf, transparentRuleOf, workflowFor, type ModelCapability } from "./capabilities";
import { errorText } from "./errors";
import { imageRuleViolations } from "./imageRule";

/** Flash 图层拆分的尺寸档，顺序即界面下拉顺序。 */
export const LAYER_SIZES = ["auto", "1K", "1.5K", "2K"] as const;
export type LayerSize = (typeof LAYER_SIZES)[number];

/** 提示文案里的取值列举，如「1K / 1.5K / 2K / auto」：具体档在前，auto 殿后。 */
export const LAYER_SIZES_TEXT = [...LAYER_SIZES.filter((s) => s !== "auto"), "auto"].join(" / ");

export function isLayerSize(value: unknown): value is LayerSize {
  return (LAYER_SIZES as readonly unknown[]).includes(value);
}
export interface LayerMetadata { z_index: number; bounding_box?: LayerBoundingBox | number[]; name?: string; description?: string }

/** 图层定位：absolute 为底图像素坐标 [left,top,right,bottom]，normalized 为 0–1000（与提示坐标 0–999 互不相干）。 */
export interface LayerBoundingBox {
  absolute: number[];
  normalized: number[];
}

/** bounding_box 合法性：两个矩形各为 [left,top,right,bottom]、有面积，normalized 限 0–1000。 */
export function validLayerBox(value: unknown): value is LayerBoundingBox {
  const b = value as LayerBoundingBox | undefined;
  const rect = (v: unknown, max: number) => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max) && v[2] > v[0] && v[3] > v[1];
  return !!b && rect(b.absolute, Number.MAX_SAFE_INTEGER) && rect(b.normalized, 1000);
}

export const MODELS_PATH = "/v1/models";
export const TEXT_TO_IMAGE_PATH = "/v1/images/generations";

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
}

export type GatewayErrorCategory = "config" | "auth" | "rate_limited" | "rejected" | "server" | "network" | "invalid_response";

/** 脱敏错误类别：任务节点失败徽标上只显示这些。 */
export const ERROR_CATEGORY_LABELS: Record<GatewayErrorCategory, string> = {
  config: "未配置网关",
  auth: "鉴权失败",
  rate_limited: "网关限流",
  rejected: "网关拒绝",
  server: "服务错误",
  network: "网络不可达",
  invalid_response: "响应无效",
};

export class GatewayError extends Error {
  constructor(
    readonly category: GatewayErrorCategory,
    message: string,
    readonly status: number | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function categoryForStatus(status: number): GatewayErrorCategory {
  if (status === 401) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "rejected";
}

export interface ReferenceImage {
  mediaType: string;
  bytes: Uint8Array;
  /** 运行器对实际参考图快照解码后确认；未知不能作为透明背景输入。 */
  hasAlpha?: boolean;
}

export interface OutputOptions {
  output_format: "png" | "jpeg";
  response_format: "url" | "b64_json";
  watermark: boolean;
}

export const DEFAULT_OUTPUT_OPTIONS: OutputOptions = { output_format: "png", response_format: "url", watermark: false };

export function outputOptions(value?: OutputOptions): OutputOptions {
  const options = value ?? DEFAULT_OUTPUT_OPTIONS;
  if (!["png", "jpeg"].includes(options.output_format) || !["url", "b64_json"].includes(options.response_format) || typeof options.watermark !== "boolean") throw new GatewayError("config", "输出选项无效");
  return { ...options };
}

export interface GenerationInput {
  model: ModelCapability;
  /** 发送文本（发送计划的 text），原样作为请求里的提示文本。 */
  text: string;
  /** 走原生字段的负向提示词（发送计划的 nativeNegativePrompt）；null = 不发。 */
  nativeNegativePrompt: string | null;
  size: { width: number; height: number };
  /** 按发送序号排列；0 张 = 文生图。 */
  references: ReferenceImage[];
  /** 透明背景开关；只对能力表支持透明背景的模型生效。 */
  transparentBackground?: boolean;
  /** 链式编辑：本轮的输入来自上一轮输出（画板判定见 graph.chainedEdit）。 */
  chainedEdit?: boolean;
  outputOptions?: OutputOptions;
  layerDecomposition?: boolean;
  layerSize?: LayerSize;
  /** 拆分图层的输出张数；缺省用能力表该工作流的 default。未声明范围的工作流忽略它。 */
  layerMaxImages?: number;
}

export type GeneratedImage = ({ kind: "url"; url: string } | { kind: "bytes"; bytes: Uint8Array }) & {
  layer?: LayerMetadata;
};

/** 请求体 background 的取值；null = 不发该字段，交给服务端默认 auto。 */
export type BackgroundMode = "transparent" | "opaque";

/**
 * 多轮链式编辑（#177）的背景默认值：用户显式开透明背景优先——那是用户对本轮的选择，
 * 由任务视图提示「之后的一致性可能下降」，不在这里静默改回；否则链式轮默认 opaque
 * （官方建议多轮编辑用不带透明通道的 RGB 图）。单轮生成不发 background，行为不变。
 */
export function backgroundMode(input: Pick<GenerationInput, "transparentBackground" | "chainedEdit">): BackgroundMode | null {
  if (input.transparentBackground) return "transparent";
  return input.chainedEdit ? "opaque" : null;
}

// ---- 请求构造 ----

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** 请求形态：怎么构造请求、怎么从响应里取出图。 */
interface RequestShape {
  build(input: GenerationInput): { path: string; body: Record<string, unknown> };
  parse(body: unknown): GeneratedImage[];
}

const dataUrl = (r: ReferenceImage) => `data:${r.mediaType};base64,${toBase64(r.bytes)}`;

/** qwen 系列：文生图与图片编辑统一走 generations 顶层字段，参考图按序进入 image。 */
const buildQwenImagesGenerations: RequestShape["build"] = (input) => {
  const { model, text, nativeNegativePrompt, size, references } = input;
  const native = nativeNegativePrompt ? { negative_prompt: nativeNegativePrompt } : {};
  const body: Record<string, unknown> = { model: model.model_id, prompt: text, ...native };
  Object.assign(body, { n: 1, size: `${size.width}x${size.height}` }, model.fixed_params);
  if (references.length) body.image = references.map(dataUrl);
  return { path: TEXT_TO_IMAGE_PATH, body };
};

/**
 * Seedream 系列（#83 实测）：文生图与图片编辑都走 /v1/images/generations 顶层字段，
 * 参考图为顶层 image 的 data-URL 数组（按序即图N）；无原生负向字段（能力表标不支持，发送计划已把负向拼进发送文本）。
 */
const buildSeedreamImagesGenerations: RequestShape["build"] = (input) => {
  const { model, text, size, references } = input;
  const body: Record<string, unknown> = {
    model: model.model_id,
    prompt: text,
    size: `${size.width}x${size.height}`,
    response_format: "url",
    ...model.fixed_params,
  };
  const background = backgroundMode(input);
  // 透明背景只对能力表支持的模型发；opaque 是本形状的常规字段，链式编辑按需带上。
  if (background === "opaque" || (background === "transparent" && isSupported(model.transparent_background))) body.background = background;
  if (references.length) body.image = references.map(dataUrl);
  return { path: TEXT_TO_IMAGE_PATH, body };
};

/** 非拆分场景的生成尺寸必须在 921600–4624220 像素、宽高比 1/16–16 之间。 */
function flashGenerationSizeInvalid(input: GenerationInput): boolean {
  if (input.layerDecomposition) return false;
  return !withinPixelRange({ min_total_pixels: 921600, max_total_pixels: 4624220, min_aspect_ratio: 1 / 16, max_aspect_ratio: 16 }, input.size.width, input.size.height);
}

/** 参考图 MIME → 能力表里的格式名（小写，jpg 归一到 jpeg）。 */
function mediaFormatOf(mediaType: string): string {
  const subtype = mediaType.replace(/^image\//i, "").toLowerCase();
  return subtype === "jpg" ? "jpeg" : subtype;
}

/**
 * 拆分场景的参考图约束（#176）：张数、格式与字节上限全部取能力表该工作流的 layer_split 声明，
 * 没声明就沿用工作流级 / 模型级规则 —— 请求层不再写死 PNG / JPEG 或 30MB。
 */
function assertLayerSplitReferences(input: GenerationInput): void {
  if (!input.layerDecomposition) return;
  const workflow = workflowFor(input.references.length);
  const rule = inputImageRuleOf(input.model, workflow, "layer_split");
  const max = maxReferencesOf(input.model, workflow, "layer_split");
  if (input.references.length < 1) throw new GatewayError("config", "图层拆分需要一张参考图");
  if (input.references.length > max) throw new GatewayError("config", max === 1 ? "图层拆分只接受 1 张参考图" : `图层拆分最多 ${max} 张参考图`);
  // 判定与界面标黄、提交前快照同一个函数（imageRule.ts）；这里只知道 MIME 与字节，像素留给快照阶段。
  const violations = input.references.flatMap((reference) =>
    imageRuleViolations({ format: mediaFormatOf(reference.mediaType), bytes: reference.bytes.length, width: 0, height: 0 }, rule),
  );
  if (violations.length) throw new GatewayError("config", `图层拆分参考图不合规：${violations.join("；")}`);
}

function flashLayerSizeInvalid(input: GenerationInput): boolean {
  return input.layerDecomposition === true && !isLayerSize(input.layerSize ?? "auto");
}

/** 透明背景需要恰好一张已确认带 alpha 的参考图，且输出必须是 PNG（5.0 Flash 与 5.5 的编辑工作流）。 */
function assertAlphaReferenceTransparent(input: GenerationInput, options: ReturnType<typeof outputOptions>): void {
  if (input.references.length !== 1) throw new GatewayError("config", "透明背景需要恰好一张实际参考图");
  if (options.output_format !== "png") throw new GatewayError("config", "透明背景输出必须为 PNG");
  if (input.references[0].hasAlpha !== true) throw new GatewayError("config", "透明背景需要已确认带透明通道的参考图快照");
}

/**
 * 透明背景按能力表该工作流的 transparent_rule 判定（#182）：
 * native 的模型（Seedream 5.5 文生图）原生出 RGBA，不需要参考图，仍要求 PNG；
 * 其余沿用 5.0 Flash 的「恰好一张带 alpha 的参考图」。
 */
function assertTransparentBackground(input: GenerationInput, options: ReturnType<typeof outputOptions>): void {
  if (transparentRuleOf(input.model, workflowFor(input.references.length)) === "native") {
    if (options.output_format !== "png") throw new GatewayError("config", "透明背景输出必须为 PNG");
    return;
  }
  assertAlphaReferenceTransparent(input, options);
}

/**
 * 拆分图层的输出张数（#175）：只有能力表为该工作流声明了范围才发。
 * 未声明的工作流（5.0 Flash / 5.0 Pro）请求体里不出现 max_images，行为与改动前一致。
 */
function layerMaxImagesOf(input: GenerationInput): number | undefined {
  if (!input.layerDecomposition) return undefined;
  const rule = layerMaxImagesRuleOf(input.model, workflowFor(input.references.length));
  if (!rule) return undefined;
  const value = input.layerMaxImages ?? rule.default;
  if (!Number.isInteger(value) || value < rule.min || value > rule.max) throw new GatewayError("config", `图层输出数量必须在 ${rule.min}–${rule.max} 之间`);
  return value;
}

/** Flash 请求体：拆分时 size 走图层尺寸，其余按像素尺寸拼；prompt 在拆分且为空时省略。 */
function flashRequestBody(input: GenerationInput, options: ReturnType<typeof outputOptions>, background: BackgroundMode | null, maxImages: number | undefined) {
  return {
    model: input.model.model_id,
    ...(input.text.trim() || !input.layerDecomposition ? { prompt: input.text } : {}),
    size: input.layerDecomposition ? input.layerSize ?? "auto" : `${input.size.width}x${input.size.height}`,
    ...(input.layerDecomposition ? { layer_decomposition: true } : {}),
    ...(maxImages === undefined ? {} : { max_images: maxImages }),
    ...options,
    optimize_prompt_options: { mode: "standard" },
    ...(background ? { background } : {}),
    ...(input.references.length ? { image: input.references.map(dataUrl) } : {}),
  };
}

const buildFlashImagesGenerations: RequestShape["build"] = (input) => {
  if (input.references.length > 10) throw new GatewayError("config", "Flash 参考图最多 10 张");
  if (flashGenerationSizeInvalid(input)) throw new GatewayError("config", "Flash 生成尺寸超出范围");
  assertLayerSplitReferences(input);
  if (flashLayerSizeInvalid(input)) throw new GatewayError("config", "Flash 图层尺寸无效");
  const options = outputOptions(input.outputOptions);
  if (input.transparentBackground) assertTransparentBackground(input, options);
  return { path: TEXT_TO_IMAGE_PATH, body: flashRequestBody(input, options, backgroundMode(input), layerMaxImagesOf(input)) };
};

const FLASH_SHAPE = "seedream_flash_images_generations";

/** 模型是否走 Flash 请求形态（参考图、透明背景、图层拆分等 Flash 专有规则都以此为准）。 */
export function isFlashShape(model: ModelCapability | null | undefined): model is ModelCapability {
  return model?.request_shape === FLASH_SHAPE;
}

/** 按能力表 request_shape 选择请求形态。 */
const REQUEST_SHAPES: Record<string, RequestShape> = {
  [FLASH_SHAPE]: { build: buildFlashImagesGenerations, parse: parseFlashImage },
  qwen_images_edits: { build: buildQwenImagesGenerations, parse: parseGeneratedImages },
  seedream_images_generations: { build: buildSeedreamImagesGenerations, parse: parseImageUrls },
};

export function isRequestShapeImplemented(model: ModelCapability): boolean {
  return model.request_shape in REQUEST_SHAPES;
}

function requestShapeOf(model: ModelCapability): RequestShape {
  const shape = REQUEST_SHAPES[model.request_shape];
  if (!shape) throw new GatewayError("config", `模型 ${model.display_name} 的请求形态（${model.request_shape}）尚未实现`);
  return shape;
}

export function buildGenerationRequest(input: GenerationInput): { path: string; body: Record<string, unknown> } {
  return requestShapeOf(input.model).build(input);
}

// ---- 发送与错误映射 ----

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("[REDACTED]") : text;
}

/** 未配置时直接给出可执行的提示，不必等网络层报错。 */
function requireGatewayConfig(config: GatewayConfig): void {
  if (!config.baseUrl.trim()) throw new GatewayError("config", "未配置网关基础地址，请在高级设置中填写");
  if (!config.apiKey) throw new GatewayError("config", "未配置 API 密钥，请在高级设置中填写");
}

function requestHeaders(config: GatewayConfig, body: unknown): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${config.apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return headers;
}

/** 错误响应可能不是 JSON；解析失败留给状态码处理。 */
function parseResponseText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 网关原文可能回显请求内容：截短，只留定位问题所需的开头。 */
function httpFailure(response: FetchResponse, parsed: unknown, config: GatewayConfig, requestId: string | null): GatewayError {
  const message = (parsed as { error?: { message?: unknown } } | undefined)?.error?.message;
  const detail = typeof message === "string" && message ? `HTTP ${response.status}：${message.slice(0, 120)}` : `HTTP ${response.status}`;
  return new GatewayError(categoryForStatus(response.status), redact(detail, config.apiKey), response.status, requestId);
}

async function send(config: GatewayConfig, method: string, path: string, body?: unknown): Promise<{ body: object; requestId: string | null }> {
  requireGatewayConfig(config);
  const headers = requestHeaders(config, body);
  let response: FetchResponse;
  try {
    response = await config.fetch(endpoint(config.baseUrl, path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new GatewayError("network", redact(`无法连接网关：${errorText(e)}`, config.apiKey));
  }
  const requestId = response.headers.get("X-Oneapi-Request-Id");
  const text = await response.text().catch(() => "");
  const parsed = parseResponseText(text);
  if (response.status >= 400) throw httpFailure(response, parsed, config, requestId);
  if (typeof parsed !== "object" || parsed === null) {
    throw new GatewayError("invalid_response", "网关返回了无法解析的响应", response.status, requestId);
  }
  return { body: parsed, requestId };
}

/** 连接测试与模型发现：GET /v1/models 的 data[].id。 */
export async function listModels(config: GatewayConfig): Promise<string[]> {
  const body = (await send(config, "GET", MODELS_PATH)).body as { data?: unknown };
  if (!Array.isArray(body.data)) throw new GatewayError("invalid_response", "模型列表响应缺少 data");
  return body.data.flatMap((m) => (typeof m?.id === "string" ? [m.id] : []));
}

function decodeBase64(value: string): Uint8Array | null {
  const token = value.startsWith("data:") ? value.slice(value.indexOf(";base64,") + ";base64,".length) : value;
  if (value.startsWith("data:") && !value.includes(";base64,")) return null;
  if (!/^[A-Za-z0-9+/\s]+=*$/.test(token)) return null;
  try {
    return Uint8Array.from(atob(token.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 出图真源 metadata.output.choices[].message.content[].image，兼容临时 URL 与 base64（契约「当前结论」）。 */
/** 图层字段的合成形状待 #83 确认：z_index 数字、bounding_box 数字数组，缺一不算图层。 */
function generatedLayerOf(item: any) {
  const zIndex = typeof item?.z_index === "number" ? item.z_index : null;
  const box = Array.isArray(item?.bounding_box) && item.bounding_box.every((n: unknown) => typeof n === "number") ? (item.bounding_box as number[]) : null;
  return zIndex !== null && box !== null ? { z_index: zIndex, bounding_box: box } : undefined;
}

/** 一条 content 项 → 一张图；没有可用的 image 字段时返回 null。 */
function generatedImageOf(item: any): GeneratedImage | null {
  const image = item?.image;
  if (typeof image !== "string" || !image) return null;
  const layer = generatedLayerOf(item);
  if (/^https?:\/\//i.test(image)) return { kind: "url", url: image, ...(layer ? { layer } : {}) };
  const bytes = decodeBase64(image);
  return bytes ? { kind: "bytes", bytes, ...(layer ? { layer } : {}) } : null;
}

/** 一条 choice 展开成它包含的图；content 不是数组时为空。 */
function generatedChoiceImages(choice: any): GeneratedImage[] {
  const content = choice?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((item: any) => {
    const image = generatedImageOf(item);
    return image ? [image] : [];
  });
}

export function parseGeneratedImages(body: unknown): GeneratedImage[] {
  const choices = (body as { metadata?: { output?: { choices?: unknown } } })?.metadata?.output?.choices;
  if (!Array.isArray(choices)) return [];
  return choices.flatMap(generatedChoiceImages);
}

/** OpenAI 形态出图：顶层 data[].url（Seedream，契约 2026-09-17）。 */
export function parseImageUrls(body: unknown): GeneratedImage[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item): GeneratedImage[] => (typeof item?.url === "string" && /^https?:\/\//i.test(item.url) ? [{ kind: "url", url: item.url }] : []));
}

/** 一张 Flash 图片项：既没有合格 url 也没有合格 b64_json，或同时给了两者，都不算有效响应。 */
function flashItemInvalid(item: any): boolean {
  if (!item || typeof item !== "object" || item.error) return true;
  return item.url !== undefined && item.b64_json !== undefined;
}

/** 一张 Flash 图片项的载荷：优先 http(s) 地址，其次 base64；都没有时返回 null。 */
function flashItemPayload(item: any): GeneratedImage | null {
  if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) return { kind: "url", url: item.url };
  const bytes = typeof item.b64_json === "string" ? decodeBase64(item.b64_json) : null;
  return bytes?.length ? { kind: "bytes", bytes } : null;
}

function parseFlashImage(body: unknown): GeneratedImage[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== 1) throw new GatewayError("invalid_response", "Flash 普通生成必须返回恰好一张图片");
  const item = data[0];
  if (flashItemInvalid(item)) throw new GatewayError("invalid_response", "Flash 图片响应无效");
  const image = flashItemPayload(item);
  if (!image) throw new GatewayError("invalid_response", "Flash 图片响应无效");
  return [image];
}

/** 图层响应最多容纳 base + 16 层；不合法的形状统一抛同一句错误。 */
function flashLayerFailure(): never {
  throw new GatewayError("invalid_response", "Flash 图层身份、层序或定位信息无效");
}

function flashLayerCountValid(data: unknown): data is any[] {
  return Array.isArray(data) && data.length >= 1 && data.length <= 17;
}

/** 单个图层的身份、层号与定位是否合法；层号重复也算不合法。 */
function flashLayerIdentityInvalid(item: any, seen: Set<number>): boolean {
  if (!item || !Number.isInteger(item.z_index)) return true;
  if (item.z_index < 0 || item.z_index > 16 || seen.has(item.z_index)) return true;
  return item.z_index > 0 && !validLayerBox(item.bounding_box);
}

function flashLayerLabelInvalid(item: any): boolean {
  const nameBad = item.name !== undefined && typeof item.name !== "string";
  const descriptionBad = item.description !== undefined && typeof item.description !== "string";
  return nameBad || descriptionBad;
}

/** 图层的附加身份字段：只带上响应里真正给了的字段，缺省的不留空值。 */
function flashLayerMeta(item: any) {
  return {
    z_index: item.z_index,
    ...(item.bounding_box !== undefined ? { bounding_box: item.bounding_box } : {}),
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.description !== undefined ? { description: item.description } : {}),
  };
}

function flashLayerOf(item: any, seen: Set<number>): GeneratedImage {
  if (flashLayerIdentityInvalid(item, seen)) flashLayerFailure();
  seen.add(item.z_index);
  if (flashLayerLabelInvalid(item)) flashLayerFailure();
  return { ...parseFlashImage({ data: [item] })[0], layer: flashLayerMeta(item) };
}

/** 层号必须从 0 起连续：有 0，且每个大于 0 的层号都有前一层。 */
function flashLayersContiguous(seen: Set<number>): boolean {
  if (!seen.has(0)) return false;
  return [...seen].every((n) => n === 0 || seen.has(n - 1));
}

function parseFlashLayers(body: unknown): GeneratedImage[] {
  const data = (body as { data?: unknown })?.data;
  if (!flashLayerCountValid(data)) flashLayerFailure();
  const seen = new Set<number>();
  const images = data.map((item): GeneratedImage => flashLayerOf(item, seen));
  if (!flashLayersContiguous(seen)) flashLayerFailure();
  return images.sort((a, b) => a.layer!.z_index - b.layer!.z_index);
}

/** 提交一个生成任务；图层拆分仍是一项生成结果。 */
export async function generate(config: GatewayConfig, input: GenerationInput): Promise<{ images: GeneratedImage[]; requestId: string | null }> {
  const shape = requestShapeOf(input.model);
  const { path, body } = buildGenerationRequest(input);
  const response = await send(config, "POST", path, body);
  const images = input.layerDecomposition && isFlashShape(input.model) ? parseFlashLayers(response.body) : shape.parse(response.body);
  if (!images.length) throw new GatewayError("invalid_response", "网关没有返回图片", 200, response.requestId);
  return { images, requestId: response.requestId };
}

/** 取结果图字节；临时地址下载不带网关鉴权头。 */
export async function fetchResultImage(fetch: FetchLike, image: GeneratedImage): Promise<Uint8Array> {
  if (image.kind === "bytes") return image.bytes;
  let response: FetchResponse;
  try {
    response = await fetch(image.url, { method: "GET", headers: { Accept: "image/*" } });
  } catch (e) {
    // 不带原始错误：可能含临时签名地址。
    throw new GatewayError("network", "下载结果图失败：网络不可达");
  }
  if (response.status >= 400) throw new GatewayError(categoryForStatus(response.status), `下载结果图失败：HTTP ${response.status}`, response.status);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await response.arrayBuffer()); }
  catch { throw new GatewayError("network", "下载结果图失败：无法读取响应"); }
  if (!bytes.length) throw new GatewayError("invalid_response", "下载结果图为空");
  return bytes;
}

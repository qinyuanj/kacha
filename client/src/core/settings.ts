// 高级设置与模型发现。settings.json 在 app-data 目录，只前向迁移；API 密钥不在这里（系统凭据库）。
import { type CapabilityTable, type ModelCapability, modelsByTier } from "./capabilities";
import { ERROR_CATEGORY_LABELS, GatewayError, listModels, type FetchLike } from "./gateway";
import { errorText } from "./errors";
import { DEFAULT_FEEDBACK_RELAY_URL } from "./feedback";
import { DEFAULT_THEME_CHOICE, parseThemeChoice, type ThemeChoice } from "./theme";

export { DEFAULT_FEEDBACK_RELAY_URL } from "./feedback";

export const SETTINGS_FORMAT_VERSION = 1;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 10;

type Json = Record<string, unknown>;

export interface Settings {
  format_version: number;
  base_url: string;
  /** 反馈中继地址覆盖；空字符串表示使用内置默认地址。 */
  feedback_relay_url: string;
  /** 全局队列的并发上限。 */
  concurrency: number;
  /**
   * 主题档位（#221）：可选字段，不升 format_version。
   * 未写或写坏都按默认暗色；真源仍在这里，首帧镜像只是窗口外观的缓存。
   */
  theme: ThemeChoice;
  extra: Json;
}

export const DEFAULT_SETTINGS: Settings = {
  format_version: SETTINGS_FORMAT_VERSION,
  base_url: "http://lzxsvn:3001",
  // 空字符串是「没有显式覆盖」；内置默认由 Go 壳的环境变量/常量决定（#205/#209）。
  feedback_relay_url: "",
  concurrency: 4,
  theme: DEFAULT_THEME_CHOICE,
  extra: {},
};

export type LoadedSettings =
  | { kind: "ok"; settings: Settings }
  | { kind: "newer"; version: number; settings: Settings }
  | { kind: "corrupt"; reason: string; settings: Settings }
  /** 读取本机设置失败（权限、I/O 等）；文件不存在由 loadSettings 合成默认值，不会落到这里。 */
  | { kind: "unreadable"; settings: Settings };

/** 保存时能否写 settings.json：newer 与 unreadable 的原文件不能被本次的默认设置覆盖。 */
export function mayOverwriteSettings(kind: LoadedSettings["kind"]): boolean {
  switch (kind) {
    case "ok":
    case "corrupt":
      return true;
    case "newer":
    case "unreadable":
      return false;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

// 已知字段不落进 extra：theme 漏了这一行会被当未知字段，永远读不回 settings.theme（#221）。
const KNOWN_KEYS = ["format_version", "base_url", "feedback_relay_url", "concurrency", "theme"];
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function corrupt(reason: string): LoadedSettings {
  return { kind: "corrupt", reason, settings: DEFAULT_SETTINGS };
}

/** 缺失字段取默认值；字段类型错误整份按损坏处理。 */
export function parseSettings(text: string | null): LoadedSettings {
  if (text === null) return { kind: "ok", settings: DEFAULT_SETTINGS };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return corrupt("不是有效的 JSON");
  }
  if (!isObject(raw)) return corrupt("顶层必须是对象");
  const version = raw.format_version;
  if (!Number.isInteger(version) || (version as number) < 1) return corrupt("format_version 必须是正整数");
  if ((version as number) > SETTINGS_FORMAT_VERSION) return { kind: "newer", version: version as number, settings: DEFAULT_SETTINGS };
  return parseSettingsFields(raw);
}

/** 版本可读后再校验设置值；未知字段原样保留。 */
function parseSettingsFields(raw: Json): LoadedSettings {
  const baseUrl = raw.base_url ?? DEFAULT_SETTINGS.base_url;
  const concurrency = raw.concurrency ?? DEFAULT_SETTINGS.concurrency;
  if (typeof baseUrl !== "string") return corrupt("base_url 必须是字符串");
  if (raw.feedback_relay_url !== undefined && typeof raw.feedback_relay_url !== "string") return corrupt("feedback_relay_url 必须是字符串");
  if (!Number.isInteger(concurrency) || (concurrency as number) < MIN_CONCURRENCY || (concurrency as number) > MAX_CONCURRENCY) {
    return corrupt(`concurrency 必须是 ${MIN_CONCURRENCY}～${MAX_CONCURRENCY} 的整数`);
  }
  const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !KNOWN_KEYS.includes(k)));
  return {
    kind: "ok",
    settings: {
      format_version: SETTINGS_FORMAT_VERSION,
      base_url: baseUrl,
      feedback_relay_url: normalizeFeedbackRelayUrl(raw.feedback_relay_url ?? ""),
      concurrency: concurrency as number,
      // 主题是可选字段：非法值不整份判损坏，回退默认暗色并保留其它字段（#221）。
      theme: parseThemeChoice(raw.theme),
      extra,
    },
  };
}

/** 并发上限输入框的草稿 → 最终值：四舍五入并钳到 MIN～MAX；空或无法解析时用 fallback（打开面板时的原值）。 */
export function parseConcurrency(draft: string, fallback: number): number {
  const value = draft.trim() === "" ? NaN : Number(draft);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(value)));
}

/** 设置面板的表单（原始文本）。 */
export interface SettingsForm {
  baseUrl: string;
  concurrencyDraft: string;
  /** 可选，兼容未暴露该字段的旧调用点；缺省沿用已存覆盖值。 */
  feedbackRelayUrl?: string;
}

/** 点保存时写入的设置：在已存设置上套用表单。并发草稿此刻才钳制——不失焦直接保存也不会存进空值或越界值。 */
export function settingsFromForm(saved: Settings, form: SettingsForm): Settings {
  return {
    ...saved,
    base_url: normalizeBaseUrl(form.baseUrl),
    feedback_relay_url: normalizeFeedbackRelayUrl(form.feedbackRelayUrl ?? saved.feedback_relay_url ?? ""),
    concurrency: parseConcurrency(form.concurrencyDraft, saved.concurrency),
  };
}

export function serializeSettings(settings: Settings): string {
  const { extra, ...known } = settings;
  return `${JSON.stringify({ ...known, format_version: SETTINGS_FORMAT_VERSION, ...extra }, null, 2)}\n`;
}

function validateHttpUrl(value: string, required: boolean, rejectCredentials: boolean): string | null {
  const text = value.trim();
  if (!text) return required ? "请填写网关基础地址" : null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "地址格式无效，应形如 http://主机:端口";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "只支持 http:// 或 https:// 地址";
  if (!url.hostname) return "地址缺少主机名";
  if (rejectCredentials && (url.username || url.password)) return "中继地址不要包含用户名或密码";
  return null;
}

/** 返回错误说明；合法为 null。 */
export function validateBaseUrl(value: string): string | null {
  return validateHttpUrl(value, true, false);
}

/** ADR 0003：明文 HTTP 仅限可信网络，设置面板保留风险提示。 */
export function isPlainHttp(value: string): boolean {
  return /^http:\/\//i.test(value.trim());
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** 反馈中继覆盖地址：留空表示默认；非空只允许无凭据的 http / https URL。 */
export function validateFeedbackRelayUrl(value: string): string | null {
  return validateHttpUrl(value, false, true);
}

export function normalizeFeedbackRelayUrl(value: string): string {
  const normalized = normalizeBaseUrl(value);
  // 与内置默认相同的值不算显式覆盖：它会让 Go 侧清空 KACHA_FEEDBACK_RELAY_URL 也关不掉能力。
  return normalized === DEFAULT_FEEDBACK_RELAY_URL ? "" : normalized;
}

/** #205 SendSpec.relayUrl 与 #206 接线层的唯一覆盖来源：只有显式且非默认的合法地址才发。 */
export function resolveFeedbackRelayAddress(settings: Pick<Settings, "feedback_relay_url">): string {
  const value = settings.feedback_relay_url ?? "";
  return validateFeedbackRelayUrl(value) === null ? normalizeFeedbackRelayUrl(value) : "";
}

// ---- 模型发现 ----

export interface ModelsCache {
  base_url: string;
  fetched_at: string;
  model_ids: string[];
}

export type Discovery = { source: "live" | "cached"; ids: string[]; fetchedAt: string } | { source: "none"; failed?: boolean };

export function parseModelsCache(text: string | null): ModelsCache | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text);
    if (!isObject(raw) || typeof raw.base_url !== "string" || typeof raw.fetched_at !== "string") return null;
    if (!Array.isArray(raw.model_ids) || !raw.model_ids.every((id) => typeof id === "string")) return null;
    return { base_url: raw.base_url, fetched_at: raw.fetched_at, model_ids: raw.model_ids };
  } catch {
    return null;
  }
}

export function serializeModelsCache(cache: ModelsCache): string {
  return `${JSON.stringify(cache, null, 2)}\n`;
}

/** 离线时用上次成功发现的缓存；缓存属于别的网关地址时不用。 */
export function discoveryFromCache(cache: ModelsCache | null, baseUrl: string): Discovery {
  if (!cache || normalizeBaseUrl(cache.base_url) !== normalizeBaseUrl(baseUrl)) return { source: "none" };
  return { source: "cached", ids: cache.model_ids, fetchedAt: cache.fetched_at };
}

function shelved(table: CapabilityTable): ModelCapability[] {
  return modelsByTier(table).flatMap((g) => g.models);
}

/** 任务节点模型列表 = 发现结果 ∩ 上架清单；没有有效发现或缓存时一个也不给，静态清单不算发现。 */
export function availableModels(table: CapabilityTable, discovery: Discovery): ModelCapability[] {
  if (discovery.source === "none") return [];
  const ids = new Set(discovery.ids);
  return shelved(table).filter((m) => ids.has(m.model_id));
}

/** 已发现模型列表但网关没有该模型时的标红原因。 */
export function modelAvailabilityIssue(table: CapabilityTable, discovery: Discovery, modelId: string): string | null {
  if (modelId === PREFERRED_TASK_MODEL && (discovery.source === "none" ? discovery.failed : !discovery.ids.includes(modelId))) return "Flash 不可用，请刷新模型列表或手动选择其它可用模型";
  if (discovery.source === "none") return discovery.failed ? "模型发现失败，请刷新模型列表" : null;
  if (discovery.ids.includes(modelId)) return null;
  const name = table.models.find((m) => m.model_id === modelId)?.display_name ?? modelId;
  return `网关未提供模型 ${name}`;
}

/** 画板没有最近选择时的首选模型。 */
export const PREFERRED_TASK_MODEL = "doubao-seedream-5-0-flash-260915";

/** 新建任务节点沿用有效最近选择，否则保留 Flash 身份；不可用由任务视图明确阻止，不自动替代。 */
export function defaultTaskModel(table: CapabilityTable, discovery: Discovery, lastModel: string | null | undefined): string | null {
  const available = availableModels(table, discovery);
  // 没有发现结果时不自动换掉画板已有的选择：那属于用户身份，不是「清单里有这个模型」的声明。
  const known = available.length === 0 && discovery.source === "none" ? table.models : available;
  if (lastModel && known.some((m) => m.model_id === lastModel)) return lastModel;
  return PREFERRED_TASK_MODEL;
}

/** 迭代动作用的默认编辑模型：工具栏模型 → 已发现可用列表 → 上架清单；编辑动作不依赖网关在线。 */
export function defaultEditModel(table: CapabilityTable, discovery: Discovery, lastModel: string | null | undefined): ModelCapability | null {
  const canEdit = (m: ModelCapability) => m.workflows.image_edit.max_references > 0;
  const toolbar = table.models.find((m) => m.model_id === defaultTaskModel(table, discovery, lastModel));
  if (toolbar && canEdit(toolbar)) return toolbar;
  return availableModels(table, discovery).find(canEdit) ?? shelved(table).find(canEdit) ?? null;
}

// ---- 载入 / 保存 / 模型刷新（#128）：经端口注入的无状态函数，不弹窗、不含文案；React 状态与提示在 ui/useSettings.ts ----

/** persisted = 已存入浏览器本地存储；session = 本地存储不可用，只在本次页面内。 */
export type KeyPersistence = "persisted" | "session";

export interface SettingsPorts {
  /** settings.json 原文；文件不存在为 null。 */
  readSettings(): Promise<string | null>;
  /** 壳提供的默认网关地址：settings.json 不存在时作首次使用的默认。 */
  defaultBaseUrl(): Promise<string>;
  writeSettings(text: string): Promise<void>;
  readModelsCache(): Promise<string | null>;
  writeModelsCache(text: string): Promise<void>;
  /** 浏览器本地存储；不可用时抛错。 */
  readApiKey(): Promise<string | null>;
  writeApiKey(key: string): Promise<void>;
  deleteApiKey(): Promise<void>;
  fetch: FetchLike;
  now(): Date;
  log(kind: "connection", fields: Record<string, unknown>): void;
}

/** 保存前的现状：决定写不写 settings.json、要不要更新浏览器里的密钥。 */
export interface SaveBaseline {
  fileKind: LoadedSettings["kind"];
  apiKey: string;
  keyPersistence: KeyPersistence;
}

export type SaveResult = { ok: true; settingsWritten: boolean; keyPersistence: KeyPersistence } | { ok: false; error: string };

export interface InitialSettings {
  file: LoadedSettings;
  apiKey: string;
  keyPersistence: KeyPersistence;
  cache: ModelsCache | null;
}

/** 首次使用（还没有 settings.json）时采用壳提供的默认网关地址。 */
async function readSettingsFile(ports: SettingsPorts): Promise<LoadedSettings> {
  const text = await ports.readSettings();
  const loaded = parseSettings(text);
  if (text !== null) return loaded;
  return { ...loaded, settings: { ...loaded.settings, base_url: await ports.defaultBaseUrl() } };
}

/** 读 settings.json、模型缓存与浏览器密钥；settings.json 读失败为 unreadable，模型缓存读失败按缺失处理，本地存储抛错退回 session。 */
export async function loadSettings(ports: SettingsPorts): Promise<InitialSettings> {
  const file = await readSettingsFile(ports).catch((): LoadedSettings => ({ kind: "unreadable", settings: DEFAULT_SETTINGS }));
  const cache = parseModelsCache(await ports.readModelsCache().catch(() => null));
  try {
    return { file, apiKey: (await ports.readApiKey()) ?? "", keyPersistence: "persisted", cache };
  } catch {
    return { file, apiKey: "", keyPersistence: "session", cache };
  }
}

/** 保存设置与密钥。newer / unreadable 时不覆盖 settings.json 但仍存密钥；密钥变了或当前为 session 才写本地存储，失败退回 session。 */
export async function saveSettings(ports: SettingsPorts, current: SaveBaseline, next: Settings, apiKey: string): Promise<SaveResult> {
  const settingsWritten = mayOverwriteSettings(current.fileKind);
  if (settingsWritten) {
    try {
      await ports.writeSettings(serializeSettings(next));
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }
  let keyPersistence: KeyPersistence = "persisted";
  if (apiKey !== current.apiKey || current.keyPersistence === "session") {
    try {
      if (apiKey) await ports.writeApiKey(apiKey);
      else await ports.deleteApiKey();
    } catch {
      keyPersistence = "session";
    }
  }
  return { ok: true, settingsWritten, keyPersistence };
}

export type RefreshResult =
  | { ok: true; cache: ModelsCache; discovery: Discovery }
  /** message：网关错误的可展示说明（「类别文案：网关原文」，类别与失败徽标同口径）；非网关错误为 null（由 ui 给兜底文案）。 */
  | { ok: false; message: string | null; discovery: Discovery };

/** 模型发现：成功写缓存（写失败不影响结果）；失败回落到同 base_url 的缓存。两种结局都记一条 connection 日志。 */
export async function refreshModels(ports: SettingsPorts, baseUrl: string, apiKey: string, cache: ModelsCache | null): Promise<RefreshResult> {
  try {
    const ids = await listModels({ baseUrl, apiKey, fetch: ports.fetch });
    const fresh: ModelsCache = { base_url: normalizeBaseUrl(baseUrl), fetched_at: ports.now().toISOString(), model_ids: ids };
    await ports.writeModelsCache(serializeModelsCache(fresh)).catch(() => undefined);
    ports.log("connection", { stage: "list_models", ok: true, models: ids.length });
    return { ok: true, cache: fresh, discovery: { source: "live", ids, fetchedAt: fresh.fetched_at } };
  } catch (e) {
    const gateway = e instanceof GatewayError ? e : null;
    ports.log("connection", { stage: "list_models", ok: false, category: gateway?.category ?? "unknown", status_code: gateway?.status, message: gateway?.message ?? String(e) });
    const message = gateway ? `${ERROR_CATEGORY_LABELS[gateway.category]}：${gateway.message}` : null;
    const cached = discoveryFromCache(cache, baseUrl);
    return { ok: false, message, discovery: cached.source === "none" ? { source: "none", failed: true } : cached };
  }
}

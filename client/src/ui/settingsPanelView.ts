// 高级设置面板的可见判定（#137）：从 ui/SettingsPanel.tsx 拆出的纯逻辑，便于单测。
// 组件只留接线与 DOM 摆放。
import { DEFAULT_SETTINGS, isPlainHttp, MAX_CONCURRENCY, mayOverwriteSettings, parseConcurrency, settingsFromForm, validateBaseUrl, type LoadedSettings, type Settings } from "../core/settings";

/** 面板此刻的样子：哪些提示要显示、保存能不能点。 */
export interface SettingsPanelView {
  /** 网关地址的输入错误；null 表示合法。 */
  urlError: string | null;
  /** 明文 HTTP 的风险提示要不要显示。 */
  plainHttp: boolean;
  /** settings.json 不能被本次覆盖（newer / unreadable）：保存置灰。 */
  readOnly: boolean;
  /** 并发上限超过 5 时给网关限流的提示。 */
  highConcurrency: boolean;
  /** 并发上限输入框的范围说明。 */
  concurrencyHint: string;
  /** 连接测试按钮能不能点：正在测、地址非法、没有密钥时不行。 */
  canTest: boolean;
  /** 连接测试按钮上的文字。 */
  testLabel: string;
  /** 保存按钮能不能点。 */
  canSave: boolean;
}

/** 面板此刻的样子：输入的地址与并发草稿、设置文件状态、是否有密钥、是否正在测 / 存。 */
export function settingsPanelView(input: {
  baseUrl: string;
  concurrencyDraft: string;
  savedConcurrency: number;
  file: LoadedSettings["kind"];
  apiKey: string;
  testing: boolean;
  saving: boolean;
}): SettingsPanelView {
  const urlError = validateBaseUrl(input.baseUrl);
  const concurrency = parseConcurrency(input.concurrencyDraft, input.savedConcurrency);
  const canTest = !input.testing && !urlError && !!input.apiKey.trim();
  return {
    urlError,
    plainHttp: !urlError && isPlainHttp(input.baseUrl),
    readOnly: !mayOverwriteSettings(input.file),
    highConcurrency: concurrency > 5,
    concurrencyHint: `1～${MAX_CONCURRENCY}，默认 ${DEFAULT_SETTINGS.concurrency}；按页面各自计算，同一密钥开多个页面时互不共享`,
    canTest,
    testLabel: input.testing ? "测试中…" : "测试连接并刷新模型",
    canSave: !input.saving && !urlError && mayOverwriteSettings(input.file),
  };
}

/** 并发上限输入框失焦时写回的值（钳制后的）。 */
export function concurrencyOnBlur(draft: string, savedConcurrency: number): string {
  return String(parseConcurrency(draft, savedConcurrency));
}

/** 连接测试的结果文案：成功给模型数，失败给本机存储的话。 */
export function connectionText(result: { ok: true; count: number } | { ok: false; message: string }): string {
  return result.ok ? `连接成功，网关提供 ${result.count} 个模型` : result.message;
}

/** 模型列表的说明行：来自网关、离线用缓存、还没拿到。 */
export function discoveryText(discovery: { source: "live" | "cached" | "none"; fetchedAt?: string }): string {
  const at = discovery.fetchedAt ? new Date(discovery.fetchedAt).toLocaleString() : "";
  if (discovery.source === "live") return `模型列表：已从网关获取（${at}）`;
  if (discovery.source === "cached") return `模型列表：离线，使用缓存（${at}）`;
  return "模型列表：尚未从网关获取，模型不可选；请配置密钥并测试连接";
}

/** 保存时要写入的设置：在已存设置上套用表单。 */
export function settingsToSave(saved: Settings, baseUrl: string, concurrencyDraft: string): Settings {
  return settingsFromForm(saved, { baseUrl, concurrencyDraft });
}

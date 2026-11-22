// 高级设置的各个操作（#137）：从 ui/useSettings.ts 拆出的模块级函数，便于单测。
import {
  DEFAULT_SETTINGS,
  discoveryFromCache,
  loadSettings,
  mayOverwriteSettings,
  normalizeBaseUrl,
  refreshModels as refreshModelsWith,
  saveSettings,
  serializeSettings,
  type Discovery,
  type KeyPersistence,
  type LoadedSettings,
  type ModelsCache,
  type Settings,
  type SettingsPorts,
} from "../core/settings";
import type { ThemeChoice } from "../core/theme";
import { settingsFileProblem } from "./settingsText";

/** 连接测试的结果。 */
export type ConnectionResult = { ok: true; count: number } | { ok: false; message: string };

/** 设置的状态。 */
export interface SettingsState {
  loaded: boolean;
  /** 文件状态：newer / unreadable 时禁止保存，corrupt 时提示已用默认值。 */
  file: LoadedSettings["kind"];
  fileProblem: string | null;
  settings: Settings;
  apiKey: string;
  keyPersistence: KeyPersistence;
  discovery: Discovery;
}

/** 还没有载入时的状态。 */
export const initialSettingsState = (): SettingsState => ({
  loaded: false,
  file: "ok",
  fileProblem: null,
  settings: DEFAULT_SETTINGS,
  apiKey: "",
  keyPersistence: "persisted",
  discovery: { source: "none" },
});

/** 文件状态 → 提示文案（ok 时没有提示）。 */
export function fileProblemOf(loaded: LoadedSettings): string | null {
  if (loaded.kind === "corrupt") return settingsFileProblem("corrupt", undefined, loaded.reason);
  return settingsFileProblem(loaded.kind, loaded.kind === "newer" ? loaded.version : undefined);
}

/**
 * 切换主题（#221）：内存状态立刻生效；设置文件为 newer / unreadable 时只改内存，
 * 绝不覆盖磁盘——能不能写只看 mayOverwriteSettings 这一处判定。
 */
export async function setThemeState(ports: SettingsPorts, current: SettingsState, choice: ThemeChoice): Promise<SettingsState> {
  const next: Settings = { ...current.settings, theme: choice };
  const state: SettingsState = { ...current, settings: next };
  if (!mayOverwriteSettings(current.file)) return state;
  // 写盘失败不回滚界面：本次会话的主题已经生效，下次打开再写一次。
  await ports.writeSettings(serializeSettings(next)).catch(() => undefined);
  return state;
}

/** 刷新模型后要不要把发现结果写回界面：网关地址换了就不写（那是另一个网关的模型）。 */
export function discoveryApplies(currentBaseUrl: string, refreshedBaseUrl: string): boolean {
  return normalizeBaseUrl(currentBaseUrl) === normalizeBaseUrl(refreshedBaseUrl);
}

/** 载入设置后的状态。 */
export function loadedState(file: LoadedSettings, apiKey: string, keyPersistence: KeyPersistence, cache: ModelsCache | null): SettingsState {
  return {
    loaded: true,
    file: file.kind,
    fileProblem: fileProblemOf(file),
    settings: file.settings,
    apiKey,
    keyPersistence,
    discovery: discoveryFromCache(cache, file.settings.base_url),
  };
}

/** 刷新模型的结果：成功给模型数，失败给一句可展示的说明。 */
export function connectionResultOf(result: { ok: true; cache: ModelsCache } | { ok: false; message: string | null }): ConnectionResult {
  if (result.ok) return { ok: true, count: result.cache.model_ids.length };
  return { ok: false, message: result.message ?? "连接测试失败" };
}

/** 保存的结果：成功为 null，失败给一句说明。 */
export function saveProblemOf(result: { ok: true; settingsWritten: boolean; keyPersistence: KeyPersistence } | { ok: false; error: string }): string | null {
  return result.ok ? null : `保存设置失败：${result.error}`;
}

/** 保存成功但没写 settings.json（newer / unreadable）：界面上的设置保持不变，只更新密钥。 */
export function keyOnlyState(current: SettingsState, apiKey: string, keyPersistence: KeyPersistence): SettingsState {
  return { ...current, apiKey, keyPersistence };
}

/** 保存成功并写了 settings.json：界面上的设置换成新的。 */
export function savedState(
  current: SettingsState,
  next: Settings,
  apiKey: string,
  keyPersistence: KeyPersistence,
  baseChanged: boolean,
  cache: ModelsCache | null,
): SettingsState {
  return {
    ...current,
    file: "ok",
    fileProblem: null,
    settings: next,
    apiKey,
    keyPersistence,
    discovery: baseChanged ? discoveryFromCache(cache, next.base_url) : current.discovery,
  };
}

/** 载入设置。 */
export async function loadSettingsState(ports: SettingsPorts): Promise<{ state: SettingsState; cache: ModelsCache | null }> {
  const { file, apiKey, keyPersistence, cache } = await loadSettings(ports);
  return { state: loadedState(file, apiKey, keyPersistence, cache), cache };
}

/** 保存设置与密钥。 */
export async function saveSettingsState(
  ports: SettingsPorts,
  current: SettingsState,
  next: Settings,
  apiKey: string,
): Promise<{ ok: true; state: SettingsState; baseChanged: boolean } | { ok: false; error: string }> {
  const result = await saveSettings(ports, { fileKind: current.file, apiKey: current.apiKey, keyPersistence: current.keyPersistence }, next, apiKey);
  if (!result.ok) return { ok: false, error: result.error };
  const baseChanged = !discoveryApplies(current.settings.base_url, next.base_url);
  // 发现缓存只属于当前网关 + 当前凭据：换密钥或清除后让旧缓存立即作废。
  // 清缓存失败也不能把旧发现留在界面上（下次读取仍会读到旧文件，所以必须尽力写空）。
  const credentialChanged = apiKey !== current.apiKey;
  if (credentialChanged) await ports.writeModelsCache("").catch(() => undefined);
  const noDiscovery: Discovery = { source: "none" };
  if (!result.settingsWritten) {
    const state = keyOnlyState(current, apiKey, result.keyPersistence);
    return { ok: true, state: credentialChanged ? { ...state, discovery: noDiscovery } : state, baseChanged };
  }
  const state = savedState(current, next, apiKey, result.keyPersistence, baseChanged, null);
  return { ok: true, state: credentialChanged ? { ...state, discovery: noDiscovery } : state, baseChanged };
}

/** 刷新模型（网关发现）。 */
export async function refreshModelsState(
  ports: SettingsPorts,
  cache: ModelsCache | null,
  baseUrl: string,
  apiKey: string,
): Promise<{ result: ConnectionResult; cache: ModelsCache | null; discovery: Discovery }> {
  const result = await refreshModelsWith(ports, baseUrl, apiKey, cache);
  return {
    result: connectionResultOf(result),
    cache: result.ok ? result.cache : cache,
    discovery: result.discovery,
  };
}

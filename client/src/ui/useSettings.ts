// 高级设置的 React 接线：载入 / 保存 / 模型刷新的规则在 core/settings.ts（#128），这里只映射成 React 状态与提示文案，并在载入后静默刷新一次模型。
// 文件状态的文案在 ui/settingsText.ts，各操作在 ui/useSettingsOps.ts（#137），这里只留接线。
import { useCallback, useEffect, useRef, useState } from "react";
import { type Discovery, type ModelsCache, type Settings } from "../core/settings";
import { useShell } from "./shell";
import {
  discoveryApplies,
  initialSettingsState,
  loadSettingsState,
  refreshModelsState,
  saveProblemOf,
  saveSettingsState,
  type ConnectionResult,
  type SettingsState,
} from "./useSettingsOps";

export type { ConnectionResult, SettingsState } from "./useSettingsOps";

/** 模型刷新：刷新中的版本号用来丢弃过期的结果。 */
function useModelRefresh(settingsPorts: ReturnType<typeof useShell>["core"]["settingsPorts"]) {
  const cacheRef = useRef<ModelsCache | null>(null);
  const refreshVersion = useRef(0);
  const discoveryRef = useRef<Discovery>({ source: "none" });
  const refreshModels = useCallback(
    async (baseUrl: string, apiKey: string): Promise<ConnectionResult> => {
      const version = ++refreshVersion.current;
      const refreshed = await refreshModelsState(settingsPorts, cacheRef.current, baseUrl, apiKey);
      if (version === refreshVersion.current) {
        if (refreshed.cache) cacheRef.current = refreshed.cache;
        discoveryRef.current = refreshed.discovery;
      }
      return refreshed.result;
    },
    [settingsPorts],
  );
  return { cacheRef, refreshVersion, discoveryRef, refreshModels };
}

export function useSettings() {
  const port = useShell();
  const settingsPorts = port.core.settingsPorts;
  const [state, setState] = useState<SettingsState>(initialSettingsState());
  const stateRef = useRef(state);
  stateRef.current = state;
  const models = useModelRefresh(settingsPorts);

  const refreshModels = useCallback(
    async (baseUrl: string, apiKey: string): Promise<ConnectionResult> => {
      const result = await models.refreshModels(baseUrl, apiKey);
      setState((s) => (discoveryApplies(s.settings.base_url, baseUrl) ? { ...s, discovery: models.discoveryRef.current } : s));
      return result;
    },
    [models.refreshModels],
  );

  useEffect(() => {
    void (async () => {
      const loaded = await loadSettingsState(settingsPorts);
      models.cacheRef.current = loaded.cache;
      setState(loaded.state);
      // 启动时静默刷新一次；失败保持缓存。
      if (loaded.state.apiKey) void refreshModels(loaded.state.settings.base_url, loaded.state.apiKey);
    })();
  }, [refreshModels]);

  /** 保存设置与密钥；返回错误说明，成功为 null。 */
  const save = useCallback(
    async (next: Settings, apiKey: string): Promise<string | null> => {
      const current = stateRef.current;
      const result = await saveSettingsState(settingsPorts, current, next, apiKey);
      if (!result.ok) return saveProblemOf(result);
      setState(result.state);
      // 凭据换了，缓存里的旧发现不能拿来给新密钥兜底。
      if (apiKey !== current.apiKey) models.cacheRef.current = null;
      if (result.baseChanged) models.refreshVersion.current++;
      if (apiKey && (result.baseChanged || apiKey !== current.apiKey)) void refreshModels(next.base_url, apiKey);
      return null;
    },
    [refreshModels],
  );

  return { ...state, save, testConnection: refreshModels };
}
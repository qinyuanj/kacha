// 高级设置的各个操作（#137）：载入、保存、模型刷新与文件状态文案。
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type SettingsPorts } from "../core/settings";
import {
  connectionResultOf,
  discoveryApplies,
  fileProblemOf,
  initialSettingsState,
  keyOnlyState,
  loadedState,
  saveProblemOf,
  saveSettingsState,
} from "./useSettingsOps";
import { SETTINGS_UNREADABLE_TEXT, settingsNewerText } from "./settingsText";

describe("文件状态", () => {
  it("ok：没有提示", () => {
    expect(fileProblemOf({ kind: "ok", settings: DEFAULT_SETTINGS })).toBeNull();
  });

  it("newer：说明由更新版本写入", () => {
    expect(fileProblemOf({ kind: "newer", version: 2, settings: DEFAULT_SETTINGS })).toBe(settingsNewerText(2));
  });

  it("corrupt：说明已损坏并给出原因", () => {
    expect(fileProblemOf({ kind: "corrupt", reason: "不是有效的 JSON", settings: DEFAULT_SETTINGS })).toContain("不是有效的 JSON");
  });

  it("unreadable：说明读不到", () => {
    expect(fileProblemOf({ kind: "unreadable", settings: DEFAULT_SETTINGS })).toBe(SETTINGS_UNREADABLE_TEXT);
  });
});

describe("网关地址变了没有", () => {
  it("同一个地址（去空白与尾斜杠后）：算没变", () => {
    expect(discoveryApplies("http://gw:3001", "http://gw:3001/")).toBe(true);
  });

  it("换了地址：算变了", () => {
    expect(discoveryApplies("http://gw:3001", "http://gw:3002")).toBe(false);
  });
});

describe("状态", () => {
  it("还没载入：不是 loaded，文件状态正常", () => {
    const state = initialSettingsState();
    expect(state.loaded).toBe(false);
    expect(state.file).toBe("ok");
    expect(state.fileProblem).toBeNull();
    expect(state.discovery).toEqual({ source: "none" });
  });

  it("载入后：文件状态与提示都在", () => {
    const state = loadedState({ kind: "newer", version: 2, settings: DEFAULT_SETTINGS }, "sk-x", "persisted", null);
    expect(state.loaded).toBe(true);
    expect(state.file).toBe("newer");
    expect(state.fileProblem).toBe(settingsNewerText(2));
    expect(state.apiKey).toBe("sk-x");
  });

  it("没写 settings.json：只更新密钥，设置不动", () => {
    const current = { ...initialSettingsState(), loaded: true, settings: { ...DEFAULT_SETTINGS, base_url: "http://a" } };
    const next = keyOnlyState(current, "sk-new", "session");
    expect(next.apiKey).toBe("sk-new");
    expect(next.keyPersistence).toBe("session");
    expect(next.settings).toBe(current.settings);
  });
});

describe("结果", () => {
  it("连接成功：给模型数", () => {
    expect(connectionResultOf({ ok: true, cache: { base_url: "http://a", fetched_at: "", model_ids: ["a", "b"] } })).toEqual({ ok: true, count: 2 });
  });

  it("连接失败：给服务端的话", () => {
    expect(connectionResultOf({ ok: false, message: "网关不可达" })).toEqual({ ok: false, message: "网关不可达" });
  });

  it("连接失败但没有话：给兜底说明", () => {
    expect(connectionResultOf({ ok: false, message: null })).toEqual({ ok: false, message: "连接测试失败" });
  });

  it("保存失败：给一句说明", () => {
    expect(saveProblemOf({ ok: false, error: "写不进去" })).toBe("保存设置失败：写不进去");
    expect(saveProblemOf({ ok: true, settingsWritten: true, keyPersistence: "persisted" })).toBeNull();
  });
});

describe("保存设置", () => {
  it("写成功：界面上的设置换成新的", async () => {
    const ports = {
      readSettings: async () => null,
      writeSettings: async () => undefined,
      readApiKey: async () => null,
      writeApiKey: async () => undefined,
      deleteApiKey: async () => undefined,
      readModelsCache: async () => null,
      writeModelsCache: async () => undefined,
      defaultBaseUrl: async () => "http://gw",
      fetch: async () => new Response(null, { status: 500 }),
      now: () => new Date(0),
      log: () => undefined,
    } as unknown as SettingsPorts;
    const current = { ...initialSettingsState(), loaded: true };
    const next = { ...DEFAULT_SETTINGS, base_url: "http://gw2" };
    const result = await saveSettingsState(ports, current, next, "sk-x");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.settings.base_url).toBe("http://gw2");
      expect(result.baseChanged).toBe(true);
    }
  });

  it("写失败：给一句说明", async () => {
    const ports = {
      writeSettings: async () => {
        throw new Error("写不进去");
      },
      readApiKey: async () => null,
      writeApiKey: async () => undefined,
      readSettings: async () => null,
      readModelsCache: async () => null,
      writeModelsCache: async () => undefined,
      defaultBaseUrl: async () => "http://gw",
      fetch: async () => new Response(null, { status: 500 }),
      now: () => new Date(0),
      log: () => undefined,
    } as unknown as SettingsPorts;
    const current = { ...initialSettingsState(), loaded: true };
    const result = await saveSettingsState(ports, current, DEFAULT_SETTINGS, "sk-x");
    expect(result.ok).toBe(false);
  });
});
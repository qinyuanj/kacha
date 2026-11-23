// 高级设置面板的可见判定（#137）：地址错误、明文 HTTP 提示、不能覆盖时的置灰、并发钳制与连接测试按钮。
import { describe, expect, it } from "vitest";
import { connectionText, discoveryText, settingsPanelView } from "./settingsPanelView";

const base = { baseUrl: "http://gw:3001", concurrencyDraft: "4", savedConcurrency: 4, file: "ok" as const, apiKey: "sk-x", testing: false, saving: false };

describe("高级设置面板", () => {
  it("地址合法：不显示错误，也不显示明文 HTTP 之外的提示", () => {
    const view = settingsPanelView(base);
    expect(view.urlError).toBeNull();
    expect(view.plainHttp).toBe(true);
  });

  it("地址非法：显示错误，连接测试与保存都不可用", () => {
    const view = settingsPanelView({ ...base, baseUrl: "不是地址" });
    expect(view.urlError).toBeTruthy();
    expect(view.canTest).toBe(false);
    expect(view.canSave).toBe(false);
    expect(view.plainHttp).toBe(false);
  });

  it("正在测试：按钮写「测试中…」且不可点", () => {
    const view = settingsPanelView({ ...base, testing: true });
    expect(view.testLabel).toBe("测试中…");
    expect(view.canTest).toBe(false);
  });

  it("settings.json 是新版或读不到：保存置灰（不能覆盖）", () => {
    expect(settingsPanelView({ ...base, file: "newer" }).readOnly).toBe(true);
    expect(settingsPanelView({ ...base, file: "newer" }).canSave).toBe(false);
    expect(settingsPanelView({ ...base, file: "unreadable" }).canSave).toBe(false);
    expect(settingsPanelView({ ...base, file: "corrupt" }).canSave).toBe(true);
  });

  it("并发超过 5：给限流提示", () => {
    expect(settingsPanelView({ ...base, concurrencyDraft: "6" }).highConcurrency).toBe(true);
    expect(settingsPanelView({ ...base, concurrencyDraft: "5" }).highConcurrency).toBe(false);
  });

  it("连接测试结果：成功给模型数，失败给存储端口的话", () => {
    expect(connectionText({ ok: true, count: 3 })).toBe("连接成功，网关提供 3 个模型");
    expect(connectionText({ ok: false, message: "网关不可达" })).toBe("网关不可达");
  });

  it("模型列表说明：三种来源各一句", () => {
    expect(discoveryText({ source: "none" })).toContain("模型不可选");
    expect(discoveryText({ source: "live", fetchedAt: new Date(0).toISOString() })).toContain("已从网关获取");
    expect(discoveryText({ source: "cached", fetchedAt: new Date(0).toISOString() })).toContain("离线，使用缓存");
  });

  it("反馈中继覆盖非法时保存置灰", () => {
    expect(settingsPanelView({ ...base, feedbackRelayUrl: "http://relay.test:3005" }).canSave).toBe(true);
    const invalid = settingsPanelView({ ...base, feedbackRelayUrl: "不是地址" });
    expect(invalid.feedbackRelayUrlError).toBeTruthy();
    expect(invalid.canSave).toBe(false);
  });
});

// 诊断包导出（#162）：桌面端口把脱敏日志与导出接到真实的 Diagnostics 绑定上。
import { describe, expect, it } from "vitest";

import { createDesktopPort, type DesktopBridge, type DesktopDiagnosticsBundle, type DesktopDiagnosticsOutcome, type DesktopInfo, type DesktopLocalBridge } from "./desktop";
import { portFailureOf } from "./port";

const INFO: DesktopInfo = {
  version: "1.5.0",
  user_data_root: "C:/data",
  board_root: "C:/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

function local(): DesktopLocalBridge {
  return new Proxy({} as DesktopLocalBridge, { get: () => () => Promise.reject(new Error("没实现的本地调用")) });
}

function bridgeWith(diagnostics?: {
  log: (kind: string, fields: Record<string, string>) => void;
  export: () => Promise<DesktopDiagnosticsOutcome>;
  pack?: () => Promise<DesktopDiagnosticsBundle>;
}): DesktopBridge {
  const pack = diagnostics?.pack ?? (() => Promise.resolve({ ok: true, kind: "saved", name: "diagnostics.zip", data: "UEsDBA==", bytes: 8 }));
  return { info: () => Promise.resolve(INFO), local: local(), ...(diagnostics ? { diagnostics: { ...diagnostics, pack } } : {}) };
}

describe("诊断采集与导出（#162）", () => {
  it("桥上有真实 Diagnostics 才开放能力；日志经它入采集，不是前端空实现", async () => {
    const logs: { kind: string; fields: Record<string, string> }[] = [];
    const bridge = bridgeWith({
      log: (kind, fields) => { logs.push({ kind, fields }); },
      export: () => Promise.resolve({ ok: true, kind: "", message: "", bytes: 42 }),
      pack: () => Promise.resolve({ ok: true, kind: "saved", name: "diagnostics.zip", data: "UEsDBA==", bytes: 8 }),
    });
    const { port } = await createDesktopPort(bridge);
    expect(port.features.diagnostics).toBe(true);

    port.ui.log("task", { model: "test-model" });
    expect(logs).toEqual([{ kind: "task", fields: { model: "test-model" } }]);
    expect(await port.ui.exportDiagnostics()).toEqual({ kind: "saved", bytes: 42 });
    expect(await port.ui.diagnosticsPack()).toEqual({ kind: "saved", name: "diagnostics.zip", contentType: "application/zip", data: "UEsDBA==" });
  });

  it("诊断包生成失败时返回明确结局，不拿空包给反馈附件", async () => {
    const bridge = bridgeWith({
      log: () => undefined,
      export: () => Promise.resolve({ ok: false, kind: "failed", message: "导出失败", bytes: 0 }),
      pack: () => Promise.resolve({ ok: false, kind: "failed", message: "采集失败", name: "", data: "", bytes: 0 }),
    });
    const { port } = await createDesktopPort(bridge);
    expect(await port.ui.diagnosticsPack()).toEqual({ kind: "failed", message: "采集失败" });
  });

  it("没有 Diagnostics 绑定时保持不可用，不以空成功冒充", async () => {
    const { port } = await createDesktopPort(bridgeWith());
    expect(port.features.diagnostics).toBe(false);
    try {
      await port.ui.exportDiagnostics();
      throw new Error("本应拒绝");
    } catch (e) {
      const failure = portFailureOf(e);
      expect(failure.kind).toBe("unavailable");
      expect(failure.feature).toBe("diagnostics");
    }
  });

  it("用户取消不是成功结局", async () => {
    const { port } = await createDesktopPort(bridgeWith({
      log: () => undefined,
      export: () => Promise.resolve({ ok: false, kind: "cancelled", message: "已取消导出诊断包", bytes: 0 }),
    }));
    await expect(port.ui.exportDiagnostics()).resolves.toEqual({ kind: "cancelled" });
  });

  it("目标不可写 / 采集失败带明确消息，不吞成成功", async () => {
    const { port } = await createDesktopPort(bridgeWith({
      log: () => undefined,
      export: () => Promise.resolve({ ok: false, kind: "failed", message: "写入诊断包失败：拒绝访问", bytes: 0 }),
    }));
    await expect(port.ui.exportDiagnostics()).resolves.toEqual({ kind: "failed", message: "写入诊断包失败：拒绝访问" });
  });
});

// 网关连接日志也要进采集：core 的 settingsPorts.log 不是空实现，
// 否则「连接测试失败」这类最需要排障的信息在诊断包里缺席。
it("设置端口的日志经同一条采集通道", async () => {
  const logs: { kind: string; fields: Record<string, string> }[] = [];
  const { port } = await createDesktopPort(bridgeWith({
    log: (kind, fields) => { logs.push({ kind, fields }); },
    export: () => Promise.resolve({ ok: true, kind: "", message: "", bytes: 1 }),
  }));
  port.core.settingsPorts.log("connection", { stage: "list_models", ok: false, status_code: 401 });
  expect(logs).toEqual([{ kind: "connection", fields: { stage: "list_models", ok: "false", status_code: "401" } }]);
});

// 真实桌面桥（#127 / #129）：把 MyGo 绑定折成 DesktopBridge。
// 这里钉住「页面调用名 = Go 侧绑定名」：名字错了 Go 会返回 notBound，前端只会静默退回
// paste 事件——原生粘贴那条路就白做了，而且没有任何报错。
import { describe, expect, it, vi } from "vitest";

const runtimeCall = vi.fn();
vi.mock("mygo-runtime", () => ({ call: (method: string, ...args: unknown[]) => runtimeCall(method, ...args) }));

function bridgeWith(callFn: (method: string, ...args: unknown[]) => Promise<unknown>) {
  runtimeCall.mockImplementation(callFn);
  return mygoBridge();
}


import type { DesktopInfo } from "./desktop";
import { mygoBridge } from "./desktopBridge";
import { FEEDBACK_SPEC, FEEDBACK_SUCCESS } from "./testing/feedbackContract";

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/data",
  board_root: "C:/data/画板",
  features: { generation: false, usage: false, pack_export: false, archive: true },
};

/** 记下每次调用的方法名，按名字回值；不起 MyGo runtime。 */
function recordingBridge() {
  const calls: { method: string; args: unknown[] }[] = [];
  const callFn = (method: string, ...args: unknown[]): Promise<unknown> => {
    calls.push({ method, args });
    if (method === "Shell.Info") return Promise.resolve(INFO);
    if (method === "Clipboard.Read") return Promise.resolve({ kind: "empty", text: "", images: [], reason: "", formats: [] });
    if (method === "Local.ReadBoard") return Promise.resolve({ main: null, bak: null, version: null });
    if (method === "Local.ArchiveBoard" || method === "Local.UnarchiveBoard") return Promise.resolve({ ok: true, kind: "", message: "", version: "" });
    return Promise.reject(new Error("没实现：" + method));
  };
  return { bridge: bridgeWith(callFn), calls };
}

describe("网关与密钥句柄（#152）", () => {
  it("gateway.request() 调用 Gateway.Request——与 Go 侧 BindAs(\"Gateway\", ...) 一致", async () => {
    const { calls } = recordingBridge();
    const res = { status: 200, headers: {}, body: "{}" };
    const callFn = (method: string, ...args: unknown[]): Promise<unknown> => {
      calls.push({ method, args });
      if (method === "Gateway.Request") return Promise.resolve(res);
      return Promise.reject(new Error("没实现：" + method));
    };
    const direct = bridgeWith(callFn);
    await expect(direct.gateway!.request("http://gw/v1/models", "GET", { Accept: "application/json" })).resolves.toEqual(res);
    expect(calls.map((c) => c.method)).toEqual(["Gateway.Request"]);
  });

  it("密钥读写与清除分别调用 Gateway.ReadApiKey / WriteApiKey / DeleteApiKey", async () => {
    const calls: string[] = [];
    const direct = bridgeWith((method) => {
      calls.push(method);
      if (method === "Gateway.ReadApiKey") return Promise.resolve("sk-synthetic");
      return Promise.resolve(undefined);
    });
    await expect(direct.gateway!.readApiKey()).resolves.toBe("sk-synthetic");
    await direct.gateway!.writeApiKey("sk-new");
    await direct.gateway!.deleteApiKey();
    expect(calls).toEqual(["Gateway.ReadApiKey", "Gateway.WriteApiKey", "Gateway.DeleteApiKey"]);
  });
});

describe("剪贴板句柄（#129）", () => {
  it("clipboard.read() 调用 Clipboard.Read——与 Go 侧 BindAs(\"Clipboard\", ...) 一致", async () => {
    const { bridge, calls } = recordingBridge();
    await bridge.clipboard!.read();
    expect(calls.map((c) => c.method)).toEqual(["Clipboard.Read"]);
  });

  it("快照原样交给页面：类别、图片、原因都不在桥里改写", async () => {
    const { bridge } = recordingBridge();
    await expect(bridge.clipboard!.read()).resolves.toEqual({ kind: "empty", text: "", images: [], reason: "", formats: [] });
  });

  it("已有的句柄不受影响：info 仍调 Shell.Info，local 仍按 PascalCase 调", async () => {
    const { bridge, calls } = recordingBridge();
    await bridge.info();
    await bridge.local.readBoard("/x");
    expect(calls.map((c) => c.method)).toEqual(["Shell.Info", "Local.ReadBoard"]);
  });

  it("归档 / 取消归档的桥名与 Go 绑定一致（Local.ArchiveBoard / Local.UnarchiveBoard）", async () => {
    const { bridge, calls } = recordingBridge();
    await bridge.local.archiveBoard("/~/a", "/~/归档/a", "v1");
    await bridge.local.unarchiveBoard("/~/归档/a", "/~/a");
    expect(calls).toEqual([
      { method: "Local.ArchiveBoard", args: ["/~/a", "/~/归档/a", "v1"] },
      { method: "Local.UnarchiveBoard", args: ["/~/归档/a", "/~/a"] },
    ]);
  });
});
describe("本机用量句柄（#159）", () => {
  it("usage 句柄按 Usage.* 调 Go 绑定，方法名错一个就 notBound", async () => {
    const { bridge, calls } = recordingBridge();
    await bridge.usage!.usage().catch(() => undefined);
    await bridge.usage!.cleanup(["2026-11-01/x"]).catch(() => undefined);
    await bridge.usage!.setLimit(1024).catch(() => undefined);
    await bridge.usage!.recycle().catch(() => undefined);
    await bridge.usage!.restore("r000001").catch(() => undefined);
    await bridge.usage!.purgeExpired().catch(() => undefined);
    expect(calls.map((c) => c.method)).toEqual([
      "Usage.Usage", "Usage.Cleanup", "Usage.SetLimit", "Usage.Recycle", "Usage.Restore", "Usage.PurgeExpired",
    ]);
    expect(calls[1].args).toEqual([["2026-11-01/x"]]);
    expect(calls[4].args).toEqual(["r000001"]);
  });
});

describe("反馈句柄（#205 / #207）", () => {
  it("feedback.send() 调 Feedback.Send——与 Go 侧 BindAs(\"Feedback\", ...) 一致", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const direct = bridgeWith((method, ...args) => {
      calls.push({ method, args });
      if (method === "Feedback.Send") return Promise.resolve(FEEDBACK_SUCCESS);
      return Promise.reject(new Error("没实现：" + method));
    });
    await expect(direct.feedback!.send(FEEDBACK_SPEC)).resolves.toEqual(FEEDBACK_SUCCESS);
    expect(calls).toEqual([{ method: "Feedback.Send", args: [FEEDBACK_SPEC] }]);
  });

  it("附件随 spec 原样交给 Feedback.Send，诊断包由 Diagnostics.Bundle 生成", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const spec = { ...FEEDBACK_SPEC, screenshots: [{ name: "a.png", content_type: "image/png", data: "iVBORw==" }] };
    const pack = { kind: "saved" as const, name: "diagnostics.zip", contentType: "application/zip", data: "UEsDBA==" };
    const direct = bridgeWith((method, ...args) => {
      calls.push({ method, args });
      if (method === "Feedback.Send") return Promise.resolve(FEEDBACK_SUCCESS);
      if (method === "Diagnostics.Bundle") return Promise.resolve(pack);
      return Promise.reject(new Error("没实现：" + method));
    });
    await direct.feedback!.send(spec);
    await expect(direct.diagnostics!.pack()).resolves.toEqual(pack);
    expect(calls).toEqual([
      { method: "Feedback.Send", args: [spec] },
      { method: "Diagnostics.Bundle", args: [] },
    ]);
  });
});

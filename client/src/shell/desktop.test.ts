// 桌面壳端口（#127）：本切片没有的能力给 unavailable，不伪装成功；本机身份不需要登录。
import { describe, expect, it } from "vitest";

import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "./desktop";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import { DEFAULT_SETTINGS } from "../core/settings";
import { PortError, portFailureOf } from "./port";

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/Users/me/AppData/Roaming/Kacha/data",
  board_root: "C:/Users/me/AppData/Roaming/Kacha/data/画板",
  features: { generation: false, usage: false, pack_export: false, archive: true },
};

/** 假桥：测试不碰真窗口与真磁盘。 */
function fakeBridge(overrides: Partial<DesktopInfo> = {}, failure?: Error): DesktopBridge {
  const info = { ...INFO, ...overrides };
  const local = new Proxy({} as DesktopLocalBridge, {
    get: () => () => Promise.reject(new Error("没实现的本地调用")),
  });
  return {
    info: () => (failure ? Promise.reject(failure) : Promise.resolve(info)),
    local,
  };
}

describe("桌面壳端口", () => {
  it("数据根是本机真实目录，画板根在它下面", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    expect(port.userRoot).toBe("C:/Users/me/AppData/Roaming/Kacha/data");
  });

  it("未实现的能力在 features 里关着；归档已接通", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    // packImport（#131）也关着：这个假桥上没有 Pack 服务，导入无从谈起。
    expect(port.features).toEqual({ generation: false, usage: false, packExport: false, packImport: false, tidy: false, archive: true });
  });

  it("生成报 unavailable，并带上能力名", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    await expect(port.core.runDeps.fetch("/api/x", { method: "GET", headers: {} })).rejects.toBeInstanceOf(PortError);
    try {
      await port.core.runDeps.fetch("/api/x", { method: "GET", headers: {} });
    } catch (e) {
      const failure = portFailureOf(e);
      expect(failure.kind).toBe("unavailable");
      expect(failure.feature).toBe("generation");
      expect(failure.message).toContain("生成");
      expect(failure.message).toContain(UNAVAILABLE_TEXT);
    }
  });

  it("用量与画板包导出同样报 unavailable，不假装成功", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    await expect(port.usage.usage()).rejects.toMatchObject({ kind: "unavailable", feature: "usage" });
    await expect(port.pack.exportPack("x", { task_dirs: [], texts: [], files: [], omitted: [] })).rejects.toMatchObject({ kind: "unavailable", feature: "packExport" });
  });

  it("归档真的走本地服务，整理仍报 unavailable", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    // 假桥上的 Local 全拒绝：归档把失败原样带回来，而不是假装能力还不可用。
    await expect(port.board.archive("a", "b")).rejects.toMatchObject({ kind: "failed" });
    await expect(port.board.measure("{}")).rejects.toMatchObject({ kind: "unavailable", feature: "tidy" });
  });

  it("结果下载在桌面壳不可用：拒绝而不是报成功", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    // 端口同步抛：调用点按类别折成「尚不可用」。
    expect(() => port.media.downloadBoardResults("/~/画板/a.ugcboard.json")).toThrow(PortError);
    try {
      port.media.downloadBoardResults("/~/画板/a.ugcboard.json");
    } catch (e) {
      const failure = portFailureOf(e);
      expect(failure.kind).toBe("unavailable");
      expect(failure.message).toContain(UNAVAILABLE_TEXT);
    }
  });

  it("壳信息读不出来时直接失败，不静默降级", async () => {
    await expect(createDesktopPort(fakeBridge({}, new Error("数据根不可用")))).rejects.toThrow("数据根不可用");
  });
});
/** 记下写文件调用的假桥：用来验「文件名就是 sha256」与 alreadyExists 当成功。 */
function uploadBridge(behaviour: "ok" | "alreadyExists" = "ok"): { bridge: DesktopBridge; writes: { path: string; data: string }[] } {
  const writes: { path: string; data: string }[] = [];
  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_t, prop: string) => {
      if (prop === "writeNewFileBase64") {
        return (path: string, data: string) => {
          writes.push({ path, data });
          return Promise.resolve(behaviour === "ok" ? { ok: true, kind: "", message: "", version: "" } : { ok: false, kind: "alreadyExists", message: "目标已存在，只新建不覆盖", version: "" });
        };
      }
      return () => Promise.reject(new Error("没实现的本地调用"));
    },
  });
  return { bridge: { info: () => Promise.resolve(INFO), local }, writes };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);


describe("网关配置与密钥（#152）", () => {
  const KEY = "sk-spec152-synthetic-not-real";

  it("设置端口接到真实 Gateway 绑定：密钥读写与请求都过桥，默认地址来自 core", async () => {
    const calls: string[] = [];
    const bridge: DesktopBridge = {
      ...fakeBridge(),
      gateway: {
        request: (url, method, headers) => {
          calls.push("Gateway.Request " + url + " " + method + " " + headers["Accept"]);
          return Promise.resolve({ status: 200, headers: {}, body: "{}" });
        },
        readApiKey: () => {
          calls.push("Gateway.ReadApiKey");
          return Promise.resolve(KEY);
        },
        writeApiKey: (_key) => {
          calls.push("Gateway.WriteApiKey");
          return Promise.resolve();
        },
        deleteApiKey: () => {
          calls.push("Gateway.DeleteApiKey");
          return Promise.resolve();
        },
      },
    };
    const { port } = await createDesktopPort(bridge);
    expect(await port.core.settingsPorts.defaultBaseUrl()).toBe(DEFAULT_SETTINGS.base_url);
    expect(await port.core.settingsPorts.readApiKey()).toBe(KEY);
    await port.core.settingsPorts.writeApiKey(KEY);
    await port.core.settingsPorts.deleteApiKey();
    await port.core.settingsPorts.fetch("http://gw:3001/v1/models", { method: "GET", headers: { Accept: "application/json" } });
    expect(calls).toEqual([
      "Gateway.ReadApiKey",
      "Gateway.WriteApiKey",
      "Gateway.DeleteApiKey",
      "Gateway.Request http://gw:3001/v1/models GET application/json",
    ]);
  });

  it("没有 Gateway 绑定时，密钥与请求明确不可用，不用空成功冒充", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    await expect(port.core.settingsPorts.readApiKey()).rejects.toMatchObject({ kind: "unavailable", feature: "gateway" });
    await expect(port.core.settingsPorts.fetch("http://gw/v1/models", { method: "GET", headers: {} })).rejects.toMatchObject({ kind: "unavailable", feature: "gateway" });
  });
});
describe("本机图片进 导入参考图/（#129）", () => {
  it("文件名是内容的 sha256、扩展名按格式、落在 导入参考图/ 下", async () => {
    const { bridge, writes } = uploadBridge();
    const { port } = await createDesktopPort(bridge);
    const file = new File([PNG_BYTES], "截图.png", { type: "image/png" });
    const uploaded = await port.media.uploadReference(file);
    expect(uploaded.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(uploaded.path).toBe("导入参考图/" + uploaded.sha256 + ".png");
    expect(writes).toHaveLength(1);
    // 落盘的绝对路径用平台分隔符；对外返回的 path 是正斜杠的相对路径。
    expect(writes[0].path.replace(/\\/g, "/")).toBe("C:/Users/me/AppData/Roaming/Kacha/data/导入参考图/" + uploaded.sha256 + ".png");
  });

  it("同名（同内容）再传一次：alreadyExists 当成功，还是同一个路径（去重）", async () => {
    const { bridge } = uploadBridge("alreadyExists");
    const { port } = await createDesktopPort(bridge);
    const file = new File([PNG_BYTES], "截图.png", { type: "image/png" });
    await expect(port.media.uploadReference(file)).resolves.toMatchObject({ path: expect.stringContaining(".png") });
  });

  it("别的原因的写入失败照旧抛 PortError，不伪装成功", async () => {
    const local = new Proxy({} as DesktopLocalBridge, {
      get: () => () => Promise.resolve({ ok: false, kind: "failed", message: "磁盘满了", version: "" }),
    });
    const { port } = await createDesktopPort({ info: () => Promise.resolve(INFO), local });
    await expect(port.media.uploadReference(new File([PNG_BYTES], "a.png", { type: "image/png" }))).rejects.toBeInstanceOf(PortError);
  });
});

describe("复制图片到系统剪贴板（#130）", () => {
  /** 桥：Clipboard.Read 空快照，Clipboard.CopyImage 按给定结局回答。 */
  function copyBridge(outcome: { ok: boolean; kind: string; message: string; container?: string; bytes: number }, calls: { method: string; args: unknown[] }[] = []): DesktopBridge {
    return {
      info: () => Promise.resolve(INFO),
      local: new Proxy({} as DesktopLocalBridge, { get: () => () => Promise.reject(new Error("没实现的本地调用")) }),
      clipboard: {
        read: () => Promise.resolve({ kind: "empty", text: "", images: [], reason: "", formats: [] }),
        copyImage: (path, format) => {
          calls.push({ method: "Clipboard.CopyImage", args: [path, format] });
          return Promise.resolve(outcome);
        },
        writeText: () => Promise.resolve({ ok: true, kind: "", message: "" }),
      },
    };
  }

  it("成功：路径与格式提示原样交给 Go，结局是 ok", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const { port } = await createDesktopPort(copyBridge({ ok: true, kind: "", message: "", bytes: 167 }, calls));
    await expect(port.media.copyImage("C:/data/参考/cat.png", "png")).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ method: "Clipboard.CopyImage", args: ["C:/data/参考/cat.png", "png"] }]);
  });

  it("Go 侧的失败类别折成端口类别：不支持 / 内容坏 / 占用 / 其它", async () => {
    for (const [kind, reason] of [["unsupported", "unsupported"], ["invalid", "invalid"], ["busy", "busy"], ["failed", "failed"], ["没见过的", "failed"]] as const) {
      const { port } = await createDesktopPort(copyBridge({ ok: false, kind, message: "失败", bytes: 0 }));
      await expect(port.media.copyImage("C:/data/参考/cat.png", "png")).resolves.toEqual({ ok: false, reason });
    }
  });

  it("Go 认出容器名时折成 detail：界面据此说出具体格式，而不是笼统的「格式不受支持」", async () => {
    const { port } = await createDesktopPort(copyBridge({ ok: false, kind: "unsupported", message: "复制图片失败", container: "tiff", bytes: 0 }));
    await expect(port.media.copyImage("C:/data/参考/cat.tiff", "tiff")).resolves.toEqual({ ok: false, reason: "unsupported", detail: "tiff" });
  });

  it("桥里没有剪贴板：按 unavailable 收，不伪装成功", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    await expect(port.media.copyImage("C:/data/参考/cat.png", "png")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("读系统剪贴板（#129）", () => {
  it("桥里没有剪贴板：返回 null，调用方改用 paste 事件", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    await expect(port.media.readClipboard()).resolves.toBeNull();
  });

  it("有剪贴板：快照折成页面的 ClipboardContent，图片还原成 image/png", async () => {
    const bridge = fakeBridge();
    const b64 = Buffer.from(PNG_BYTES).toString("base64");
    const withClip = {
      ...bridge,
      clipboard: {
        read: () => Promise.resolve({ kind: "images", text: "", images: [b64], reason: "", formats: ["image/png"] }),
        copyImage: () => Promise.resolve({ ok: true, kind: "", message: "", bytes: b64.length }),
        writeText: () => Promise.resolve({ ok: true, kind: "", message: "" }),
      },
    };
    const { port } = await createDesktopPort(withClip);
    const content = await port.media.readClipboard();
    expect(content?.kind).toBe("images");
    expect(content?.images[0].type).toBe("image/png");
    expect(content?.images[0].size).toBe(PNG_BYTES.length);
  });

});

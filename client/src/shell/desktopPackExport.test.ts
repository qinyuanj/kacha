// 桌面画板包导出（票 160）：目标选择、facts、后台导出进度、取消与结局都走本机 Pack 服务。
import { describe, expect, it, vi } from "vitest";

const runtimeCall = vi.fn();
vi.mock("mygo-runtime", () => ({ call: (method: string, ...args: unknown[]) => runtimeCall(method, ...args) }));

function bridgeWith(callFn: (method: string, ...args: unknown[]) => Promise<unknown>) {
  runtimeCall.mockImplementation(callFn);
  return mygoBridge();
}


import type { PackExportSpec } from "../core/boardPack";
import { createDesktopPort, type DesktopBridge, type DesktopInfo } from "./desktop";
import { mygoBridge } from "./desktopBridge";
import { portFailureOf } from "./port";

const INFO: DesktopInfo = {
  version: "1.5.0",
  user_data_root: "C:/data",
  board_root: "C:/data/画板",
  features: { generation: false, usage: false, pack_export: true },
};

const SPEC: PackExportSpec = {
  texts: [{ entry: "manifest.json", text: "{}" }],
  task_dirs: ["2026-01-02/t1"],
  files: [],
  omitted: [],
};

/** 假桥：按 Go 绑定名记录调用，按脚本给结局。 */
function bridgeOf(handlers: Record<string, (...args: unknown[]) => unknown>): { bridge: DesktopBridge; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const callFn = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
    const fn = handlers[method];
    return fn ? Promise.resolve(fn(...args)) : Promise.reject(new Error("未实现：" + method));
  };
  return { bridge: bridgeWith(callFn), calls };
}

const DONE = {
  running: false,
  progress: { step: "done", done: 1, total: 1, detail: "完成", bytes_done: 12, bytes_total: 12 },
  outcome: { ok: true, kind: "", step: "done", message: "", result: { task_dirs: 1, bytes: 12 } },
};

describe("桌面画板包导出", () => {
  it("壳信息说导出可用时，features.packExport 为 true", async () => {
    const { bridge } = bridgeOf({ "Shell.Info": () => INFO });
    const { port } = await createDesktopPort(bridge);
    expect(port.features.packExport).toBe(true);
  });

  it("facts 交给本机 Pack.Facts，拿回逐文件事实", async () => {
    const facts = [{ entry: "2026-01-02/t1/task.json", size: 3, sha256: "abc" }];
    const { bridge, calls } = bridgeOf({ "Shell.Info": () => INFO, "Pack.Facts": () => facts });
    const { port } = await createDesktopPort(bridge);
    await expect(port.pack.facts({ task_dirs: SPEC.task_dirs, files: SPEC.files })).resolves.toEqual(facts);
    expect(calls).toContainEqual({ method: "Pack.Facts", args: [{ task_dirs: SPEC.task_dirs, files: SPEC.files }] });
  });

  it("导出前用系统对话框选目标，确认覆盖的许可带到导出，后台进度推送到界面，成功带回实际路径", async () => {
    let snapshot = 0;
    const { bridge, calls } = bridgeOf({
      "Shell.Info": () => INFO,
      "Pack.PickExport": (name: unknown) => (name === "画板.ugcpack" ? { path: "C:/导出/画板.ugcpack", overwrite: true } : { path: "", overwrite: false }),
      "Pack.Export": () => ({ ok: true }),
      "Pack.ExportSnapshot": () => (snapshot++ === 0 ? { ...DONE, running: true, progress: { ...DONE.progress, bytes_done: 5 }, outcome: null } : DONE),
    });
    const { port } = await createDesktopPort(bridge);
    const seen: { done: number; total: number }[] = [];
    await port.ui.onPackProgress((p) => seen.push(p));
    await expect(port.pack.exportPack("画板.ugcpack", SPEC)).resolves.toEqual({ task_dirs: 1, bytes: 12, target: "C:/导出/画板.ugcpack" });
    expect(calls).toContainEqual({ method: "Pack.PickExport", args: ["画板.ugcpack"] });
    expect(calls).toContainEqual({ method: "Pack.Export", args: ["C:/导出/画板.ugcpack", SPEC, true] });
    expect(seen.some((p) => p.done === 5)).toBe(true);
  });

  it("取消系统目标选择：拒绝且不是成功，也不开始打包", async () => {
    const { bridge, calls } = bridgeOf({ "Shell.Info": () => INFO, "Pack.PickExport": () => ({ path: "", overwrite: false }) });
    const { port } = await createDesktopPort(bridge);
    const failure = await port.pack.exportPack("画板.ugcpack", SPEC).then(() => null, portFailureOf);
    expect(failure?.kind).toBe("cancelled");
    expect(calls.some((c) => c.method === "Pack.Export")).toBe(false);
  });

  it("导出中取消：调用 Pack.CancelExport，结局是取消，不报成功", async () => {
    const { bridge, calls } = bridgeOf({
      "Shell.Info": () => INFO,
      "Pack.PickExport": () => ({ path: "C:/导出/画板.ugcpack", overwrite: false }),
      "Pack.Export": () => ({ ok: true }),
      "Pack.ExportSnapshot": () => ({ ...DONE, outcome: { ok: false, kind: "cancelled", step: "pack", message: "已取消导出" } }),
    });
    const { port } = await createDesktopPort(bridge);
    await port.pack.io.cancel(true);
    expect(calls).toContainEqual({ method: "Pack.CancelExport", args: [] });
    const failure = await port.pack.exportPack("画板.ugcpack", SPEC).then(() => null, portFailureOf);
    expect(failure?.kind).toBe("cancelled");
  });

  it("写失败给出明确失败，不把未完成包当成功", async () => {
    const { bridge } = bridgeOf({
      "Shell.Info": () => INFO,
      "Pack.PickExport": () => ({ path: "C:/导出/画板.ugcpack", overwrite: false }),
      "Pack.Export": () => ({ ok: true }),
      "Pack.ExportSnapshot": () => ({ ...DONE, outcome: { ok: false, kind: "failed", step: "pack", message: "磁盘满了" } }),
    });
    const { port } = await createDesktopPort(bridge);
    const failure = await port.pack.exportPack("画板.ugcpack", SPEC).then(() => null, portFailureOf);
    expect(failure?.kind).toBe("failed");
    expect(failure?.message).toContain("磁盘满了");
  });
});

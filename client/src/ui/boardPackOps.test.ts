// 画板包界面的各个步骤（#137）：导出的第一步与第二步、对话框的状态。
import { describe, expect, it, vi } from "vitest";
import { planExport } from "../core/boardPack";
import { confirmDialog, exportPackStep, exportPlanStep, progressDialog, type ExportDeps } from "./boardPackOps";

const board = { format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} } as never;
const packFs = { isFile: async () => false, sha256: async () => "sha" } as never;

function deps(patch: Partial<ExportDeps> = {}): ExportDeps {
  return {
    packFs,
    io: { cancel: async () => undefined } as never,
    facts: async () => [],
    exportPack: async () => ({ task_dirs: 0, bytes: 0 }),
    version: async () => "1.0",
    log: () => undefined,
    ...patch,
  };
}

describe("导出的第一步", () => {
  it("算计划出错：给一句提示", async () => {
    const broken = { ...(board as { nodes: unknown[] }), nodes: undefined } as never;
    const step = await exportPlanStep(deps(), broken, "a.ugcboard.json", "/~", () => () => undefined);
    expect(step.kind).toBe("failed");
    expect(step.kind === "failed" && step.text).toContain("无法导出画板包：");
  });

  it("读不到参考图：仍进确认，但计划里记为缺图", async () => {
    const d = deps({ packFs: { isFile: async () => false, sha256: async () => null } as never });
    const withRef = { ...(board as { nodes: unknown[] }), nodes: [{ id: "r1", type: "reference", pos: [0, 0], size: [1, 1], extra: {}, path: "refs/a.png", sha256: "s", display_name: "a.png" }] } as never;
    const step = await exportPlanStep(d, withRef, "a.ugcboard.json", "/~", () => () => undefined);
    expect(step.kind).toBe("confirm");
    if (step.kind === "confirm") expect(step.plan.missing.length).toBeGreaterThan(0);
  });

  it("计划与 hash 都成功：请用户确认", async () => {
    const step = await exportPlanStep(deps(), board, "a.ugcboard.json", "/~", () => () => undefined);
    expect(step.kind).toBe("confirm");
  });
});

describe("导出的第二步", () => {
  it("成功：提示已导出", async () => {
    const plan = await planExport(board, "/~", packFs);
    const contents = { duplicates: {}, bytes: 10, totalBytes: 10 };
    const exportPack = vi.fn(async () => ({ task_dirs: 0, bytes: 0, target: "/~/a.ugcpack" }));
    const d = deps({ exportPack });
    const result = await exportPackStep(d, "a.ugcboard.json", plan, contents, () => () => undefined);
    expect(exportPack).toHaveBeenCalledWith("a.ugcpack", expect.anything());
    expect(result.ok && result.text).toBe("已导出画板包 /~/a.ugcpack");
  });
});

describe("对话框的状态", () => {
  it("进度与确认", async () => {
    expect(progressDialog("正在导出")).toEqual({ stage: "progress", title: "正在导出" });
    const plan = await planExport(board, "/~", packFs);
    expect(confirmDialog("a.ugcboard.json", plan, { duplicates: {}, bytes: 10, totalBytes: 10 }).stage).toBe("confirmExport");
    expect(progressDialog("正在导出").stage).toBe("progress");
  });
});

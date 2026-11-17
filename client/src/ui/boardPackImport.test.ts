// 画板包导入结局的可见判定（#137）：各结局对应的提示或弹窗。
import { describe, expect, it } from "vitest";
import { PACK_IMPORT_TEXT } from "./boardText";
import { importOutcome } from "./boardPackImport";

describe("导入结局", () => {
  it("包格式更新：用系统提示框提示原文", () => {
    expect(importOutcome({ kind: "newer", message: "包太新" })).toEqual({ kind: "message", text: "包太新" });
  });

  it("包损坏：提示无法导入并给原因", () => {
    expect(importOutcome({ kind: "corrupt", reason: "缺清单" })).toEqual({ kind: "toast", text: "无法导入画板包：缺清单" });
  });

  it("已取消：提示取消文案", () => {
    expect(importOutcome({ kind: "cancelled" })).toEqual({ kind: "toast", text: PACK_IMPORT_TEXT.cancelled });
  });

  it("画板位满：提示统一文案", () => {
    expect(importOutcome({ kind: "slotsFull", message: "画板位已满" })).toEqual({ kind: "toast", text: "画板位已满" });
  });

  it("导入请求失败：提示失败", () => {
    expect(importOutcome({ kind: "failed", error: "断网" })).toEqual({ kind: "toast", text: PACK_IMPORT_TEXT.failed("断网") });
  });

  it("导入请求失败但报错是画板位满：照原文提示，不加前缀", () => {
    expect(importOutcome({ kind: "failed", error: "画板位满了（3/3），归档或删掉一块再新建。" })).toEqual({
      kind: "toast",
      text: "画板位满了（3/3），归档或删掉一块再新建。",
    });
  });

  it("存储端口提交失败：弹窗说明画板没写入", () => {
    const outcome = importOutcome({ kind: "commitFailed", error: "断网" });
    expect(outcome.kind).toBe("dialog");
    if (outcome.kind === "dialog") {
      expect(outcome.state.stage).toBe("importDone");
      if (outcome.state.stage === "importDone") expect(outcome.state.notice).toBe(PACK_IMPORT_TEXT.commitFailed);
    }
  });

  it("成功且无冲突：提示结局", () => {
    expect(importOutcome({ kind: "done", summary: { imported: 1, skipped: 0, conflicts: [], message: "已导入" }, written: [], writeError: null })).toEqual({ kind: "toast", text: "已导入" });
  });

  it("成功但有冲突：弹窗列出冲突", () => {
    const outcome = importOutcome({ kind: "done", summary: { imported: 1, skipped: 1, conflicts: ["a"], message: "已导入" }, written: [], writeError: null });
    expect(outcome.kind).toBe("dialog");
    if (outcome.kind === "dialog" && outcome.state.stage === "importDone") expect(outcome.state.conflicts).toEqual(["a"]);
  });

  it("成功但打开画板失败：弹窗说明", () => {
    const outcome = importOutcome({ kind: "done", summary: { imported: 1, skipped: 0, conflicts: [], message: "已导入" }, written: [], writeError: "打不开" });
    expect(outcome.kind).toBe("dialog");
    if (outcome.kind === "dialog" && outcome.state.stage === "importDone") expect(outcome.state.notice).toContain("打不开");
  });
});

// 画板包导出的各个步骤（#137）：计划、hash 阶段、打包阶段与文案。
import { describe, expect, it } from "vitest";
import { exportCancelledText, exportDoneText, exportFailedText, exportTargetOf, exportHashFailedText, planFailedText } from "./boardPackExportOps";

describe("导出文案", () => {
  it("计划失败 / hash 失败 / 打包失败：各有各的说法", () => {
    expect(planFailedText("offline")).toBe("无法导出画板包：offline");
    expect(exportHashFailedText("offline")).toBe("无法导出画板包：offline");
    expect(exportFailedText("offline")).toBe("导出画板包失败：offline");
  });

  it("取消与成功", () => {
    expect(exportCancelledText).toBe("已取消导出画板包");
    expect(exportDoneText("/~/a.ugcpack")).toBe("已导出画板包 /~/a.ugcpack");
  });

  it("导出目标：画板名加 .ugcpack", () => {
    expect(exportTargetOf("a.ugcboard.json")).toEqual({ stem: "a", target: "a.ugcpack" });
  });
});

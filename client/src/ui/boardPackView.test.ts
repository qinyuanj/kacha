// 画板包对话框的可见判定（#137）：进度文本、预估大小、导出说明与按钮文字。
import { describe, expect, it } from "vitest";
import { dismissible, estimateText, exportButtonLabel, exportSummary, formatSize, progressMax, progressText } from "./boardPackView";

describe("画板包对话框", () => {
  it("字节的可读大小", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("进度：没有总量时说准备中，有了说已用 / 总量", () => {
    expect(progressText({ done: 0, total: 0 })).toBe("准备中…");
    expect(progressText({ done: 1024, total: 2048 })).toBe("1.0 KB / 2.0 KB");
  });

  it("进度条的 max：没有总量时给 1", () => {
    expect(progressMax({ done: 0, total: 0 })).toBe(1);
    expect(progressMax({ done: 1, total: 5 })).toBe(5);
  });

  it("预估大小：重复内容省下的字节也说出来", () => {
    expect(estimateText(1024, 1024)).toBe("预估大小：1.0 KB");
    expect(estimateText(1024, 2048)).toBe("预估大小：1.0 KB（重复内容只存一份，省去 1.0 KB）");
  });

  it("导出说明：任务目录与参考图", () => {
    expect(exportSummary(3, 0)).toBe("将打包画板与它引用的 3 个任务目录。");
    expect(exportSummary(3, 2)).toContain("2 张参考图");
  });

  it("导出按钮：有缺图时说「仍然导出…」", () => {
    expect(exportButtonLabel(0)).toBe("导出并下载…");
    expect(exportButtonLabel(2)).toBe("仍然导出…");
  });

  it("进度阶段：点背景不关闭", () => {
    expect(dismissible({ stage: "progress", title: "正在导出" })).toBe(false);
    expect(dismissible({ stage: "importDone", message: "好了", conflicts: [], notice: null })).toBe(true);
  });
});

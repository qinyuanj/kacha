// 预览弹窗的导出接线（#137）：成功、失败与提示。
import { describe, expect, it, vi } from "vitest";
import { exportAllImages, exportAllText, exportFailedText, exportOneImage, exportOneText, runExport } from "./previewExport";

const port = (patch: Partial<{ saveCopyAs(absPath: string): Promise<{ kind: "saved" | "cancelled" }>; downloadImage(path: string): Promise<{ kind: "saved" | "cancelled" }> }> = {}) => ({
  saveCopyAs: vi.fn(async () => ({ kind: "saved" as const })),
  downloadImage: vi.fn(async () => ({ kind: "saved" as const })),
  ...patch,
});

describe("导出接线", () => {
  it("成功：给出提示", async () => {
    const toast = vi.fn();
    await runExport(toast, vi.fn(), async () => "好了");
    expect(toast).toHaveBeenCalledWith("好了");
  });

  it("失败：给出失败说明", async () => {
    const toast = vi.fn();
    await runExport(
      toast,
      vi.fn(),
      async () => {
        throw new Error("offline");
      },
    );
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });

  it("没有提示：什么都不说", async () => {
    const toast = vi.fn();
    await runExport(toast, vi.fn(), async () => null);
    expect(toast).not.toHaveBeenCalled();
  });

  it("导出单张图：调端口并提示", async () => {
    const p = port();
    const toast = vi.fn();
    await exportOneImage(p, toast, vi.fn(), "/~/a.png");
    expect(p.saveCopyAs).toHaveBeenCalledWith("/~/a.png");
    expect(toast).toHaveBeenCalledWith(exportOneText);
  });

  it("取消系统另存为：不提示已开始下载", async () => {
    const p = port({ saveCopyAs: vi.fn(async () => ({ kind: "cancelled" as const })) });
    const toast = vi.fn();
    await exportOneImage(p, toast, vi.fn(), "/~/a.png");
    expect(p.saveCopyAs).toHaveBeenCalledWith("/~/a.png");
    expect(toast).not.toHaveBeenCalled();
  });

  it("导出全部：调端口并提示", async () => {
    const p = port();
    const toast = vi.fn();
    await exportAllImages(p, toast, vi.fn(), "/~/a.png");
    expect(p.downloadImage).toHaveBeenCalledWith("/~/a.png");
    expect(toast).toHaveBeenCalledWith(exportAllText);
  });

  it("文案", () => {
    expect(exportFailedText("offline")).toContain("offline");
  });

  it("保存全部：系统对话框取消时不报成功", async () => {
    const p = {
      saveCopyAs: vi.fn(async () => ({ kind: "saved" as const })),
      downloadImage: vi.fn(async () => ({ kind: "cancelled" as const })),
    };
    const toast = vi.fn();
    await exportAllImages(p, toast, vi.fn(), "/~/a.png");
    expect(p.downloadImage).toHaveBeenCalledWith("/~/a.png");
    expect(toast).not.toHaveBeenCalled();
  });

  it("保存全部：写失败给出明确失败", async () => {
    const p = {
      saveCopyAs: vi.fn(async () => ({ kind: "saved" as const })),
      downloadImage: vi.fn(async () => {
        throw new Error("磁盘满了");
      }),
    };
    const toast = vi.fn();
    await exportAllImages(p, toast, vi.fn(), "/~/a.png");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("磁盘满了"));
    expect(toast).not.toHaveBeenCalledWith(exportAllText);
  });
});

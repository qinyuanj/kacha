// 预览弹窗的导出接线（#137）：成功、失败与提示。
import { describe, expect, it, vi } from "vitest";
import { exportAllImages, exportAllText, exportFailedText, exportOneImage, exportOneText, runExport } from "./previewExport";

const port = (patch: Partial<{ saveCopyAs(absPath: string): Promise<void>; downloadImage(path: string): void }> = {}) => ({
  saveCopyAs: vi.fn(async () => undefined),
  downloadImage: vi.fn(),
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
});

// 桌面壳端口的各个分组（#137）：本地调用的异常折算与没有的能力。
import { describe, expect, it } from "vitest";
import { checked, desktopMediaStore, localRun, unavailable } from "./desktopStores";
import { PortError } from "./port";

describe("本地调用", () => {
  it("成功：原样返回", async () => {
    expect(await localRun(async () => 1)).toBe(1);
  });

  it("Go 侧异常：折成 failed", async () => {
    await expect(
      localRun(async () => {
        throw new Error("offline");
      }),
    ).rejects.toMatchObject({ kind: "failed" });
  });

  it("已经是 PortError：原样抛", async () => {
    const e = new PortError({ kind: "conflict", code: "conflict", message: "x", status: 409 });
    await expect(localRun(async () => Promise.reject(e))).rejects.toBe(e);
  });
});

describe("结局检查", () => {
  it("成功：什么都不做", () => {
    expect(() => checked({ ok: true, kind: "", message: "", version: "v" })).not.toThrow();
  });

  it("失败：抛类别化的错误", () => {
    expect(() => checked({ ok: false, kind: "conflict", message: "已改过", version: "" })).toThrow(PortError);
  });

  it("未列出的类别：按 failed 处理", () => {
    expect(() => checked({ ok: false, kind: "别的", message: "x", version: "" })).toThrow(PortError);
  });
});

describe("没有的能力", () => {
  it("拒绝：类别是 unavailable", () => {
    expect(() => unavailable("generation")).toThrow(PortError);
    try {
      unavailable("generation");
    } catch (e) {
      expect(e).toMatchObject({ kind: "unavailable" });
    }
  });

  it("图片能力用自己的名字，不把「生成」当成保存 / 下载的理由（C4）", async () => {
    const media = desktopMediaStore("C:/data");
    await expect(media.copyImage("C:/data/a.png")).rejects.toMatchObject({ kind: "unavailable", feature: "copyImage" });
    await expect(media.saveCopyAs("C:/data/a.png")).rejects.toMatchObject({ kind: "unavailable", feature: "saveImage" });
    await expect(media.downloadImage("C:/data/a.png")).rejects.toBeInstanceOf(PortError);
    try {
      await media.downloadImage("C:/data/a.png");
    } catch (e) {
      expect(e).toMatchObject({ kind: "unavailable", feature: "downloadImage" });
    }
    try {
      await media.downloadBoardResults("C:/data/画板/a.ugcboard.json");
    } catch (e) {
      expect(e).toMatchObject({ kind: "unavailable", feature: "downloadResults" });
    }
  });
});

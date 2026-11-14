// @vitest-environment jsdom
// 图片信息缓存与读取（#137）：读过就缓存，读不到不缓存。
import { describe, expect, it } from "vitest";
import { createImageInfoCache } from "./imageInfoCache";
import type { ImageInfo } from "../shell/port";

const info = (patch: Partial<ImageInfo> = {}): ImageInfo => ({ sha256: "s", bytes: 10, width: 64, height: 48, format: "png", has_alpha: false, ...patch });

describe("图片信息缓存", () => {
  it("没读过：不知道", () => {
    const cache = createImageInfoCache();
    expect(cache.known("/a.png")).toBeFalsy();
  });

  it("读过：知道了", async () => {
    const cache = createImageInfoCache();
    await cache.read(async () => info(), "/a.png");
    expect(cache.known("/a.png")).toBeTruthy();
  });

  it("读失败：不缓存", async () => {
    const cache = createImageInfoCache();
    await cache
      .read(async () => {
        throw new Error("读不到");
      }, "/a.png")
      .catch(() => undefined);
    expect(cache.known("/a.png")).toBeFalsy();
  });

  it("预先塞入：直接知道", () => {
    const cache = createImageInfoCache();
    cache.prime("/a.png", info({ has_alpha: true }));
    expect(cache.known("/a.png")).toBeTruthy();
  });

  it("读两次：只问端口一次", async () => {
    const cache = createImageInfoCache();
    let asked = 0;
    const inspect = async () => {
      asked += 1;
      return info();
    };
    await cache.read(inspect, "/a.png");
    await cache.read(inspect, "/a.png");
    expect(asked).toBe(1);
  });
});

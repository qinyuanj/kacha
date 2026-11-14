// 图片信息缓存（#137）：命中缓存、读取失败不缓存、prime 之后同步可读。
import { describe, expect, it, vi } from "vitest";
import type { ImageInfo } from "../shell/port";
import { createImageInfoCache } from "./imageInfoCache";

const info = (sha: string): ImageInfo => ({ sha256: sha, bytes: 10, width: 64, height: 48, format: "png", has_alpha: false });

describe("图片信息缓存", () => {
  it("同一个路径只问一次端口", async () => {
    const cache = createImageInfoCache();
    const inspect = vi.fn(async () => info("a"));
    await expect(cache.read(inspect, "/~/a.png")).resolves.toEqual(info("a"));
    await expect(cache.read(inspect, "/~/a.png")).resolves.toEqual(info("a"));
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("读取失败：不缓存，下次要能重查", async () => {
    const cache = createImageInfoCache();
    let fail = true;
    const inspect = vi.fn(async () => {
      if (fail) throw new Error("missing");
      return info("a");
    });
    await expect(cache.read(inspect, "/~/a.png")).resolves.toBeNull();
    fail = false;
    await expect(cache.read(inspect, "/~/a.png")).resolves.toEqual(info("a"));
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("读到的信息同步可读", async () => {
    const cache = createImageInfoCache();
    expect(cache.known("/~/a.png")).toBeUndefined();
    await cache.read(async () => info("a"), "/~/a.png");
    expect(cache.known("/~/a.png")).toEqual(info("a"));
  });

  it("prime：立刻可读，且之后命中缓存", async () => {
    const cache = createImageInfoCache();
    const inspect = vi.fn(async () => info("b"));
    cache.prime("/~/a.png", info("a"));
    expect(cache.known("/~/a.png")).toEqual(info("a"));
    await expect(cache.read(inspect, "/~/a.png")).resolves.toEqual(info("a"));
    expect(inspect).not.toHaveBeenCalled();
  });
});

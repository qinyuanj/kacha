// @vitest-environment jsdom
// 图片信息缓存与读取（#137）：读过就缓存，读不到不缓存。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImageInfoCache } from "./imageInfoCache";
import { useImageInfo } from "./context";
import { createFakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import type { ImageInfo } from "../shell/port";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("读一张图的信息", () => {
  let container: HTMLDivElement;
  let dom: ReactRoot;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    dom = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => dom.unmount());
    container.remove();
  });

  it("没有路径：没有信息", async () => {
    const port = createFakePort();
    let seen: unknown = "unset";
    const Probe = () => {
      seen = useImageInfo(null);
      return null;
    };
    await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(Probe) })));
    expect(seen).toBeUndefined();
  });

  it("有路径：读到信息", async () => {
    const port = createFakePort({ files: { "/a.png": new Uint8Array([137, 80, 78, 71]) } });
    let seen: unknown = "unset";
    const Probe = () => {
      seen = useImageInfo("/a.png");
      return null;
    };
    await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(Probe) })));
    await act(async () => undefined);
    expect(seen).toMatchObject({ sha256: expect.any(String), bytes: expect.any(Number), width: expect.any(Number), height: expect.any(Number), format: expect.any(String), has_alpha: expect.any(Boolean) });
  });
});

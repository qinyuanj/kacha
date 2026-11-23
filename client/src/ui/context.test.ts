// @vitest-environment jsdom
// 图片信息缓存与读取（#137）：读过就缓存，读不到不缓存。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useImageInfo } from "./context";
import { createFakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    expect(seen).toMatchObject({ sha256: "sha-/a.png", bytes: 10, width: 64, height: 48, format: "png", has_alpha: false });
    expect(port.calls.inspectImage).toContain("/a.png");
  });
});

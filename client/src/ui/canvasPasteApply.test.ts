// 粘贴落地的分派（#137）：一个分派结局落到界面上该做什么（吞掉 / 提示 / 落图 / 粘节点）。
import { describe, expect, it } from "vitest";
import type { Clip } from "../core/iterate";
import { applyPasteEffect, pasteEffect } from "./canvasPasteApply";

const image = (name = "shot.png", size = 1024): File => ({ name, type: "image/png", size }) as unknown as File;
const clipOf = (id: string): Clip => ({ nodes: [{ id, type: "prompt", pos: [0, 0], size: [240, 120], text: id, extra: {} }], edges: [] });
const refuseText = (reason: string) => "拒绝：" + reason;
const noticeText = (notice: string) => "提示：" + notice;
const deps = (over: Partial<Parameters<typeof pasteEffect>[1]> = {}) => ({
  images: () => [image()],
  readClipboard: () => clipOf("p1"),
  refuseText,
  noticeText,
  ...over,
});

describe("放行与提示", () => {
  it("放行：什么都不做", () => {
    expect(pasteEffect({ kind: "pass" }, deps())).toEqual({ kind: "pass" });
  });

  it("拒绝：换成对应的文案", () => {
    expect(pasteEffect({ kind: "refuse", reason: "readOnly" }, deps())).toEqual({ kind: "toast", text: "拒绝：readOnly" });
  });

  it("提示：换成对应的文案", () => {
    expect(pasteEffect({ kind: "notice", notice: "busy" }, deps())).toEqual({ kind: "toast", text: "提示：busy" });
  });
});

describe("落图", () => {
  it("有图片：交给导入链路，落点原样带出", () => {
    const files = [image("a.png")];
    expect(pasteEffect({ kind: "importImages", at: [51, 26] }, deps({ images: () => files }))).toEqual({ kind: "importImages", files, at: [51, 26] });
  });

  it("没有能读出的图片：吞掉但什么都不做", () => {
    expect(pasteEffect({ kind: "importImages", at: [0, 0] }, deps({ images: () => [] }))).toEqual({ kind: "swallow" });
  });
});

describe("粘节点", () => {
  it("应用内剪贴板有节点：写进画板", () => {
    const clip = clipOf("p1");
    expect(pasteEffect({ kind: "pasteNodes" }, deps({ readClipboard: () => clip }))).toEqual({ kind: "pasteNodes", clip });
  });

  it("剪贴板空了：吞掉但什么都不做（防御分支）", () => {
    expect(pasteEffect({ kind: "pasteNodes" }, deps({ readClipboard: () => null }))).toEqual({ kind: "swallow" });
  });

  it("剪贴板里没有节点：同样什么都不做", () => {
    expect(pasteEffect({ kind: "pasteNodes" }, deps({ readClipboard: () => ({ nodes: [], edges: [] }) }))).toEqual({ kind: "swallow" });
  });
});

describe("接到界面上", () => {
  /** 记下界面被要求做的每一件事。 */
  function sinks() {
    const calls = { toast: [] as string[], images: [] as { files: File[]; at: { x: number; y: number } }[], clips: [] as Clip[], written: [] as Clip[] };
    return {
      calls,
      sinks: {
        toast: (m: string) => calls.toast.push(m),
        importPastedImages: (files: File[], at: { x: number; y: number }) => calls.images.push({ files, at }),
        apply: (change: { kind: "paste"; clip: Clip }) => calls.clips.push(change.clip),
        writeClipboard: (clip: Clip) => calls.written.push(clip),
      },
    };
  }

  it("放行：返回 false，什么都不做", () => {
    const { calls, sinks: s } = sinks();
    expect(applyPasteEffect({ kind: "pass" }, s)).toBe(false);
    expect(calls.toast).toEqual([]);
  });

  it("提示：返回 true 并弹一次", () => {
    const { calls, sinks: s } = sinks();
    expect(applyPasteEffect({ kind: "toast", text: "说清楚" }, s)).toBe(true);
    expect(calls.toast).toEqual(["说清楚"]);
  });

  it("落图：返回 true 并把落点带出去", () => {
    const { calls, sinks: s } = sinks();
    const files = [image()];
    expect(applyPasteEffect({ kind: "importImages", files, at: [51, 26] }, s)).toBe(true);
    expect(calls.images).toEqual([{ files, at: { x: 51, y: 26 } }]);
  });

  it("粘节点：写进画板并把剪贴板存回去", () => {
    const { calls, sinks: s } = sinks();
    const clip = clipOf("p1");
    expect(applyPasteEffect({ kind: "pasteNodes", clip }, s)).toBe(true);
    expect(calls.clips).toEqual([clip]);
    expect(calls.written).toEqual([clip]);
  });

  it("吞掉：返回 true 但什么都不做", () => {
    const { calls, sinks: s } = sinks();
    expect(applyPasteEffect({ kind: "swallow" }, s)).toBe(true);
    expect(calls).toEqual({ toast: [], images: [], clips: [], written: [] });
  });
});

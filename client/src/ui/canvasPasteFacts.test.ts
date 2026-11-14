// 页面级粘贴的判定（#137）：落点取整、读不到内容的文件算不透明、剪贴板快照优先于事件内容。
import { describe, expect, it } from "vitest";
import type { ClipboardContent } from "../core/clipboardDispatch";
import { decidePaste, pastePosition, pastedFacts, splitPastedFiles } from "./canvasPasteFacts";

const image = (name = "shot.png", size = 1024): File => ({ name, type: "image/png", size }) as unknown as File;
const opaque = (name = "报表.pdf"): File => ({ name, type: "application/pdf", size: 1024 }) as unknown as File;
const isImage = (f: File) => f.type.startsWith("image/");

describe("粘贴落点", () => {
  it("指针在画布内：用它换算的画布坐标，取整", () => {
    const at = pastePosition({ pointer: { x: 101, y: 51 }, center: () => ({ x: 0, y: 0 }), toFlow: (c) => ({ x: c.x / 2, y: c.y / 2 }) });
    expect(at).toEqual([51, 26]);
  });

  it("指针从没进过画布：用视口中央，取整", () => {
    const at = pastePosition({ pointer: null, center: () => ({ x: 500.4, y: 400.6 }), toFlow: (c) => c });
    expect(at).toEqual([500, 401]);
  });
});

describe("粘贴读到了什么", () => {
  it("能读出内容的图片算图片；读不到内容的算不透明文件", () => {
    const r = splitPastedFiles([image(), opaque()], isImage);
    expect(r.images).toHaveLength(1);
    expect(r.opaque).toBe(1);
  });

  it("size 为 0 的图片按读不到的文件算", () => {
    const r = splitPastedFiles([image("empty.png", 0)], isImage);
    expect(r.images).toHaveLength(0);
    expect(r.opaque).toBe(1);
  });

  it("剪贴板快照优先于 paste 事件带的内容", () => {
    const snapshot: ClipboardContent = { kind: "images", text: "快照里的文字", images: [image()], reason: null, readFailureCount: 2 };
    const facts = pastedFacts(snapshot, [opaque()], "事件里的文字", isImage);
    expect(facts.text).toBe("快照里的文字");
    expect(facts.images).toBe(1);
    expect(facts.opaqueFiles).toBe(2);
  });

  it("读不到快照时用事件带的内容", () => {
    const facts = pastedFacts(null, [image()], "事件里的文字", isImage);
    expect(facts.text).toBe("事件里的文字");
    expect(facts.images).toBe(1);
    expect(facts.opaqueFiles).toBe(0);
  });
});

describe("粘贴分派", () => {
  const context = { readOnly: false, modal: false, textFocus: false, hasNodeClip: false, at: [0, 0] as [number, number] };

  it("什么都没有：放行", () => {
    expect(decidePaste({ text: null, images: 0, opaqueFiles: 0 }, context).kind).toBe("pass");
  });

  it("只读画板粘图片：拒绝", () => {
    expect(decidePaste({ text: null, images: 1, opaqueFiles: 0 }, { ...context, readOnly: true }).kind).toBe("refuse");
  });

  it("模态开着：放行给弹窗", () => {
    expect(decidePaste({ text: null, images: 1, opaqueFiles: 0 }, { ...context, modal: true }).kind).toBe("pass");
  });

  it("文件读不到内容：拒绝并提示拖入", () => {
    const action = decidePaste({ text: null, images: 0, opaqueFiles: 1 }, context);
    expect(action.kind).toBe("refuse");
    if (action.kind === "refuse") expect(action.reason).toBe("filesNotReadable");
  });
});

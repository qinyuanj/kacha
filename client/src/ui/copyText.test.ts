import { describe, expect, it } from "vitest";
import type { ImageCopyFailure } from "../shell/imageClipboard";
import { COPY_TEXT } from "./copyText";

// 期望文案照抄票面（#115），独立于源码，防止同义反复。
describe("复制图片的失败文案（#115）", () => {
  it("四类失败各有各的提示，都指向同一节点的「另存为…」下载", () => {
    const failures: ImageCopyFailure[] = [
      { kind: "decode" },
      { kind: "rejected" },
      { kind: "noEvent" },
      { kind: "exception", detail: "浏览器炸了" },
    ];
    const reasons = failures.map((f) => COPY_TEXT.imageFailureReason(f));
    // 四类彼此不同：用户要能分辨是解码不了、命令被拒、没看到事件，还是意外错误。
    expect(new Set(reasons).size).toBe(failures.length);
    for (const reason of reasons) {
      expect(reason.length).toBeGreaterThan(0);
      expect(COPY_TEXT.imageFailed(reason)).toContain("另存为");
    }
    // 意外异常带上原因原文。
    expect(COPY_TEXT.imageFailureReason({ kind: "exception", detail: "浏览器炸了" })).toContain("浏览器炸了");
  });

  it("不宣称已读回系统剪贴板", () => {
    for (const failure of [{ kind: "decode" }, { kind: "rejected" }, { kind: "noEvent" }] as ImageCopyFailure[]) {
      expect(COPY_TEXT.imageFailed(COPY_TEXT.imageFailureReason(failure))).not.toContain("已复制到剪贴板");
    }
  });
});

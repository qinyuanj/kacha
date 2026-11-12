import { describe, expect, it } from "vitest";
import type { ImageCopyFailure } from "../shell/imageClipboard";
import { COPY_TEXT } from "./copyText";

// 期望文案手写在这里，不复用被测模块的常量：这是文案定义处的测试，
// 需要一份独立于源码的期望值来锁住「文案一字不改」（CODING_STANDARDS 的例外条款）。
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

  it("四类失败的具体原因照票面手写：解码不了 / 命令被拒 / 没看到事件 / 意外错误", () => {
    expect(COPY_TEXT.imageFailureReason({ kind: "decode" })).toBe("浏览器无法解码这张图片（可能是不支持的格式，如 HEIC）");
    expect(COPY_TEXT.imageFailureReason({ kind: "rejected" })).toBe("浏览器拒绝了复制命令");
    expect(COPY_TEXT.imageFailureReason({ kind: "noEvent" })).toBe("复制命令返回成功，但没有观察到本次原生复制事件");
    expect(COPY_TEXT.imageFailureReason({ kind: "exception", detail: "浏览器炸了" })).toBe("复制图片时出现意外错误：浏览器炸了");
  });

  it("整句照票面手写：失败时指向「另存为…」下载，不宣称已读回系统剪贴板", () => {
    expect(COPY_TEXT.imageFailed("浏览器拒绝了复制命令")).toBe("复制图片失败：浏览器拒绝了复制命令；请改用该图片节点的「另存为…」下载");
  });

  it("不宣称已读回系统剪贴板", () => {
    for (const failure of [{ kind: "decode" }, { kind: "rejected" }, { kind: "noEvent" }] as ImageCopyFailure[]) {
      expect(COPY_TEXT.imageFailed(COPY_TEXT.imageFailureReason(failure))).not.toContain("已复制到剪贴板");
    }
  });
});

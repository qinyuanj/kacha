// 反馈脱敏的跨语言 parity（#227 复审判断题 6）：Go 侧 desktop/internal/redaction 与这里的
// redactFeedbackText 共用 contracts/redaction-samples.json 的同一批样本。两端各写一套实现，
// 替换标记也不同（Go 用 [REDACTED]，这里用 <已隐藏>/<本地路径>），所以比的是
// 「哪些内容必须消失、哪些必须留下」，靠这份夹具保证两边给出同一个答案。
import { describe, expect, it } from "vitest";
import fixture from "../../../contracts/redaction-samples.json" with { type: "json" };
import { redactFeedbackText } from "./FeedbackDialog";

describe("反馈脱敏与 Go 侧一致", () => {
  it("同一批样本里该消失的都消失、该留下的都留下", () => {
    for (const sample of fixture.samples) {
      const redacted = redactFeedbackText(sample.text);
      for (const secret of sample.hidden) {
        expect(redacted, `${sample.name}：${secret}`).not.toContain(secret);
      }
      for (const kept of sample.kept) {
        expect(redacted, `${sample.name}：${kept}`).toContain(kept);
      }
    }
  });

  it("没有秘密的对照样本原样返回，不吞普通文本", () => {
    const clean = fixture.samples.filter((sample) => sample.hidden.length === 0);
    expect(clean.length).toBeGreaterThan(0);
    for (const sample of clean) {
      expect(redactFeedbackText(sample.text), sample.name).toBe(sample.text);
    }
  });
});

import { describe, expect, it } from "vitest";

import { createFakePort } from "./fakePort";
import { FEEDBACK_SPEC, FEEDBACK_SUCCESS, feedbackPortContract } from "./feedbackContract";

feedbackPortContract("内存替身", (outcome) => {
  const port = createFakePort({ feedbackOutcome: outcome });
  return { port, lastSpec: () => port.calls.feedback.at(-1) };
});

describe("缺省内存替身的反馈（#205）", () => {
  it("没有脚本化结局时默认成功，界面流程不必先配一个回执", async () => {
    const port = createFakePort();
    await expect(port.feedback.send(FEEDBACK_SPEC)).resolves.toEqual(FEEDBACK_SUCCESS);
  });
});

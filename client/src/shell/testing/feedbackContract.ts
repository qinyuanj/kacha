import { describe, expect, it } from "vitest";

import type { FeedbackOutcome, FeedbackSpec, ShellPort } from "../port";

export const FEEDBACK_SPEC: FeedbackSpec = {
  title: "画板打开失败",
  category: "bug",
  body: "启动后点不开最近画板",
  version: "1.6.8",
  build: "20261121",
  os: "Windows 11",
  board_name: "角色设定",
  contact: "artist@example.com",
  gitea_token: "user-token-from-spec",
  relay_url: "http://relay.test",
  screenshots: [{ name: "画面.png", content_type: "image/png", data: "iVBORw0KGgo=" }],
  diagnostics_pack: { name: "diagnostics.zip", content_type: "application/zip", data: "UEsDBA==" },
};

export const FEEDBACK_SUCCESS: FeedbackOutcome = {
  ok: true,
  kind: "ok",
  message: "已提交 #17",
  number: 17,
  url: "https://gitea.test/kacha-feedback/issues/17",
};

export const FEEDBACK_FAILURE: FeedbackOutcome = {
  ok: false,
  kind: "unreachable",
  message: "反馈中继不可达，请稍后再试",
  number: undefined,
  url: undefined,
};

export const FEEDBACK_UNAUTHORIZED: FeedbackOutcome = {
  ok: false,
  kind: "unauthorized",
  message: "Gitea token 无效或权限不足",
  number: undefined,
  url: undefined,
};

export interface FeedbackPortHarness {
  port: ShellPort;
  lastSpec(): FeedbackSpec | undefined;
}

/** 真实端口与内存替身共用这一组断言：失败是返回值，不靠异常或 HTTP 状态分支。 */
export function feedbackPortContract(name: string, createHarness: (outcome: FeedbackOutcome) => Promise<FeedbackPortHarness> | FeedbackPortHarness): void {
  describe(`${name} 的 Feedback.send 端口契约（#205）`, () => {
    it("成功与失败都返回 ok/kind/message/number/url 同形结局", async () => {
      for (const outcome of [FEEDBACK_SUCCESS, FEEDBACK_FAILURE, FEEDBACK_UNAUTHORIZED]) {
        const { port } = await createHarness(outcome);
        const got = await port.feedback.send(FEEDBACK_SPEC);
        expect(got).toEqual(outcome);
        expect(typeof got.ok).toBe("boolean");
        expect(typeof got.kind).toBe("string");
        expect(typeof got.message).toBe("string");
      }
    });

    it("send(spec) 把截图与诊断包附件原样交下去", async () => {
      const harness = await createHarness(FEEDBACK_SUCCESS);
      await harness.port.feedback.send(FEEDBACK_SPEC);
      expect(harness.lastSpec()?.screenshots).toEqual(FEEDBACK_SPEC.screenshots);
      expect(harness.lastSpec()?.diagnostics_pack).toEqual(FEEDBACK_SPEC.diagnostics_pack);
    });

    it("send(spec) 把标题、分类、正文、环境、画板名、联系方式与覆盖地址原样交下去", async () => {
      const harness = await createHarness(FEEDBACK_SUCCESS);
      await harness.port.feedback.send(FEEDBACK_SPEC);
      expect(harness.lastSpec()).toEqual(FEEDBACK_SPEC);
    });
  });
}

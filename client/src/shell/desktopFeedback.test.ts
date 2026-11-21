import { describe, expect, it } from "vitest";

import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "./desktop";
import type { FeedbackOutcome, FeedbackSpec } from "./port";
import { FEEDBACK_FAILURE, FEEDBACK_SPEC, FEEDBACK_SUCCESS, feedbackPortContract } from "./testing/feedbackContract";

const INFO: DesktopInfo = {
  version: "1.6.8",
  user_data_root: "C:/data",
  board_root: "C:/data/画板",
  features: { generation: false, usage: false, pack_export: false, archive: true, feedback: true },
};

function bridgeFor(outcome: FeedbackOutcome, hasBridge = true, relayConfigured = true) {
  let seen: FeedbackSpec | undefined;
  const bridge: DesktopBridge = {
    info: async () => ({ ...INFO, features: { ...INFO.features, feedback: relayConfigured } }),
    local: {} as DesktopLocalBridge,
    ...(hasBridge ? { feedback: { send: async (spec: FeedbackSpec) => {
      seen = spec;
      return outcome;
    } } } : {}),
  };
  return { bridge, lastSpec: () => seen };
}

feedbackPortContract("桌面壳", async (outcome) => {
  const { bridge, lastSpec } = bridgeFor(outcome);
  const { port } = await createDesktopPort(bridge);
  return { port, lastSpec };
});

describe("反馈能力开关（#205）", () => {
  it("Go 说没配中继地址时 features.feedback 为 false", async () => {
    const { bridge } = bridgeFor(FEEDBACK_SUCCESS, true, false);
    const { port } = await createDesktopPort(bridge);
    expect(port.features.feedback).toBe(false);
  });

  it("桥上没有 Feedback 服务时调用返回明确的 unavailable 结局", async () => {
    const { bridge } = bridgeFor(FEEDBACK_SUCCESS, false, true);
    const { port } = await createDesktopPort(bridge);
    expect(port.features.feedback).toBe(false);
    await expect(port.feedback.send(FEEDBACK_SPEC)).resolves.toEqual({
      ok: false,
      kind: "unavailable",
      message: "反馈暂不可用：未配置中继地址",
      number: undefined,
      url: undefined,
    });
  });

  it("真实端口不改变 Go 回执的类别与文案", async () => {
    const { bridge } = bridgeFor(FEEDBACK_FAILURE);
    const { port } = await createDesktopPort(bridge);
    await expect(port.feedback.send(FEEDBACK_SPEC)).resolves.toEqual(FEEDBACK_FAILURE);
  });
});

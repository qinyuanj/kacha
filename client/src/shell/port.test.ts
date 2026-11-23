// 壳端口的类型化失败。
import { describe, expect, it } from "vitest";
import { portFailureOf, PortError } from "./port";

describe("端口失败类别", () => {
  it("PortError 带类别、原始错误码与状态；feature 只在 unavailable 时出现", () => {
    const failure = portFailureOf(new PortError({ kind: "conflict", code: "board_conflict", message: "画板已在别处修改", status: 409 }));
    expect(failure).toEqual({ kind: "conflict", code: "board_conflict", message: "画板已在别处修改", status: 409 });
    const missingFeature = portFailureOf(new PortError({ kind: "unavailable", code: "unavailable", message: "桌面版没有用量统计", status: 0, feature: "usage" }));
    expect(missingFeature.kind).toBe("unavailable");
    expect(missingFeature.feature).toBe("usage");
  });

  it("不是 PortError 的异常按 failed 处理，消息原样保留", () => {
    expect(portFailureOf(new Error("磁盘满了"))).toEqual({ kind: "failed", code: "unknown", message: "磁盘满了", status: 0 });
  });
});

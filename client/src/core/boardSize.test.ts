import { describe, expect, it } from "vitest";
import { sizeNotice, sizeTier } from "./boardSize";

// 期望值按票面规则手写：黄线 500、红线 1000（测试用小数），超过才算越线。
const lines = { warn: 500, alert: 1000 };

describe("画板体量档位", () => {
  it("超过黄线标黄、超过红线标红，线上不算越线", () => {
    expect(sizeTier(0, lines)).toBeNull();
    expect(sizeTier(500, lines)).toBeNull();
    expect(sizeTier(501, lines)).toBe("warn");
    expect(sizeTier(1000, lines)).toBe("warn");
    expect(sizeTier(1001, lines)).toBe("alert");
  });

  it("体量未知（画板读不懂）不标", () => {
    expect(sizeTier(null, lines)).toBeNull();
  });
});

describe("当前画板越线提示", () => {
  it("第一次越黄线出现提示", () => {
    expect(sizeNotice("warn", undefined)).toEqual({ show: "warn", notified: undefined });
  });

  it("关闭后（已提醒到黄档）同档不再出现", () => {
    expect(sizeNotice("warn", "warn")).toEqual({ show: null, notified: "warn" });
  });

  it("从黄升到红再提醒一次，红档关闭后不再出现", () => {
    expect(sizeNotice("alert", "warn")).toEqual({ show: "alert", notified: "warn" });
    expect(sizeNotice("alert", "alert")).toEqual({ show: null, notified: "alert" });
  });

  it("直接越过红线只提醒红档一次", () => {
    expect(sizeNotice("alert", undefined)).toEqual({ show: "alert", notified: undefined });
  });

  it("回落到线下后清除，再次越线重新提醒", () => {
    expect(sizeNotice(null, "alert")).toEqual({ show: null, notified: undefined });
    expect(sizeNotice("warn", undefined).show).toBe("warn");
  });

  it("从红回落到黄：红档清除、黄档仍算已提醒，再升红时重新提醒", () => {
    expect(sizeNotice("warn", "alert")).toEqual({ show: null, notified: "warn" });
    expect(sizeNotice("alert", "warn").show).toBe("alert");
  });
});

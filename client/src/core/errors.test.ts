import { describe, expect, it } from "vitest";
import { errorText } from "./errors";

describe("错误文案", () => {
  it("Error 取 message，不带类型名", () => {
    expect(errorText(new TypeError("读不到文件"))).toBe("读不到文件");
  });

  it("抛出的非 Error 值转成字符串", () => {
    expect(errorText("已取消")).toBe("已取消");
    expect(errorText(42)).toBe("42");
  });
});

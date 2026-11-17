import { createContext, createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { useRequiredContext } from "./requiredContext";

const Context = createContext<string | null>(null);
function Probe() { return createElement("span", null, useRequiredContext(Context, "缺少所需上下文")); }

it("未注入必需上下文时明确报告调用方的原因", () => {
  expect(() => renderToString(createElement(Probe))).toThrow("缺少所需上下文");
});
it("已注入的值直接提供给消费者，空字符串也是有效值", () => {
  expect(renderToString(createElement(Context.Provider, { value: "已注入" }, createElement(Probe)))).toContain("已注入");
  expect(renderToString(createElement(Context.Provider, { value: "" }, createElement(Probe)))).toBe("<span></span>");
});

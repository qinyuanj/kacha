import { describe, expect, it } from "vitest";

import { servedFileUrl } from "./desktopStores";

// 本机图片地址（#132 真机验收发现）：WebView2 的页面来自 http://mygo.localhost，不能加载 file://，
// 用户数据根里的图片必须经 Go 注册的 kacha 协议读取，否则节点一律显示「图片缺失」。
describe("servedFileUrl", () => {
  it("根内文件走 kacha 协议，正斜杠相对路径", () => {
    expect(servedFileUrl("C:\\Users\\x\\data", "C:\\Users\\x\\data\\2026-11-15\\t1\\result.png")).toBe(
      "http://kacha.localhost/2026-11-15/t1/result.png",
    );
  });

  it("中文与空格按段编码", () => {
    expect(servedFileUrl("C:\\data", "C:\\data\\导入 参考图\\a b.png")).toBe(
      "http://kacha.localhost/" + encodeURIComponent("导入 参考图") + "/" + encodeURIComponent("a b.png"),
    );
  });

  it("根比较不区分大小写（Windows）", () => {
    expect(servedFileUrl("C:\\Data", "c:\\data\\x.png")).toBe("http://kacha.localhost/x.png");
  });

  it("根外退回 file:///（画板契约要求路径在根内，仅兜底）", () => {
    expect(servedFileUrl("C:\\data", "D:\\other\\a.png")).toBe("file:///D:/other/a.png");
  });
});

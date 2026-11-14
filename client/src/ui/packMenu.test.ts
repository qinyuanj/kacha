// 下载整板结果（#127）：端口说「尚不可用」时如实说，不报成功，也不冒成未捕获异常。
import { describe, expect, it, vi } from "vitest";

import { PortError, type ShellPort } from "../shell/port";
import { createFakePort } from "../shell/testing/fakePort";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import { downloadBoardResults } from "./packMenu";

describe("下载整板结果", () => {
  it("端口说尚不可用时给「尚不可用」的说法，不说已开始下载", () => {
    const port = createFakePort();
    port.media.downloadBoardResults = vi.fn(() => {
      throw new PortError({ kind: "unavailable", code: "unavailable", message: "桌面客户端：结果下载" + UNAVAILABLE_TEXT, status: 0, feature: "downloadResults" });
    });
    const toast = vi.fn();
    downloadBoardResults(port as ShellPort, "/~/画板/a.ugcboard.json", toast);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain(UNAVAILABLE_TEXT);
    expect(toast.mock.calls[0][0]).not.toContain("已开始下载");
  });

  it("端口异步拒绝时同样给「尚不可用」的说法", async () => {
    const port = createFakePort();
    port.media.downloadBoardResults = vi.fn(() =>
      Promise.reject(new PortError({ kind: "unavailable", code: "unavailable", message: "桌面客户端：结果下载" + UNAVAILABLE_TEXT, status: 0, feature: "downloadResults" })),
    ) as unknown as ShellPort["media"]["downloadBoardResults"];
    const toast = vi.fn();
    downloadBoardResults(port as ShellPort, "/~/画板/a.ugcboard.json", toast);
    await Promise.resolve();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain(UNAVAILABLE_TEXT);
    expect(toast.mock.calls[0][0]).not.toContain("已开始下载");
  });

  it("端口正常时照旧说已开始下载", () => {
    const port = createFakePort();
    const toast = vi.fn();
    downloadBoardResults(port as ShellPort, "/~/画板/a.ugcboard.json", toast);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain("已开始下载");
  });

  it("其它失败按失败说，不冒充「尚不可用」", () => {
    const port = createFakePort();
    port.media.downloadBoardResults = vi.fn(() => {
      throw new Error("网络断了");
    });
    const toast = vi.fn();
    downloadBoardResults(port as ShellPort, "/~/画板/a.ugcboard.json", toast);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain("网络断了");
    expect(toast.mock.calls[0][0]).not.toContain(UNAVAILABLE_TEXT);
  });
});

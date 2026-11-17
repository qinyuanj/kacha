// 壳端口的类型化失败与测试替身契约。
import { describe, expect, it } from "vitest";
import { createFakePort, fakeFailure } from "./testing/fakePort";
import { portFailureOf, PortError } from "./port";


describe("端口失败类别", () => {
  it("PortError 带类别、原始错误码与状态；feature 只在 unavailable 时出现", () => {
    const failure = portFailureOf(new PortError({ kind: "conflict", code: "board_conflict", message: "画板已在别处修改", status: 409 }));
    expect(failure).toEqual({ kind: "conflict", code: "board_conflict", message: "画板已在别处修改", status: 409 });
    const missingFeature = portFailureOf(fakeFailure("unavailable", "桌面版没有用量统计", "usage"));
    expect(missingFeature.kind).toBe("unavailable");
    expect(missingFeature.feature).toBe("usage");
  });

  it("不是 PortError 的异常按 failed 处理，消息原样保留", () => {
    expect(portFailureOf(new Error("磁盘满了"))).toEqual({ kind: "failed", code: "unknown", message: "磁盘满了", status: 0 });
  });


});

describe("替身端口与真实实现同形", () => {
  it("失败都是 PortError，界面按 kind 分支的分支点走得到", async () => {
    const port = createFakePort({ writeFailures: new Map([["/~/画板/a.ugcboard.json", "conflict"]]) });
    await expect(port.board.write("/~/画板/a.ugcboard.json", "{}")).rejects.toBeInstanceOf(PortError);
    const failure = await port.board.write("/~/画板/a.ugcboard.json", "{}").then(() => null, (e: unknown) => portFailureOf(e));
    expect(failure?.kind).toBe("conflict");
  });

  it("createOnly 写已有画板 = alreadyExists；带过期版本 = conflict", async () => {
    const port = createFakePort({ boards: [{ path: "/~/画板/a.ugcboard.json", main: "{}", version: "v1" }] });
    expect(await port.board.write("/~/画板/a.ugcboard.json", "{}", { createOnly: true }).catch((e: unknown) => portFailureOf(e).kind)).toBe("alreadyExists");
    expect(await port.board.write("/~/画板/a.ugcboard.json", "{}", { version: "stale" }).catch((e: unknown) => portFailureOf(e).kind)).toBe("conflict");
    await expect(port.board.write("/~/画板/a.ugcboard.json", "{}", { version: "v1" })).resolves.toBeUndefined();
  });
});

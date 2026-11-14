// 壳端口（#126）：Web 实现把 HTTP 错误折成类型化失败，界面只按类别分支；桌面壳只要实现同一组接口就能换掉实现。
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiError";
import { createFakePort, fakeFailure } from "./testing/fakePort";
import { portFailureOf, PortError, type PortFailure } from "./port";

afterEach(() => vi.unstubAllGlobals());

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

  it("Web 实现把 HTTP 状态与错误码折成同一套类别：界面不再看状态码", async () => {
    const { webPort } = await import("./webPort");
    const respond = (status: number, body: unknown) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    const kindOf = async (status: number, body: unknown) => {
      respond(status, body);
      const failure = await webPort.board.write("/~/画板/a.ugcboard.json", "{}", { version: "v1" }).then(() => null, (e: unknown) => portFailureOf(e));
      return failure?.kind;
    };
    expect(await kindOf(409, { code: "board_conflict", message: "画板已在别处修改" })).toBe("conflict");
    expect(await kindOf(409, { code: "board_missing", message: "画板已不存在" })).toBe("missing");
    expect(await kindOf(409, { code: "already_exists", message: "目标已存在" })).toBe("alreadyExists");
    expect(await kindOf(409, { code: "board_slots_full", message: "画板位已满" })).toBe("slotsFull");
    expect(await kindOf(409, { code: "board_archived", message: "已归档" })).toBe("archived");
    expect(await kindOf(403, { code: "forbidden", message: "无权" })).toBe("forbidden");
    expect(await kindOf(507, { code: "insufficient_storage", message: "空间不足" })).toBe("storageFull");
    expect(await kindOf(422, { code: "invalid_pack", message: "包损坏" })).toBe("invalid");
    expect(await kindOf(418, { code: "teapot", message: "别的失败" })).toBe("failed");
    // 断网（status 0）仍是 network，不是原生 TypeError。
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const offline: PortFailure | null = await webPort.board.list().then(() => null, (e: unknown) => portFailureOf(e));
    expect(offline).toMatchObject({ kind: "network", status: 0 });
    expect(offline).not.toBeInstanceOf(ApiError);
  });
});

describe("替身端口与真实实现同形", () => {
  it("失败都是 PortError，界面按 kind 分支的分支点走得到", async () => {
    const port = createFakePort({ writeFailures: new Map([["/~/画板/a.ugcboard.json", "conflict"]]) });
    await expect(port.board.write("/~/画板/a.ugcboard.json", "{}")).rejects.toBeInstanceOf(PortError);
    const failure = await port.board.write("/~/画板/a.ugcboard.json", "{}").then(() => null, (e: unknown) => portFailureOf(e));
    expect(failure?.kind).toBe("conflict");
  });

  it("createOnly 写已有画板 = alreadyExists；带过期版本 = conflict（与 Web 的服务端判定一致）", async () => {
    const port = createFakePort({ boards: [{ path: "/~/画板/a.ugcboard.json", main: "{}", version: "v1" }] });
    expect(await port.board.write("/~/画板/a.ugcboard.json", "{}", { createOnly: true }).catch((e: unknown) => portFailureOf(e).kind)).toBe("alreadyExists");
    expect(await port.board.write("/~/画板/a.ugcboard.json", "{}", { version: "stale" }).catch((e: unknown) => portFailureOf(e).kind)).toBe("conflict");
    await expect(port.board.write("/~/画板/a.ugcboard.json", "{}", { version: "v1" })).resolves.toBeUndefined();
  });
});

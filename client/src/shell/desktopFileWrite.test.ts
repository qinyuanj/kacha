import { describe, expect, it } from "vitest";
import { base64Of } from "../core/base64";
import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "./desktop";

const INFO: DesktopInfo = {
  version: "test",
  user_data_root: "C:/data",
  board_root: "C:/data/画板",
  features: { generation: true, usage: false, pack_export: false },
};

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 64]);

function bridge(behaviour: "ok" | "alreadyExists" = "ok") {
  const calls: { method: string; path: string; data: unknown }[] = [];
  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_t, prop: string) => (...args: unknown[]) => {
      calls.push({ method: prop, path: String(args[0]), data: args[1] });
      if (prop === "readFile") return Promise.resolve(base64Of(PNG));
      if (prop === "writeNewFileBase64")
        return Promise.resolve(behaviour === "ok"
          ? { ok: true, kind: "", message: "", version: "" }
          : { ok: false, kind: "alreadyExists", message: "目标已存在，只新建不覆盖", version: "" });
      return Promise.reject(new Error("Unexpected local." + prop));
    },
  });
  return { bridge: { info: async () => INFO, local } satisfies DesktopBridge, calls };
}

describe("通用文件写入的跨绑定字节传输（#153）", () => {
  it("writeNewFile 走 WriteNewFileBase64，读回字节与原始 Uint8Array 一致", async () => {
    const { bridge: b, calls } = bridge();
    const { port } = await createDesktopPort(b);
    await port.core.taskFs.writeNewFile("C:/data/task/result.png", PNG);
    expect(calls).toEqual([{ method: "writeNewFileBase64", path: "C:/data/task/result.png", data: base64Of(PNG) }]);
    expect(await port.files.readFile("C:/data/task/result.png")).toEqual(PNG);
  });

  it("只写一次的失败从 base64 绑定原样折成 alreadyExists", async () => {
    const { bridge: b } = bridge("alreadyExists");
    const { port } = await createDesktopPort(b);
    await expect(port.core.runDeps.writeNewFile("C:/data/task/task.json", PNG)).rejects.toMatchObject({ kind: "alreadyExists" });
  });
});

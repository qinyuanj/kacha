// 桌面壳端口的画板方法（#128）：对着绑定好的本地服务实现，失败要带类别与原因。
import { describe, expect, it } from "vitest";

import { isArchivedPath } from "../core/archive";
import { boardsDir, joinPath } from "../core/paths";
import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge, type DesktopOutcome } from "./desktop";
import { portFailureOf } from "./port";

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/Users/me/AppData/Roaming/Kacha/data",
  board_root: "C:/Users/me/AppData/Roaming/Kacha/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

interface BridgeStub {
  bridge: DesktopBridge;
  calls: { rename: { from: string; to: string; version?: string }[]; remove: { path: string; version?: string }[]; write: { path: string; text: string; options?: { version?: string; create_only?: boolean } }[] };
}

/** 假桥：只记下画板方法的调用，结局由脚本给出。 */
function stubBridge(outcomes: { rename?: DesktopOutcome; remove?: DesktopOutcome; write?: DesktopOutcome } = {}): BridgeStub {
  const calls: BridgeStub["calls"] = { rename: [], remove: [], write: [] };
  const local: DesktopLocalBridge = {
    readBoard: async () => ({ main: "{}", bak: null, version: "v1" }),
    writeBoard: async (path, text, options) => {
      calls.write.push({ path, text, options });
      return outcomes.write ?? { ok: true, kind: "", message: "", version: "v2" };
    },
    listBoardNames: async () => ["本地.ugcboard.json"],
    listBoards: async () => ({ boards: [{ name: "本地.ugcboard.json", path: "画板/本地.ugcboard.json", archived: false, bytes: null }], slots: { used: 1, total: 20 }, size_lines: { warn: 1, alert: 2 } }),
    renameBoard: async (from, to, version) => {
      calls.rename.push({ from, to, version });
      return outcomes.rename ?? { ok: true, kind: "", message: "", version: "" };
    },
    deleteBoard: async (path, version) => {
      calls.remove.push({ path, version });
      return outcomes.remove ?? { ok: true, kind: "", message: "", version: "" };
    },
    readFile: async () => "",
    writeNewFile: async () => ({ ok: true, kind: "", message: "", version: "" }),
    writeNewFileBase64: async () => ({ ok: true, kind: "", message: "", version: "" }),
    saveCopyAs: async () => ({ ok: true, kind: "", message: "", version: "" }),
    saveResult: async () => ({ ok: true, kind: "", message: "", version: "" }),
    saveBoardResults: async () => ({ ok: true, kind: "", message: "", version: "" }),
    isFile: async () => true,
    listDir: async () => [],
    fileSha256: async () => "a".repeat(64),
    inspectImage: async () => ({ sha256: "a".repeat(64), bytes: 1, width: 1, height: 1, format: "png", has_alpha: false }),
    readSettings: async () => "",
    writeSettings: async () => ({ ok: true, kind: "", message: "", version: "" }),
    readUiState: async () => "",
    writeUiState: async () => ({ ok: true, kind: "", message: "", version: "" }),
    readModelsCache: async () => "",
    writeModelsCache: async () => ({ ok: true, kind: "", message: "", version: "" }),
    readCapabilityOverride: async () => "",
    boardsDir: async () => INFO.board_root,
    userDataRoot: async () => INFO.user_data_root,
  };
  return { bridge: { info: async () => INFO, local }, calls };
}

describe("桌面壳的画板方法", () => {
  it("保存把内容版本与只新建一起交给本地服务", async () => {
    const stub = stubBridge();
    const { port } = await createDesktopPort(stub.bridge);

    await port.board.write("C:/data/画板/本地.ugcboard.json", "{}", { version: "v1" });
    await port.board.write("C:/data/画板/新.ugcboard.json", "{}", { createOnly: true });

    expect(stub.calls.write[0].options).toEqual({ version: "v1", create_only: undefined });
    expect(stub.calls.write[1].options).toEqual({ version: undefined, create_only: true });
  });

  it("保存失败：类别与原因原样传给界面", async () => {
    const stub = stubBridge({ write: { ok: false, kind: "failed", message: "Access is denied.", version: "" } });
    const { port } = await createDesktopPort(stub.bridge);

    const failure = await port.board.write("C:/data/画板/本地.ugcboard.json", "{}").then(() => null, (e: unknown) => portFailureOf(e));
    expect(failure?.kind).toBe("failed");
    expect(failure?.message).toContain("Access is denied.");
  });

  it("只新建撞上同名：alreadyExists", async () => {
    const stub = stubBridge({ write: { ok: false, kind: "alreadyExists", message: "目标已存在，只新建不覆盖", version: "" } });
    const { port } = await createDesktopPort(stub.bridge);

    const failure = await port.board.write("C:/data/画板/本地.ugcboard.json", "{}", { createOnly: true }).then(() => null, (e: unknown) => portFailureOf(e));
    expect(failure?.kind).toBe("alreadyExists");
  });

  it("内容版本已变：conflict（界面据此提示重新载入）", async () => {
    const stub = stubBridge({ write: { ok: false, kind: "conflict", message: "画板已在别处修改", version: "" } });
    const { port } = await createDesktopPort(stub.bridge);

    const failure = await port.board.write("C:/data/画板/本地.ugcboard.json", "{}", { version: "v1" }).then(() => null, (e: unknown) => portFailureOf(e));
    expect(failure?.kind).toBe("conflict");
  });

  it("改名与删除把内容版本带过去（内容已变就不动）", async () => {
    const stub = stubBridge();
    const { port } = await createDesktopPort(stub.bridge);

    await port.board.rename("C:/data/画板/旧.ugcboard.json", "C:/data/画板/新.ugcboard.json", "v1");
    await port.board.remove("C:/data/画板/新.ugcboard.json", "v1");

    expect(stub.calls.rename[0]).toEqual({ from: "C:/data/画板/旧.ugcboard.json", to: "C:/data/画板/新.ugcboard.json", version: "v1" });
    expect(stub.calls.remove[0]).toEqual({ path: "C:/data/画板/新.ugcboard.json", version: "v1" });
  });

  it("删除失败：类别与原因原样传给界面", async () => {
    const stub = stubBridge({ remove: { ok: false, kind: "conflict", message: "画板已在别处修改", version: "" } });
    const { port } = await createDesktopPort(stub.bridge);

    const failure = await port.board.remove("C:/data/画板/本地.ugcboard.json", "v1").then(() => null, (e: unknown) => portFailureOf(e));
    expect(failure?.kind).toBe("conflict");
  });

  it("列出画板：名字带扩展名，路径是数据根下的绝对路径", async () => {
    const stub = stubBridge();
    const { port } = await createDesktopPort(stub.bridge);

    const listing = await port.board.list();
    expect(listing.boards[0].name).toBe("本地.ugcboard.json");
    expect(listing.boards[0].path).toBe(joinPath(INFO.user_data_root, "画板/本地.ugcboard.json"));
    expect(listing.slots.used).toBe(1);
  });

  it("列出画板文件名：带扩展名，界面据此派生不重名的文件名", async () => {
    const stub = stubBridge();
    const { port } = await createDesktopPort(stub.bridge);

    await expect(port.board.listNames("C:/data/画板")).resolves.toEqual(["本地.ugcboard.json"]);
  });

  it("画板列表的路径是数据根下的绝对路径（与界面别处同一形状）", async () => {
    const stub = stubBridge();
    const { port } = await createDesktopPort(stub.bridge);

    const listing = await port.board.list();
    expect(listing.boards[0].path).toBe(joinPath(INFO.user_data_root, "画板/本地.ugcboard.json"));
    // 与界面自己拼的画板目录同一形状：列表里的路径能直接当作会话路径用。
    expect(listing.boards[0].path.startsWith(boardsDir(INFO.user_data_root))).toBe(true);
  });

  it("列表 → 打开 → 带版本保存 → 带版本删除：路径形状一路一致", async () => {
    const stub = stubBridge();
    const { port } = await createDesktopPort(stub.bridge);

    const listing = await port.board.list();
    const path = listing.boards[0].path;

    // 按列表给的路径打开。
    const texts = await port.board.read(path);
    expect(texts.version).toBe("v1");

    // 带版本保存：交给本地服务的就是同一个路径。
    await port.board.write(path, "{}", { version: texts.version ?? undefined });
    expect(stub.calls.write[0].path).toBe(path);

    // 带版本删除：同一个路径。
    await port.board.remove(path, texts.version ?? undefined);
    expect(stub.calls.remove[0].path).toBe(path);
    expect(stub.calls.remove[0].version).toBe("v1");
  });

  it("归档画板在列表里的路径仍能认出是归档（不会误判成可编辑）", async () => {
    const stub = stubBridge();
    stub.bridge.local.listBoards = async () => ({
      boards: [{ name: "旧.ugcboard.json", path: "画板/归档/旧.ugcboard.json", archived: true, bytes: null }],
      slots: { used: 0, total: 20 },
      size_lines: { warn: 1, alert: 2 },
    });
    const { port } = await createDesktopPort(stub.bridge);

    const listing = await port.board.list();
    const path = listing.boards[0].path;
    expect(isArchivedPath(port.userRoot, path)).toBe(true);
    // 归档能力本切片没有：不假装成功，界面据此知道归档入口尚不可用。
    await expect(port.board.archive(path, path)).rejects.toMatchObject({ kind: "unavailable", feature: "archive" });
  });
});

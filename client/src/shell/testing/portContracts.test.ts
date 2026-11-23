import { describe, expect, it } from "vitest";
import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "../desktop";
import { sha256Hex } from "../../core/sha256";
import { createFakePort } from "./fakePort";
import { boardStoreContract, fileStoreContract } from "./portContracts";

const INFO: DesktopInfo = {
  version: "test",
  user_data_root: "C:/data",
  board_root: "C:/data/画板",
  features: { generation: true, usage: false, pack_export: false },
};

const BOARD_PATH = "C:/data/画板/共享.ugcboard.json";
const FILE_PATH = "C:/data/画板/任务/result.png";
const FILE_DIR = "C:/data/画板/任务";
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** 画板版本就是内容字节的 sha256：与 Go 壳一致（localstore.go:358 返回 hashOf([]byte(text))）。 */
const digestOf = (text: string): Promise<string> => sha256Hex(new TextEncoder().encode(text));

/** 真端口背后的本机桥：用内存状态模拟 Local.*，不碰真磁盘。 */
function desktopHarness() {
  const boards = new Map<string, string>([[BOARD_PATH, "原内容"]]);
  const files = new Map<string, string>();
  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_target, prop: string) => (...args: unknown[]) => {
      if (prop === "readBoard") {
        const text = boards.get(String(args[0]));
        return text === undefined ? Promise.resolve({ main: null, bak: null, version: null }) : digestOf(text).then((version) => ({ main: text, bak: null, version }));
      }
      if (prop === "writeBoard") {
        const [path, text, options] = args as [string, string, { create_only?: boolean; version?: string } | undefined];
        const found = boards.get(path);
        if (options?.create_only && found !== undefined) return Promise.resolve({ ok: false, kind: "alreadyExists", message: "目标已存在", version: "" });
        // 带版本：主文件不在就说画板没了；内容摘要变了就是冲突——与 Go 壳同判据。
        if (options?.version) {
          if (found === undefined) return Promise.resolve({ ok: false, kind: "missing", message: "画板不存在", version: "" });
          return digestOf(found).then((current) =>
            current === options.version
              ? digestOf(text).then((version) => {
                  boards.set(path, text);
                  return { ok: true, kind: "", message: "", version };
                })
              : { ok: false, kind: "conflict", message: "版本不符", version: "" },
          );
        }
        return digestOf(text).then((version) => {
          boards.set(path, text);
          return { ok: true, kind: "", message: "", version };
        });
      }
      if (prop === "writeNewFileBase64") {
        files.set(String(args[0]), String(args[1]));
        return Promise.resolve({ ok: true, kind: "", message: "", version: "" });
      }
      if (prop === "readFile") return Promise.resolve(files.get(String(args[0])) ?? "");
      if (prop === "isFile") return Promise.resolve(files.has(String(args[0])));
      if (prop === "listDir") {
        const prefix = String(args[0]).replace(/\\/g, "/").replace(/\/+$/, "") + "/";
        return Promise.resolve([...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ name: p.slice(prefix.length), is_dir: false })));
      }
      return Promise.reject(new Error("未实现的本地调用：" + prop));
    },
  });
  const bridge: DesktopBridge = { info: async () => INFO, local };
  return createDesktopPort(bridge).then(({ port }) => ({ port, boardPath: BOARD_PATH, filePath: FILE_PATH, fileDir: FILE_DIR, bytes: BYTES }));
}

boardStoreContract("桌面壳", desktopHarness);
boardStoreContract("内存替身", () => ({
  port: createFakePort({ boards: [{ path: BOARD_PATH, main: "原内容", version: "v1" }] }),
  boardPath: BOARD_PATH,
}));
fileStoreContract("桌面壳", desktopHarness);
fileStoreContract("内存替身", () => ({ port: createFakePort(), filePath: FILE_PATH, fileDir: FILE_DIR, bytes: BYTES }));

describe("共享契约的独立失败证明", () => {
  it("桌面壳与替身对同一类冲突都给出类别化结局", async () => {
    const real = await desktopHarness();
    const fake = createFakePort({ boards: [{ path: BOARD_PATH, main: "原内容", version: "v1" }] });
    for (const port of [real.port, fake]) {
      const error = await port.board.write(BOARD_PATH, "新内容", { createOnly: true }).then(() => null, (e: unknown) => e);
      expect(error).toMatchObject({ kind: "alreadyExists" });
    }
  });
});

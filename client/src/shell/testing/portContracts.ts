import { describe, expect, it } from "vitest";
import type { ShellPort } from "../port";

export interface BoardStoreHarness {
  port: ShellPort;
  /** 预置的画板路径；正文固定为「原内容」。 */
  boardPath: string;
}

/** 真实桌面端口与内存替身共用：写盘冲突是返回值，不是空成功。 */
export function boardStoreContract(name: string, createHarness: () => Promise<BoardStoreHarness> | BoardStoreHarness): void {
  describe(`${name} 的 BoardStore 共享契约`, () => {
    it("只新建：目标已存在就拒绝，原内容不被覆盖", async () => {
      const { port, boardPath } = await createHarness();
      await expect(port.board.write(boardPath, "新内容", { createOnly: true })).rejects.toMatchObject({ kind: "alreadyExists" });
      expect((await port.board.read(boardPath)).main).toBe("原内容");
    });

    it("版本不符报 conflict，不覆盖", async () => {
      const { port, boardPath } = await createHarness();
      await expect(port.board.write(boardPath, "新内容", { version: "stale" })).rejects.toMatchObject({ kind: "conflict" });
      expect((await port.board.read(boardPath)).main).toBe("原内容");
    });

    // 带版本写时主文件不在：真实壳报 missing、不凭空建出画板（localstore.go:343），替身必须同判据。
    it("带版本写一个不存在的画板：报 missing，不凭空建出来", async () => {
      const { port, boardPath } = await createHarness();
      const absent = boardPath + ".absent";
      await expect(port.board.write(absent, "内容", { version: "任意" })).rejects.toMatchObject({ kind: "missing" });
      expect((await port.board.read(absent)).main).toBeNull();
    });

    // 版本号就是内容字节的 sha256（desktop/internal/localstore/localstore.go:358 返回
    // hashOf([]byte(text))，ReadBoard 也按文件字节算）。客户端保存后按同一摘要回写版本，
    // 所以两侧都必须让「第一次写入读回的版本」能直接用作「第二次写入」的版本（#225）。
    //
    // 期望值是**字面摘要**，由独立工具算出（sha256sum 与 Python hashlib 一致），不经被测的
    // sha256Hex：两侧若用同一函数重算期望值，大写、带前缀这类形状缺陷会被一起放过。
    const FIRST_TEXT = '{"format_version":2,"nodes":[]}';
    const FIRST_DIGEST = "7a84bb239f6af54e1990a3618e87c7a3ece9b9f59564c6c8adbaf6dc2e83ba6a";
    it("连续两次写入同一画板不判冲突：读回的版本就是内容字节的摘要", async () => {
      const { port, boardPath } = await createHarness();
      await port.board.write(boardPath, FIRST_TEXT);
      expect((await port.board.read(boardPath)).version).toBe(FIRST_DIGEST);
      await port.board.write(boardPath, "第二次写入", { version: FIRST_DIGEST });
      expect((await port.board.read(boardPath)).main).toBe("第二次写入");
    });
  });
}

export interface FileStoreHarness {
  port: ShellPort;
  /** 可新建的文件路径、父目录与期望字节；harness 负责两侧同样为空。 */
  filePath: string;
  fileDir: string;
  bytes: Uint8Array;
}

/** 真实桌面端口与内存替身共用：写、读、isFile、listDir 指向同一份文件事实。 */
export function fileStoreContract(name: string, createHarness: () => Promise<FileStoreHarness> | FileStoreHarness): void {
  describe(`${name} 的 FileStore 共享契约`, () => {
    it("写新文件后读回字节，isFile 与 listDir 认得它", async () => {
      const { port, filePath, fileDir, bytes } = await createHarness();
      await port.files.writeNewFile(filePath, bytes);
      expect(await port.files.readFile(filePath)).toEqual(bytes);
      expect(await port.files.isFile(filePath)).toBe(true);
      expect((await port.files.listDir(fileDir)).map((e) => e.name)).toContain(filePath.split("/").at(-1));
    });
  });
}

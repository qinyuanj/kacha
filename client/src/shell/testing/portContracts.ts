import { describe, expect, it } from "vitest";
import type { ShellPort } from "../port";

export interface BoardStoreHarness {
  port: ShellPort;
  /** 预置的画板路径；正文固定为「原内容」，版本由 harness 提供。 */
  boardPath: string;
  version: string;
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

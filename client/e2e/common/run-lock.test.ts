import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRunLock } from "./run-lock";

const lockIn = () => path.join(mkdtempSync(path.join(tmpdir(), "kacha-run-lock-")), "e2e.lock");
const alive = () => true;
const dead = () => false;

describe("acquireRunLock", () => {
  it("另一个存活的进程持锁时拒绝，报出持锁 pid 与锁文件", () => {
    const lock = lockIn();
    writeFileSync(lock, "4242");
    expect(() => acquireRunLock(lock, { pid: 7, isAlive: alive })).toThrow(/4242[\s\S]*e2e\.lock/);
    expect(readFileSync(lock, "utf8")).toBe("4242");
  });

  it("释放后下一次运行能拿到锁", () => {
    const lock = lockIn();
    const release = acquireRunLock(lock, { pid: 7, isAlive: alive });
    expect(() => acquireRunLock(lock, { pid: 8, isAlive: alive })).toThrow();
    release();
    expect(() => acquireRunLock(lock, { pid: 8, isAlive: alive })).not.toThrow();
    expect(readFileSync(lock, "utf8")).toBe("8");
  });

  it("持锁进程已死（上次运行被强杀）时接管锁", () => {
    const lock = lockIn();
    writeFileSync(lock, "4242");
    expect(() => acquireRunLock(lock, { pid: 7, isAlive: dead })).not.toThrow();
    expect(readFileSync(lock, "utf8")).toBe("7");
  });

  it("持锁的就是本进程时直接放行（配置在同一进程里被再次加载）", () => {
    const lock = lockIn();
    acquireRunLock(lock, { pid: 7, isAlive: alive });
    expect(() => acquireRunLock(lock, { pid: 7, isAlive: alive })).not.toThrow();
  });
});

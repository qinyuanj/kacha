// 同一份 client 目录下同时只允许一次 Playwright 运行。
// 每次运行开头的 clear output 会整个删掉 test-results，并发的第二次运行会把第一次正在写的
// trace 与附件一起删掉（browserContext.close: ENOENT …/.playwright-artifacts-N/…）；
// global-setup 的 vite build 也会清空另一运行正在提供的 dist。
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export interface LockHolder {
  pid: number;
  isAlive(pid: number): boolean;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 拿到锁返回释放函数；锁被另一个存活进程持有时抛错，持有者已死（被强杀）时接管。 */
export function acquireRunLock(lockPath: string, me: LockHolder = { pid: process.pid, isAlive: pidAlive }): () => void {
  const release = () => {
    if (readHolder(lockPath) === me.pid) unlinkSync(lockPath);
  };
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(me.pid));
      closeSync(fd);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = readHolder(lockPath);
    if (holder === me.pid) return release;
    if (holder !== undefined && !me.isAlive(holder)) {
      unlinkSync(lockPath);
      continue;
    }
    throw new Error(
      `另一次 e2e 运行（pid ${holder ?? "未知"}）正在使用这份 client 目录，并发运行会互相删掉 test-results。` +
        `等它结束再跑；确认没有运行在跑时删掉锁文件 ${lockPath}`,
    );
  }
}

function readHolder(lockPath: string): number | undefined {
  try {
    const pid = Number(readFileSync(lockPath, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

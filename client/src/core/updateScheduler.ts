// 更新排程（#164）：启动约 3 秒后检查一次，之后每次检查结束 15 分钟再检查。
//
// 计时器与时钟从外面注入，测试不用等真实时间；手动检查由调用方直接触发。
import { canCheck, nextCheckDelay, type UpdateSnapshot } from "./update";

export interface UpdateSchedulerPorts {
  /** 读当前快照（排程按 checked_at 决定下一次）。 */
  snapshot(): UpdateSnapshot;
  /** 发起一次检查。 */
  check(): void;
  /** 排一个计时器，返回取消函数。 */
  schedule(ms: number, run: () => void): () => void;
  /** 当前时间（毫秒）。 */
  now(): number;
}

export interface UpdateScheduler {
  /** 装上排程：立刻按快照排下一次；返回卸载函数。 */
  start(): () => void;
  /** 快照变了之后重排（检查结束、装完了）。 */
  reschedule(): void;
}

export function createUpdateScheduler(ports: UpdateSchedulerPorts): UpdateScheduler {
  let cancel: (() => void) | null = null;
  let stopped = false;
  // 启动后那一次还没到点：首次调度一律等 STARTUP_DELAY_MS（#164 判据：启动约 3 秒后检查）。
  let startup = true;

  function clear(): void {
    cancel?.();
    cancel = null;
  }

  function reschedule(): void {
    if (stopped) return;
    clear();
    const delay = nextCheckDelay(ports.snapshot(), ports.now(), startup);
    if (delay === null) return;
    cancel = ports.schedule(delay, () => {
      cancel = null;
      // 启动那次到点了（不管这次能不能查）：此后按两次检查之间的间隔算。
      startup = false;
      // 到点了再判一次：期间可能已经在检查或已经装上了。
      if (!canCheck(ports.snapshot())) return;
      ports.check();
      // 检查是异步的：这里不排下一次，等检查结束（reschedule）再排。
    });
  }

  return {
    start() {
      stopped = false;
      reschedule();
      return () => {
        stopped = true;
        clear();
      };
    },
    reschedule,
  };
}

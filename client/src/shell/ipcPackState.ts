// 画板包操作的浏览器端状态（#137）：当前操作 id、取消标记、在途请求数与中止信号。
// 取消与进度按操作 id 隔离（一个用户的取消不影响其他用户 / 其他页面）。
// 从 ipc.ts 拆出的纯逻辑，便于单测操作 id 的分配、取消标记、在途计数与中止信号。
export const PACK_CANCELLED = "已取消";

/** 新操作 id：时间戳 + 随机尾巴。 */
export const newOpId = (): string => `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 画板包操作的状态机。 */
export interface PackOpState {
  /** 当前操作 id；还没有为 null。 */
  currentOp(): string | null;
  /** 记下新的一次操作（上一个操作的中止信号不再有人用）。 */
  begin(): string;
  /** 取消当前操作：记下取消标记并中止它的在途请求；没有当前操作时为 null。 */
  cancel(): string | null;
  /** 这个操作是否已被取消。 */
  isCancelled(op: string): boolean;
  /** 这个操作还有在途请求吗。 */
  busy(op: string): boolean;
  /** 在途请求 +1 / -1。 */
  enter(op: string): void;
  leave(op: string): void;
  /** 这个操作的中止信号（还没有就建一个）。 */
  signal(op: string): AbortSignal;
  /** 记下这个操作的本地进度（Worker 里 hash）。 */
  setLocalProgress(op: string, progress: { done: number; total: number } | undefined): void;
  /** 这个操作的本地进度；没有为 undefined。 */
  localProgress(op: string): { done: number; total: number } | undefined;
}

export function createPackOpState(): PackOpState {
  let current: string | null = null;
  const cancelled = new Set<string>();
  const inFlight = new Map<string, number>();
  const aborts = new Map<string, AbortController>();
  const local = new Map<string, { done: number; total: number }>();

  const signalOf = (op: string): AbortSignal => {
    let abort = aborts.get(op);
    if (!abort) aborts.set(op, (abort = new AbortController()));
    return abort.signal;
  };

  return {
    currentOp: () => current,
    begin: () => {
      // 上一个操作的中止信号不再有人用。
      if (current) aborts.delete(current);
      current = newOpId();
      signalOf(current);
      return current;
    },
    cancel: () => {
      if (!current) return null;
      cancelled.add(current);
      aborts.get(current)?.abort(new Error(PACK_CANCELLED));
      return current;
    },
    isCancelled: (op) => cancelled.has(op),
    busy: (op) => inFlight.has(op),
    enter: (op) => inFlight.set(op, (inFlight.get(op) ?? 0) + 1),
    leave: (op) => {
      const left = (inFlight.get(op) ?? 1) - 1;
      if (left > 0) inFlight.set(op, left);
      else inFlight.delete(op);
    },
    signal: signalOf,
    setLocalProgress: (op, progress) => {
      if (progress) local.set(op, progress);
      else local.delete(op);
    },
    localProgress: (op) => local.get(op),
  };
}

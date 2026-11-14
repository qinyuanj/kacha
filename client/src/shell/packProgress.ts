// 画板包进度轮询（#137）：服务端按操作 id 报告 done/total；本地阶段（Worker 里 hash）有进度时直接报它，不问服务端。
// 从 ipc.ts 拆出来的纯逻辑：不碰网络与 DOM，便于单测。
export interface PackProgress {
  done: number;
  total: number;
}

/** 进度来源：ipc.ts 提供操作状态与向服务端问进度的办法。 */
export interface PackProgressSource {
  /** 当前操作 id；没有进行中的操作时为 null。 */
  currentOp(): string | null;
  /** 这个操作还有在途请求吗。 */
  busy(op: string): boolean;
  /** 本地阶段（Worker 里 hash）的进度；没有为 undefined。 */
  localProgress(op: string): PackProgress | undefined;
  /** 向服务端问这个操作的进度；读不到（网络抖动、非 2xx）为 null。 */
  fetchProgress(op: string): Promise<PackProgress | null>;
}

/** 一次轮询：本地有进度就报它，没有且操作在途才问服务端。 */
async function pollProgress(source: PackProgressSource, handler: (progress: PackProgress) => void): Promise<void> {
  const op = source.currentOp();
  if (!op) return;
  const local = source.localProgress(op);
  if (local) {
    handler(local);
    return;
  }
  if (!source.busy(op)) return;
  const progress = await source.fetchProgress(op);
  if (progress) handler(progress);
}

/** 开始轮询：先立刻问一次，之后每隔 intervalMs 问一次。返回停下来的办法。 */
export function createPackProgress(source: PackProgressSource, handler: (progress: PackProgress) => void, intervalMs = 200): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await pollProgress(source, handler);
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

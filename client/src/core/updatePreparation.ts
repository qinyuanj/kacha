// 更新安装前的准备与保护（#164）：复用 v0.3.2 updatePreparation 的行为。
//
// 保护要覆盖三件事：拒绝新提交（含已经开始的异步提交）、等在途操作、
// 严格保存全部打开的画板与界面状态。任一失败就解除保护、恢复正常操作。

/** 有未完成任务时的拒绝说法（与旧版一致）。 */
export const BUSY_MESSAGE = "任务结束后可更新";

/** 落盘之后仍有改动没保存成功时的拒绝说法（#180）：自动安装也照这条不装。 */
export const UNSAVED_MESSAGE = "改动保存后再更新";

export type PreparationResult = { ok: true } | { ok: false; reason: string };

/** 生成任务队列：只要有没结束的份就不能装。 */
export interface UpdateQueue {
  /** 还没结束的任务份数（排队、读图、执行、退避都算）。 */
  pending(): number;
  /** 挂上提交守护：期间一切新提交被拒绝并回调；null 解除。 */
  setSubmissionGuard(guard: (() => void) | null): void;
}

/** 在途操作登记：导入、迁移、另存等异步动作，准备时要等它们结束。 */
export interface OperationGate {
  blocked(): boolean;
  track(operation: Promise<unknown>): void;
}

export interface UpdatePreparationPorts {
  queue: UpdateQueue;
  /** 立刻落盘全部打开的画板（含此前保存失败的重试）。 */
  saveBoards(): Promise<void>;
  /** 落盘界面状态（打开的画板、当前画板、设置草稿等）。 */
  saveUi(): Promise<void>;
  /**
   * 落盘之后仍没保存成功的改动（#180）。
   *
   * 自动保存把失败记在会话上、不抛出，所以只看 saveBoards / saveUi 的结局不够；
   * 这里与「空闲判定」用的是同一个来源（updateAutoInstall.idleBlocker）。
   */
  unsavedChanges(): boolean;
  /** 保护开关变化：界面据此禁用入口。 */
  onProtectionChange?(active: boolean): void;
}

export interface UpdatePreparation extends OperationGate {
  /** 准备：并发调用合并成一次；成功时保持保护到安装结束。 */
  prepare(): Promise<PreparationResult>;
  /** 安装前的守卫：准备通过才允许装。 */
  installGuard(): Promise<{ allowed: boolean; reason?: string }>;
  /** 解除保护（准备失败、安装失败或用户放弃时）。 */
  release(): void;
  active(): boolean;
  /** 异步界面操作持有的代次：恢复后旧操作不能再提交变更。 */
  generation(): number;
}

/** 把任意抛出折成一句话。 */
function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 等在途操作结束：期间可能又有新操作进来，所以循环到集合空。 */
async function drain(pending: Set<Promise<unknown>>): Promise<void> {
  let failure: PromiseRejectedResult | undefined;
  while (pending.size > 0) {
    const batch = [...pending];
    const results = await Promise.allSettled(batch);
    failure ??= results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    for (const p of batch) pending.delete(p);
  }
  // 在途操作失败时状态不可信：不保存，直接算准备失败。
  if (failure) throw failure.reason;
}

/** 严格保存：两块都要落盘，任一失败都要说清是哪一块。 */
async function saveAll(ports: UpdatePreparationPorts): Promise<PreparationResult> {
  const [boards, ui] = await Promise.allSettled([
    Promise.resolve().then(ports.saveBoards),
    Promise.resolve().then(ports.saveUi),
  ]);
  if (boards.status === "rejected") return { ok: false, reason: `保存画板失败：${text(boards.reason)}` };
  if (ui.status === "rejected") return { ok: false, reason: `保存界面状态失败：${text(ui.reason)}` };
  // 写盘调用没抛错不代表写成了：自动保存会把失败记在会话上（不抛出），这里再核一次（#180）。
  if (ports.unsavedChanges()) return { ok: false, reason: UNSAVED_MESSAGE };
  return { ok: true };
}

/** 一次准备的完整流程：任务必须结束、在途操作要等、保存要成功。 */
async function runPreparation(ports: UpdatePreparationPorts, pending: Set<Promise<unknown>>): Promise<PreparationResult> {
  try {
    // 已经在读图 / 排队 / 执行 / 退避的任务继续跑：不等它结束、也不取消。
    if (ports.queue.pending() > 0) return { ok: false, reason: BUSY_MESSAGE };
    await drain(pending);
    // 等完之后再查一次：期间可能又有新任务进来了。
    if (ports.queue.pending() > 0) return { ok: false, reason: BUSY_MESSAGE };
    return await saveAll(ports);
  } catch (e) {
    return { ok: false, reason: `更新准备失败：${text(e)}` };
  }
}

export function createUpdatePreparation(ports: UpdatePreparationPorts): UpdatePreparation {
  const pending = new Set<Promise<unknown>>();
  let current: Promise<PreparationResult> | null = null;
  let protectedNow = false;
  let generation = 0;

  function release(): void {
    protectedNow = false;
    current = null;
    ports.queue.setSubmissionGuard(null);
    ports.onProtectionChange?.(false);
  }

  async function run(): Promise<PreparationResult> {
    return runPreparation(ports, pending);
  }

  const preparation: UpdatePreparation = {
    prepare() {
      if (current) return current;
      if (ports.queue.pending() > 0) return Promise.resolve({ ok: false, reason: BUSY_MESSAGE });
      protectedNow = true;
      generation++;
      ports.queue.setSubmissionGuard(() => undefined);
      ports.onProtectionChange?.(true);
      current = run().then((result) => {
        // 失败立刻解除保护：用户要能继续创作，旧版本也照常可用。
        if (!result.ok) release();
        return result;
      });
      return current;
    },
    release,
    async installGuard() {
      const result = await preparation.prepare();
      return result.ok ? { allowed: true } : { allowed: false, reason: result.reason };
    },
    track(operation) {
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
    },
    active: () => protectedNow,
    blocked: () => protectedNow,
    generation: () => generation,
  };
  return preparation;
}

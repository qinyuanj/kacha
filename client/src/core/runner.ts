// 任务运行器（ADR 0015）：提交（读参考图）→ 全局任务队列按并发上限派发（写任务目录 + 提交记录 → 调网关）→ 运行结果。
// 队列跨画板 FIFO；429 自动退避重试，其余错误不重试。任务状态按任务编号记录、按（画板键, 任务节点 id）聚合，只在内存。
// 时钟、文件、网关、画板写入与日志都经端口注入；运行器不直接调 Date.now() / setTimeout。
import type { Board, TaskNode } from "./board";
import type { CapabilityTable } from "./capabilities";
import type { BoardChange } from "./edit";
import { GatewayError, isFlashShape } from "./gateway";
import { CancelledError, executeJob, failureLabel, prepareJob, prepareRegenerate, writeJob, type Prepared, type PreparedJob, type RunDeps, type TaskStatus, type WrittenJob } from "./run";
import { groupCopies, type NodeCopyEntry } from "./nodeCopies";
import { tableDigest, writeOutcome, type TaskOutcome } from "./taskDir";
import { errorText } from "./errors";

/** 第 1、2、3 次 429 后的等待；第 4 次按失败。 */
export const BACKOFF_MS = [30_000, 60_000, 120_000];

/** 提交时随任务固化的目标：排队期间改设置不影响已排队任务。 */
export interface RunTarget {
  boardKey: string;
  /** 画板文件名（日志用）。 */
  boardFile: string | null;
  table: CapabilityTable;
  userRoot: string;
  baseUrl: string;
  apiKey: string;
}

/** 运行器产出的系统变更：提交记录、运行结果。 */
export type RunnerChange = Extract<BoardChange, { kind: "submitted" | "runResult" }>;

/** 进诊断包的日志事件（对外契约，名称与字段不变）。 */
export type RunnerLogKind = "task" | "queue_dispatch" | "rate_limit" | "download";

export interface RunnerPorts {
  deps: RunDeps;
  /** 画板写入（ADR 0014 的 apply）；画板已关闭时由对方忽略。 */
  apply(boardKey: string, change: RunnerChange): void;
  log(kind: RunnerLogKind, fields: Record<string, unknown>): void;
  concurrency: number;
}

/** 运行指示里的一行。 */
export interface ActiveTask {
  taskId: string;
  boardKey: string;
  taskNodeId: string;
  state: "running" | "waiting";
}

/** 任务节点的一份：taskId = 任务编号；读参考图中或读图失败时还没有任务编号，为 null。 */
export interface TaskCopy {
  taskId: string | null;
  status: TaskStatus;
}

/** 各任务状态的份数；没有的状态不出现。 */
export type StatusCounts = Partial<Record<TaskStatus["kind"], number>>;

/** 一个任务节点在本次运行里的各份：明细（含失败原因）与计数摘要。 */
export interface NodeRunState {
  /** 已结束的份（失败 / 已取消）在前，未结束的按提交顺序在后。 */
  copies: readonly TaskCopy[];
  counts: StatusCounts;
  /** 本次提交展开的份数（含已成功、不再出现在 copies 里的份）；摘要与明细按它判断是不是多份。 */
  total: number;
}

/** 只有一份时即该份的状态（显示与以前一致）；多份时取最后一份，节点上显示的是 nodeSummary。 */
export function nodeStatus(node: NodeRunState | undefined): TaskStatus | null {
  return node?.copies.at(-1)?.status ?? null;
}

/** 摘要的排列顺序与名称；限流退避计入排队。 */
const SUMMARY_PARTS: [string, TaskStatus["kind"][]][] = [
  ["执行中", ["running"]],
  ["排队", ["queued", "backoff"]],
  ["失败", ["failed"]],
  ["已取消", ["cancelled"]],
  ["已中断", ["interrupted"]],
];

/** 多份时的计数摘要，如「执行中 2 · 排队 1 · 失败 1」；本次提交只有一份（或没有）时为 null，按单份状态显示。 */
export function nodeSummary(node: NodeRunState | undefined): string | null {
  if (!node || node.total < 2) return null;
  return SUMMARY_PARTS.flatMap(([label, kinds]) => {
    const n = kinds.reduce((sum, k) => sum + (node.counts[k] ?? 0), 0);
    return n ? [`${label} ${n}`] : [];
  }).join(" · ");
}

/** 计数摘要徽标的色调：有失败即失败色，否则有执行中为运行色，其余为排队色；有执行中的份时带转圈。 */
export interface SummaryTone {
  tone: "running" | "failed" | "queued";
  spinning: boolean;
}

export function summaryTone(counts: StatusCounts): SummaryTone {
  const spinning = (counts.running ?? 0) > 0;
  return { tone: counts.failed ? "failed" : spinning ? "running" : "queued", spinning };
}

/** 悬停明细里一份的状态文字（计时类状态不带读秒）。 */
function copyText(status: TaskStatus): string {
  switch (status.kind) {
    case "queued":
      return "排队中";
    case "running":
      return "执行中";
    case "backoff":
      return "网关限流，等待重试";
    case "failed":
      return `失败 · ${status.label}`;
    case "cancelled":
      return "已取消";
    case "interrupted":
      return "已中断";
  }
}

/**
 * 多份时计数摘要的悬停明细：未成功的份逐份一行，含失败原因；本次提交只有一份（或没有）时为 null。
 * 不带序号：成功的份不在 copies 里，下标对不上实际是第几份。
 */
export function nodeCopyDetail(node: NodeRunState | undefined): string | null {
  if (!node || node.total < 2) return null;
  return node.copies.map((c) => copyText(c.status)).join("\n");
}

export interface BoardRunState {
  /** 任务节点 id → 本次运行里的各份（含失败 / 已取消）；已中断等由任务目录推导的不在这里。 */
  nodes: ReadonlyMap<string, NodeRunState>;
  /** 至少有一份在读图中、排队、执行、退避的任务节点：参数与输入连线锁定（ADR 0014 环境里的锁定集）。 */
  locked: ReadonlySet<string>;
  /** 本次运行经手过的任务编号，用于推导「已中断」。 */
  handled: ReadonlySet<string>;
}

/**
 * 未完成份的阶段分布：读参考图、排队、执行、限流退避都算这一份还没结束（ADR 0015）。
 * 迁移（数据根）与更新准备据此判断忙闲，用的是同一个运行器，不另建一份任务状态。
 */
export interface TaskActivity {
  /** 还有未完成的份：迁移 / 更新准备必须先问这一项。 */
  busy: boolean;
  /** 未完成的份数（各阶段之和）。 */
  pending: number;
  /** 正在读参考图、还没拿到任务编号的份。 */
  reading: number;
  /** 已入队等派发的份（不含退避）。 */
  waiting: number;
  /** 执行中的份。 */
  running: number;
  /** 限流退避中等着重试的份。 */
  backoff: number;
  /** 有未完成份的画板键，按首次出现顺序。 */
  boards: readonly string[];
}

export interface RunnerSnapshot {
  board(boardKey: string): BoardRunState;
  /** 运行指示：执行中在前，排队（含退避）按队列顺序在后。 */
  active: readonly ActiveTask[];
  /** 读图中、排队、执行、退避的任务数；关闭画板 / 退出前确认用。 */
  pending(boardKey?: string): number;
  /** 同一个忙闲判断的分阶段展开：运行指示与迁移 / 更新准备都读这一份。 */
  activity: TaskActivity;
}

export type CancelFilter =
  /** 节点上的取消：该节点全部未结束的份，含展开中还没读图的。 */
  | { kind: "task"; boardKey: string; taskNodeId: string }
  /** 运行指示的单行：只取消这一份（按任务编号），其余份与同一次提交的展开继续。 */
  | { kind: "copy"; taskId: string }
  | { kind: "board"; boardKey: string }
  /** 运行指示「取消全部排队」：读图中、排队、退避的；执行中的不受影响。 */
  | { kind: "waiting" }
  | { kind: "all" };

/** 重新生成按 copies 份展开（调用方经 runCopies 算出、提交时固化，缺省为 1）；
 *  生成变体（fromTaskId = 该结果的任务编号）总是一份，不改 last_submitted。 */
export type RegenerateRequest = { kind: "regenerate"; copies?: number } | { kind: "variant"; fromTaskId: string };

/** 任务节点 id → 本次实际份数（调用方经 core 的 runCopies / copiesByNode 算出，提交时固化）；缺省为 1。 */
export type CopiesByNode = Readonly<Record<string, number>>;

export interface Runner {
  /** 按顺序读参考图并入队，每个节点按 copies 展开为输入相同的若干个生成任务；board 是二次确认时的画板。
   *  返回本地提交失败的说明（不含密钥与提示词）。 */
  submit(target: RunTarget, board: Board, taskNodeIds: string[], copies?: CopiesByNode): Promise<string[]>;
  /** 重新生成 / 生成变体（见 RegenerateRequest，缺省为重新生成一份）；board 是当前画板。返回本地失败说明：多份失败时为「N 份失败：首份原因」。 */
  regenerate(target: RunTarget, board: Board, taskNodeId: string, request?: RegenerateRequest): Promise<string | null>;
  cancel(filter: CancelFilter): void;
  /** 关闭画板：取消该画板的任务并遗忘它的状态与经手过的任务编号。 */
  closeBoard(boardKey: string): void;
  /** 更新准备的提交守护（ADR 0016）：挂上后 submit / regenerate 一律拒绝，
   *  包含已经在等能力表摘要的异步间隙；传 null 解除。 */
  setSubmissionGuard(guard: (() => void) | null): void;
  setConcurrency(limit: number): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RunnerSnapshot;
}

type Phase = "reading" | "waiting" | "backoff" | "running";

/** 一个任务的记录（读图中 / 等待 / 退避 / 执行中）；结束即删除。 */
interface Job {
  target: RunTarget;
  taskNodeId: string;
  phase: Phase;
  /** 同一次提交的一组任务共用；按画板 / 全部取消时，其中还没读图的不再提交。 */
  submission: { cancelled: boolean };
  /** 本次提交为该节点展开的份数。 */
  total: number;
  prepared?: PreparedJob;
  /** 派发时写到任务节点上；undefined = 不改（生成变体）。 */
  lastSubmitted?: TaskNode["last_submitted"];
  /** 展开为多份时同一节点各份共用：已派发（任务目录已写）的各份任务编号，随 last_submitted 落到画板。 */
  dispatched?: string[];
  /** 任务目录已写、提交记录已落地后的任务（429 重试不再写）。 */
  written?: WrittenJob;
  /** 已自动重试的次数（仅 429）。 */
  retries: number;
  startedAt: number;
  controller: AbortController;
}


const EMPTY_BOARD: BoardRunState = { nodes: new Map(), locked: new Set(), handled: new Set() };

/** 日志里的错误字段：只带类别、状态码、网关请求编号与脱敏说明。 */
function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof GatewayError) return { category: error.category, status_code: error.status, gateway_request_id: error.requestId, message: failureLabel(error) };
  return { category: "local", message: failureLabel(error) };
}

/** 一份的状态：读图中与排队都算排队；退避带上恢复时刻（整条队列共用一个）。 */
function statusOf(job: Job, pausedUntil: number): TaskStatus {
  switch (job.phase) {
    case "reading":
    case "waiting":
      return { kind: "queued" };
    case "backoff":
      return { kind: "backoff", retryAt: pausedUntil };
    case "running":
      return { kind: "running", startedAt: job.startedAt };
  }
}

/** 某个阶段的份数。 */
function countOf(live: readonly Job[], phase: Phase): number {
  return live.filter((j) => j.phase === phase).length;
}

/** 忙闲判断：各阶段的份数与涉及的画板，供运行指示与迁移 / 更新准备共读。 */
function activityOf(live: readonly Job[]): TaskActivity {
  return {
    busy: live.length > 0,
    pending: live.length,
    reading: countOf(live, "reading"),
    waiting: countOf(live, "waiting"),
    running: countOf(live, "running"),
    backoff: countOf(live, "backoff"),
    boards: [...new Set(live.map((j) => j.target.boardKey))],
  };
}

/** 未完成份数；不给画板键时是整条队列（跨画板唯一）。 */
function pendingOf(live: readonly Job[], key: string | undefined): number {
  return live.filter((j) => key === undefined || j.target.boardKey === key).length;
}

/** 运行指示的一行。 */
function rowOf(state: ActiveTask["state"]) {
  return (job: Job): ActiveTask => ({ taskId: job.prepared!.taskId, boardKey: job.target.boardKey, taskNodeId: job.taskNodeId, state });
}

/** 每个画板：已结束的份在前，未结束的按提交顺序在后；未结束的节点同时进入锁定集。 */
function entriesOf(jobs: Iterable<Job>, finished: ReadonlyMap<string, NodeCopyEntry[]>, pausedUntil: number) {
  const entries = new Map<string, NodeCopyEntry[]>([...finished].map(([key, list]) => [key, [...list]]));
  const locked = new Map<string, Set<string>>();
  for (const job of jobs) {
    const key = job.target.boardKey;
    if (!entries.has(key)) entries.set(key, []);
    entries.get(key)!.push({ taskNodeId: job.taskNodeId, total: job.total, copy: { taskId: job.prepared?.taskId ?? null, status: statusOf(job, pausedUntil) } });
    if (!locked.has(key)) locked.set(key, new Set());
    locked.get(key)!.add(job.taskNodeId);
  }
  return { entries, locked };
}

/** 画板键 → 运行状态；经手过任务编号的画板即使没有未完成的份也保留（用来推导已中断）。 */
function boardStatesOf(entries: ReadonlyMap<string, NodeCopyEntry[]>, locked: ReadonlyMap<string, Set<string>>, handled: ReadonlyMap<string, Set<string>>) {
  const states = new Map<string, BoardRunState>();
  for (const key of new Set([...entries.keys(), ...handled.keys()])) {
    states.set(key, { nodes: groupCopies(entries.get(key) ?? []), locked: locked.get(key) ?? new Set(), handled: handled.get(key) ?? new Set() });
  }
  return states;
}

/** 派发时写的 last_submitted：多份时带上同一次提交已派发的各份任务编号（不参与脏判据），一份时不带；
 *  不沿用上一次提交的各份（重新生成以上次的 last_submitted 为底）。 */
function withCopyTaskIds(job: Job): TaskNode["last_submitted"] {
  const { copy_task_ids: _stale, ...last } = job.lastSubmitted ?? {};
  if (!job.dispatched) return last;
  job.dispatched.push(job.prepared!.taskId);
  return { ...last, copy_task_ids: [...job.dispatched] };
}

/** 任务迁移事件带画板文件名 + 任务节点 id。 */
function taskFields(job: Job) {
  const p = job.prepared!;
  return { task_id: p.taskId, board_file: job.target.boardFile, task_node_id: job.taskNodeId, model: p.plan.model, workflow: p.plan.send.workflow };
}

/** 快照：画板状态、运行指示与忙闲判断都从同一份任务集合算出。 */
function snapshotOf(boards: ReadonlyMap<string, BoardRunState>, jobs: Iterable<Job>, running: readonly Job[], waiting: readonly Job[]): RunnerSnapshot {
  const live = [...jobs];
  return {
    board: (key) => boards.get(key) ?? EMPTY_BOARD,
    active: [...running.map(rowOf("running")), ...waiting.map(rowOf("waiting"))],
    pending: (key) => pendingOf(live, key),
    activity: activityOf(live),
  };
}

/**
 * 运行器实现：状态都在实例上，方法对应一个公开动作或一个内部步骤。
 * 工厂只做装配——质量门禁按函数计量，摊在这里的每一步各自都小。
 */
class RunnerImpl implements Runner {
  private readonly deps: RunDeps;
  private readonly ports: RunnerPorts;
  private limit: number;
  private readonly jobs = new Set<Job>();
  /** 等待派发（含退避），队首在前。 */
  private waiting: Job[] = [];
  private running: Job[] = [];
  /** 429 退避期间整条队列暂停派发，到此刻（毫秒）恢复；0 = 未暂停。 */
  private pausedUntil = 0;
  private cancelTimer: (() => void) | null = null;
  /** 画板键 → 已结束的各份（失败 / 已取消），按结束先后。 */
  private readonly finished = new Map<string, NodeCopyEntry[]>();
  private readonly handled = new Map<string, Set<string>>();
  /** 已关闭的画板键（键不复用）：关闭前已开始、还在算摘要的提交不再入队。 */
  private readonly closed = new Set<string>();
  /** 更新准备期间拒绝一切新提交（读摘要之前与之后都查）。 */
  private submissionGuard: (() => void) | null = null;
  private submissionGeneration = 0;
  private readonly listeners = new Set<() => void>();
  private snapshot: RunnerSnapshot;

  constructor(ports: RunnerPorts) {
    this.deps = ports.deps;
    this.ports = ports;
    this.limit = ports.concurrency;
    this.snapshot = this.buildSnapshot();
  }

  /** 两个订阅口写成实例字段：useSyncExternalStore 会把它们拆下来单独调用，不能依赖 this 的绑定。 */
  readonly getSnapshot = (): RunnerSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setConcurrency(next: number) {
    this.limit = next;
    this.pump();
  }

  setSubmissionGuard(guard: (() => void) | null) {
    if (guard) this.submissionGeneration++;
    this.submissionGuard = guard;
  }

  closeBoard(boardKey: string) {
    this.closed.add(boardKey);
    this.cancel({ kind: "board", boardKey });
    this.finished.delete(boardKey);
    this.handled.delete(boardKey);
    this.publish();
  }

  private now() {
    return this.deps.now().getTime();
  }

  private buildSnapshot(): RunnerSnapshot {
    const { entries, locked } = entriesOf(this.jobs, this.finished, this.pausedUntil);
    return snapshotOf(boardStatesOf(entries, locked, this.handled), this.jobs, this.running, this.waiting);
  }

  private publish() {
    this.snapshot = this.buildSnapshot();
    this.listeners.forEach((l) => l());
  }

  /** 记下一份的终态（按任务编号；读图失败时没有编号）。 */
  private setFinished(job: Job, status: TaskStatus) {
    const key = job.target.boardKey;
    let list = this.finished.get(key);
    if (!list) this.finished.set(key, (list = []));
    list.push({ taskNodeId: job.taskNodeId, total: job.total, copy: { taskId: job.prepared?.taskId ?? null, status } });
  }

  /** 重新运行前清掉该节点上次的终态（每次提交每个节点一次，见 expand）。 */
  private clearFinished(boardKey: string, taskNodeId: string) {
    const list = this.finished.get(boardKey);
    if (list) this.finished.set(boardKey, list.filter((f) => f.taskNodeId !== taskNodeId));
  }

  private logTransition(job: Job, from: string | null, to: string, extra: Record<string, unknown> = {}) {
    this.ports.log("task", { ...taskFields(job), from_status: from, to_status: to, ...extra });
  }

  /** 任务目录已写的任务没有结果时记下结局，重开时据此区分失败 / 已取消 / 已中断；写不了就算了。 */
  private recordOutcome(job: Job, outcome: TaskOutcome) {
    if (job.written) void writeOutcome(this.deps, job.target.userRoot, job.written.relDir, outcome).catch(() => undefined);
  }

  private removeJob(job: Job) {
    this.jobs.delete(job);
    this.waiting = this.waiting.filter((j) => j !== job);
    this.running = this.running.filter((j) => j !== job);
  }

  private fail(job: Job, error: unknown) {
    this.removeJob(job);
    this.logTransition(job, "running", "failed", errorFields(error));
    const failed = { kind: "failed" as const, label: failureLabel(error) };
    this.setFinished(job, failed);
    this.recordOutcome(job, failed);
  }

  private rateLimited(job: Job, error: unknown) {
    const attempt = job.retries + 1;
    if (job.retries >= BACKOFF_MS.length) {
      this.ports.log("rate_limit", { ...taskFields(job), attempt, outcome: "failed" });
      this.fail(job, error);
      return;
    }
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + BACKOFF_MS[job.retries]);
    job.retries = attempt;
    this.running = this.running.filter((j) => j !== job);
    // 回队首，排在已在退避的任务之后。
    let head = 0;
    while (head < this.waiting.length && this.waiting[head].phase === "backoff") head++;
    this.waiting.splice(head, 0, job);
    job.phase = "backoff";
    const at = new Date(this.pausedUntil).toISOString();
    this.ports.log("rate_limit", { ...taskFields(job), attempt, outcome: "retry", retry_at: at, queue_paused_until: at });
    this.logTransition(job, "running", "backoff");
  }

  /** 下载事件的字段：成功带张数，失败带错误类别。 */
  private logDownload(written: WrittenJob, r: { ok: true; images: number } | { ok: false; error: unknown }) {
    const fields = r.ok ? { ok: true, images: r.images } : { ok: false, ...errorFields(r.error) };
    this.ports.log("download", { task_id: written.taskId, model: written.plan.model, ...fields });
  }

  private aborted(job: Job) {
    return job.controller.signal.aborted;
  }

  /** 任务目录只写一次（429 重试不再写）；写完把 last_submitted 落到画板上。 */
  private async writeDirOnce(job: Job) {
    if (job.written) return;
    const target = job.target;
    job.written = await writeJob(this.deps, target.userRoot, job.prepared!);
    if (job.lastSubmitted !== undefined) this.ports.apply(target.boardKey, { kind: "submitted", taskId: job.taskNodeId, lastSubmitted: withCopyTaskIds(job) });
    // 写目录期间被取消：取消时目录还没写，这里补记结局。
    if (this.aborted(job)) this.recordOutcome(job, { kind: "cancelled", gatewayMayContinue: false });
  }

  /** 调网关取结果；下载事件逐张记日志。 */
  private runGateway(job: Job, written: WrittenJob) {
    return executeJob(this.deps, {
      job: written,
      userRoot: job.target.userRoot,
      baseUrl: job.target.baseUrl,
      apiKey: job.target.apiKey,
      signal: job.controller.signal,
      onDownload: (r) => this.logDownload(written, r),
    });
  }

  private succeed(job: Job, result: Awaited<ReturnType<typeof executeJob>>) {
    this.removeJob(job);
    this.logTransition(job, "running", "succeeded");
    this.ports.apply(job.target.boardKey, { kind: "runResult", result });
  }

  /** 取消 / 已取消的错误不算失败；429 且非 Flash 退避重试，其余直接失败。 */
  private handleError(job: Job, e: unknown) {
    if (this.aborted(job) || e instanceof CancelledError) return;
    if (e instanceof GatewayError && e.category === "rate_limited" && !isFlashShape(job.prepared?.input.model)) {
      this.rateLimited(job, e);
      return;
    }
    this.fail(job, e);
  }

  private async execute(job: Job) {
    try {
      await this.writeDirOnce(job);
      if (this.aborted(job)) return;
      const result = await this.runGateway(job, job.written!);
      // 请求可能已发出、网关已在算：取消后不再等它，也不落结果。
      if (this.aborted(job)) return;
      this.succeed(job, result);
    } catch (e) {
      this.handleError(job, e);
    } finally {
      if (!this.aborted(job)) this.pump();
    }
  }

  /** 从队首派发，直到执行数达到并发上限；暂停中则定时到恢复时刻。 */
  private pump() {
    this.cancelTimer?.();
    this.cancelTimer = null;
    const t = this.now();
    if (t < this.pausedUntil) {
      if (this.waiting.length) this.cancelTimer = this.deps.schedule(this.pausedUntil - t, () => this.pump());
      this.publish();
      return;
    }
    const started = this.waiting.slice(0, Math.max(0, this.limit - this.running.length));
    this.waiting = this.waiting.slice(started.length);
    this.running = [...this.running, ...started];
    for (const job of started) {
      this.ports.log("queue_dispatch", { ...taskFields(job), running: this.running.length, waiting: this.waiting.length, limit: this.limit });
      this.logTransition(job, job.phase === "backoff" ? "backoff" : "queued", "running");
      job.phase = "running";
      job.startedAt = t;
      void this.execute(job);
    }
    this.publish();
  }

  /** 该节点有任一份未结束。 */
  private occupied(boardKey: string, taskNodeId: string) {
    return [...this.jobs].some((j) => j.target.boardKey === boardKey && j.taskNodeId === taskNodeId);
  }

  /**
   * 把一个任务节点展开为 copies 份：各份一开始就以读图中的任务记下（节点从此锁定，摘要计入排队），
   * 上次的终态只在这里清一次；随后逐份读参考图并入队。某份在读图前已被取消（中止）就不再读图、不入队。
   * stopped() 为真（更新准备守护挂上）时余下的份撤掉、不留痕迹。
   * prepare 收到首份的提交时刻，各份共用，任务记录除任务编号外相同。返回各份的本地失败说明。
   */
  private async expand(
    target: RunTarget,
    taskNodeId: string,
    submission: Job["submission"],
    copies: number,
    stopped: () => boolean,
    prepare: (submittedAt: Date | undefined) => Promise<Prepared>,
  ): Promise<string[]> {
    if (this.closed.has(target.boardKey)) return [];
    // 守护在算能力表摘要期间挂上的情况由 submit / regenerate 在 await 之后拦截，这里不用查。
    const guardedAtEntry = this.submissionGuard;
    if (guardedAtEntry) {
      guardedAtEntry();
      return [];
    }
    const dispatched = copies > 1 ? [] : undefined;
    const copyJobs = Array.from({ length: copies }, (): Job => ({ target, taskNodeId, phase: "reading", submission, total: copies, dispatched, retries: 0, startedAt: 0, controller: new AbortController() }));
    copyJobs.forEach((job) => this.jobs.add(job));
    this.clearFinished(target.boardKey, taskNodeId);
    this.publish();
    const problems: string[] = [];
    let submittedAt: Date | undefined;
    for (const job of copyJobs) {
      if (job.controller.signal.aborted) continue;
      if (stopped()) {
        this.removeJob(job);
        this.publish();
        continue;
      }
      const problem = await this.enqueue(job, () => prepare(submittedAt));
      submittedAt ??= job.prepared?.plan.submittedAt;
      if (problem) problems.push(problem);
    }
    return problems;
  }

  /** 读参考图并入队；读的期间被取消则不入队。返回本地失败说明。 */
  private async enqueue(job: Job, prepare: () => Promise<Prepared>): Promise<string | null> {
    const { target } = job;
    try {
      const prepared = await prepare();
      if (job.controller.signal.aborted) return null;
      job.prepared = prepared.job;
      job.lastSubmitted = prepared.lastSubmitted;
      job.phase = "waiting";
      let h = this.handled.get(target.boardKey);
      if (!h) this.handled.set(target.boardKey, (h = new Set()));
      h.add(prepared.job.taskId);
      this.waiting.push(job);
      this.logTransition(job, null, "queued");
      this.pump();
      return null;
    } catch (e) {
      if (job.controller.signal.aborted) return null;
      this.jobs.delete(job);
      this.setFinished(job, { kind: "failed", label: failureLabel(e) });
      this.publish();
      return errorText(e);
    }
  }

  private cancelJob(job: Job) {
    job.controller.abort();
    const was = job.phase;
    this.removeJob(job);
    // 暂停是这一份在等重试：最后一份退避的份没了，队列立刻恢复派发，不连累其他任务。
    if (was === "backoff" && ![...this.jobs].some((j) => j.phase === "backoff")) this.pausedUntil = 0;
    if (was === "reading") return;
    if (was === "waiting") {
      // 从未派发：画板与任务目录都没动过，不留痕迹。
      this.logTransition(job, "queued", "cancelled", { gateway_may_continue: false });
      return;
    }
    // 执行中：请求可能已发出；限流退避中：网关没接这次请求。
    const cancelled = { kind: "cancelled" as const, gatewayMayContinue: was === "running" && job.written !== undefined };
    this.logTransition(job, was, "cancelled", { gateway_may_continue: cancelled.gatewayMayContinue });
    this.setFinished(job, cancelled);
    this.recordOutcome(job, cancelled);
  }

  cancel(filter: CancelFilter) {
    for (const job of [...this.jobs]) {
      if (!matchesCancel(filter, job)) continue;
      // 按画板 / 排队 / 全部取消时，同一次提交里还没读图的任务也不再提交；节点取消与单份取消不波及其他节点。
      if (filter.kind !== "task" && filter.kind !== "copy") job.submission.cancelled = true;
      this.cancelJob(job);
    }
    this.pump();
  }

  async submit(target: RunTarget, board: Board, taskNodeIds: string[], copies: CopiesByNode = {}): Promise<string[]> {
    const problems: string[] = [];
    if (this.submissionGuard) {
      this.submissionGuard();
      return problems;
    }
    const generation = this.submissionGeneration;
    const stopped = () => generation !== this.submissionGeneration;
    const submission = { cancelled: false };
    const tableSha256 = await tableDigest(target.table);
    if (generation !== this.submissionGeneration) return problems;
    for (const taskNodeId of taskNodeIds) {
      if (submission.cancelled || this.closed.has(target.boardKey) || generation !== this.submissionGeneration) break;
      if (this.occupied(target.boardKey, taskNodeId)) continue;
      problems.push(...(await this.expand(target, taskNodeId, submission, copies[taskNodeId] ?? 1, stopped, (submittedAt) => prepareJob(this.deps, { board, table: target.table, tableSha256, userRoot: target.userRoot, taskNodeId, submittedAt }))));
    }
    return problems;
  }

  async regenerate(target: RunTarget, board: Board, taskNodeId: string, request: RegenerateRequest = { kind: "regenerate" }): Promise<string | null> {
    if (this.submissionGuard) {
      this.submissionGuard();
      return null;
    }
    const generation = this.submissionGeneration;
    if (this.occupied(target.boardKey, taskNodeId)) return null;
    const tableSha256 = await tableDigest(target.table);
    if (generation !== this.submissionGeneration) return null;
    if (this.occupied(target.boardKey, taskNodeId)) return null;
    // 生成变体固定一份只在这里判断。
    const [copies, fromTaskId] = request.kind === "variant" ? [1, request.fromTaskId] : [request.copies ?? 1, undefined];
    const problems = await this.expand(target, taskNodeId, { cancelled: false }, copies, () => generation !== this.submissionGeneration, (submittedAt) =>
      prepareRegenerate(this.deps, { board, table: target.table, tableSha256, userRoot: target.userRoot, taskNodeId, fromTaskId, submittedAt }),
    );
    // 与运行一样汇总本地失败：多份给份数与首份原因，一份只给原因。
    if (problems.length > 1) return `${problems.length} 份失败：${problems[0]}`;
    return problems[0] ?? null;
  }
}

/** 取消筛选：节点、单份（按任务编号）、画板、全部排队（执行中的不动）或全部。 */
function matchesCancel(filter: CancelFilter, job: Job): boolean {
  switch (filter.kind) {
    case "task":
      return job.target.boardKey === filter.boardKey && job.taskNodeId === filter.taskNodeId;
    case "copy":
      return job.prepared?.taskId === filter.taskId;
    case "board":
      return job.target.boardKey === filter.boardKey;
    case "waiting":
      return job.phase !== "running";
    case "all":
      return true;
  }
}

export function createRunner(ports: RunnerPorts): Runner {
  return new RunnerImpl(ports);
}

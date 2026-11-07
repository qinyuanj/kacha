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

export interface RunnerSnapshot {
  board(boardKey: string): BoardRunState;
  /** 运行指示：执行中在前，排队（含退避）按队列顺序在后。 */
  active: readonly ActiveTask[];
  /** 读图中、排队、执行、退避的任务数；关闭画板 / 退出前确认用。 */
  pending(boardKey?: string): number;
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

export function createRunner(ports: RunnerPorts): Runner {
  const { deps } = ports;
  let limit = ports.concurrency;
  const jobs = new Set<Job>();
  /** 等待派发（含退避），队首在前。 */
  let waiting: Job[] = [];
  let running: Job[] = [];
  /** 429 退避期间整条队列暂停派发，到此刻（毫秒）恢复；0 = 未暂停。 */
  let pausedUntil = 0;
  let cancelTimer: (() => void) | null = null;
  /** 画板键 → 已结束的各份（失败 / 已取消），按结束先后。 */
  const finished = new Map<string, NodeCopyEntry[]>();
  const handled = new Map<string, Set<string>>();
  /** 已关闭的画板键（键不复用）：关闭前已开始、还在算摘要的提交不再入队。 */
  const closed = new Set<string>();
  /** 更新准备期间拒绝一切新提交（读摘要之前与之后都查）。 */
  let submissionGuard: (() => void) | null = null;
  let submissionGeneration = 0;
  const listeners = new Set<() => void>();
  let snapshot = buildSnapshot();

  const now = () => deps.now().getTime();

  function statusOf(job: Job): TaskStatus {
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

  function buildSnapshot(): RunnerSnapshot {
    // 每个画板：已结束的份在前，未结束的按提交顺序在后。
    const entries = new Map<string, NodeCopyEntry[]>([...finished].map(([key, list]) => [key, [...list]]));
    const locked = new Map<string, Set<string>>();
    for (const job of jobs) {
      const key = job.target.boardKey;
      if (!entries.has(key)) entries.set(key, []);
      entries.get(key)!.push({ taskNodeId: job.taskNodeId, total: job.total, copy: { taskId: job.prepared?.taskId ?? null, status: statusOf(job) } });
      if (!locked.has(key)) locked.set(key, new Set());
      locked.get(key)!.add(job.taskNodeId);
    }
    const keys = new Set([...entries.keys(), ...handled.keys()]);
    const boards = new Map<string, BoardRunState>(
      [...keys].map((key) => [key, { nodes: groupCopies(entries.get(key) ?? []), locked: locked.get(key) ?? new Set(), handled: handled.get(key) ?? new Set() }]),
    );
    const row = (state: ActiveTask["state"]) => (job: Job): ActiveTask => ({ taskId: job.prepared!.taskId, boardKey: job.target.boardKey, taskNodeId: job.taskNodeId, state });
    const live = [...jobs];
    return {
      board: (key) => boards.get(key) ?? EMPTY_BOARD,
      active: [...running.map(row("running")), ...waiting.map(row("waiting"))],
      pending: (key) => live.filter((j) => key === undefined || j.target.boardKey === key).length,
    };
  }

  function publish() {
    snapshot = buildSnapshot();
    listeners.forEach((l) => l());
  }

  /** 记下一份的终态（按任务编号；读图失败时没有编号）。 */
  function setFinished(job: Job, status: TaskStatus) {
    const key = job.target.boardKey;
    let list = finished.get(key);
    if (!list) finished.set(key, (list = []));
    list.push({ taskNodeId: job.taskNodeId, total: job.total, copy: { taskId: job.prepared?.taskId ?? null, status } });
  }

  /** 重新运行前清掉该节点上次的终态（每次提交每个节点一次，见 expand）。 */
  function clearFinished(boardKey: string, taskNodeId: string) {
    const list = finished.get(boardKey);
    if (list) finished.set(boardKey, list.filter((f) => f.taskNodeId !== taskNodeId));
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
  function logTransition(job: Job, from: string | null, to: string, extra: Record<string, unknown> = {}) {
    ports.log("task", { ...taskFields(job), from_status: from, to_status: to, ...extra });
  }

  /** 任务目录已写的任务没有结果时记下结局，重开时据此区分失败 / 已取消 / 已中断；写不了就算了。 */
  function recordOutcome(job: Job, outcome: TaskOutcome) {
    if (job.written) void writeOutcome(deps, job.target.userRoot, job.written.relDir, outcome).catch(() => undefined);
  }

  function remove(job: Job) {
    jobs.delete(job);
    waiting = waiting.filter((j) => j !== job);
    running = running.filter((j) => j !== job);
  }

  function fail(job: Job, error: unknown) {
    remove(job);
    logTransition(job, "running", "failed", errorFields(error));
    const failed = { kind: "failed" as const, label: failureLabel(error) };
    setFinished(job, failed);
    recordOutcome(job, failed);
  }

  function rateLimited(job: Job, error: unknown) {
    const attempt = job.retries + 1;
    if (job.retries >= BACKOFF_MS.length) {
      ports.log("rate_limit", { ...taskFields(job), attempt, outcome: "failed" });
      fail(job, error);
      return;
    }
    pausedUntil = Math.max(pausedUntil, now() + BACKOFF_MS[job.retries]);
    job.retries = attempt;
    running = running.filter((j) => j !== job);
    // 回队首，排在已在退避的任务之后。
    let head = 0;
    while (head < waiting.length && waiting[head].phase === "backoff") head++;
    waiting.splice(head, 0, job);
    job.phase = "backoff";
    const at = (ms: number) => new Date(ms).toISOString();
    ports.log("rate_limit", { ...taskFields(job), attempt, outcome: "retry", retry_at: at(pausedUntil), queue_paused_until: at(pausedUntil) });
    logTransition(job, "running", "backoff");
  }

  async function execute(job: Job) {
    const { controller, target } = job;
    const aborted = () => controller.signal.aborted;
    try {
      if (!job.written) {
        job.written = await writeJob(deps, target.userRoot, job.prepared!);
        if (job.lastSubmitted !== undefined) ports.apply(target.boardKey, { kind: "submitted", taskId: job.taskNodeId, lastSubmitted: withCopyTaskIds(job) });
        // 写目录期间被取消：取消时目录还没写，这里补记结局。
        if (aborted()) recordOutcome(job, { kind: "cancelled", gatewayMayContinue: false });
      }
      if (aborted()) return;
      const written = job.written;
      const result = await executeJob(deps, {
        job: written,
        userRoot: target.userRoot,
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        signal: controller.signal,
        onDownload: (r) => ports.log("download", { task_id: written.taskId, model: written.plan.model, ...(r.ok ? { ok: true, images: r.images } : { ok: false, ...errorFields(r.error) }) }),
      });
      if (aborted()) return;
      remove(job);
      logTransition(job, "running", "succeeded");
      ports.apply(target.boardKey, { kind: "runResult", result });
    } catch (e) {
      if (aborted() || e instanceof CancelledError) return;
      if (e instanceof GatewayError && e.category === "rate_limited" && !isFlashShape(job.prepared?.input.model)) rateLimited(job, e);
      else fail(job, e);
    } finally {
      if (!aborted()) pump();
    }
  }

  /** 从队首派发，直到执行数达到并发上限；暂停中则定时到恢复时刻。 */
  function pump() {
    cancelTimer?.();
    cancelTimer = null;
    const t = now();
    if (t < pausedUntil) {
      if (waiting.length) cancelTimer = deps.schedule(pausedUntil - t, pump);
      publish();
      return;
    }
    const started = waiting.slice(0, Math.max(0, limit - running.length));
    waiting = waiting.slice(started.length);
    running = [...running, ...started];
    for (const job of started) {
      ports.log("queue_dispatch", { ...taskFields(job), running: running.length, waiting: waiting.length, limit });
      logTransition(job, job.phase === "backoff" ? "backoff" : "queued", "running");
      job.phase = "running";
      job.startedAt = t;
      void execute(job);
    }
    publish();
  }

  /** 该节点有任一份未结束。 */
  const occupied = (boardKey: string, taskNodeId: string) => [...jobs].some((j) => j.target.boardKey === boardKey && j.taskNodeId === taskNodeId);

  /**
   * 把一个任务节点展开为 copies 份：各份一开始就以读图中的任务记下（节点从此锁定，摘要计入排队），
   * 上次的终态只在这里清一次；随后逐份读参考图并入队。某份在读图前已被取消（中止）就不再读图、不入队。
   * stopped() 为真（更新准备守护挂上）时余下的份撤掉、不留痕迹。
   * prepare 收到首份的提交时刻，各份共用，任务记录除任务编号外相同。返回各份的本地失败说明。
   */
  async function expand(
    target: RunTarget,
    taskNodeId: string,
    submission: Job["submission"],
    copies: number,
    stopped: () => boolean,
    prepare: (submittedAt: Date | undefined) => Promise<Prepared>,
  ): Promise<string[]> {
    if (closed.has(target.boardKey)) return [];
    // 守护在算能力表摘要期间挂上的情况由 submit / regenerate 在 await 之后拦截，这里不用查。
    const guardedAtEntry = submissionGuard;
    if (guardedAtEntry) {
      guardedAtEntry();
      return [];
    }
    const dispatched = copies > 1 ? [] : undefined;
    const copyJobs = Array.from({ length: copies }, (): Job => ({ target, taskNodeId, phase: "reading", submission, total: copies, dispatched, retries: 0, startedAt: 0, controller: new AbortController() }));
    copyJobs.forEach((job) => jobs.add(job));
    clearFinished(target.boardKey, taskNodeId);
    publish();
    const problems: string[] = [];
    let submittedAt: Date | undefined;
    for (const job of copyJobs) {
      if (job.controller.signal.aborted) continue;
      if (stopped()) {
        remove(job);
        publish();
        continue;
      }
      const problem = await enqueue(job, () => prepare(submittedAt));
      submittedAt ??= job.prepared?.plan.submittedAt;
      if (problem) problems.push(problem);
    }
    return problems;
  }

  /** 读参考图并入队；读的期间被取消则不入队。返回本地失败说明。 */
  async function enqueue(job: Job, prepare: () => Promise<Prepared>): Promise<string | null> {
    const { target } = job;
    try {
      const prepared = await prepare();
      if (job.controller.signal.aborted) return null;
      job.prepared = prepared.job;
      job.lastSubmitted = prepared.lastSubmitted;
      job.phase = "waiting";
      let h = handled.get(target.boardKey);
      if (!h) handled.set(target.boardKey, (h = new Set()));
      h.add(prepared.job.taskId);
      waiting.push(job);
      logTransition(job, null, "queued");
      pump();
      return null;
    } catch (e) {
      if (job.controller.signal.aborted) return null;
      jobs.delete(job);
      setFinished(job, { kind: "failed", label: failureLabel(e) });
      publish();
      return e instanceof Error ? e.message : String(e);
    }
  }

  function cancelJob(job: Job) {
    job.controller.abort();
    const was = job.phase;
    remove(job);
    if (was === "reading") return;
    if (was === "waiting") {
      // 从未派发：画板与任务目录都没动过，不留痕迹。
      logTransition(job, "queued", "cancelled", { gateway_may_continue: false });
      return;
    }
    // 执行中：请求可能已发出；限流退避中：网关没接这次请求。
    const cancelled = { kind: "cancelled" as const, gatewayMayContinue: was === "running" && job.written !== undefined };
    logTransition(job, was, "cancelled", { gateway_may_continue: cancelled.gatewayMayContinue });
    setFinished(job, cancelled);
    recordOutcome(job, cancelled);
  }

  function cancel(filter: CancelFilter) {
    const match = (job: Job) => {
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
    };
    for (const job of [...jobs]) {
      if (!match(job)) continue;
      // 按画板 / 排队 / 全部取消时，同一次提交里还没读图的任务也不再提交；节点取消与单份取消不波及其他节点。
      if (filter.kind !== "task" && filter.kind !== "copy") job.submission.cancelled = true;
      cancelJob(job);
    }
    pump();
  }

  async function submit(target: RunTarget, board: Board, taskNodeIds: string[], copies: CopiesByNode = {}): Promise<string[]> {
    const problems: string[] = [];
    if (submissionGuard) {
      submissionGuard();
      return problems;
    }
    const generation = submissionGeneration;
    const stopped = () => generation !== submissionGeneration;
    const submission = { cancelled: false };
    const tableSha256 = await tableDigest(target.table);
    if (generation !== submissionGeneration) return problems;
    for (const taskNodeId of taskNodeIds) {
      if (submission.cancelled || closed.has(target.boardKey) || generation !== submissionGeneration) break;
      if (occupied(target.boardKey, taskNodeId)) continue;
      problems.push(...(await expand(target, taskNodeId, submission, copies[taskNodeId] ?? 1, stopped, (submittedAt) => prepareJob(deps, { board, table: target.table, tableSha256, userRoot: target.userRoot, taskNodeId, submittedAt }))));
    }
    return problems;
  }

  async function regenerate(target: RunTarget, board: Board, taskNodeId: string, request: RegenerateRequest = { kind: "regenerate" }): Promise<string | null> {
    if (submissionGuard) {
      submissionGuard();
      return null;
    }
    const generation = submissionGeneration;
    if (occupied(target.boardKey, taskNodeId)) return null;
    const tableSha256 = await tableDigest(target.table);
    if (generation !== submissionGeneration) return null;
    if (occupied(target.boardKey, taskNodeId)) return null;
    // 生成变体固定一份只在这里判断。
    const [copies, fromTaskId] = request.kind === "variant" ? [1, request.fromTaskId] : [request.copies ?? 1, undefined];
    const problems = await expand(target, taskNodeId, { cancelled: false }, copies, () => generation !== submissionGeneration, (submittedAt) =>
      prepareRegenerate(deps, { board, table: target.table, tableSha256, userRoot: target.userRoot, taskNodeId, fromTaskId, submittedAt }),
    );
    // 与运行一样汇总本地失败：多份给份数与首份原因，一份只给原因。
    if (problems.length > 1) return `${problems.length} 份失败：${problems[0]}`;
    return problems[0] ?? null;
  }

  return {
    submit,
    regenerate,
    cancel,
    setSubmissionGuard(guard) {
      if (guard) submissionGeneration++;
      submissionGuard = guard;
    },
    closeBoard(boardKey) {
      closed.add(boardKey);
      cancel({ kind: "board", boardKey });
      finished.delete(boardKey);
      handled.delete(boardKey);
      publish();
    },
    setConcurrency(next) {
      limit = next;
      pump();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}

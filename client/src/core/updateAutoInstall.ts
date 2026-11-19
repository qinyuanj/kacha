// 空闲自动安装（#180）：更新已下载并验签、且没有进行中的任务、也没有未落盘的改动时，
// 倒计时结束就自动保存并重启安装；「稍后」让本轮不再自动装。
//
// 判定与计时都在这里（纯函数 + 注入的时钟），React 只负责接线与重绘。
import { canInstall, updateText, type UpdateSnapshot } from "./update";
import { BUSY_MESSAGE, UNSAVED_MESSAGE } from "./updatePreparation";

/** 倒计时多久：给用户看见提示、并有机会点「稍后」。 */
export const AUTO_INSTALL_DELAY_MS = 30_000;

/**
 * 空闲依据：任务队列剩下的份数与未落盘的改动。
 *
 * 这是「现在能不能装」的薄边界：两处依据各自只有一个来源——runner 的 pending 份数、
 * 画板会话的落盘状态——这里只做判定，播放它们的代码不再各判一次。
 */
export interface UpdateIdleFacts {
  /**
   * 画板列表读出来了没有。
   *
   * 启动时先到的是更新快照、工作台还在读盘；这时自动安装会把「还没载入」当成
   * 「没有改动」，把半载入的界面状态写回去。等它载入完成再判。
   */
  boardsReady: boolean;
  /** 设置文件读出来了没有（同上：设置也会在准备时被写回）。 */
  settingsLoaded: boolean;
  /** 还在排队 / 读图 / 执行 / 退避的任务份数（runner 快照的 pending）。 */
  pendingTasks: number;
  /** 有改动没落盘：还在等去抖写盘，或上一次写盘失败。 */
  unsavedChanges: boolean;
}

/** 工作台还没载入完成时的说法：这时不装，也不解除，等条件恢复。 */
export const NOT_READY_MESSAGE = "等工作台载入完成再更新";

/** 空闲判定：返回不能装的原因；空串表示空闲，可以装。 */
export function idleBlocker(facts: UpdateIdleFacts): string {
  if (!facts.boardsReady || !facts.settingsLoaded) return NOT_READY_MESSAGE;
  if (facts.pendingTasks > 0) return BUSY_MESSAGE;
  if (facts.unsavedChanges) return UNSAVED_MESSAGE;
  return "";
}

/** 自动安装的内部状态。 */
export interface AutoInstallState {
  /** 第一份真实快照是不是「已就绪」：是就启动时直接装，不再倒计时。 */
  startup: "unknown" | "ready" | "other";
  /** 用户点过「稍后」：本轮不再自动装。 */
  deferred: boolean;
  /** 倒计时截止时刻；null 表示没在倒计时。 */
  deadline: number | null;
  /** 已经交给安装器，等它的结局。 */
  installing: boolean;
  /** 正在等条件（任务结束、改动落盘）；空串表示没在等。 */
  waiting: string;
}

/** 一开机就有的样子。 */
export const INITIAL_AUTO_STATE: AutoInstallState = {
  startup: "unknown",
  deferred: false,
  deadline: null,
  installing: false,
  waiting: "",
};

/** 界面要的样子：倒计时秒数、等待原因、是否已推迟、是否在装。 */
export interface AutoInstallView {
  counting: boolean;
  seconds: number;
  waiting: string;
  deferred: boolean;
  installing: boolean;
}

/** 还没开始判定时的样子（界面初始值与测试都从这里来）。 */
export const IDLE_AUTO_VIEW: AutoInstallView = { counting: false, seconds: 0, waiting: "", deferred: false, installing: false };

/** 一次判定要看的全部输入。 */
export interface AutoInstallInput extends UpdateIdleFacts {
  snapshot: UpdateSnapshot;
  /** 第一份真实快照读回来了：空快照不代表状态，读到之前不判断。 */
  loaded: boolean;
}

/** 这一步的结局：新状态，以及要不要立刻交给安装器。 */
export interface AutoStep {
  state: AutoInstallState;
  install: boolean;
}

/** 停在原处。 */
function hold(state: AutoInstallState): AutoStep {
  return { state, install: false };
}

/** 清掉倒计时与等待原因（不是可装状态、已经推迟或在装）。 */
function cleared(state: AutoInstallState): AutoStep {
  return { state: { ...state, deadline: null, waiting: "" }, install: false };
}

/** 第一份真实快照决定「启动时是不是就绪」；之后不再改。 */
function startupOf(state: AutoInstallState, snapshot: UpdateSnapshot): AutoInstallState["startup"] {
  if (state.startup !== "unknown") return state.startup;
  return snapshot.phase === "ready" ? "ready" : "other";
}

/** 空闲时：启动就绪的直接装，其余先倒计时；倒计时到点才装。 */
function countdownStep(state: AutoInstallState, now: number): AutoStep {
  if (state.deadline !== null) {
    if (now < state.deadline) return { state: { ...state, waiting: "" }, install: false };
    return { state: { ...state, waiting: "", deadline: null, startup: "other" }, install: true };
  }
  if (state.startup === "ready") return { state: { ...state, waiting: "", startup: "other" }, install: true };
  return { state: { ...state, waiting: "", deadline: now + AUTO_INSTALL_DELAY_MS }, install: false };
}

/**
 * 推进一步：这一步要不要装、界面该显示什么。
 *
 * 只有「已就绪且可装 + 空闲 + 用户没推迟」才往下走；条件恢复后重新从倒计时开始，
 * 所以任务在跑或保存失败时不会突然重启安装。
 */
export function autoStep(state: AutoInstallState, input: AutoInstallInput, now: number): AutoStep {
  // 还没读到真实快照：不判（空快照的 idle 不代表服务说没更新）。
  if (!input.loaded) return hold(state);
  const startup = startupOf(state, input.snapshot);
  const base = startup === state.startup ? state : { ...state, startup };
  if (state.installing || state.deferred) return cleared(base);
  if (!canInstall(input.snapshot)) return cleared(base);
  const waiting = idleBlocker(input);
  // 有任务或有未保存的改动：降级成普通就绪，条件恢复后按倒计时走，不突然重启。
  // 工作台还没载入完成不算「用户在忙」：那是启动窗口，留给「下次启动直接安装」。
  if (waiting) return { state: { ...base, deadline: null, waiting, startup: input.boardsReady && input.settingsLoaded ? "other" : base.startup }, install: false };
  return countdownStep(base, now);
}

/** 两份样子是否一模一样：界面据此避免无意义重绘。 */
export function sameAutoInstallView(a: AutoInstallView, b: AutoInstallView): boolean {
  return a.counting === b.counting && a.seconds === b.seconds && a.waiting === b.waiting && a.deferred === b.deferred && a.installing === b.installing;
}

/** 界面要的样子。 */
export function autoInstallView(state: AutoInstallState, now: number): AutoInstallView {
  return {
    counting: state.deadline !== null,
    seconds: state.deadline === null ? 0 : Math.max(0, Math.ceil((state.deadline - now) / 1000)),
    waiting: state.waiting,
    deferred: state.deferred,
    installing: state.installing,
  };
}

/** 主界面那一句：按快照阶段与自动安装的样子说清下一步。 */
export function autoInstallText(view: AutoInstallView, snapshot: UpdateSnapshot): string {
  if (view.installing) return "正在保存并重启安装…";
  if (snapshot.phase !== "ready") return updateText(snapshot);
  if (view.deferred) return `新版本 ${snapshot.version} 已就绪；本次不再自动安装，可在高级设置里手动安装`;
  if (view.counting) return `新版本 ${snapshot.version} 已就绪，${view.seconds} 秒后自动保存并重启安装`;
  if (view.waiting) return `新版本 ${snapshot.version} 已就绪，${view.waiting}。`;
  return updateText(snapshot);
}

/** 一件事的结局：交给安装器了没有、没交出去的原因。 */
export type InstallOutcome = { ok: true } | { ok: false; reason?: string };

/** 自动安装对外的接线。 */
export interface AutoInstallPorts {
  now(): number;
  /** 真去装：先准备（等任务、严格保存）再交给安装器；失败返回原因。 */
  install(): Promise<InstallOutcome>;
  /** 状态变了：把新的样子交给界面重绘。 */
  changed(view: AutoInstallView): void;
}

/** 自动安装对外的那一层：React 只调这几个方法。 */
export interface AutoInstall {
  /** 推进一步并返回界面要的样子。 */
  pump(input: AutoInstallInput): AutoInstallView;
  /** 用户点「稍后」：本轮不再自动装。 */
  defer(): void;
  /** 界面要的样子（不推进）。 */
  view(): AutoInstallView;
}

export function createAutoInstall(ports: AutoInstallPorts): AutoInstall {
  let state = INITIAL_AUTO_STATE;

  /** 交给安装器；装上了就不再回来（程序会重启），失败就回到等待。 */
  async function fire(): Promise<void> {
    state = { ...state, installing: true, waiting: "" };
    ports.changed(autoInstallView(state, ports.now()));
    const result = await ports.install();
    // 装上了就不再回来：程序会重启，状态没有后续。
    if (result.ok) return;
    state = { ...state, installing: false, waiting: result.reason ?? "" };
    ports.changed(autoInstallView(state, ports.now()));
  }

  return {
    pump(input) {
      const step = autoStep(state, input, ports.now());
      state = step.state;
      if (step.install) void fire();
      return autoInstallView(state, ports.now());
    },
    defer() {
      state = { ...state, deferred: true, deadline: null };
      ports.changed(autoInstallView(state, ports.now()));
    },
    view: () => autoInstallView(state, ports.now()),
  };
}

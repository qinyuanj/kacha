// 更新检查与安装的排程与状态（#164）：从 v0.3.2 的 updateFlow 复用行为，
// 但判定全部落在「公开检查/准备/安装服务」上，界面只按这里的阶段分支。

/** 启动后多久检查第一次：约 3 秒，让界面先画出来。 */
export const STARTUP_DELAY_MS = 3000;

/** 每次检查结束后隔多久再检查：约 6 小时。 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 更新此刻的阶段；与 Go 侧 updateservice.Phase 同名同义。 */
export type UpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

/** 更新状态快照（Go 侧 Snapshot 的页面镜像）。 */
export interface UpdateSnapshot {
  phase: UpdatePhase;
  current: string;
  version: string;
  notes: string;
  page_url: string;
  downloaded: number;
  total: number;
  /** 发布者签名已在本机验过。 */
  verified: boolean;
  /** 可以点安装：已验签且还没在装。 */
  installable: boolean;
  error: string;
  checked_at: string;
}

/** 空快照：还没连上服务时的样子。 */
export function emptySnapshot(): UpdateSnapshot {
  return {
    phase: "idle",
    current: "",
    version: "",
    notes: "",
    page_url: "",
    downloaded: 0,
    total: 0,
    verified: false,
    installable: false,
    error: "",
    checked_at: "",
  };
}

/**
 * 两次快照的内容是否一样（#180）。
 *
 * 工作台这一层每半秒到五秒读一次状态；内容没变就不该重绘——画布很重，
 * 别让轮询带着整个工作台重排。
 */
export function sameUpdateSnapshot(a: UpdateSnapshot, b: UpdateSnapshot): boolean {
  // 按序列化结果比：字段少、形状固定，比逐字段写一遍更不容易漏掉新加的字段。
  // 字段顺序不同只会多一次重绘，不会把「变了」误判成「没变」。
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 下一次自动检查该在多久之后：只在检查结束后计时，不在启动时固定计时。 */
export function nextCheckDelay(snapshot: UpdateSnapshot, now: number): number | null {
  if (snapshot.phase === "disabled" || snapshot.phase === "installing") return null;
  if (snapshot.phase !== "checking" && snapshot.checked_at) {
    const at = Date.parse(snapshot.checked_at);
    if (!Number.isNaN(at)) return Math.max(0, at + CHECK_INTERVAL_MS - now);
  }
  // 还没检查过（或正在检查）：按启动延迟算，检查结束后会重新排。
  return snapshot.phase === "checking" ? null : STARTUP_DELAY_MS;
}

/** 能不能点「检查更新」：正在检查、正在装时不能。 */
export function canCheck(snapshot: UpdateSnapshot): boolean {
  return snapshot.phase !== "disabled" && snapshot.phase !== "checking" && snapshot.phase !== "installing";
}

/** 能不能点「安装」：只有已验签且服务说可装。 */
export function canInstall(snapshot: UpdateSnapshot): boolean {
  return snapshot.phase === "ready" && snapshot.verified && snapshot.installable;
}

/** 每个阶段的一句话：查表而不是分支，新增阶段时只补一行。 */
const PHASE_TEXT: Record<UpdatePhase, (snapshot: UpdateSnapshot) => string> = {
  disabled: () => "自动更新尚不可用",
  idle: () => "尚未检查更新",
  checking: () => "正在检查更新…",
  up_to_date: () => "已是最新版本",
  available: (s) => `发现新版本 ${s.version}，准备下载`,
  downloading: (s) => `正在下载 ${s.version}${progressText(s)}`,
  ready: (s) => `新版本 ${s.version} 已下载并验签，可安装`,
  installing: () => "正在安装，安装完成后请重新启动",
  // 失败必须给原因；没有原因时也要说「失败」，不能说成正常。
  error: (s) => s.error || "检查更新失败",
};

/**
 * 状态一句话：高级设置里的更新面板与主界面的更新提示条共用（#180 起顶栏那一句才真的接上，
 * 此前注释先说共用、实际只有设置页在用）。
 */
export function updateText(snapshot: UpdateSnapshot): string {
  const text = PHASE_TEXT[snapshot.phase];
  return text ? text(snapshot) : PHASE_TEXT.error(snapshot);
}

/** 下载进度的百分比文案；总字节未知时给空串。 */
export function progressText(snapshot: UpdateSnapshot): string {
  if (snapshot.total <= 0) return "";
  const percent = Math.min(100, Math.floor((snapshot.downloaded / snapshot.total) * 100));
  return `（${percent}%）`;
}

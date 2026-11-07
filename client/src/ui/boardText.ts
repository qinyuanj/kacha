// 画板相关的用户可见提示文案；跨语言的值由共享契约定义。
import policy from "../../../contracts/board-policy.json" with { type: "json" };

/** 画板已不存在（另一页面删除或改名）。 */
export const BOARD_MISSING_TEXT = "该画板已不存在，可能已在别处改名或删除";

/** 工具栏「新建任务模型」：默认模型 Flash 不在可用列表时的占位项。 */
export const FLASH_UNAVAILABLE_TEXT = "Flash 不可用，请刷新模型列表";

/** 定稿结果节点上的角标。 */
export const FINAL_BADGE_TEXT = "定稿";

/** 阶段框标题栏上的按钮。 */
export const STAGE_TEXT = {
  collapse: "收起",
  expand: "展开",
  addSelected: "加入所选",
  delete: "删除阶段",
  /** 收起时显示的成员数。 */
  count: (n: number) => `${n} 个节点`,
} as const;

/** 顶栏常驻的备份提示。 */
export const BACKUP_HINT_TEXT = "服务端不备份，重要画板请导出。";

/** 设置 › 用量：闲置用户规则（画板没有有效期）。 */
export const IDLE_USER_RULE_TEXT = "画板不会因为时间被删。60 天没用 Kacha，全部数据可能被清理。";

/** 画板位已用 / 总数（#89）。 */
export interface Slots {
  used: number;
  total: number;
}

const SLOTS_FULL_HEAD = policy.slots_full_head;

/** 上传前的预检与服务端拒绝共用契约文案。 */
export const boardSlotsFullText = ({ used, total }: Slots) => policy.slots_full.replace("{head}", SLOTS_FULL_HEAD).replace("{used}", String(used)).replace("{total}", String(total));

/** 服务端合并前按画板位拒绝时，导入报错原文就是统一文案（错误码在 runCancellable 里变成了文本）。 */
export const isSlotsFullText = (text: string) => text.startsWith(SLOTS_FULL_HEAD);

/** 服务端画板位满的错误码（409）。 */
export const BOARD_SLOTS_FULL = "board_slots_full";

/** 要新增 adding 块画板时：放不下给出统一文案，放得下为 null。 */
export const slotsRefusal = (slots: Slots, adding: number): string | null =>
  adding > 0 && slots.used + adding > slots.total ? boardSlotsFullText(slots) : null;

/** 画板列表里的画板位用量。 */
export const slotsUsageText = ({ used, total }: Slots) => `画板位 ${used}/${total}`;

/** 归档画板（#90）：确认框、只读横条与按钮。 */
export const ARCHIVE_TEXT = {
  action: "归档",
  confirm: "归档后只读，不占画板位，随时可以取消。归档不是备份。",
  banner: "已归档，只读",
  unarchive: "取消归档",
  copy: "复制为新画板",
  /** 画板列表里归档画板一组的标题。 */
  group: "已归档",
  /** 在归档画板上试图编辑时的提示。 */
  readOnly: policy.archived_read_only,
} as const;

/** 导入画板包的结局（#86：任务目录合并与画板提交在服务端同一个导入请求里完成）。 */
export const PACK_IMPORT_TEXT = {
  failed: (error: string) => `导入画板包失败：${error}`,
  cancelled: "已取消导入；已移入的任务目录保留",
  /** 服务端导入请求失败时弹窗里的说明：画板一块都没写入。 */
  commitFailed: "画板没有写入。已移入的任务目录保留，重新导入时会跳过它们。",
  /** 服务端已写好画板，只是本页打开失败。 */
  openFailed: (error: string) => `画板已导入，但打开失败：${error}。可从画板列表打开。`,
} as const;

/** 已超出画板位的老用户：现有画板照常编辑，列表顶部提示。 */
export const OVER_SLOTS_TEXT = "归档几块后才能新建。";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** 画板体量一律写「约 X」：服务端按任务目录累加、不去重，可能略大于导出画板包时的预估（#87）。 */
export const approxSizeText = (bytes: number) => `约 ${formatBytes(bytes)}`;

/** 用量提醒（#88）里的入口与「管理画板」对话框标题。 */
export const MANAGE_BOARDS_TEXT = "管理画板";

/** 用量接近（warn）/ 达到（alert）用量上限时的提醒；只提醒，生成照常。 */
export const usageLimitText = (level: "warn" | "alert", total: number, limit: number) =>
  level === "alert"
    ? `用量已满（${formatBytes(total)} / 上限 ${formatBytes(limit)}），生成不受影响，请整理画板释放空间。`
    : `用量接近上限（${formatBytes(total)} / 上限 ${formatBytes(limit)}），整理一下画板？`;

/** 当前画板越过体量提醒线时画布顶部的提示。 */
export const sizeNoticeText = (bytes: number) => `这块画板已经${approxSizeText(bytes)} 了，整理一下？`;

/** 整理模式（#92）。 */
export const TIDY_TEXT = {
  /** 越线提示与工具栏上进入整理模式的按钮。 */
  enter: "整理",
  done: "完成",
  measuring: "正在计算体量…",
  /** 顶部整理前后的体量对比。 */
  compare: (before: number, now: number) => `整理前${approxSizeText(before)} → 现在${approxSizeText(now)}`,
  /** 阶段框上的动作。 */
  prune: (n: number) => `收掉未定稿（${n}）`,
  pruneTitle: "收掉未定稿",
  pruneOk: "收掉",
  /** 确认框；saved 为 null = 体量暂时算不出。 */
  pruneConfirm: (n: number, saved: number | null) =>
    `将收掉 ${n} 张，${saved === null ? "画板体量暂时算不出" : `画板约减少 ${formatBytes(saved)}`}。\n定稿与已被下游使用的结果保留；可以撤销。`,
  nothingToPrune: "这个阶段没有可收掉的结果：定稿与已被下游使用的结果会保留。",
  /** 阶段框上的「移出为新画板」（#93）。 */
  moveOut: "移出为新画板",
  moveOutHint: "把这个阶段拆成一块新画板：跨阶段的连线断开，上游图片在新画板里成为参考图。占一个画板位。",
  movedOut: (title: string) => `已移出为新画板「${title}」，可在画板列表里打开。撤销只恢复本画板，新画板保留。`,
  /** 新画板写好之后原画板的移出被拒（期间有任务开始运行）。 */
  movedOutKept: (title: string, reason: string | null) => `新画板「${title}」已建好，但本画板没有删去这些节点${reason ? `：${reason}` : ""}`,
  moveOutFailed: (reason: string) => `移出失败：${reason}`,
  moveOutBusy: "正在移出另一个阶段，请稍候",
} as const;

// 画板相关的用户可见提示文案：源码与 e2e 断言共用这一份，改文案只改这里。

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

const SLOTS_FULL_HEAD = "画板位满了";

/**
 * 画板位满时新建 / 导入被拒的统一文案。服务端 board_list::ensure_board_slots 的 409 message 是同一句，
 * 改一处要同改另一处（前端在发请求前就按列表里的画板位自己判定，用这一份）。
 */
export const boardSlotsFullText = ({ used, total }: Slots) => `${SLOTS_FULL_HEAD}（${used}/${total}），归档或删掉一块再新建。`;

/** 服务端合并前按画板位拒绝时，导入报错原文就是统一文案（错误码在 runCancellable 里变成了文本）。 */
export const isSlotsFullText = (text: string) => text.startsWith(SLOTS_FULL_HEAD);

/** 服务端画板位满的错误码（409）。 */
export const BOARD_SLOTS_FULL = "board_slots_full";

/** 要新增 adding 块画板时：放不下给出统一文案，放得下为 null。 */
export const slotsRefusal = (slots: Slots, adding: number): string | null =>
  adding > 0 && slots.used + adding > slots.total ? boardSlotsFullText(slots) : null;

/** 画板列表里的画板位用量。 */
export const slotsUsageText = ({ used, total }: Slots) => `画板位 ${used}/${total}`;

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
} as const;

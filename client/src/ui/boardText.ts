// 画板相关的用户可见提示文案；跨语言的值由共享契约定义。
import policy from "../../../contracts/board-policy.json" with { type: "json" };
import { MAX_PASTE_BYTES, type PasteFailures, type PasteRefusal } from "../core/pageInput";

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
  /** 「收掉未定稿」确认框的取消按钮（确认框见 canvasStageView）。 */
  cancelLabel: "取消",
} as const;

/** 粘贴（#96）：被拒时的原因文案与超限提示。只读归档沿用共享的 ARCHIVE_TEXT.readOnly。 */
export const PASTE_TEXT = {
  /** 剪贴板里的节点标记还在，但应用内剪贴板已空：刷新过页面、或标记来自另一个标签页。 */
  staleNodeClip: "剪贴板里的节点已失效，重新复制节点后再粘贴",
  /** 剪贴板里是文件本身：浏览器不给页面读文件内容，只能拖入。 */
  filesNotReadable: "剪贴板里是文件，浏览器读不到内容：请把文件拖进画板",
  /** 单张图片超过服务端单请求上限：不发请求，先提示压缩。 */
  tooLarge: `图片超过 ${MAX_PASTE_BYTES / (1024 * 1024)} MB 上限，先压缩再粘贴`,
  /** 剪贴板里是文件 / HTML / URI 类内容，其中却没有受支持图片：告诉用户改用哪种做法。 */
  noSupportedImage: "剪贴板里没有可用的图片：请把图片文件拖进画板，或用工具栏的「＋ 参考图…」选择图片",
  /** 剪贴板里是网络地址（图片或链接）：应用不主动抓，也不代为下载。 */
  remoteImage: "剪贴板里是网络地址，Kacha 不会去下载图片：请先把图片保存到本机，再拖进画板",
  /** 内嵌图片（data URL）没读出来：具体原因见 pasteImageFailureText。 */
  imageFailed: "内嵌图片读不出来，请改用图片文件拖进画板",
  /** 节点标记写不进系统剪贴板：Ctrl+V 粘节点会失效，给一条不等粘贴的替代动作。 */
  markerUnwritable: "无法写入系统剪贴板：Ctrl+V 粘贴节点可能不生效，可用 Ctrl+J 原地复制",
  /** 工具栏「＋ 参考图…」的悬浮提示：粘贴没有按钮入口（内网 HTTP 下页面读不到剪贴板），只能用文案告诉用户。 */
  toolbarHint: "选择图片文件加为参考图节点（也可以直接按 Ctrl+V 粘贴截图）",
} as const;

/** 粘贴被拒时给用户的话：拒绝原因到文案的映射只在这里，界面不各自写一份。 */
export const pasteRefusalText = (reason: PasteRefusal): string => (reason === "readOnly" ? ARCHIVE_TEXT.readOnly : PASTE_TEXT[reason]);

/**
 * 内嵌图片（data URL）失败的具体原因：按分类给一句话。
 * 同批其它图片仍会照常导入，这里只说明失败的那几张为什么没进来。
 * 文案里不带任何来源地址或鉴权信息。
 */
export const pasteImageFailureText = (failures: PasteFailures): string => {
  const parts: string[] = [];
  if (failures.invalid > 0) parts.push(`${failures.invalid} 张内嵌图片无法解码`);
  if (failures.unsupported > 0) parts.push(`${failures.unsupported} 张内嵌图片格式不受支持`);
  if (failures.tooLarge > 0) parts.push(`${failures.tooLarge} 张内嵌图片超过 ${MAX_PASTE_BYTES / (1024 * 1024)} MB 上限`);
  return parts.length ? `${parts.join("；")}，已跳过` : PASTE_TEXT.imageFailed;
};

/** 「另存为」（参考图 / 结果节点）的提示：结果带图层时服务端打的是 zip。 */
export const SAVE_TEXT = {
  started: "已开始下载（结果带图层时为 zip）",
  failed: (reason: string) => `另存失败：${reason}`,
} as const;

/** 「生成变体」：父任务已不在画板上（菜单置灰规则之外，这里可能刚被撤销掉）。 */
export const VARIANT_TEXT = {
  parentGone: "父任务已删除，无法生成变体",
} as const;

/** 框选修改区域：拒绝原因、放大预览弹窗的标题、弹窗里的目标标注与画布连线上的区域数徽标。 */
export const REGION_TEXT = {
  /** 模型不支持框选修改区域时给用户的原因。 */
  unsupported: "当前模型不支持框选修改区域",
  /** 弹窗标题：源节点名（参考图用显示名，结果用文件名）。 */
  previewTitle: (name: string) => `框选修改区域 · ${name}`,
  /** 弹窗里的一条可编辑区域线：模型显示名 + 图序号（1 起）。 */
  targetLabel: (modelName: string, port: number) => `${modelName} 的图${port}`,
  /** 连线上的区域数徽标。 */
  edgeLabel: (count: number) => `${count} 区域`,
} as const;

/** 删除排队 / 执行中的任务节点前的确认框（「先取消再删除」）。 */
export const DELETE_TASK_TEXT = {
  title: "删除任务节点",
  ok: "取消并删除",
  cancel: "不删除",
  /** running = 要删的排队 / 执行中任务数；第二行说明网关侧计算可能仍在继续。 */
  confirm: (running: number) => `${running} 个任务正在排队 / 执行。先取消再删除？\n已在执行的只停止本地等待，网关侧计算可能仍在继续。`,
} as const;

/** 缺图节点重新定位的提示：根目录内没找到（可改手动选文件）、找到了却读不了。 */
export const RELOCATE_TEXT = {
  missing: (name: string) => `在用户数据根内没有找到 ${name}，可改为手动选择文件`,
  unreadable: (name: string, reason: string) => `无法读取 ${name}：${reason}`,
} as const;

/** 本机图片导入（文件选择器 / 拖入 / 粘贴）：不是图片文件时的提示，与逐张失败的原因。 */
export const IMPORT_TEXT = {
  imageOnly: "只支持拖入图片文件",
  failed: (name: string, reason: string) => `无法导入 ${name}：${reason}`,
} as const;

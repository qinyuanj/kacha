// 画板相关的用户可见提示文案；跨语言的值由共享契约定义。
import policy from "../../../contracts/board-policy.json" with { type: "json" };
import type { ClipboardNotice } from "../core/clipboardDispatch";
import { MAX_PASTE_BYTES, type PasteRefusal } from "../core/pageInput";

/** 画板已不存在（另一页面删除或改名）。 */
export const BOARD_MISSING_TEXT = "该画板已不存在，可能已在别处改名或删除";

/** 原文件丢失时保留内存改动的恢复指引。 */
export const MISSING_BOARD_RECOVERY_TEXT = "请勿关闭当前画板；请先恢复原文件路径后重试保存";

/** 工具栏「新建任务模型」：默认模型 Flash 不在可用列表时的占位项。 */
export const FLASH_UNAVAILABLE_TEXT = "Flash 不可用，请刷新模型列表";

/** 定稿结果节点上的角标。 */
export const FINAL_BADGE_TEXT = "定稿";

/** 阶段框标题栏：收起时显示的成员数。 */
export const STAGE_TEXT = {
  count: (n: number) => `${n} 个节点`,
} as const;

/** 画板位已用 / 总数（#89）。 */
export interface Slots {
  used: number;
  total: number;
}

const SLOTS_FULL_HEAD = policy.slots_full_head;

/** 上传前的预检与本机存储拒绝共用契约文案。 */
export const boardSlotsFullText = ({ used, total }: Slots) => policy.slots_full.replace("{head}", SLOTS_FULL_HEAD).replace("{used}", String(used)).replace("{total}", String(total));

/** 本机存储合并前按画板位拒绝时，导入报错原文就是统一文案（错误码在 runCancellable 里变成了文本）。 */
export const isSlotsFullText = (text: string) => text.startsWith(SLOTS_FULL_HEAD);

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

/** 导入画板包的结局（#86：任务目录合并与画板提交在本机存储同一个导入请求里完成）。 */
export const PACK_IMPORT_TEXT = {
  failed: (error: string) => `导入画板包失败：${error}`,
  cancelled: "已取消导入；已移入的任务目录保留",
  /** 本机存储导入请求失败时弹窗里的说明：画板一块都没写入。 */
  commitFailed: "画板没有写入。已移入的任务目录保留，重新导入时会跳过它们。",
  /** 本机存储已写好画板，只是本页打开失败。 */
  openFailed: (error: string) => `画板已导入，但打开失败：${error}。可从画板列表打开。`,
} as const;

/** 已超出画板位的老用户：现有画板照常编辑，列表顶部提示。 */
export const OVER_SLOTS_TEXT = "删除不再需要的画板后才能新建。";

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

/** 画板体量一律写「约 X」：本机存储按任务目录累加、不去重，可能略大于导出画板包时的预估（#87）。 */
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

/** 建议保留（#144）：系统在整理模式里推断该留、尚未定稿的结果。只在整理模式里存在，不写进画板。 */
export const SUGGEST_KEEP_TEXT = {
  /** 结果节点上的标记。 */
  badge: "建议保留",
} as const;

/** 整理模式（#92）。 */
export const TIDY_TEXT = {
  /** 越线提示与工具栏上进入整理模式的按钮。 */
  enter: "整理",
  done: "完成",
  measuring: "正在计算体量…",
  /** 量不出来时照实说：读不出画板或读盘失败，不显示成 0。 */
  measureFailed: "体量暂时算不出",
  /** 整理模式下阶段体量的未知占位。 */
  sizeUnknown: "未知",
  /** 顶部整理前后的体量对比。 */
  compare: (before: number, now: number) => `整理前${approxSizeText(before)} → 现在${approxSizeText(now)}`,
} as const;

/** 粘贴（#96）：被拒时的原因文案与超限提示。只读归档沿用共享的 ARCHIVE_TEXT.readOnly。 */
export const PASTE_TEXT = {
  /** 剪贴板里的节点标记还在，但应用内剪贴板已空：刷新过页面、或标记来自另一个标签页。 */
  staleNodeClip: "剪贴板里的节点已失效，重新复制节点后再粘贴",
  /** 剪贴板里是文件本身：浏览器不给页面读文件内容，只能拖入。 */
  filesNotReadable: "剪贴板里是文件，暂不支持粘贴文件：请把图片拖进画板",
  /** 单张图片超过本机存储单请求上限：不发请求，先提示压缩。 */
  tooLarge: `图片超过 ${MAX_PASTE_BYTES / (1024 * 1024)} MB 上限，先压缩再粘贴`,
  /** 节点标记写不进系统剪贴板：Ctrl+V 粘节点会失效，给一条不等粘贴的替代动作。 */
  markerUnwritable: "无法写入系统剪贴板：Ctrl+V 粘贴节点可能不生效，可用 Ctrl+J 原地复制",
  /** 剪贴板里什么都没有（#129）：桌面壳读得到剪贴板，空的时候要说一声，不能按了没反应。 */
  empty: "剪贴板里没有可粘贴的内容",
  unavailable: "无法读取系统剪贴板，请稍后重试",
  /** 剪贴板里是不受支持的内容（HEIC、TIFF 等非 PNG 图片，或别的富文本）：说清是什么不行。 */
  unsupported: "剪贴板里的内容不受支持：请复制图片（PNG）或本应用的节点",
  /** 剪贴板正被别的程序占用（#129）：可重试，不要说得像永久失败。 */
  busy: "剪贴板正被其他程序占用，请稍后重试",
  /** 工具栏「＋ 参考图…」的悬浮提示：粘贴没有按钮入口（内网 HTTP 下页面读不到剪贴板），只能用文案告诉用户。 */
  toolbarHint: "选择图片文件加为参考图节点（也可以直接按 Ctrl+V 粘贴截图）",
} as const;

/** 读不出剪贴板内容时给用户的话（#129）：空、格式不支持、被占用（可重试）。 */
export const clipboardNoticeText = (notice: ClipboardNotice): string => PASTE_TEXT[notice];

/** 粘贴被拒时给用户的话：拒绝原因到文案的映射只在这里，界面不各自写一份。 */
export const pasteRefusalText = (reason: PasteRefusal): string => (reason === "readOnly" ? ARCHIVE_TEXT.readOnly : PASTE_TEXT[reason]);

/** 「另存为」（参考图 / 结果节点）的提示：结果带图层时本机存储打的是 zip。 */
export const SAVE_TEXT = {
  started: "已保存图片副本",
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
  missing: (name: string) => `在数据根内没有找到 ${name}，可改为手动选择文件`,
  unreadable: (name: string, reason: string) => `无法读取 ${name}：${reason}`,
} as const;

/** 本机图片导入（文件选择器 / 拖入 / 粘贴）：不是图片文件时的提示，与逐张失败的原因。 */
export const IMPORT_TEXT = {
  imageOnly: "只支持拖入图片文件",
  failed: (name: string, reason: string) => `无法导入 ${name}：${reason}`,
} as const;

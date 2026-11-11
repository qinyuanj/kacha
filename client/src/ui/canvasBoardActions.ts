// 画布动作（BoardActions）的构造：上下文菜单、悬浮动作条、节点按钮与放大预览共用的迭代、草稿、
// 预览、区域编辑、变体与重新定位。每个动作一个模块顶层工厂函数，画布组件只把 ref、本地状态 setter
// 与写入入口接进来；行为、文案与日志字段与拆分前逐字一致。
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Board } from "../core/board";
import type { CapabilityTable } from "../core/capabilities";
import { continueEditingChange, type BoardChange, type EditResult } from "../core/edit";
import { errorText } from "../core/errors";
import type { ExpandOverrides } from "../core/expand";
import { LOCKED_HINT, producerOf } from "../core/iterate";
import { basename, resolveFromRoot, toRootRelative } from "../core/paths";
import { findReferenceFile, findResultFile } from "../core/relocate";
import { availableModels, type Discovery } from "../core/settings";
import { relocateFs } from "../shell/adapters";
import { ipc, transfer, type ImageInfo } from "../shell/ipc";
import { logEvent } from "../shell/log";
import { RELOCATE_TEXT, REGION_TEXT, VARIANT_TEXT } from "./boardText";
import { imageNodeOf, nodePreviewRequest, regionEditRequest, type ImageNode } from "./canvasPreview";
import { posOf } from "./canvasPoint";
import type { BoardActions } from "./context";
import type { PreviewRequest } from "./PreviewDialog";

/** 缺图节点重新定位的两条路：pick = 选本机文件，search = 在用户数据根内按身份找。 */
type RelocateMode = BoardActions["relocate"] extends (nodeId: string, mode: infer M) => void ? M : never;

/** 重新定位的日志结局：成功，或未找到 / 读不了。 */
type RelocateOutcome = { ok: true } | { ok: false; reason: "not_found" | "unreadable" };

/**
 * 画布动作的依赖：画板与能力表、跨渲染状态（ref）、本地状态 setter 与各类写入入口。
 * apply 是画布组件里那层（只读拒绝、提示原因、按建议选中），会返回试算结果的写入入口。
 */
export interface CanvasBoardActionsDeps {
  table: CapabilityTable;
  /** 画板文件名，只用于日志。 */
  boardFile: string;
  userRoot: string;
  discovery: Discovery;
  concurrency: number;
  /** 画板写入：被拒或需告知时提示原因，并在有建议选中时切换选区。 */
  apply: (change: BoardChange) => EditResult | null;
  boardRef: MutableRefObject<Board>;
  selectedRef: MutableRefObject<ReadonlySet<string>>;
  /** 排队 / 执行中的任务节点：框选修改区域不再可用。 */
  lockedRef: MutableRefObject<ReadonlySet<string>>;
  /** 「以此继续编辑」的一次性聚焦请求：权威值在这个 ref 上。 */
  focusPromptRef: MutableRefObject<string | null>;
  requestPromptFocus: (promptId: string | null) => void;
  setPromptDrafts: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
  setExpandOverrides: Dispatch<SetStateAction<ExpandOverrides>>;
  /** 图片节点卸载（离开视口、被删）：收起它的悬浮动作条。 */
  unhoverNode: (nodeId: string) => void;
  /** 打开放大预览弹窗（画布组件负责 nonce 递增）。 */
  showPreview: (req: PreviewRequest) => void;
  /** 读到的图片信息进缓存：刚重定位的图片不等下一轮批量读取。 */
  primeImageInfo: (absPath: string, info: ImageInfo) => void;
  /** 生成变体：按 resultId 的父任务目录重跑。 */
  onRegenerate: (taskId: string, fromTaskId?: string) => void;
  toast: (message: string) => void;
  /** perform 依赖每次渲染重建的新建类函数，经 ref 取最新一版，动作对象因此可以稳定。 */
  performRef: MutableRefObject<BoardActions["perform"]>;
}

/** 「以此继续编辑」：新建的提示词选中并取一次性聚焦，新建的任务节点（新提示词接的那个）也默认展开。 */
function continueEditingAction(deps: CanvasBoardActionsDeps): BoardActions["continueEditing"] {
  return (nodeId, sourceLayer = null, at) => {
    const r = deps.apply(continueEditingChange(deps.selectedRef.current, nodeId, sourceLayer, at ? posOf(at) : null));
    const promptId = r?.step && r.selection?.[0];
    if (!promptId) return;
    const taskId = r.board.edges.find((e) => e.from[0] === promptId && e.to[1] === "positive")?.to[0];
    if (taskId) deps.setExpandOverrides((o) => new Map([...o, [taskId, true]]));
    deps.requestPromptFocus(promptId);
  };
}

/** 提示词等待三选一的未提交文本：null = 清掉；没有变化时返回原 Map（不触发重渲染）。 */
function setPromptDraftAction(deps: CanvasBoardActionsDeps): BoardActions["setPromptDraft"] {
  return (promptId, text) =>
    deps.setPromptDrafts((d) => {
      if (text === null ? !d.has(promptId) : d.get(promptId) === text) return d;
      const next = new Map(d);
      if (text === null) next.delete(promptId);
      else next.set(promptId, text);
      return next;
    });
}

/** 一次性聚焦请求：仍指向该提示词时清掉并返回 true（只聚焦一次）。 */
function takePromptFocusAction(deps: CanvasBoardActionsDeps): BoardActions["takePromptFocus"] {
  return (promptId) => {
    if (deps.focusPromptRef.current !== promptId) return false;
    deps.requestPromptFocus(null);
    return true;
  };
}

/** 放大预览：参考图 / 结果节点才有请求，其余静默不弹。 */
function previewNodeAction(deps: CanvasBoardActionsDeps): BoardActions["previewNode"] {
  return (nodeId) => {
    const req = nodePreviewRequest(deps.boardRef.current, deps.table, deps.userRoot, nodeId);
    if (!req) return;
    deps.showPreview(req);
  };
}

/**
 * 任务端口行「指示区域」：锁定任务只提示锁定；模型不支持框选区域时给拒绝原因；
 * 线找到了但源节点不是参考图 / 结果节点时静默（与拆分前一致，不额外提示）。
 */
function editRegionAction(deps: CanvasBoardActionsDeps): BoardActions["editRegion"] {
  return (taskId, ref) => {
    if (deps.lockedRef.current.has(taskId)) return deps.toast(LOCKED_HINT);
    const result = regionEditRequest(deps.boardRef.current, deps.table, deps.userRoot, taskId, ref);
    if (result.kind === "refuse") return deps.toast(REGION_TEXT.unsupported);
    if (result.kind === "ignore") return;
    deps.showPreview(result.req);
  };
}

/** 生成变体：按结果节点的父任务目录重跑；父任务已删除时提示（与菜单置灰原因不同，这里可能刚被撤销掉）。 */
function generateVariantAction(deps: CanvasBoardActionsDeps): BoardActions["generateVariant"] {
  return (resultId) => {
    const b = deps.boardRef.current;
    const result = b.nodes.find((n) => n.id === resultId);
    const parent = producerOf(b, resultId);
    if (result?.type !== "result" || !parent) return deps.toast(VARIANT_TEXT.parentGone);
    deps.onRegenerate(parent.id, result.task_id);
  };
}

/** 重新定位的日志：类别固定，字段与拆分前逐字一致（成功 / 未找到 / 读不了）。 */
function relocateLog(deps: CanvasBoardActionsDeps, node: ImageNode, mode: RelocateMode) {
  return (outcome: RelocateOutcome): void => logEvent("relocate", { board_file: deps.boardFile, node_id: node.id, node_type: node.type, mode, ...outcome });
}

/** 重新定位没找到时的提示：结果是文件名，参考图是显示名。 */
function relocateMissingText(node: ImageNode): string {
  const name = node.type === "result" ? node.file : node.display_name;
  return RELOCATE_TEXT.missing(name);
}

/** 选文件重定位：本机文件先上传到当前用户数据根，再更新节点引用。 */
async function relocateByPick(deps: CanvasBoardActionsDeps, node: ImageNode): Promise<void> {
  const logRelocate = relocateLog(deps, node, "pick");
  const files = await transfer.pickLocalImages(false);
  if (!files.length) return;
  const file = files[0];
  try {
    const uploaded = await transfer.uploadReference(file);
    const abs = resolveFromRoot(deps.userRoot, uploaded.path);
    const info = await ipc.inspectImage(abs);
    deps.primeImageInfo(abs, info);
    deps.apply({ kind: "relocate", nodeId: node.id, path: uploaded.path, sha256: info.sha256, fileName: file.name, picked: true });
    logRelocate({ ok: true });
  } catch (e) {
    logRelocate({ ok: false, reason: "unreadable" });
    deps.toast(RELOCATE_TEXT.unreadable(file.name, errorText(e)));
  }
}

/** 在用户数据根内按身份找：结果按 task_id 找任务目录，参考图按 sha256 找文件。 */
async function relocateBySearch(deps: CanvasBoardActionsDeps, node: ImageNode): Promise<void> {
  const logRelocate = relocateLog(deps, node, "search");
  const abs =
    node.type === "result"
      ? await findResultFile(relocateFs, deps.userRoot, { task_id: node.task_id, file: node.file })
      : await findReferenceFile(relocateFs, deps.userRoot, { sha256: node.sha256, display_name: node.display_name });
  if (!abs) {
    logRelocate({ ok: false, reason: "not_found" });
    return deps.toast(relocateMissingText(node));
  }
  try {
    const info = await ipc.inspectImage(abs);
    deps.primeImageInfo(abs, info);
    deps.apply({ kind: "relocate", nodeId: node.id, path: toRootRelative(deps.userRoot, abs), sha256: info.sha256, fileName: basename(abs), picked: false });
    logRelocate({ ok: true });
  } catch (e) {
    logRelocate({ ok: false, reason: "unreadable" });
    deps.toast(RELOCATE_TEXT.unreadable(basename(abs), errorText(e)));
  }
}

/** 缺图节点重新定位：pick = 选文件，search = 在用户数据根内按身份找。 */
function relocateAction(deps: CanvasBoardActionsDeps): BoardActions["relocate"] {
  return (nodeId, mode) =>
    void (async () => {
      const node = imageNodeOf(deps.boardRef.current, nodeId);
      if (!node) return;
      if (mode === "pick") return relocateByPick(deps, node);
      return relocateBySearch(deps, node);
    })();
}

/** 画布动作：上下文菜单、悬浮动作条、节点按钮与放大预览共用的一套写入口。 */
export function canvasBoardActions(deps: CanvasBoardActionsDeps): BoardActions {
  return {
    perform: (action, target, at) => deps.performRef.current(action, target, at),
    table: deps.table,
    userRoot: deps.userRoot,
    availableModels: availableModels(deps.table, deps.discovery),
    concurrency: deps.concurrency,
    apply: (change) => void deps.apply(change),
    continueEditing: continueEditingAction(deps),
    setPromptDraft: setPromptDraftAction(deps),
    takePromptFocus: takePromptFocusAction(deps),
    nodeUnmounted: (nodeId) => deps.unhoverNode(nodeId),
    addAsReference: (resultId, sourceLayer = null) => void deps.apply({ kind: "addAsReference", resultId, selected: [...deps.selectedRef.current], sourceLayer }),
    previewNode: previewNodeAction(deps),
    editRegion: editRegionAction(deps),
    generateVariant: generateVariantAction(deps),
    relocate: relocateAction(deps),
  };
}

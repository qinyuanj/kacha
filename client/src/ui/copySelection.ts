// 复制分派（#130）：Ctrl+C 的语义只看选区（ADR 0021）——恰好单选一张参考图或结果图时复制图片，
// 其余选区（提示词节点、生成任务节点、多选、空选区）仍复制节点标记。
//
// 纯逻辑：不碰 DOM、不起 MyGo runtime、不读文件——真正的写入由壳端口的 media.copyImage 负责
// （桌面壳走 Go 原生剪贴板，Web 走 legacy 的复制命令），这样判定可以在单测里验，
// 而「往剪贴板里写」只有一处。
import type { Board } from "../core/board";
import { copyTarget } from "../core/pageInput";
import { basename } from "../core/paths";

/** 一次 Ctrl+C 的意图：复制图片 / 复制节点 / 什么都不做（空选区）。 */
export type CopyOutcome = { kind: "image"; path: string; format: string } | { kind: "nodes" } | { kind: "nothing" };

/**
 * 选区 → 这次 Ctrl+C 要做什么。
 *
 * 图片路径原样交给端口（相对用户数据根或绝对路径都可以，端口按它取字节）；
 * format 只是提示，Go 侧仍按字节判断容器（HEIC、TIFF 由那边明确失败）。
 */
export function copyOutcome(board: Board, selectedIds: readonly string[]): CopyOutcome {
  if (selectedIds.length === 0) return { kind: "nothing" };
  const target = copyTarget(board, selectedIds);
  if (target.mode !== "image") return { kind: "nodes" };
  return { kind: "image", path: target.node.path, format: imageFormatOf(target.node.path) };
}

/**
 * 图片格式提示：按扩展名给，认不出就给空串（交给 Go 按字节判断）。
 *
 * 扩展名只是提示而不是判据：节点路径来自画板，用户或导入都可能写错扩展名，
 * 真正确认容器的是字节签名（desktop/internal/clipboard 的 Sniff）。
 */
export function imageFormatOf(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  const ext = name.slice(dot + 1);
  return ext === "jpg" ? "jpeg" : ext;
}

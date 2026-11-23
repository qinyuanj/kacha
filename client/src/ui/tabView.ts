// 标签页的判定（#137）：从 ui/TabBar.tsx 拆出的模块级纯函数，便于单测。
// 组件只留接线与 DOM 摆放。
import { basename } from "../core/paths";
import type { Session } from "./useBoardSessions";
import type { ShellPort } from "../shell/port";
import { packMenuEntries } from "./packMenuEntries";

/** 标签上写什么：画板标题，读不出来时写文件名。 */
export function tabTitleOf(s: Session): string {
  return s.status === "ok" ? s.board.title : basename(s.path);
}

/** 标签的样式类：当前标签高亮；读不出来或保存失败标红。 */
export function tabClassOf(s: Session, activeKey: string | null): string {
  const active = s.key === activeKey ? "tab-active" : "";
  const bad = s.status !== "ok" || s.saveError ? "tab-bad" : "";
  return `tab ${active} ${bad}`;
}

/** 双击能不能改名：读不出来的画板没有标题可改。 */
export function canRename(s: Session): boolean {
  return s.status === "ok";
}

/** 双击改名要的草稿：读不出来的画板返回 null（不改名）。 */
export function renameDraftOf(s: Session): string | null {
  return s.status === "ok" ? s.board.title : null;
}

/** 改名输入框按键：回车提交、Esc 取消，其它不处理。 */
export function renameKeyOf(key: string): "commit" | "cancel" | null {
  if (key === "Enter") return "commit";
  if (key === "Escape") return "cancel";
  return null;
}

/** 右键菜单里「导出画板包」这一条要的画板状态。 */
function packBoardOf(s: Session): { open: boolean; broken: boolean } {
  return { open: s.status === "ok", broken: s.status !== "ok" };
}
/** 右键菜单要的那一条：导出画板包。 */
export function tabPackMenu(port: ShellPort, s: Session): { label: string; disabledReason: string | null }[] {
  return packMenuEntries(port, packBoardOf(s)).filter((e) => e.label.startsWith("导出"));
}
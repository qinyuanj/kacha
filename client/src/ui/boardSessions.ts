// 多画板会话的判定逻辑（#137）：从 ui/useBoardSessions.ts 拆出的纯函数，便于单测。
// hook 只留接线；这里一个函数一个意思，覆盖率与 CRAP 都能分开看。
import { isArchivedPath } from "../core/archive";
import { BOARD_MISSING_TEXT, MISSING_BOARD_RECOVERY_TEXT } from "./boardText";
import { portFailureOf, type PortFailureKind } from "../shell/port";

/** 端口失败里属于「冲突」的一类：桌面适配器按本机写入结局映射。 */
const CONFLICT_KINDS: ReadonlySet<PortFailureKind> = new Set(["conflict", "missing", "alreadyExists", "slotsFull", "archived", "cancelled"]);

/** 冲突类= 过期保存 / 旧名已改名 / 同名已存在 / 画板位满 / 已归档 / 已取消：
 *  不自动合并，也不再自动重试，等用户重新载入或改名。 */
export const isConflict = (e: unknown) => CONFLICT_KINDS.has(portFailureOf(e).kind);

/** 画板已不存在（另一页面删除或改名）：带版本保存回 missing，本机存储不会重建它。 */
export const isMissing = (e: unknown) => portFailureOf(e).kind === "missing";

/** 画板位满（#89）：本机存储的 message 即统一文案。 */
export const isSlotsFull = (e: unknown) => portFailureOf(e).kind === "slotsFull";

/** 归档画板（#90）只读：不进画板变更、不撤销、不保存。 */
export const isReadOnly = (userRoot: string | null, path: string) => !!userRoot && isArchivedPath(userRoot, path);

/** 路径比较：Windows 下大小写与分隔符不敏感。 */
export const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** 自动保存失败时的提示：画板已不存在单独说，其余给路径与原因。 */
export function saveErrorText(path: string, reason: string, missing: boolean): string {
  return missing ? `未能保存：${BOARD_MISSING_TEXT}。本页内容仍在。${MISSING_BOARD_RECOVERY_TEXT}` : `未能保存到 ${path}：${reason}`;
}

/** 保存失败后画板的状态标记：冲突与丢失分别打标。 */
export function saveErrorFlags(e: unknown): { conflicted: boolean; missing: boolean } {
  return { conflicted: isConflict(e), missing: isMissing(e) };
}

/** 删除画板前的阻断说明：没保存成功就不删，并说清原因。 */
export function deleteBlockedText(state: { missing: boolean; conflicted: boolean; saveError: string }): string {
  if (state.missing) return `未删除：${BOARD_MISSING_TEXT}`;
  if (state.conflicted) return "未删除：画板已在别处修改，请先重新载入";
  return `未删除：未保存的改动没能保存（${state.saveError}）`;
}

/** 归档前的阻断说明：与删除同一套口径。 */
export function archiveBlockedText(state: { missing: boolean; conflicted: boolean; saveError: string }): string {
  return deleteBlockedText(state);
}

/** 删除失败后的画板状态：画板已不存在就标 missing，其余标 conflicted。 */
export function deleteFailureState(e: unknown): { saveError: string | null; conflicted: boolean; missing: boolean } {
  if (isMissing(e)) return { saveError: `${BOARD_MISSING_TEXT}。本页内容仍在。${MISSING_BOARD_RECOVERY_TEXT}`, conflicted: true, missing: true };
  if (isConflict(e)) return { saveError: `删除失败：${portFailureOf(e).message}`, conflicted: true, missing: false };
  return { saveError: null, conflicted: false, missing: false };
}

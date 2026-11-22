// 「运行」二次确认：逐项列模型、提示词首行、可展开的完整发送文本；标红项列原因且不可勾选；黄色提示不阻断。
// 行与勾选集合的更新各自收成小单元：父组件只管「谁勾着、谁展开着」，判断留在纯函数里。
import { useState } from "react";
import { toggled } from "../core/collections";
import type { ConfirmItem } from "../core/submission";
import { ItemProblems, SendTextBody } from "./SendTextDialog";

interface Props {
  items: ConfirmItem[];
  /** 选中子图还是整个画板。 */
  scope: "selection" | "board";
  onConfirm: (taskIds: string[]) => void;
  onCancel: () => void;
}

/** 初始勾选：只勾没有阻断原因的项——标红项从一开始就不在集合里。 */
function runnableTaskIds(items: ConfirmItem[]): Set<string> {
  return new Set(items.filter((item) => item.reasons.length === 0).map((item) => item.taskId));
}

/** 要回传的任务编号：已勾选且可运行（标红项无论集合里有什么都不回传）。 */
function selectedTaskIds(items: ConfirmItem[], checked: ReadonlySet<string>): string[] {
  return items.filter((item) => item.reasons.length === 0 && checked.has(item.taskId)).map((item) => item.taskId);
}

/** 一行任务：勾选框、编号、模型、首行、参考图角标、阻断原因与可折叠的完整发送文本。 */
function RunConfirmRow(input: {
  item: ConfirmItem;
  index: number;
  checked: boolean;
  open: boolean;
  onToggle: () => void;
  onExpand: () => void;
}) {
  const { item, index, checked, open, onToggle, onExpand } = input;
  const bad = item.reasons.length > 0;
  const references = item.send?.referenceCount ?? 0;
  return (
    <li className={bad ? "confirm-bad" : ""}>
      <label className="confirm-head">
        <input type="checkbox" disabled={bad} checked={checked && !bad} onChange={onToggle} />
        <span className="muted">#{index + 1}</span>
        <strong>{item.modelName}</strong>
        <span className="confirm-line">{item.firstLine || <span className="muted">（无提示词）</span>}</span>
        {references > 0 && <span className="badge">{references} 张参考图</span>}
      </label>
      <ItemProblems item={item} />
      <button className="link small" onClick={onExpand}>
        {open ? "收起发送文本" : "展开完整发送文本"}
      </button>
      {open && <SendTextBody item={item} />}
    </li>
  );
}

export function RunConfirmDialog({ items, scope, onConfirm, onCancel }: Props) {
  const [checked, setChecked] = useState(() => runnableTaskIds(items));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const blocked = items.filter((item) => item.reasons.length > 0).length;
  const toggleCheck = (taskId: string) => setChecked((current) => toggled(current, taskId));
  const toggleExpand = (taskId: string) => setExpanded((current) => toggled(current, taskId));

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="modal modal-wide" role="dialog" aria-label="确认运行">
        <div className="modal-head">
          <strong>确认运行（{scope === "selection" ? "选中子图" : "整个画板"}）</strong>
        </div>
        <ul className="confirm-list">
          {items.map((item, index) => (
            <RunConfirmRow
              key={item.taskId}
              item={item}
              index={index}
              checked={checked.has(item.taskId)}
              open={expanded.has(item.taskId)}
              onToggle={() => toggleCheck(item.taskId)}
              onExpand={() => toggleExpand(item.taskId)}
            />
          ))}
        </ul>
        <div className="modal-foot">
          <span className="muted modal-foot-note">
            共 {items.length} 个任务，已勾选 {checked.size}
            {blocked > 0 && `，${blocked} 个不可运行`}
          </span>
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={checked.size === 0} onClick={() => onConfirm(selectedTaskIds(items, checked))}>
            运行 {checked.size} 个任务
          </button>
        </div>
      </div>
    </div>
  );
}

// 标签页栏（#127 / #137）：标签、新建、画板列表与右键菜单。
// 判定在 ui/tabView.ts，这里只留接线与 DOM 摆放。
import { useCallback, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { useShell } from "./shell";
import type { Session } from "./useBoardSessions";
import { canRename, renameDraftOf, renameKeyOf, tabClassOf, tabPackMenu, tabTitleOf } from "./tabView";

interface Props {
  sessions: Session[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onRename: (key: string, title: string) => void;
  onCreate: () => void;
  /** 打开本机画板列表，重新打开已关闭的画板。 */
  onOpenList?: () => void;
  onExportPack: (key: string) => void;
}

/** 一个标签：单击切换、双击改名、右键出菜单、× 关闭。 */
function TabItem(props: {
  session: Session;
  activeKey: string | null;
  editing: boolean;
  draft: string;
  onDraft(value: string): void;
  onActivate(): void;
  onClose(): void;
  onStartRename(): void;
  onCommit(): void;
  onCancelRename(): void;
  onMenu(at: { x: number; y: number }): void;
}) {
  const { session, activeKey, editing, draft } = props;
  return (
    <div
      className={tabClassOf(session, activeKey)}
      title={session.path}
      onClick={props.onActivate}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu({ x: e.clientX, y: e.clientY });
      }}
      onDoubleClick={() => {
        if (canRename(session)) props.onStartRename();
      }}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => props.onDraft(e.target.value)}
          onBlur={props.onCommit}
          onKeyDown={(e) => {
            const action = renameKeyOf(e.key);
            if (action === "commit") props.onCommit();
            if (action === "cancel") props.onCancelRename();
          }}
        />
      ) : (
        <span className="tab-title">{tabTitleOf(session)}</span>
      )}
      <button
        className="tab-close"
        title="关闭"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}

/** 标签的右键菜单：导出画板包（标签与置灰原因跟顶部「画板包」菜单同一处定义）。 */
function TabMenu(props: { session: Session; at: { x: number; y: number }; onExport(): void; onClose(): void }) {
  const port = useShell();
  return (
    <ContextMenu
      at={props.at}
      items={[{ action: "exportPack", ...tabPackMenu(port, props.session)[0] }]}
      onPick={props.onExport}
      onClose={props.onClose}
    />
  );
}

export function TabBar({ sessions, activeKey, onActivate, onClose, onRename, onCreate, onOpenList, onExportPack }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ key: string; at: { x: number; y: number } } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuSession = menu && sessions.find((s) => s.key === menu.key);

  const commit = (key: string) => {
    setEditing(null);
    onRename(key, draft);
  };

  return (
    <nav className="tabs">
      {sessions.map((s) => (
        <TabItem
          key={s.key}
          session={s}
          activeKey={activeKey}
          editing={editing === s.key}
          draft={draft}
          onDraft={setDraft}
          onActivate={() => onActivate(s.key)}
          onClose={() => onClose(s.key)}
          onStartRename={() => {
            setDraft(renameDraftOf(s) ?? "");
            setEditing(s.key);
          }}
          onCommit={() => commit(s.key)}
          onCancelRename={() => setEditing(null)}
          onMenu={(at) => setMenu({ key: s.key, at })}
        />
      ))}
      <button className="tab-new" title="新建画板" onClick={onCreate}>
        ＋
      </button>
      {onOpenList && (
        <button className="tab-list" title="列出本机存储已有画板并打开" onClick={onOpenList}>
          画板列表
        </button>
      )}
      {menuSession && menu && (
        <TabMenu session={menuSession} at={menu.at} onExport={() => onExportPack(menuSession.key)} onClose={closeMenu} />
      )}
    </nav>
  );
}

// 工作台的各个对话框与浮层（#137）：从 src/App.tsx 拆出的子组件，让 App 只留接线。
import type { ReactNode } from "react";
import type { ConfirmItem } from "../core/submission";
import { BoardPackDialog, type BoardPackDialogProps } from "./BoardPackDialog";
import { ChangelogDialog } from "./ChangelogDialog";
import { RunConfirmDialog } from "./RunConfirmDialog";
import { SendTextDialog } from "./SendTextDialog";
import { SettingsPanel } from "./SettingsPanel";
import type { useSettings } from "./useSettings";

/** 设置面板。 */
export function AppSettingsPanel({ settings, onClose }: { settings: ReturnType<typeof useSettings>; onClose(): void }) {
  return <SettingsPanel settings={settings} onClose={onClose} />;
}

/** 更新说明。 */
export function AppChangelogDialog({ version, onClose }: { version: string; onClose(): void }) {
  return <ChangelogDialog currentVersion={version} onClose={onClose} />;
}

/** 运行的二次确认。 */
export function AppRunConfirm({
  items,
  scope,
  onCancel,
  onConfirm,
}: {
  items: ConfirmItem[];
  scope: "selection" | "board";
  onCancel(): void;
  onConfirm(ids: string[]): void;
}) {
  return <RunConfirmDialog items={items} scope={scope} onCancel={onCancel} onConfirm={onConfirm} />;
}

/** 查看发送文本。 */
export function AppSendTextDialog({ item, onCopy, onClose }: { item: ConfirmItem; onCopy(text: string): void; onClose(): void }) {
  return <SendTextDialog item={item} onCopy={onCopy} onClose={onClose} />;
}

/** 画板包对话框。 */
export function AppBoardPackDialog(props: BoardPackDialogProps) {
  return <BoardPackDialog {...props} />;
}

/** 一次性的提示（底部浮出的那句话）。 */
export function AppToast({ text }: { text: string }) {
  return <div className="toast">{text}</div>;
}

/** 页面级模态（会话失效时盖在工作台之上，不销毁它）。 */
export function AppSessionExpired({ children }: { children: ReactNode }) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="notice notice-warn">会话已失效，请重新粘贴 API 密钥；当前页面上的改动保留，验证后可继续保存。</div>
        {children}
      </div>
    </div>
  );
}

/** 工作区外面那层（供 App 组合用）。 */
export const workspaceClass = "workspace";

/** 空工作台（没有打开的画板）。 */
export function AppEmptyWorkspace({
  ready,
  userRoot,
  onCreate,
  onImportPack,
}: {
  ready: boolean;
  userRoot: string | null;
  onCreate(): void;
  onImportPack(): void;
}) {
  if (!ready) return <div className="empty">正在加载…</div>;
  return (
    <div className="empty">
      <div>没有打开的画板</div>
      <div className="empty-actions">
        <button className="primary" onClick={onCreate} disabled={!userRoot}>
          新建画板
        </button>
        <button onClick={onImportPack} disabled={!userRoot}>
          导入画板包…
        </button>
      </div>
    </div>
  );
}

/** 画板打不开时的说明（版本太新 / 文件损坏）。 */
export function AppUnopenableBoard({ active }: { active: { path: string; status: string; version?: number; reason?: string } }) {
  if (active.status === "newer") {
    return (
      <div className="empty">
        该画板由更新版本的工具保存（format_version {active.version}），本版本无法打开；文件未做任何改动。
        <div className="mono muted">{active.path}</div>
      </div>
    );
  }
  return (
    <div className="empty">
      画板文件已损坏且没有可用备份：{active.reason}
      <div className="mono muted">{active.path}</div>
    </div>
  );
}

/** 工作台的全部浮层与对话框：开着哪个就渲染哪个。 */
export function AppOverlays({
  settings,
  settingsOpen,
  onSettingsClose,
  changelogOpen,
  version,
  onChangelogClose,
  confirm,
  onConfirmCancel,
  onConfirm,
  sendText,
  onCopyText,
  onSendTextClose,
  packDialog,
  toastText,
}: {
  settings: ReturnType<typeof useSettings>;
  settingsOpen: boolean;
  onSettingsClose(): void;
  changelogOpen: boolean;
  version: string;
  onChangelogClose(): void;
  confirm: { items: ConfirmItem[]; scope: "selection" | "board"; boardKey: string; board: import("../core/board").Board } | null;
  onConfirmCancel(): void;
  onConfirm(ids: string[]): void;
  sendText: ConfirmItem | null;
  onCopyText(text: string): void;
  onSendTextClose(): void;
  packDialog: BoardPackDialogProps | null;
  toastText: string | null;
}) {
  return (
    <>
      {settingsOpen && <AppSettingsPanel settings={settings} onClose={onSettingsClose} />}
      {changelogOpen && <AppChangelogDialog version={version} onClose={onChangelogClose} />}
      {confirm && (
        <AppRunConfirm
          items={confirm.items}
          scope={confirm.scope}
          onCancel={onConfirmCancel}
          onConfirm={onConfirm}
        />
      )}
      {sendText && <AppSendTextDialog item={sendText} onCopy={onCopyText} onClose={onSendTextClose} />}
      {packDialog && <AppBoardPackDialog {...packDialog} />}
      {toastText && <AppToast text={toastText} />}
    </>
  );
}

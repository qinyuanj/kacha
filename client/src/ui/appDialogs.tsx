// 工作台的各个对话框与浮层（#137）：从 src/App.tsx 拆出的子组件，让 App 只留接线。
import type { ConfirmItem } from "../core/submission";
import { BoardPackDialog, type BoardPackDialogProps } from "./BoardPackDialog";
import { ChangelogDialog } from "./ChangelogDialog";
import { FeedbackDialog } from "./FeedbackDialog";
import { RunConfirmDialog } from "./RunConfirmDialog";
import { SendTextDialog } from "./SendTextDialog";
import type { DataRootActions } from "./dataRootMove";
import { SettingsPanel } from "./SettingsPanel";
import type { useSettings } from "./useSettings";

/** 设置面板。 */
export function AppSettingsPanel({ settings, onClose, dataRoot }: { settings: ReturnType<typeof useSettings>; onClose(): void; dataRoot?: DataRootActions }) {
  return <SettingsPanel settings={settings} onClose={onClose} dataRoot={dataRoot} />;
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

/** 工作台的全部浮层与对话框：开着哪个就渲染哪个。 */
export function AppOverlays({
  settings,
  settingsOpen,
  onSettingsClose,
  changelogOpen,
  version,
  onChangelogClose,
  build,
  feedbackOpen,
  onFeedbackClose,
  feedbackBoardName,
  confirm,
  onConfirmCancel,
  onConfirm,
  sendText,
  onCopyText,
  onSendTextClose,
  packDialog,
  toastText,
  dataRoot,
}: {
  settings: ReturnType<typeof useSettings>;
  settingsOpen: boolean;
  onSettingsClose(): void;
  changelogOpen: boolean;
  version: string;
  onChangelogClose(): void;
  build: string;
  feedbackOpen: boolean;
  onFeedbackClose(): void;
  feedbackBoardName: string;
  confirm: { items: ConfirmItem[]; scope: "selection" | "board"; boardKey: string; board: import("../core/board").Board } | null;
  onConfirmCancel(): void;
  onConfirm(ids: string[]): void;
  sendText: ConfirmItem | null;
  onCopyText(text: string): void;
  onSendTextClose(): void;
  packDialog: BoardPackDialogProps | null;
  toastText: string | null;
  /** 更新那一段的快照与动作（#164、#180）。 */
  /** 数据位置迁移的接线（#161）。 */
  dataRoot?: DataRootActions;
}) {
  return (
    <>
      {settingsOpen && <AppSettingsPanel settings={settings} onClose={onSettingsClose} dataRoot={dataRoot} />}
      {changelogOpen && <AppChangelogDialog version={version} onClose={onChangelogClose} />}
      {feedbackOpen && <FeedbackDialog version={version} build={build} boardName={feedbackBoardName} onClose={onFeedbackClose} />}
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
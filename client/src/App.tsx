import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Board } from "./core/board";
import { BUILTIN_TABLE, type CapabilityTable } from "./core/capabilities";
import type { BoardChange } from "./core/edit";
import type { Runner, RunTarget } from "./core/runner";
import type { UpdatePreparationPorts } from "./core/updatePreparation";
import { useActiveBoardSize } from "./ui/useBoardSize";
import { shouldShowUpdateNotice } from "./core/changelog";
import { useUsageLimit } from "./ui/useUsageLimit";
import { useRunner } from "./ui/useRunner";
import { useSettings } from "./ui/useSettings";
import { resolveFeedbackRelayAddress } from "./core/settings";
import { useBoardPack } from "./ui/useBoardPack";
import { useRunCallbacks } from "./ui/appRunHooks";
import { useBoardSessions } from "./ui/useBoardSessions";
import { errorText } from "./core/errors";
import { useShell } from "./ui/shell";
import { useUpdate } from "./ui/useUpdate";
import { useUpdateAutoInstall } from "./ui/useUpdateAutoInstall";
import { updateStatusView } from "./ui/updateStatusView";
import { modalOpenOf, noticesAfterMove, uiStateOf, uiStateText } from "./ui/appUiState";
import { AppOverlays } from "./ui/appDialogs";
import type { DataRootActions } from "./ui/dataRootMove";
import { downloadBoardResults } from "./ui/packMenu";
import { AppShell } from "./ui/appShell";
import { useAppState, useRestoreTabs, useStartupReads, useToastTimer, useUiStateWriter, useVersionNotice } from "./ui/useAppState";
import {
  appView,
  archivedAction,
  handledOf,
  lockedOf,
  orEmpty,
  settingsEnabled,
  usageEnabled,
  versionOrEmpty,
  versionOrUndefined,
  boardKeyOf,
  canvasBoard,
  createBoardOrExplain,
  dismissBoardNotice,
  dismissSizeAction,
  focusFor,
  openFromList,
  packMenuPick,
  sizeQueryOf,
  tidyAction,
  tidyKeyAfter,
  tidyingFor,
  updateNoticeOf,
  usageNoticeOf,
} from "./ui/appView";
import {
  activateBoard,
  boardFileOf,
  closeBoardList,
  applyActive,
  cancelTaskOn,
  checkActive,
  jumpToTask,
  openBoardList,
  openManageBoards,
  redoOn,
  sizeNoticeUpdated,
  togglePackMenu,
  undoOn,
} from "./ui/appCallbacks";
import {
  applyGuarded,
  archiveBoardAt as archiveBoardAction,
  closeBoard as closeBoardAction,
  deleteBoardAt as deleteBoardAction,
  discardMissing as discardMissingAction,
  exportBoardAt as exportBoardAction,
} from "./ui/appActions";

/** 没有画板时的占位画板（工作区这时不渲染画布）。 */
const EMPTY_BOARD: Board = { format_version: 2, title: "", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} };

/** 工作台的 props。 */
export interface AppProps {
  version?: string | null;
}

export function App({ version }: AppProps) {
  const port = useShell();
  const userRoot = port.userRoot;
  const store = useAppState();
  const { state } = store;
  const settings = useSettings();
  const [table, setTable] = useState<CapabilityTable>(BUILTIN_TABLE);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // 编辑环境随渲染更新（能力表、网关发现），锁定集按画板现取运行器的最新快照；sessions 在每次画板变更时取。
  const envRef = useRef({ table, discovery: settings.discovery });
  envRef.current = { table, discovery: settings.discovery };
  const runnerRef = useRef<Runner | null>(null);
  const boards = useBoardSessions(
    userRoot,
    useCallback((key: string) => ({ ...envRef.current, locked: runnerRef.current!.getSnapshot().board(key).locked }), []),
    useCallback((from: string, to: string) => store.setSizeNotices((s) => noticesAfterMove(s, from, to)), []),
  );
  const { sessions, activeKey, openPath, createBoard } = boards;

  const { apply, check, undoBoard, redoBoard } = boards;
  const applyOne = useCallback(
    (key: string, change: BoardChange) => applyGuarded(apply, boards.flushNow, key, change),
    [apply, boards],
  );
  const { runner, snapshot: runState } = useRunner(applyOne, settings.settings.concurrency);
  runnerRef.current = runner;

  const toast = useCallback((message: string) => store.setToastText(message), [store]);

  // 导入与导出是两项能力（#131）：桌面壳能导入、还不能导出。
  const pack = useBoardPack(userRoot, boards, toast);

  // 数据位置迁移（#161）：准备期先落盘并拦下新的生成提交，结束后（成败都）解除；成功才重新载入。
  const [movingRoot, setMovingRoot] = useState(false);
  const movingRootRef = useRef(false);
  useEffect(() => {
    runner.setSubmissionGuard(movingRoot ? () => toast("正在迁移数据位置，请等它结束") : null);
  }, [movingRoot, runner, toast]);
  const dataRootActions = useMemo<DataRootActions>(
    () => ({
      prepare: async () => {
        movingRootRef.current = true;
        setMovingRoot(true);
        await boards.flushAll();
      },
      finish: (moved: boolean) => {
        movingRootRef.current = false;
        setMovingRoot(false);
        // 数据根换了：页面启动时读的地址是快照，必须重新读一次（服务与图片协议已跟着换）。
        if (moved) window.location.reload();
      },
      guard: () => ({
        pending: runnerRef.current?.getSnapshot().pending() ?? 0,
        // 进度模态开着就是导入 / 导出在跑；Go 侧也会拒绝并发迁移。
        packBusy: pack.dialog?.state.stage === "progress",
        moving: movingRootRef.current,
      }),
    }),
    [boards, pack.dialog],
  );

  useToastTimer(state.toastText, store.setToastText);
  useStartupReads(
    { capabilityOverride: () => port.meta.readCapabilityOverride(), uiState: () => port.meta.readUiState() },
    store,
    setTable,
  );
  useVersionNotice(state.metadataReady, version, state.lastSeenVersion, store.uiReadFailedRef.current, store.setLastSeenVersion);

  const confirmCtx = useMemo(
    () => ({ table, discovery: settings.discovery, concurrency: settings.settings.concurrency, probe: port.core.imageProbe }),
    [table, settings.discovery, settings.settings.concurrency],
  );

  const targetOf = useCallback(
    (boardKey: string): RunTarget => ({ boardKey, boardFile: boards.boardFileName(boardKey), table, userRoot, baseUrl: settings.settings.base_url, apiKey: settings.apiKey }),
    [boards, table, userRoot, settings.settings.base_url, settings.apiKey],
  );

  const { openRun, viewSendText, copyText, doRegenerate, runNow } = useRunCallbacks({
    activeKey,
    userRoot,
    apiKey: settings.apiKey,
    boards,
    runner,
    runState,
    ctx: confirmCtx,
    targetOf,
    toast,
    openSettings: () => store.setSettingsOpen(true),
    setConfirm: (c) => store.setConfirm(c),
    setSendText: (item) => store.setSendText(item),
    applyOne,
  });

  const cancelTask = useCallback((taskNodeId: string) => cancelTaskOn(runner, activeKey, taskNodeId), [runner, activeKey]);

  const closeOne = useCallback(
    async (key: string) => {
      await closeBoardAction(
        {
          pending: (k) => runner.getSnapshot().pending(k),
          ask: (text, options) => port.ui.ask(text, options),
          closeRunner: (k) => runner.closeBoard(k),
          closeSessions: (k) => boards.closeBoard(k),
        },
        key,
      );
    },
    [runner, boards],
  );

  /**
   * 从画板列表删除：本页开着的先保存再带版本删、成功后关标签页；没开的直接删（#68）。失败以错误抛回列表；
   * 用户不肯停掉未完成的任务时什么都不做。
   */
  const deleteBoardAt = useCallback(
    async (path: string) => {
      await deleteBoardAction(
        {
          keyOf: (p) => boards.keyOf(p),
          pending: (k) => runner.getSnapshot().pending(k),
          ask: (text, options) => port.ui.ask(text, options),
          closeRunner: (k) => runner.closeBoard(k),
          deleteSessions: (k) => boards.deleteBoard(k),
          removeDirect: (p) => port.board.remove(p),
        },
        path,
      );
    },
    [boards, runner],
  );

  /** 归档（#90）：本页开着且有未完成的任务时先确认停掉（结果写不进只读画板），再保存、搬进归档子目录。 */
  const archiveBoardAtPath = useCallback(
    async (path: string) => {
      await archiveBoardAction(
        {
          keyOf: (p) => boards.keyOf(p),
          pending: (k) => runner.getSnapshot().pending(k),
          ask: (text, options) => port.ui.ask(text, options),
          closeRunner: (k) => runner.closeBoard(k),
          archiveSessions: (p) => boards.archiveBoard(p),
        },
        path,
      );
    },
    [boards, runner],
  );

  /** 删除前导出画板包：没打开的先打开（导出流程以已打开的画板为准）。 */
  const exportBoardAt = useCallback(
    async (path: string) => {
      await exportBoardAction(
        {
          keyOf: (p) => boards.keyOf(p),
          open: (p, activate) => openPath(p, activate),
          prepareExport: (k) => pack.prepareExport(k),
          toast,
        },
        path,
      );
    },
    [boards, openPath, pack, toast],
  );

  /** 放弃一块本机存储已不存在的画板：本页内容随之丢弃，先确认。 */
  const discardMissingBoard = useCallback(
    async (key: string) => {
      await discardMissingAction(
        {
          ask: (text, options) => port.ui.ask(text, options),
          closeRunner: (k) => runner.closeBoard(k),
          dropSession: (k) => boards.dropSession(k),
        },
        key,
      );
    },
    [runner, boards],
  );

  /** 新建画板；画板位满时提示统一文案（#89）。 */
  const createOne = useCallback(() => createBoardOrExplain(createBoard, toast), [createBoard, toast]);

  useRestoreTabs(
    {
      metadataReady: state.metadataReady,
      settingsLoaded: settings.loaded,
      openPath,
      createBoardOrExplain: createOne,
      toast,
    },
    store,
  );

  const openChangelog = useCallback(() => {
    store.setLastSeenVersion(versionOrUndefined(version));
    store.setChangelogOpen(true);
  }, [version, store]);

  const writeUi = useCallback(() => {
    const uiState = uiStateOf(boards.snapshot(), state.lastSeenVersion, state.sizeNotices);
    const text = uiStateText(uiState);
    return port.meta.writeUiState(text);
  }, [boards, state.lastSeenVersion, state.sizeNotices, port]);
  const persistUi = useUiStateWriter(writeUi);

  // 更新安装前的准备依赖（#164）：任务队列用 runner 的真实份数与提交守护，
  // 保存用画板会话的严格落盘与界面状态写入；准备失败时界面恢复创作，旧版本照常可用。
  const updateDeps = useMemo<UpdatePreparationPorts>(
    () => ({
      queue: {
        pending: () => runner.getSnapshot().pending(),
        setSubmissionGuard: (guard) => runner.setSubmissionGuard(guard),
      },
      saveBoards: () => boards.flushAll(),
      saveUi: async () => {
        await persistUi();
      },
      unsavedChanges: () => boards.hasUnsavedChanges(),
    }),
    [runner, boards, persistUi],
  );
  // 更新的接线（#180）：一份快照、一份动作、一处空闲判定；高级设置、主界面提示条与
  // 空闲自动安装共用它们，所以只有一个轮询、一个排程与一个准备协调器。
  const update = useUpdate(updateDeps);
  // 画板列表与设置读出来没有也交给空闲判定（#180）：启动时快照往往先到，
  // 这时自动安装会把半载入的界面状态写回去。判定只在 core/updateAutoInstall 一处。
  const updateIdle = useCallback(
    () => ({
      boardsReady: state.ready,
      settingsLoaded: settings.loaded,
      pendingTasks: runner.getSnapshot().pending(),
      unsavedChanges: boards.hasUnsavedChanges(),
    }),
    [state.ready, settings.loaded, runner, boards],
  );
  const autoInstall = useUpdateAutoInstall({ snapshot: update.snapshot, loaded: update.loaded, idle: updateIdle, install: update.install });
  const updateStatus = updateStatusView({ snapshot: update.snapshot, auto: autoInstall.view });

  const uiSignature = JSON.stringify([sessions.map((s) => s.path), sessions.find((s) => s.key === activeKey)?.path, state.lastSeenVersion, state.sizeNotices]);
  const persistRef = useRef(persistUi);
  persistRef.current = persistUi;
  const ready = state.ready;
  useEffect(() => {
    if (ready) void persistRef.current();
  }, [ready, uiSignature]);

  // 当前画板越线提示（#87）：只提醒，不碰生成。体量回落时校正已提醒档位（清除回落那条线的记录）。
  // 导入与导出是两项能力（#131）：桌面壳能导入、还不能导出。
  const packImportOff = port.features.packImport === false;
  const sizeQuery = sizeQueryOf(appView({ sessions, activeKey, userRoot, activeSize: null, sizeNotices: state.sizeNotices, packImportOff }).active);
  const activeSize = useActiveBoardSize(sizeQuery?.path ?? null, sizeQuery?.version ?? null);
  const view = appView({ sessions, activeKey, userRoot, activeSize, sizeNotices: state.sizeNotices, packImportOff });
  // 用量上限提醒（#88）：只提醒，生成照常。
  const usageLimit = useUsageLimit(usageEnabled(state.metadataReady, userRoot));
  const usageNotice = usageNoticeOf(usageLimit.notice, state.usageDismissed);
  useEffect(() => {
    store.setSizeNotices((notices) => sizeNoticeUpdated(notices, view.sizeNotice));
  }, [view.sizeNotice, store]);

  if (state.fatal) return <div className="fatal">启动失败：{state.fatal}</div>;

  const updateNotice = updateNoticeOf(ready, versionOrEmpty(version), state.lastSeenVersion, shouldShowUpdateNotice);
  /** 页面级模态开着（设置、更新说明、画板列表、运行确认、发送文本、画板包对话框）：粘贴放行给弹窗，不落到背后的画板（#96）。 */
  const modalOpen = modalOpenOf({
    settingsOpen: state.settingsOpen,
    changelogOpen: state.changelogOpen,
    boardListOpen: state.boardListOpen,
    confirmOpen: state.confirm !== null,
    sendTextOpen: state.sendText !== null,
    packDialogOpen: pack.dialog !== null,
    feedbackOpen,
  });
  return (

    <>
      <AppShell
        view={view}
        sessions={sessions}
        activeKey={activeKey}
        userRoot={userRoot}
        ready={ready}
        version={versionOrEmpty(version)}
        updateNotice={updateNotice}
        packMenu={state.packMenu}
        boardListOpen={state.boardListOpen}
        manageBoards={state.manageBoards}
        settingsLoaded={settingsEnabled(settings.loaded, userRoot)}
        tableError={state.tableError}
        settingsFileProblem={settings.fileProblem}
        settingsOpen={state.settingsOpen}
        usageNotice={usageNotice}
        updateStatus={updateStatus}
        update={update}
        onDeferUpdate={autoInstall.defer}
        runIndicator={{
          active: runState.active,
          activity: runState.activity,
          titleOf: view.titleOf,
          onJump: (t) => jumpToTask(boards.setActiveKey, store.setFocus, state.focus, t),
          onCancelCopy: (taskId) => runner.cancel({ kind: "copy", taskId }),
          onCancelWaiting: () => runner.cancel({ kind: "waiting" }),
        }}
        canvasProps={{
          board: canvasBoard(view.active, EMPTY_BOARD),
          boardFile: boardFileOf(view.active),
          table,
          userRoot: orEmpty(userRoot),
          apply: (change: BoardChange) => applyActive(apply, activeKey, change) as ReturnType<typeof apply>,
          check: (change: BoardChange) => checkActive(check, activeKey, change) as ReturnType<typeof check>,
          locked: lockedOf(runState.board(orEmpty(activeKey)).locked),
          onUndo: () => undoOn(undoBoard, activeKey),
          onRedo: () => redoOn(redoBoard, activeKey),
          undoLabel: view.undoLabel,
          redoLabel: view.redoLabel,
          toast,
          discovery: settings.discovery,
          concurrency: settings.settings.concurrency,
          runNodes: runState.board(orEmpty(activeKey)).nodes,
          handled: handledOf(runState.board(orEmpty(activeKey)).handled),
          onRun: (ids) => void openRun(ids),
          onCancelTask: cancelTask,
          onRegenerate: doRegenerate,
          onViewSendText: (id) => void viewSendText(id),
          toolbarSlot,
          readOnly: view.activeArchived,
          modalOpen,
          focus: focusFor(state.focus, view.active),
          tidying: tidyingFor(state.tidyKey, view.active, view.activeArchived),
          onTidyChange: (on) => store.setTidyKey(tidyKeyAfter(on, view.active)),
          onMoveOutStage: (stageId) => boards.moveOutStage(boardKeyOf(view.active), stageId),
        }}
        onActivate={(key) => activateBoard(boards.setActiveKey, () => store.setFocus(null), key)}
        onCloseTab={(key) => void closeOne(key)}
        onRename={(key, title) => void boards.renameBoard(key, title)}
        onCreate={() => void createOne()}
        onOpenList={() => openBoardList(boards.flushAll, store.setBoardListOpen)}
        onExportPack={(key) => void pack.prepareExport(key)}
        onOpenChangelog={openChangelog}
        onCloseUpdateNotice={() => store.setLastSeenVersion(versionOrUndefined(version))}
        onOpenListItem={(path) => openFromList(openPath, toast, path)}
        onCloseBoardList={() => {
          closeBoardList(store.setBoardListOpen, store.setManageBoards);
          usageLimit.refresh();
        }}
        onDeleteBoard={deleteBoardAt}
        onArchiveBoard={archiveBoardAtPath}
        onUnarchiveBoard={boards.unarchiveBoard}
        onCopyBoard={boards.copyAsNewBoard}
        onExportBoard={(path) => void exportBoardAt(path).catch((e) => toast(errorText(e)))}
        onTogglePackMenu={(at) => store.setPackMenu(togglePackMenu(state.packMenu, at))}
        onPackMenuPick={(action) => packMenuPick(action, view.active, () => void pack.importPack(), (k) => void pack.prepareExport(k), (p) => downloadBoardResults(port, p, toast))}
        onPackMenuClose={() => store.setPackMenu(null)}
        onDismissTableError={() => store.setTableError(null)}
        onOpenSettings={() => store.setSettingsOpen(true)}
        onManageBoards={() => openManageBoards(boards.flushAll, store.setManageBoards, store.setBoardListOpen)}
        onDismissUsage={() => store.setUsageDismissed(usageNotice?.level ?? null)}
        onTidy={() => tidyAction(view, state.sizeNotices, store.setSizeNotices, store.setTidyKey)}
        onDismissSize={() => dismissSizeAction(view, state.sizeNotices, store.setSizeNotices)}
        onUnarchive={() => archivedAction(view.archived, boards.unarchiveBoard)}
        onCopyArchived={() => archivedAction(view.archived, boards.copyAsNewBoard)}
        onDismissBoardNotice={() => dismissBoardNotice(view.active, boards.dismissNotice)}
        onReload={(key) => void boards.reload(key)}
        onRetrySave={(key) => void boards.retrySave(key)}
        onExportFailure={(key) => void pack.prepareExport(key)}
        onCloseMissing={(key) => void discardMissingBoard(key)}
        onImportPack={() => void pack.importPack()}
        importDisabled={view.importDisabled}
        onOpenFeedback={() => setFeedbackOpen(true)}
        onToolbarSlot={setToolbarSlot}
      />
      <AppOverlays
        settings={settings}
        settingsOpen={state.settingsOpen}
        onSettingsClose={() => store.setSettingsOpen(false)}
        changelogOpen={state.changelogOpen}
        version={versionOrEmpty(version)}
        onChangelogClose={() => store.setChangelogOpen(false)}
        build=""
        feedbackOpen={feedbackOpen}
        onFeedbackClose={() => setFeedbackOpen(false)}
        feedbackBoardName={activeKey ? view.titleOf(activeKey) : ""}
        feedbackRelayUrl={resolveFeedbackRelayAddress(settings.settings)}
        confirm={state.confirm}
        onConfirmCancel={() => store.setConfirm(null)}
        onConfirm={(ids) => void runNow(state.confirm!.boardKey, state.confirm!.board, ids)}
        sendText={state.sendText}
        onCopyText={copyText}
        onSendTextClose={() => store.setSendText(null)}
        packDialog={pack.dialog}
        toastText={state.toastText}
        dataRoot={dataRootActions}
      />
    </>

  );
}

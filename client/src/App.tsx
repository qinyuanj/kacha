import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Board } from "./core/board";
import { BUILTIN_TABLE, effectiveTable, type CapabilityTable } from "./core/capabilities";
import type { BoardChange } from "./core/edit";
import { redoLabel, undoLabel } from "./core/history";
import { basename, boardsDir } from "./core/paths";
import type { RegenerateRequest, Runner, RunTarget } from "./core/runner";
import { copiesByNode, regenerateDispatch, runDispatch, runScope, buildConfirmItems, collectRunFacts, type ConfirmItem } from "./core/submission";
import { parseUiState, serializeUiState, type UiState } from "./core/uiState";
import { imageProbe } from "./shell/adapters";
import { copyTextToClipboard } from "./shell/clipboard";
import { browser, ipc, transfer, userRoot } from "./shell/ipc";
import { BoardPackDialog } from "./ui/BoardPackDialog";
import { BoardListDialog } from "./ui/BoardListDialog";
import { BoardToolbar } from "./ui/BoardToolbar";
import { ContextMenu } from "./ui/ContextMenu";
import { BoardCanvas } from "./ui/BoardCanvas";
import { RunConfirmDialog } from "./ui/RunConfirmDialog";
import { RunIndicator } from "./ui/RunIndicator";
import { SendTextDialog } from "./ui/SendTextDialog";
import { SettingsPanel } from "./ui/SettingsPanel";
import { useRunner } from "./ui/useRunner";
import { useSettings } from "./ui/useSettings";
import { TabBar } from "./ui/TabBar";
import { useBoardPack } from "./ui/useBoardPack";
import { useBoardSessions } from "./ui/useBoardSessions";

export function App({ onLogout, version }: { onLogout?: () => void; version?: string | null } = {}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [boardListOpen, setBoardListOpen] = useState(false);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [packMenu, setPackMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<{ boardKey: string; board: Board; items: ConfirmItem[]; scope: "selection" | "board" } | null>(null);
  const [sendText, setSendText] = useState<ConfirmItem | null>(null);
  const settings = useSettings();
  const [table, setTable] = useState<CapabilityTable>(BUILTIN_TABLE);
  const [tableError, setTableError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [metadataReady, setMetadataReady] = useState(false);
  const [toastText, setToastText] = useState<string | null>(null);
  const started = useRef(false);
  const initialUi = useRef<UiState | null>(null);
  // 编辑环境随渲染更新（能力表、网关发现），锁定集按画板现取运行器的最新快照；sessions 在每次画板变更时取。
  const envRef = useRef({ table, discovery: settings.discovery });
  envRef.current = { table, discovery: settings.discovery };
  const runnerRef = useRef<Runner | null>(null);
  const boards = useBoardSessions(
    userRoot,
    useCallback((key: string) => ({ ...envRef.current, locked: runnerRef.current!.getSnapshot().board(key).locked }), []),
  );
  const { sessions, activeKey, openPath, createBoard } = boards;

  const { apply, check, undoBoard, redoBoard } = boards;
  const applyGuarded = useCallback(
    (key: string, change: BoardChange) => {
      const result = apply(key, change);
      // 提交与结果立即落盘，避免浏览器关页 / 刷新时丢失 last_submitted 或新结果节点。
      if (result && (change.kind === "submitted" || change.kind === "runResult")) void boards.flushNow(key);
      return result;
    },
    [apply, boards],
  );
  const { runner, snapshot: runState } = useRunner(applyGuarded, settings.settings.concurrency);
  runnerRef.current = runner;
  const [focus, setFocus] = useState<{ boardKey: string; nodeId: string; nonce: number } | null>(null);
  const applyActive = useCallback((change: BoardChange) => activeKey ? apply(activeKey, change) : null, [activeKey, apply]);
  const checkActive = useCallback((change: BoardChange) => (activeKey ? check(activeKey, change) : null), [activeKey, check]);
  const undoActive = useCallback(() => activeKey && undoBoard(activeKey), [activeKey, undoBoard]);
  const redoActive = useCallback(() => activeKey && redoBoard(activeKey), [activeKey, redoBoard]);
  const toast = useCallback((message: string) => setToastText(message), []);
  const pack = useBoardPack(userRoot, boards, toast);
  useEffect(() => {
    if (!toastText) return;
    const timer = setTimeout(() => setToastText(null), 4000);
    return () => clearTimeout(timer);
  }, [toastText]);

  useEffect(() => {
    void (async () => {
      try {
        const override = await ipc.readCapabilityOverride().catch((e) => {
          setTableError(`读取能力表覆盖文件失败：${e}`);
          return null;
        });
        const effective = effectiveTable(override);
        setTable(effective.table);
        if (effective.error) setTableError(effective.error);
        initialUi.current = parseUiState(await ipc.readUiState().catch(() => null));
        setMetadataReady(true);
      } catch (e) {
        setFatal(String(e));
      }
    })();
  }, []);

  /** 与运行时相同的上下文算确认项：逐张检测参考图（缺失 / 透明通道）。运行与查看发送文本共用。 */
  const confirmItemsOf = useCallback(
    async (board: Board, ids: string[], root: string) => {
      const { missingNodes, alphaByNode } = await collectRunFacts(imageProbe, board, ids, root);
      return buildConfirmItems(board, table, ids, { discovery: settings.discovery, concurrency: settings.settings.concurrency, missingNodes, alphaByNode });
    },
    [settings.discovery, settings.settings.concurrency, table],
  );

  const startRun = useCallback(
    async (boardKey: string, board: Board, taskIds: string[]) => {
      setConfirm(null);
      if (!userRoot) return;
      const target: RunTarget = { boardKey, boardFile: boards.boardFileName(boardKey), table, userRoot, baseUrl: settings.settings.base_url, apiKey: settings.apiKey };
      // 实际份数按此刻的并发上限算出并随任务固化；之后改并发上限不影响已排队的任务数。
      const problems = await runner.submit(target, board, taskIds, copiesByNode(board, taskIds, settings.settings.concurrency));
      if (problems.length) toast(`${problems.length} 个任务提交失败：${problems[0]}`);
    },
    [userRoot, runner, boards, table, settings.settings.base_url, settings.settings.concurrency, settings.apiKey, toast],
  );

  // 单个干净任务直接提交，单个标红 / 没有任务只提示；其余弹二次确认（分派规则见 runDispatch）。
  const openRunConfirm = useCallback(
    async (selectedIds: string[]) => {
      if (!activeKey || !userRoot) return;
      await boards.flushAll();
      const board = boards.getBoard(activeKey);
      if (!board) return;
      const busy = runner.getSnapshot().board(activeKey).locked;
      const items = await confirmItemsOf(board, runScope(board, selectedIds, busy), userRoot);
      const dispatch = runDispatch(items);
      // 没有可提交的任务时先说明原因；真要提交或弹确认窗才需要密钥。
      if (dispatch.kind === "toast") return toast(dispatch.message);
      if (!settings.apiKey) {
        toast("请先在高级设置中填写 API 密钥");
        setSettingsOpen(true);
        return;
      }
      if (dispatch.kind === "submit") void startRun(activeKey, board, [dispatch.taskId]);
      else setConfirm({ boardKey: activeKey, board, items, scope: selectedIds.length ? "selection" : "board" });
    },
    [activeKey, userRoot, settings.apiKey, boards, runner, confirmItemsOf, startRun, toast],
  );

  const viewSendText = useCallback(
    async (taskNodeId: string) => {
      if (!activeKey || !userRoot) return;
      const board = boards.getBoard(activeKey);
      if (!board) return;
      const [item] = await confirmItemsOf(board, [taskNodeId], userRoot);
      if (item) setSendText(item);
    },
    [activeKey, userRoot, boards, confirmItemsOf],
  );

  const copyText = useCallback(
    // 内网 HTTP 不是安全上下文，navigator.clipboard 不可用；壳层用 textarea 回退。
    (text: string) => void copyTextToClipboard(text).then(() => toast("已复制发送文本"), (e) => toast(`复制失败：${e}`)),
    [toast],
  );

  const regenerate = useCallback(
    async (taskNodeId: string, fromTaskId?: string) => {
      if (!activeKey || !userRoot) return;
      if (!settings.apiKey) {
        toast("请先在高级设置中填写 API 密钥");
        setSettingsOpen(true);
        return;
      }
      const board = boards.getBoard(activeKey);
      if (!board) return;
      const target: RunTarget = { boardKey: activeKey, boardFile: boards.boardFileName(activeKey), table, userRoot, baseUrl: settings.settings.base_url, apiKey: settings.apiKey };
      // 重新生成按此刻的实际份数固化，多于一份先轻量确认，免得忘了份数多花钱；生成变体由运行器固定一份。
      let request: RegenerateRequest;
      if (fromTaskId === undefined) {
        const dispatch = regenerateDispatch(board, table, taskNodeId, settings.settings.concurrency);
        if (dispatch.kind === "confirm") {
          const text = `将生成 ${dispatch.copies} 份，模型 ${dispatch.modelName}。${dispatch.note ? `\n${dispatch.note}。` : ""}`;
          if (!(await browser.ask(text, { title: "确认重新生成", okLabel: `重新生成 ${dispatch.copies} 份`, cancelLabel: "取消" }))) return;
        }
        request = { kind: "regenerate", copies: dispatch.copies };
      } else request = { kind: "variant", fromTaskId };
      const problem = await runner.regenerate(target, board, taskNodeId, request);
      if (problem) toast(`${fromTaskId ? "生成变体" : "重新生成"}失败：${problem}`);
    },
    [activeKey, userRoot, boards, runner, settings.apiKey, settings.settings.base_url, settings.settings.concurrency, table, toast],
  );

  const cancelTask = useCallback((taskNodeId: string) => activeKey && runner.cancel({ kind: "task", boardKey: activeKey, taskNodeId }), [activeKey, runner]);

  /** 画板还有排队 / 执行中的任务时，关闭前阻断式二选一；不后台续跑。 */
  const confirmStopTasks = (count: number) =>
    browser.ask(`还有 ${count} 个任务在排队或执行。关闭后不会在后台继续；已在执行的只停止本地等待，网关侧计算可能仍在继续。`, {
      title: "任务未完成",
      kind: "warning",
      okLabel: "取消全部并关闭",
      cancelLabel: "留在画板",
    });

  const closeBoard = useCallback(
    async (key: string) => {
      const count = runner.getSnapshot().pending(key);
      if (count > 0 && !(await confirmStopTasks(count))) return;
      // 取消并遗忘：重开后失败 / 已取消由任务目录的 outcome.json 给出。
      runner.closeBoard(key);
      await boards.closeBoard(key);
    },
    [boards, runner],
  );

  // 设置与界面状态就绪后恢复标签页；一个都没有就新建。
  useEffect(() => {
    if (!metadataReady || !settings.loaded || started.current) return;
    started.current = true;
    void (async () => {
      const ui = initialUi.current!;
      const opened: string[] = [];
      for (const p of ui.open_boards) {
        try {
          if (await openPath(p, false)) opened.push(p);
          else toast(`找不到画板文件：${p}`);
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e));
        }
      }
      let activated = false;
      if (ui.active_board && opened.includes(ui.active_board)) activated = await openPath(ui.active_board, true);
      if (!activated && opened.length) await openPath(opened[0], true);
      else if (!activated) await createBoard();
      setReady(true);
    })();
  }, [metadataReady, settings.loaded, openPath, createBoard, toast]);

  const uiWriteChain = useRef(Promise.resolve());
  const writeUi = useCallback(() => {
    const { sessions: list, activeKey: key } = boards.snapshot();
    const active = list.find((s) => s.key === key);
    const text = serializeUiState({ open_boards: list.map((s) => s.path), active_board: active?.path ?? null });
    const write = uiWriteChain.current.then(() => ipc.writeUiState(text));
    uiWriteChain.current = write.catch(() => undefined);
    return write;
  }, [boards]);
  const persistUi = useCallback(() => writeUi().catch(() => undefined), [writeUi]);
  const persistRef = useRef(persistUi);
  persistRef.current = persistUi;

  const uiSignature = JSON.stringify([sessions.map((s) => s.path), sessions.find((s) => s.key === activeKey)?.path]);
  useEffect(() => {
    if (ready) void persistRef.current();
  }, [ready, uiSignature]);

  if (fatal) return <div className="fatal">启动失败：{fatal}</div>;

  const active = sessions.find((s) => s.key === activeKey);
  const failing = sessions.filter((s) => s.status === "ok" && s.saveError);

  const canvasReady = active?.status === "ok" && !!userRoot;
  return (
    <div className="app">
      <div className="topbar">
        <div className="muted small topbar-backup-hint">服务端不备份；60 天未使用的数据可能被清理，请定期导出画板包</div>
        <TabBar
          sessions={sessions}
          activeKey={activeKey}
          onActivate={(key) => {
            setFocus(null);
            boards.setActiveKey(key);
          }}
          onClose={(key) => void closeBoard(key)}
          onRename={(key, title) => void boards.renameBoard(key, title)}
          onCreate={() => void createBoard()}
          onOpenList={() => void boards.flushAll().then(() => setBoardListOpen(true))}
          onExportPack={(key) => void pack.prepareExport(key)}
        />
      </div>
      {boardListOpen && userRoot && (
        <BoardListDialog
          dir={boardsDir(userRoot)}
          openPaths={sessions.map((s) => s.path)}
          onOpen={(path) => {
            void openPath(path, true).then((opened) => {
              if (!opened) toast("画板不存在，可能已在别处改名；请刷新列表");
            }, (e) => toast(e instanceof Error ? e.message : String(e)));
          }}
          onClose={() => setBoardListOpen(false)}
        />
      )}
      <div className="board-toolbar">
        {/* 有画板时画布把工具栏 portal 进这个容器；没有时放置灰占位，布局不跳。 */}
        <div ref={setToolbarSlot} className="board-toolbar-slot">
          {!canvasReady && <BoardToolbar disabled />}
        </div>
        <div className="board-toolbar-right">
          <RunIndicator
            active={runState.active}
            titleOf={(key) => {
              const s = sessions.find((x) => x.key === key);
              return s?.status === "ok" ? s.board.title : "（已关闭的画板）";
            }}
            onJump={(t) => {
              boards.setActiveKey(t.boardKey);
              setFocus((f) => ({ boardKey: t.boardKey, nodeId: t.taskNodeId, nonce: (f?.nonce ?? 0) + 1 }));
            }}
            onCancelCopy={(taskId) => runner.cancel({ kind: "copy", taskId })}
            onCancelWaiting={() => runner.cancel({ kind: "waiting" })}
          />
          <button
            className="topbar-button"
            aria-haspopup="menu"
            aria-expanded={packMenu !== null}
            disabled={!userRoot}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPackMenu((m) => (m ? null : { x: r.left, y: r.bottom + 2 }));
            }}
          >
            画板包 ▾
          </button>
          {version && <span className="muted small topbar-version">Kacha {version}</span>}
          <button className="topbar-button" onClick={() => setSettingsOpen(true)} disabled={!settings.loaded || !userRoot}>
            ⚙ 高级设置
          </button>
          {onLogout && (
            <button className="topbar-button" onClick={onLogout} title="退出当前会话；换密钥即视为新用户">
              退出
            </button>
          )}
        </div>
      </div>
      {packMenu && (
        <ContextMenu
          at={packMenu}
          items={[
            { action: "importPack", label: "导入画板包…", disabledReason: null },
            { action: "exportPack", label: "导出画板包…", disabledReason: active?.status === "ok" ? null : active ? "画板无法打开，不能导出" : "没有打开的画板" },
            { action: "downloadResults" as const, label: "下载整板结果（zip）", disabledReason: active?.status === "ok" ? null : active ? "画板无法打开，不能下载" : "没有打开的画板" },
          ]}
          onPick={(action) => {
            setPackMenu(null);
            if (action === "importPack") void pack.importPack();
            else if (action === "exportPack" && active) void pack.prepareExport(active.key);
            else if (action === "downloadResults" && active) {
              transfer.downloadBoardResults(active.path);
              toast("已开始下载整板结果（含各结果的图层），缺失的结果列在包内 缺失文件.txt");
            }
          }}
          onClose={() => setPackMenu(null)}
        />
      )}
      {failing.map(
        (s) =>
          s.status === "ok" && (
            <div key={s.key} className="bar bar-error">
              <span>
                「{s.board.title}」{s.saveError}
                {s.conflicted ? "（改动保留在本页，不会自动合并）" : "（之后每次修改都会重试）"}
              </span>
              {s.conflicted ? <button onClick={() => void boards.reload(s.key)}>重新载入</button> : <button onClick={() => void boards.retrySave(s.key)}>重试保存</button>}
              <button onClick={() => void pack.prepareExport(s.key)}>导出画板包</button>
            </div>
          ),
      )}
      {tableError && (
        <div className="bar bar-warn">
          <span>{tableError}（已使用内置能力表）</span>
          <button onClick={() => setTableError(null)}>知道了</button>
        </div>
      )}
      {settings.fileProblem && !settingsOpen && (
        <div className="bar bar-warn">
          <span>{settings.fileProblem}</span>
          <button onClick={() => setSettingsOpen(true)}>打开高级设置</button>
        </div>
      )}
      {active?.status === "ok" && active.notice && (
        <div className="bar bar-warn">
          <span>{active.notice}</span>
          <button onClick={() => boards.dismissNotice(active.key)}>知道了</button>
        </div>
      )}
      <main className="workspace">
        {!active || !userRoot ? (
          <div className="empty">
            {ready ? (
              <>
                <div>没有打开的画板</div>
                <div className="empty-actions">
                  <button className="primary" onClick={() => void createBoard()} disabled={!userRoot}>
                    新建画板
                  </button>
                  <button onClick={() => void pack.importPack()} disabled={!userRoot}>
                    导入画板包…
                  </button>
                </div>
              </>
            ) : (
              "正在加载…"
            )}
          </div>
        ) : active.status === "newer" ? (
          <div className="empty">
            该画板由更新版本的工具保存（format_version {active.version}），本版本无法打开；文件未做任何改动。
            <div className="mono muted">{active.path}</div>
          </div>
        ) : active.status === "corrupt" ? (
          <div className="empty">
            画板文件已损坏且没有可用备份：{active.reason}
            <div className="mono muted">{active.path}</div>
          </div>
        ) : (
          <ReactFlowProvider key={active.key}>
            <BoardCanvas
              board={active.board}
              boardFile={basename(active.path)}
              table={table}
              userRoot={userRoot}
              apply={applyActive}
              check={checkActive}
              locked={runState.board(active.key).locked}
              onUndo={undoActive}
              onRedo={redoActive}
              undoLabel={undoLabel(active.history)}
              redoLabel={redoLabel(active.history)}
              toast={toast}
              discovery={settings.discovery}
              concurrency={settings.settings.concurrency}
              runNodes={runState.board(active.key).nodes}
              handled={runState.board(active.key).handled}
              onRun={(ids) => void openRunConfirm(ids)}
              onCancelTask={cancelTask}
              onRegenerate={regenerate}
              onViewSendText={(id) => void viewSendText(id)}
              toolbarSlot={toolbarSlot}
              focus={focus?.boardKey === active.key ? focus : null}
            />
          </ReactFlowProvider>
        )}
      </main>
      {settingsOpen && (
        <SettingsPanel settings={settings} onClose={() => setSettingsOpen(false)} />
      )}
      {confirm && (
        <RunConfirmDialog
          items={confirm.items}
          scope={confirm.scope}
          onCancel={() => setConfirm(null)}
          onConfirm={(ids) => void startRun(confirm.boardKey, confirm.board, ids)}
        />
      )}
      {sendText && <SendTextDialog item={sendText} onCopy={copyText} onClose={() => setSendText(null)} />}
      {pack.dialog && <BoardPackDialog {...pack.dialog} />}
      {toastText && <div className="toast">{toastText}</div>}
    </div>
  );
}

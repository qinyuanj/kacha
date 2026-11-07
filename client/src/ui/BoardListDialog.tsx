// 画板列表：画板在服务端，关掉的标签页与另一个浏览器都从这里重新打开（桌面版靠启动参数 / 拖入文件）；也在这里删除画板。
import { useCallback, useEffect, useState } from "react";
import { BOARD_EXTENSION } from "../core/board";
import { joinPath } from "../core/paths";
import { ipc } from "../shell/ipc";
import { errorText } from "../core/errors";

interface Props {
  /** 画板目录（绝对路径，含用户数据根）。 */
  dir: string;
  /** 本页已打开的画板路径：列表里标注，不重复开。 */
  openPaths: string[];
  onOpen(path: string): void;
  /** 删除画板（移入回收区）；失败时 reject，错误留在确认框里。 */
  onDelete(path: string): Promise<void>;
  /** 删除前先导出画板包：沿用现有导出流程。 */
  onExport(path: string): void;
  onClose(): void;
}

const titleOf = (name: string) => name.slice(0, -BOARD_EXTENSION.length);

export function BoardListDialog({ dir, openPaths, onOpen, onDelete, onExport, onClose }: Props) {
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ name: string; busy: boolean; error: string | null } | null>(null);
  const refresh = useCallback(() => {
    setError(null);
    ipc.listBoardNames(dir).then(setNames, (e) => {
      setNames([]);
      setError(errorText(e));
    });
  }, [dir]);
  useEffect(refresh, [refresh]);

  const confirmDelete = async () => {
    if (!deleting || deleting.busy) return;
    setDeleting({ ...deleting, busy: true, error: null });
    try {
      await onDelete(joinPath(dir, deleting.name));
      setDeleting(null);
    } catch (e) {
      setDeleting({ ...deleting, busy: false, error: errorText(e) });
    }
    refresh();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="画板列表" onClick={(e) => e.stopPropagation()}>
        <h2>画板列表</h2>
        <p className="muted">画板保存在服务端；换浏览器后用同一把密钥也能看到同一份。</p>
        {error && <div className="bar bar-error">读取画板列表失败：{error}</div>}
        {names === null ? (
          <div>正在加载…</div>
        ) : names.length === 0 ? (
          <div>还没有画板</div>
        ) : (
          <ul className="board-list">
            {names.map((name) => {
              const path = joinPath(dir, name);
              const isOpen = openPaths.includes(path);
              return (
                <li key={name}>
                  <button
                    className="board-list-open"
                    onClick={() => {
                      onOpen(path);
                      onClose();
                    }}
                  >
                    {titleOf(name)}
                  </button>
                  {isOpen && <span className="muted">已打开</span>}
                  <button className="board-list-delete" aria-label={`删除「${titleOf(name)}」`} onClick={() => setDeleting({ name, busy: false, error: null })}>
                    删除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="modal-foot">
          <button onClick={refresh}>刷新</button>
          <button className="primary" onClick={onClose}>关闭</button>
        </div>
      </div>
      {deleting && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            e.stopPropagation();
            if (!deleting.busy) setDeleting(null);
          }}
        >
          <div className="modal" role="dialog" aria-label="删除画板" onClick={(e) => e.stopPropagation()}>
            <h2>删除画板「{titleOf(deleting.name)}」？</h2>
            <ul className="delete-notes">
              <li>画板里的生成结果仍保留在任务目录中，删除画板不会删除图片。</li>
              <li>不再被任何画板引用的结果之后可能被清理。</li>
              <li>误删可在 14 天内联系管理员恢复。</li>
            </ul>
            {deleting.error && <div className="bar bar-error">删除失败：{deleting.error}</div>}
            <div className="modal-foot">
              <button onClick={() => onExport(joinPath(dir, deleting.name))} disabled={deleting.busy}>
                先导出画板包
              </button>
              <button className="danger" onClick={() => void confirmDelete()} disabled={deleting.busy}>
                {deleting.busy ? "正在删除…" : "删除"}
              </button>
              <button onClick={() => setDeleting(null)} disabled={deleting.busy}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

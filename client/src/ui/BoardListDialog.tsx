// 画板列表：画板在服务端，关掉的标签页与另一个浏览器都从这里重新打开（桌面版靠启动参数 / 拖入文件）。
import { useCallback, useEffect, useState } from "react";
import { BOARD_EXTENSION } from "../core/board";
import { joinPath } from "../core/paths";
import { ipc } from "../shell/ipc";

interface Props {
  /** 画板目录（绝对路径，含用户数据根）。 */
  dir: string;
  /** 本页已打开的画板路径：列表里标注，不重复开。 */
  openPaths: string[];
  onOpen(path: string): void;
  onClose(): void;
}

export function BoardListDialog({ dir, openPaths, onOpen, onClose }: Props) {
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    setError(null);
    ipc.listBoardNames(dir).then(setNames, (e) => {
      setNames([]);
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [dir]);
  useEffect(refresh, [refresh]);

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
                    onClick={() => {
                      onOpen(path);
                      onClose();
                    }}
                  >
                    {name.slice(0, -BOARD_EXTENSION.length)}
                  </button>
                  {isOpen && <span className="muted">已打开</span>}
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
    </div>
  );
}

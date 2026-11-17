import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { NOTICE_PREFIX, parseChangelog, type ChangelogVersion } from "../core/changelog";
import changelogText from "../../../docs/release/changelog.md?raw";

// 格式错误只让弹窗显示提示，不让整个页面在加载时崩溃；日常验证由守护测试抓。
function loadReleases(): { releases: ChangelogVersion[]; error: string | null } {
  try {
    return { releases: parseChangelog(changelogText), error: null };
  } catch (e) {
    return { releases: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** 弹窗键盘边界：Esc 关闭，Tab 在关闭按钮与正文之间循环。 */
function handleDialogKey(event: KeyboardEvent<HTMLDivElement>, onClose: () => void, close: HTMLButtonElement | null, content: HTMLDivElement | null): void {
  if (event.key === "Escape") {
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const next = document.activeElement === close ? content : close;
    next?.focus();
  }
}

export function ChangelogDialog({ currentVersion, onClose }: { currentVersion: string; onClose: () => void }) {
  const { releases, error } = useMemo(loadReleases, []);
  const contentRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    currentRef.current?.scrollIntoView({ block: "start" });
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal changelog-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-title"
        onKeyDown={(event) => handleDialogKey(event, onClose, closeRef.current, contentRef.current)}
      >
        <div className="modal-head">
          <strong id="changelog-title">更新内容</strong>
          <button ref={closeRef} className="link" onClick={onClose}>关闭</button>
        </div>
        <div ref={contentRef} className="changelog-releases" tabIndex={0} aria-label="各版本更新说明">
          {error && <div className="notice notice-warn">更新说明暂时显示不了：{error}</div>}
          {!error && releases.length === 0 && <div className="muted">暂无更新说明</div>}
          {/* 文档最上面可能有尚未发布的下一版，只列当前版本及更早的。 */}
          {releases.slice(Math.max(0, releases.findIndex((r) => r.version === currentVersion))).map((release) => (
            <section key={release.version} ref={release.version === currentVersion ? currentRef : undefined} className="changelog-release">
              <h2>{release.version}{release.version === currentVersion && <span className="muted small">当前版本</span>}</h2>
              {release.groups.map((group) => (
                <div key={group.title} className="changelog-group">
                  <h3>{group.title}</h3>
                  <ul>
                    {group.items.map((item, index) => (
                      <li key={index}>{item.notice && <strong className="changelog-notice">{NOTICE_PREFIX}</strong>}{item.text}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// 进入界面的各个区块（#137）：从 ui/Root.tsx 拆出的子组件，让 Root 只留接线。
import { useEffect } from "react";

/** 粘贴 API 密钥的表单。 */
export function KeyEntryForm(props: {
  apiKey: string;
  busy: boolean;
  error: string | null;
  version: string | null;
  onChange(value: string): void;
  onSubmit(): void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { apiKey, busy, error, version, inputRef } = props;
  return (
    <div className="key-entry" role="dialog" aria-label="粘贴 API 密钥">
      <h1>Kacha</h1>
      <p className="muted">粘贴你的 new-api API 密钥即可进入工作台，无需注册。7 天内重新打开不用再次粘贴。</p>
      <textarea
        ref={inputRef}
        aria-label="API 密钥"
        rows={3}
        value={apiKey}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit();
          }
        }}
        placeholder="sk-…"
        spellCheck={false}
        autoComplete="off"
      />
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="primary" onClick={props.onSubmit} disabled={busy || !apiKey.trim()}>
        {busy ? "正在向网关验证…" : "进入工作台"}
      </button>
      <p className="muted small">
        密钥只保存在你自己的浏览器里，服务端只存它的指纹。换密钥即视为新用户：看不到原来密钥下的画板与结果，更换前请先导出画板包或联系管理员迁移。
      </p>
      {version && <p className="muted small">Kacha 版本 {version}</p>}
    </div>
  );
}

/** 会话失效时盖在工作台之上的模态（不销毁工作台）。 */
export function SessionExpiredModal(props: { children: React.ReactNode }) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="notice notice-warn">会话已失效，请重新粘贴 API 密钥；当前页面上的改动保留，验证后可继续保存。</div>
        {props.children}
      </div>
    </div>
  );
}

/** 焦点落在密钥输入框上（要粘贴时自动聚焦）。 */
export function useKeyFocus(phase: string, expired: boolean, inputRef: React.RefObject<HTMLTextAreaElement | null>): void {
  useEffect(() => {
    if (phase === "enter" || expired) inputRef.current?.focus();
  }, [phase, expired, inputRef]);
}

/** 连不上服务端时的说明。 */
export const fatalText = (message: string) => `无法连接 Kacha 服务端：${message}`;

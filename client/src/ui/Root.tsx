// 进入与身份（ADR 0018）：粘贴 new-api API 密钥 → 服务端验证 → 7 天会话。
// 会话失效（HTTP 层统一识别 401）时只盖一层重新粘贴的模态，不卸载工作台，未保存的画板改动保留。
// 启动与提交的判定在 ui/rootSession.ts（#137），这里只留接线与 DOM 摆放。
import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "../App";
import { useShell } from "./shell";
import { bootSession, submitKey, type Phase } from "./rootSession";

export function Root() {
  const port = useShell();
  const session = port.session;
  const [phase, setPhase] = useState<Phase>("loading");
  const [version, setVersion] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  /** 覆盖在工作台之上的重新粘贴模态（会话过期），不销毁 App。 */
  const [expired, setExpired] = useState(false);
  const [sessionNonce, setSessionNonce] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    void (async () => {
      const result = await bootSession(session);
      if (result.kind === "fatal") return setFatal(result.message);
      setVersion(result.version);
      setPhase(result.kind);
    })();
  }, []);

  useEffect(() => session.onExpired(() => setExpired(true)), []);

  useEffect(() => {
    if (phase === "enter" || expired) inputRef.current?.focus();
  }, [phase, expired]);

  const submit = useCallback(async () => {
    const pasted = key.trim();
    if (!pasted || busy) return;
    setBusy(true);
    setError(null);
    const result = await submitKey(session, pasted);
    setBusy(false);
    if (result.kind === "error") return setError(result.message);
    setKey("");
    setExpired(false);
    setPhase("ready");
    setSessionNonce((n) => n + 1);
  }, [key, busy, session]);

  const logout = useCallback(async () => {
    await session.logout().catch(() => undefined);
    session.clearStoredKey();
    setExpired(false);
    setError(null);
    setPhase("enter");
  }, [session]);

  const form = (
    <div className="key-entry" role="dialog" aria-label="粘贴 API 密钥">
      <h1>Kacha</h1>
      <p className="muted">粘贴你的 new-api API 密钥即可进入工作台，无需注册。7 天内重新打开不用再次粘贴。</p>
      <textarea
        ref={inputRef}
        aria-label="API 密钥"
        rows={3}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="sk-…"
        spellCheck={false}
        autoComplete="off"
      />
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="primary" onClick={() => void submit()} disabled={busy || !key.trim()}>
        {busy ? "正在向网关验证…" : "进入工作台"}
      </button>
      <p className="muted small">
        密钥只保存在你自己的浏览器里，服务端只存它的指纹。换密钥即视为新用户：看不到原来密钥下的画板与结果，更换前请先导出画板包或联系管理员迁移。
      </p>
      {version && <p className="muted small">Kacha 版本 {version}</p>}
    </div>
  );

  if (fatal) return <div className="fatal">{fatal}</div>;
  if (phase === "loading") return <div className="empty">正在加载…</div>;
  if (phase === "enter") return <div className="key-entry-page">{form}</div>;
  return (
    <>
      {/* 会话失效时遮罩盖在 App 之上、不销毁它：告诉画布此刻有模态，粘贴不落到背后的画板（#96）。 */}
      <App key={sessionNonce} onLogout={() => void logout()} version={version} sessionExpired={expired} />
      {expired && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="notice notice-warn">会话已失效，请重新粘贴 API 密钥；当前页面上的改动保留，验证后可继续保存。</div>
            {form}
          </div>
        </div>
      )}
    </>
  );
}

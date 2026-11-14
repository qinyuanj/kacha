// 进入与身份（ADR 0018）：粘贴 new-api API 密钥 → 服务端验证 → 7 天会话。
// 会话失效（HTTP 层统一识别 401）时只盖一层重新粘贴的模态，不卸载工作台，未保存的画板改动保留。
// 启动与提交的判定在 ui/rootSession.ts，各区块在 ui/rootViews.tsx（#137），这里只留接线。
import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "../App";
import { useShell } from "./shell";
import { bootSession, submitKey, type Phase } from "./rootSession";
import { fatalText, KeyEntryForm, SessionExpiredModal, useKeyFocus } from "./rootViews";

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
      if (result.kind === "fatal") return setFatal(fatalText(result.message));
      setVersion(result.version);
      setPhase(result.kind);
    })();
  }, []);

  useEffect(() => session.onExpired(() => setExpired(true)), []);

  useKeyFocus(phase, expired, inputRef);

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

  const form = <KeyEntryForm apiKey={key} busy={busy} error={error} version={version} onChange={setKey} onSubmit={() => void submit()} inputRef={inputRef} />;

  if (fatal) return <div className="fatal">{fatal}</div>;
  if (phase === "loading") return <div className="empty">正在加载…</div>;
  if (phase === "enter") return <div className="key-entry-page">{form}</div>;
  return (
    <>
      {/* 会话失效时遮罩盖在 App 之上、不销毁它：告诉画布此刻有模态，粘贴不落到背后的画板（#96）。 */}
      <App key={sessionNonce} onLogout={() => void logout()} version={version} sessionExpired={expired} />
      {expired && <SessionExpiredModal>{form}</SessionExpiredModal>}
    </>
  );
}
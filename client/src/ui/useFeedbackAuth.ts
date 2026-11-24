import { useEffect, useState } from "react";

import { FEEDBACK_AUTH_REQUIRED } from "../core/feedback";
import type { FeedbackAuthStatus, ShellPort } from "../shell/port";

export interface FeedbackAuthView {
  auth: FeedbackAuthStatus;
  busy: boolean;
  url: string;
  message: string;
  start(): void;
}

/** 一键授权的页面侧状态：只读 Go 侧授权状态，token 不经过这里。 */
export function useFeedbackAuth(port: ShellPort): FeedbackAuthView {
  const [auth, setAuth] = useState<FeedbackAuthStatus>({ authorized: false, pending: false, message: "" });
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    void port.feedback.authStatus().then((status) => { if (alive) setAuth(status); }).catch(() => { if (alive) setAuth({ authorized: false, pending: false, message: FEEDBACK_AUTH_REQUIRED }); });
    return () => { alive = false; };
  }, [port]);

  useEffect(() => {
    if (!auth.pending) return;
    let alive = true;
    const poll = () => {
      void port.feedback.authStatus().then((status) => { if (alive) setAuth(status); }).catch(() => undefined);
    };
    const timer = window.setInterval(poll, 1000);
    poll();
    return () => { alive = false; window.clearInterval(timer); };
  }, [auth.pending, port]);

  const start = () => {
    setBusy(true);
    setMessage("");
    void port.feedback.authStart().then((result) => {
      setBusy(false);
      if (!result.ok) { setMessage(result.message || "Gitea 授权失败，请重试"); return; }
      setUrl(result.url);
      setAuth({ authorized: false, pending: true, message: result.message });
    }).catch(() => { setBusy(false); setMessage("Gitea 授权失败，请重试"); });
  };

  return { auth, busy, url, message, start };
}

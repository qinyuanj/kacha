// 桌面客户端直接进入工作台；API 密钥不参与本机画板身份。
import { useEffect, useState } from "react";
import { App } from "../App";
import { errorText } from "../core/errors";
import { useShell } from "./shell";

export function Root() {
  const port = useShell();
  const [version, setVersion] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void port.ui.version().then(
      (value) => { if (active) setVersion(value); },
      (error: unknown) => { if (active) setFatal(errorText(error)); },
    );
    return () => { active = false; };
  }, [port]);
  if (fatal !== null) return <div className="fatal">无法启动 Kacha 桌面客户端：{fatal}</div>;
  if (version === null) return <div className="empty">正在加载…</div>;
  return <App version={version} />;
}

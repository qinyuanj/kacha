// 桌面入口（#127）：在 MyGo 窗口里直接进工作台，不经过登录与密钥界面。
//
// 普通浏览器里原样渲染 Root（Web 路线的登录流程）。桌面壳没有服务端会话：
// 版本与身份取自壳信息，工作台本身由后续切片接到本地画板端口上。
import { useEffect, useState } from "react";

import { App } from "../App";
import { Root } from "../ui/Root";
import { bootDesktop } from "./desktopBoot";
import type { DesktopShell } from "./desktop";

export function DesktopRoot() {
  /** null = 还在判断，false = 不在 MyGo 窗口里。 */
  const [shell, setShell] = useState<DesktopShell | false | null>(null);

  useEffect(() => {
    let alive = true;
    void bootDesktop().then(
      (found) => alive && setShell(found ?? false),
      () => alive && setShell(false),
    );
    return () => {
      alive = false;
    };
  }, []);

  if (shell === null) return <div className="empty">正在加载…</div>;
  if (shell === false) return <Root />;
  return <App version={shell.version} />;
}

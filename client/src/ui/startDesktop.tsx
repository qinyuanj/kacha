import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { selectShellPort } from "../shell/boot";
import { errorText } from "../core/errors";
import { applyMirroredTheme, colorSchemeQuery, themeStorage } from "../core/theme";
import { Root } from "./Root";
import { ShellProvider } from "./shell";

/** 等桌面端口就绪后挂载；本地初始化失败始终显示原因。 */
export async function startDesktop(element: HTMLElement): Promise<void> {
  // 首帧主题（#221）：挂载前同步按镜像档位写到文档根，避免启动时反向主题闪一下。
  applyMirroredTheme(document.documentElement, themeStorage(), colorSchemeQuery()?.matches ?? false);
  const root = createRoot(element);
  try {
    const port = await selectShellPort();
    port.ui.installInputTakeover();
    document.addEventListener("contextmenu", (event) => {
      if (!port.ui.isEditableTarget(event.target)) event.preventDefault();
    });
    root.render(<StrictMode><ShellProvider port={port}><Root /></ShellProvider></StrictMode>);
  } catch (error) {
    root.render(<div className="fatal" role="alert">无法启动 Kacha 桌面客户端：{errorText(error)}</div>);
  }
}

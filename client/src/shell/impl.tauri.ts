// Tauri 版壳层实现：只被旧假壳 e2e project 使用；生产构建用 impl.web.ts。
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { Update } from "@tauri-apps/plugin-updater";
import type { UpdateFlowPorts } from "../core/updateFlow";
import { detectPlatform, LATEST_RELEASE_API_URL, selectUpdateRelease, type Platform } from "../core/update";
import { fileUrl, httpFetch, ipc } from "./impl.tauri.ipc";
import type { DesktopPort, SessionPort, ShellImpl } from "./types";

const desktop: DesktopPort = {
  ask: (text, options) => ask(text, options),
  message: async (text, options) => void (await message(text, options)),
  open: (options) => open(options),
  save: (options) => save(options),
  setWindowSize: async (size) => {
    await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
  },
  onResized: (handler) => {
    const win = getCurrentWindow();
    return win.onResized(({ payload }) => {
      handler(async () => {
        if (await win.isMaximized()) return null;
        const logical = payload.toLogical(await win.scaleFactor());
        return { width: Math.round(logical.width), height: Math.round(logical.height) };
      });
    });
  },
  // 桌面主进程关窗前由前端保存；Web 版没有这一步（浏览器不等待异步）。
  destroyWindow: () => getCurrentWindow().destroy(),
  onCloseRequested: (handler) => getCurrentWindow().onCloseRequested((event) => handler(event)),
  onSecondInstance: (handler) => listen<string[]>("second-instance", (event) => handler(event.payload)),
  onPackProgress: (handler) => listen<{ done: number; total: number }>("board-pack-progress", (event) => handler(event.payload)),
  onDropPaths: (handler) =>
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") handler(event.payload.paths, event.payload.position);
    }),
  openExternal: (url) => void openUrl(url).catch(() => undefined),
  version: () => getVersion(),
};

/** 统一更新流程的真端口（#12）。 */
function updateFlowPorts(protection: Pick<UpdateFlowPorts, "restartGuard" | "restartReleased">): UpdateFlowPorts {
  const platform: Platform = detectPlatform(navigator.userAgent);
  return {
    currentVersion: () => getVersion(),
    platform: () => platform,
    schedule: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    log: (kind, fields) => void ipc.logEvent(kind, fields).catch(() => undefined),
    release: {
      fetchLatest: async () => {
        const res = await httpFetch(LATEST_RELEASE_API_URL, { method: "GET", headers: { Accept: "application/json" } });
        if (res.status === 404) return null;
        if (res.status < 200 || res.status >= 300) throw new Error(`发布服务器返回 HTTP ${res.status}`);
        return selectUpdateRelease(JSON.parse(await res.text()), platform);
      },
    },
    updater: {
      // 静态端点：官方 updater 直接请求描述 URL；target 固定平台名。
      check: async (descriptorUrl, target) => {
        const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>("check_update", {
          endpoints: [descriptorUrl], target,
        });
        return metadata ? new Update(metadata) : null;
      },
    },
    ...protection,
    restart: relaunch,
  };
}

/** 桌面没有进入界面；这些占位不会被调用。 */
const session: SessionPort = {
  login: async () => ({ fingerprint: "" }),
  current: async () => ({ fingerprint: "" }),
  logout: async () => undefined,
  config: async () => ({ version: await getVersion(), gateway_url: "" }),
  onExpired: () => () => undefined,
  readStoredKey: () => null,
  storeKey: () => undefined,
  clearStoredKey: () => undefined,
};

export const shell: ShellImpl = { web: false, ipc, httpFetch, fileUrl, desktop, session, updateFlowPorts };

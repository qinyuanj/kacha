// 壳层入口：具体实现由构建选择（vite alias `kacha/shell-impl`）。
// 生产 / 新 e2e 接缝 = impl.web.ts；旧假壳 e2e = impl.tauri.ts。
import { shell } from "kacha/shell-impl";

export const { ipc, httpFetch, fileUrl, desktop, updateFlowPorts } = shell;
export const isWeb = shell.web;
export const session = shell.session;
export const relay = shell.relay;
export const packUpload = shell.pack;
export const usage = shell.usage;
export type { AppPaths, BoardTexts, DesktopPort, ImageInfo, Ipc, PackageEntry, PackUploadPort, RelayPort, SessionPort, ShellImpl, Usage, UsageCandidate, UsagePort } from "./types";

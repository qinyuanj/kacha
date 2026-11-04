// 唯一壳层实现：同源 HTTP + 浏览器上传 / 下载。
import { shell } from "./impl.web";

export const { ipc, httpFetch, fileUrl, browser, outputRoot } = shell;
export const session = shell.session;
export const relay = shell.relay;
export const transfer = shell.transfer;
export const packUpload = shell.pack;
export const usage = shell.usage;
export type { BoardTexts, BrowserPort, ImageInfo, Ipc, PackUploadPort, RelayPort, SessionPort, ShellImpl, TransferPort, Usage, UsageCandidate, UsagePort } from "./types";

// 真实桌面桥（#127）：把 MyGo 绑定折成 DesktopBridge。
//
// 走 mygo-runtime 的 call 而不是生成的 client/src/mygo.ts：生成文件是构建产物（gitignore），
// 源码与单测在没有它时也要能编译。调用名与 Go 侧绑定名一致（Shell.Info / Local.WriteBoard）。
import { call } from "mygo-runtime";

import type { DesktopBridge, DesktopClipboardBridge, DesktopClipboardSnapshot, DesktopDiagnosticsBridge, DesktopDiagnosticsOutcome, DesktopExportOutcome, DesktopExportSnapshot, DesktopGatewayBridge, DesktopGatewayResponse, DesktopImageCopy, DesktopInfo, DesktopLocalBridge, DesktopPackBridge, DesktopPackOutcome, DesktopPackSnapshot, DesktopTextCopy, DesktopUpdateBridge, DesktopUsageBridge } from "./desktop";
import type { PackEntryFact } from "../core/boardPack";

/** camelCase 的页面侧方法名 → Go 侧的 PascalCase 绑定名。 */
function goName(method: string): string {
  return method.charAt(0).toUpperCase() + method.slice(1);
}

/** 生成的客户端没在手边时也能用：直接按方法名调用。 */
export function mygoBridge(callFn: (method: string, ...args: unknown[]) => Promise<unknown> = (method, ...args) => call(method, ...args)): DesktopBridge {
  const local = new Proxy({} as DesktopLocalBridge, {
    get: (_target, prop: string) => (...args: unknown[]) => callFn(`Local.${goName(prop)}`, ...args),
  });
  // 系统剪贴板（#129）：与 Go 侧 BindAs("Clipboard", clipboard.Service{}) 对齐。
  // 少这一项时 desktop.ts 的 readClipboard 恒为 null，粘贴会静默退回 paste 事件。
  const clipboard: DesktopClipboardBridge = {
    read: () => callFn("Clipboard.Read") as Promise<DesktopClipboardSnapshot>,
    // 复制图片（#130）：Go 侧自己按路径读字节并归一化成 PNG，页面只给路径与格式提示。
    copyImage: (path, format) => callFn("Clipboard.CopyImage", path, format) as Promise<DesktopImageCopy>,
    // 复制文本（#124）：Go 原生 Clipboard.WriteText，桌面壳复制节点标记不再依赖浏览器剪贴板权限。
    writeText: (text) => callFn("Clipboard.WriteText", text) as Promise<DesktopTextCopy>,
  };
  // 画板包导入（#131）：与 Go 侧 BindAs("Pack", packservice.New(root)) 对齐。
  // 少这一项时 desktop.ts 的 features.packImport 为 false，导入入口会标「尚不可用」。
  const pack: DesktopPackBridge = {
    pick: () => callFn("Pack.Pick") as Promise<string>,
    start: (path) => callFn("Pack.Start", path) as Promise<DesktopPackOutcome>,
    snapshot: () => callFn("Pack.Snapshot") as Promise<DesktopPackSnapshot>,
    cancel: () => callFn("Pack.Cancel") as Promise<void>,
    // 画板包导出（票 160）：与 Go 侧 Pack.PickExport / Facts / Export / ExportSnapshot / CancelExport 对齐。
    pickExport: (name) => callFn("Pack.PickExport", name) as Promise<string>,
    facts: (spec) => callFn("Pack.Facts", spec) as Promise<PackEntryFact[]>,
    exportPack: (target, spec) => callFn("Pack.Export", target, spec) as Promise<DesktopExportOutcome>,
    exportSnapshot: () => callFn("Pack.ExportSnapshot") as Promise<DesktopExportSnapshot>,
    cancelExport: () => callFn("Pack.CancelExport") as Promise<void>,
  };
  // 网关与密钥（#152）：与 Go 侧 BindAs("Gateway", ...) 对齐。
  const gateway: DesktopGatewayBridge = {
    request: (url, method, headers, body) => callFn("Gateway.Request", url, method, headers, body) as Promise<DesktopGatewayResponse>,
    readApiKey: () => callFn("Gateway.ReadApiKey") as Promise<string | null>,
    writeApiKey: (key) => callFn("Gateway.WriteApiKey", key) as Promise<void>,
    deleteApiKey: () => callFn("Gateway.DeleteApiKey") as Promise<void>,
  };
  // 本机用量与回收（#159）：与 Go 侧 BindAs("Usage", usageservice.New(store)) 对齐。
  const usage = new Proxy({} as DesktopUsageBridge, {
    get: (_target, prop: string) => (...args: unknown[]) => callFn(`Usage.${goName(prop)}`, ...args),
  });
  // 可信自动更新（#164）：与 Go 侧 BindAs("Update", updateservice.New(...)) 对齐。
  // 选版、验签与真实安装器都在 Go 侧；这里只转发三个动作。
  const update: DesktopUpdateBridge = {
    status: () => callFn("Update.Status") as Promise<Awaited<ReturnType<DesktopUpdateBridge["status"]>>>,
    check: () => callFn("Update.Check") as Promise<void>,
    install: () => callFn("Update.Install") as Promise<void>,
  };
  // 诊断采集与导出（#162）：与 Go 侧 BindAs("Diagnostics", ...) 对齐。
  const diagnostics: DesktopDiagnosticsBridge = {
    // 日志是尽力而为的旁路：采集失败不能影响界面，错误在这里就地吞掉。
    log: (kind, fields) => {
      void Promise.resolve(callFn("Diagnostics.Log", kind, fields)).catch(() => undefined);
    },
    export: () => callFn("Diagnostics.Export") as Promise<DesktopDiagnosticsOutcome>,
  };
  return {
    info: () => callFn("Shell.Info") as Promise<DesktopInfo>,
    local,
    clipboard,
    pack,
    gateway,
    usage,
    update,
    diagnostics,
  };
}
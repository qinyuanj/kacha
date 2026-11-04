// core 端口的真适配器集中在这里（#128）：ui 只 import 使用，不在调用点就地拼。测试侧各自就地拼伪实现。
import type { PackFs, PackIo } from "../core/boardPack";
import type { RelocateFs } from "../core/relocate";
import type { RunDeps } from "../core/run";
import type { SettingsPorts } from "../core/settings";
import type { ImageProbe } from "../core/submission";
import type { TaskFs } from "../core/taskDir";
import { imageCodec } from "./imageCodec";
import { desktop, httpFetch, ipc, relay } from "./ipc";
import { logEvent } from "./log";
import { composeOverlay } from "./overlay";

export { updateFlowPorts } from "./ipc";

export const taskFs: TaskFs = {
  writeNewFile: ipc.writeNewFile,
  readFile: ipc.readFileBytes,
};

export const runDeps: RunDeps = {
  ...taskFs,
  fetch: httpFetch,
  now: () => new Date(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  composeOverlay,
  imageCodec,
  // Web 版：url 结果由服务端中转；桌面 / 旧假壳没有该端口，仍由浏览器直接取字节。
  ...(relay ? { relayResult: relay.relayResult, commitRelayed: relay.commitRelayed, discardRelayed: relay.discardRelayed } : {}),
};

/** 哈希走 fileSha256（原始字节，不要求可解码）；候选已按扩展名过滤。 */
export const relocateFs: RelocateFs = {
  listDir: ipc.listDir,
  isFile: ipc.isFile,
  sha256: ipc.fileSha256,
};

export const packFs: PackFs = {
  isFile: ipc.isFile,
  sha256: ipc.fileSha256,
};

export const packIo: PackIo = {
  cancel: ipc.boardPackCancel,
  entries: ipc.boardPackEntries,
  readTexts: ipc.boardPackReadTexts,
  importUnits: ipc.boardPackImport,
};

export const imageProbe: ImageProbe = {
  inspectImage: ipc.inspectImage,
};

export const settingsPorts: SettingsPorts = {
  readSettings: ipc.readSettings,
  writeSettings: ipc.writeSettings,
  readModelsCache: ipc.readModelsCache,
  writeModelsCache: ipc.writeModelsCache,
  secretGet: ipc.secretGet,
  secretSet: ipc.secretSet,
  secretDelete: ipc.secretDelete,
  fetch: httpFetch,
  now: () => new Date(),
  log: logEvent,
};

export const openExternal = desktop.openExternal;

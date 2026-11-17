// 内存壳端口的类型（#137）：从 shell/testing/fakePort.ts 拆出，供替身与各分组共用。
import type { ImportOptions } from "../../core/boardPack";
import type { BoardWriteOptions } from "../types";
import type { ClipboardContent, ImageCopyResult } from "../port";
import type { DiagnosticsOutcome, FeatureId, PortFailureKind } from "../port";

export interface FakeBoard {
  path: string;
  main: string | null;
  bak?: string | null;
  version: string | null;
  archived?: boolean;
  bytes?: number | null;
}

/** 画板包导入的脚本化结局：success / partial / failure 都由它给出。 */
export type FakeImportOutcome =
  | { kind: "done"; summary: { imported: number; skipped: number; conflicts: string[]; message: string }; written: string[]; writeError?: string | null }
  | { kind: "partial"; message: string; conflicts: string[] }
  | { kind: "failed"; error: string }
  | { kind: "slotsFull"; message: string }
  | { kind: "corrupt"; reason: string }
  | { kind: "newer"; message: string }
  | { kind: "cancelled" };

export interface FakePortOptions {
  userRoot?: string;
  boards?: FakeBoard[];
  /** 系统剪贴板内容：readClipboard 返回它（null = 读不到，按 paste 事件走）。 */
  clipboard?: ClipboardContent | null;
  /** copyImage 的结局：默认成功。 */
  copyImage?: ImageCopyResult | ((absPath: string, format?: string) => ImageCopyResult);
  /** pickImages / pickPackFile 依次返回的文件（空了返回空 / null）。 */
  pickImages?: File[][];
  pickPackFiles?: (File | null)[];
  /** importPack 依次返回的结局；空了回 done。 */
  imports?: FakeImportOutcome[];
  /** write 的失败：命中路径时抛（用来验保存冲突）。 */
  writeFailures?: Map<string, PortFailureKind>;
  /** 没有的能力。 */
  missing?: FeatureId[];
  slots?: { used: number; total: number };
  /** 文件组已有的文件（绝对路径 → 字节）：readFile/sha256/inspectImage 只认这些与画板。 */
  files?: Record<string, Uint8Array>;
  /** 文件组已有的目录：listDir 用它判断目录在不在（缺省由一个文件路径推出来）。 */
  dirs?: string[];
  /** 诊断包导出的脚本化结局（缺省成功）。 */
  diagnosticsOutcome?: DiagnosticsOutcome;
  /** 更新快照：status() 返回它（缺省 idle 快照）；check / install 也按它演。 */
  update?: import("../../core/update").UpdateSnapshot;
  /** install 的失败：命中时以该类别拒绝（验界面在安装失败后解除保护）。 */
  updateInstallFailure?: PortFailureKind;
  /** 数据位置迁移（#161）：依次返回的目标目录（空了表示用户取消）。 */
  pickTargets?: string[];
  /** 迁移失败的类别；缺省成功。 */
  moveFailure?: PortFailureKind;
  /** 迁移成功时的文件数（结局文案用）。 */
  moveFiles?: number;
}

/** 替身记下的调用：断言界面把结局传出去时用。 */
export interface FakeCalls {
  write: { path: string; text: string; options?: BoardWriteOptions }[];
  read: string[];
  rename: { from: string; to: string; version?: string }[];
  remove: { path: string; version?: string }[];
  archive: { from: string; to: string; version?: string }[];
  unarchive: { from: string; to: string }[];
  import: { file: File; options: ImportOptions }[];
  /** 更新：检查与安装各被调用几次。 */
  updateCheck: number;
  updateInstall: number;
  copyImage: { path: string; format?: string }[];
  copyText: string[];
  pickImages: { multiple: boolean; files: File[] }[];
  pickPackFile: (File | null)[];
  saveCopyAs: string[];
  log: { kind: string; fields: Record<string, unknown> }[];
  uploadReference: File[];
  inspectImage: string[];
  list: number;
  uiStateWrites: string[];
  ask?: boolean;
  messages?: string[];
  openExternal?: string[];
  downloadImage?: string[];
  downloadBoardResults?: string[];
  writeNewFile?: { absPath: string; bytes: Uint8Array }[];
  exportDiagnostics: number;
  /** 迁移请求过的目标目录（按顺序）。 */
  moveTargets?: string[];
  /** 替身认为的当前数据根；迁移成功后换成新位置。 */
  dataRootRoot?: string;
}
// 把画布上的图片另存到用户选的位置：只新建不覆盖。
import { basename, dirname, joinPath } from "../core/paths";
import { desktop, ipc, isWeb, transfer } from "./ipc";

function suffixed(path: string, n: number): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return joinPath(dirname(path), `${stem} (${n})${ext}`);
}

/** writeNewFile 只新建不覆盖：重名时在文件名后加序号再试；非重名错误直接抛出。 */
export async function writeNew(bytes: Uint8Array, target: string): Promise<string> {
  for (let n = 1; n <= 99; n++) {
    const path = n === 1 ? target : suffixed(target, n);
    try {
      await ipc.writeNewFile(path, bytes);
      return path;
    } catch (e) {
      if (await ipc.isFile(path).catch(() => false)) continue;
      throw e;
    }
  }
  throw new Error("同名文件太多");
}

/** 桌面：弹保存对话框把 absPath 另存一份（只新建不覆盖）；Web：经下载接口存回本机（带图层的结果自动打 zip）。
 *  取消返回 null；Web 版下载没有可返回的路径，返回空字符串表示已发起。 */
export async function saveCopyAs(absPath: string): Promise<string | null> {
  if (isWeb && transfer) {
    transfer.downloadImage(absPath);
    return "";
  }
  const target = await desktop.save({ defaultPath: basename(absPath) });
  if (!target) return null;
  return writeNew(await ipc.readFileBytes(absPath), target);
}
